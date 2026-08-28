import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "../../src/config.js";
import { Orchestrator } from "../../src/core/orchestrator.js";
import { redact } from "../../src/core/redaction.js";

const runFile = promisify(execFile);
const ACK = "I_UNDERSTAND_THIS_STARTS_A_LOCAL_CODEX_PROCESS";
if (
  process.env.CODEX_SUPERVISOR_LIVE_TEST !== "1" ||
  process.env.CODEX_SUPERVISOR_LIVE_E2E !== "1" ||
  process.env.CODEX_SUPERVISOR_LIVE_ACK !== ACK
) {
  process.stdout.write(`${JSON.stringify({
    status: "NOT_RUN",
    reason: "Real development E2E requires both live flags and the exact acknowledgement."
  }, null, 2)}\n`);
  process.exit(0);
}
const verifierImage = process.env.CODEX_SUPERVISOR_VERIFIER_IMAGE?.trim();
if (!verifierImage || !/@sha256:[a-f0-9]{64}$/.test(verifierImage)) {
  process.stdout.write(`${JSON.stringify({
    status: "BLOCKED_BY_ENVIRONMENT",
    reason: "Live E2E requires CODEX_SUPERVISOR_VERIFIER_IMAGE pinned by an exact SHA-256 digest."
  }, null, 2)}\n`);
  process.exit(2);
}

const runId = `codex-e2e-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const artifactRoot = path.resolve("artifacts", "live", runId);
await mkdir(artifactRoot, { recursive: true });
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "codex-supervisor-live-e2e-"));
const repository = path.join(temporaryRoot, "repository");
const stateDirectory = path.join(temporaryRoot, "state");
const verificationFile = path.join(temporaryRoot, "verification.json");
let orchestrator: Orchestrator | undefined;
let summary: Record<string, unknown> = { status: "FAIL", runId };
let safeToRemoveTemporary = false;

async function git(args: string[]): Promise<string> {
  return (await runFile("git", ["-C", repository, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true
  })).stdout.trim();
}

try {
  await mkdir(repository, { recursive: true });
  await runFile("git", ["init", "-b", "main", repository], { encoding: "utf8", windowsHide: true });
  await git(["config", "user.name", "Codex Supervisor E2E"]);
  await git(["config", "user.email", "codex-supervisor-e2e@example.invalid"]);
  await writeFile(path.join(repository, "README.md"), "# Disposable live E2E repository\n", "utf8");
  await git(["add", "README.md"]);
  await git(["commit", "-m", "Create disposable E2E fixture"]);
  if (await git(["remote"])) throw new Error("Disposable E2E repository unexpectedly has a remote");

  await writeFile(verificationFile, `${JSON.stringify({
    version: 2,
    runtime: {
      engine: process.env.CODEX_SUPERVISOR_OCI_ENGINE === "podman" ? "podman" : "docker",
      image: verifierImage,
      user: "65532:65532",
      pidsLimit: 64,
      memoryBytes: 268435456,
      cpus: 1,
      tmpfsSizeBytes: 16777216,
      engineArguments: []
    },
    environmentAllowlist: [],
    profiles: {
      "live-e2e": {
        recipes: [{
          id: "result-check",
          program: "node",
          args: ["-e", "const fs=require('fs');const v=fs.readFileSync('result.txt','utf8').trim();if(v!=='supervised')process.exit(1)"],
          cwd: ".",
          timeoutMs: 15_000,
          required: true
        }]
      }
    }
  }, null, 2)}\n`, "utf8");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MCP_HOST: "127.0.0.1",
    MCP_CONTROL_ENABLED: "true",
    CODEX_WORKSPACE_ROOTS: temporaryRoot,
    SUPERVISOR_STATE_FILE: path.join(stateDirectory, "state.json"),
    SUPERVISOR_VERIFICATION_CONFIG: verificationFile
  };
  const config = loadConfig(env);
  orchestrator = new Orchestrator(config);
  await orchestrator.init();
  const contract = {
    contractVersion: "1.0",
    clientRequestId: runId,
    title: "Disposable Codex Supervisor live E2E",
    objective: "Create result.txt containing exactly the word supervised followed by a newline.",
    plan: ["Inspect the disposable repository", "Create only result.txt", "Report the change"],
    scope: { in: ["result.txt"], out: ["README.md", "Git history", "any remote operation"] },
    constraints: ["Do not commit, push, merge, release, or deploy", "Do not modify README.md"],
    acceptanceCriteria: [{ id: "AC-1", description: "result.txt contains exactly supervised" }],
    requiredVerificationRecipes: ["result-check"],
    allowedChangePaths: ["result.txt"],
    forbiddenChangePaths: ["README.md"],
    maxCorrectionPasses: 1
  };
  await writeFile(path.join(artifactRoot, "contract.json"), `${JSON.stringify(contract, null, 2)}\n`, "utf8");
  const task = await orchestrator.startTask({ workspace: repository, contract });
  const deadline = Date.now() + 10 * 60_000;
  let current = task;
  let afterSeq = 0;
  while (Date.now() < deadline) {
    current = orchestrator.getTask(task.id);
    if (["awaiting_verification", "failed", "blocked", "stale", "interrupted"].includes(current.status)) break;
    await orchestrator.waitForChange(task.id, afterSeq, 20_000);
    afterSeq = orchestrator.getTask(task.id).eventSeq;
  }
  if (current.status !== "awaiting_verification") {
    throw new Error(`Codex task did not reach awaiting_verification: ${current.status}`);
  }
  const diff = await orchestrator.getWorkspaceDiff(task.id);
  await writeFile(path.join(artifactRoot, "workspace.diff"), diff.text, "utf8");
  const verification = await orchestrator.verifyTask({ taskId: task.id, profileId: "live-e2e" });
  await writeFile(path.join(artifactRoot, "verification.json"), `${JSON.stringify(redact(verification), null, 2)}\n`, "utf8");
  if (verification.state !== "passed") throw new Error(`Verification did not pass: ${verification.state}`);
  const verifiedTask = orchestrator.getTask(task.id);
  const expectedSnapshotId = verifiedTask.snapshots?.at(-1)?.snapshotId;
  if (!expectedSnapshotId) throw new Error("Verification did not produce a snapshot-bound acceptance candidate");
  const decided = await orchestrator.decideTask({
    taskId: task.id,
    decision: "accept",
    rationale: "Disposable live E2E acceptance criterion and trusted verifier passed.",
    expectedSnapshotId,
    criterionConfirmations: [{
      criterionId: "AC-1",
      evidence: "The required result-check OCI recipe passed against the exact current snapshot."
    }]
  });
  await writeFile(path.join(artifactRoot, "decision.json"), `${JSON.stringify(redact(decided.decisions?.at(-1)), null, 2)}\n`, "utf8");
  await writeFile(path.join(artifactRoot, "events.ndjson"), `${orchestrator.getEvents(task.id).map((event) => JSON.stringify(redact(event))).join("\n")}\n`, "utf8");
  await writeFile(path.join(artifactRoot, "task-status.json"), `${JSON.stringify(redact(orchestrator.getTaskSummary(task.id)), null, 2)}\n`, "utf8");
  summary = {
    status: decided.status === "ready_for_human_review" ? "PASS" : "FAIL",
    runId,
    realCodexTurn: true,
    disposableRepository: true,
    remoteCount: 0,
    taskId: task.id,
    finalTaskStatus: decided.status,
    verificationState: verification.state,
    artifacts: artifactRoot
  };
  safeToRemoveTemporary = summary.status === "PASS";
} catch (error) {
  summary = {
    status: "FAIL",
    runId,
    realCodexTurn: true,
    error: error instanceof Error ? error.message : String(error),
    artifacts: artifactRoot
  };
  process.exitCode = 1;
} finally {
  if (orchestrator) {
    try {
      await orchestrator.stop();
    } catch (error) {
      safeToRemoveTemporary = false;
      summary = {
        ...summary,
        status: "FAIL",
        shutdownError: error instanceof Error ? error.message : String(error),
        preservedTemporaryRoot: temporaryRoot
      };
      process.exitCode = 1;
    }
  }
  const resolvedTemporary = path.resolve(temporaryRoot);
  if (
    safeToRemoveTemporary &&
    resolvedTemporary.startsWith(path.resolve(os.tmpdir()) + path.sep) &&
    path.basename(resolvedTemporary).startsWith("codex-supervisor-live-e2e-")
  ) {
    await rm(resolvedTemporary, { recursive: true, force: false });
  } else if (!safeToRemoveTemporary) {
    summary = { ...summary, preservedTemporaryRoot: temporaryRoot };
  }
}

summary = redact(summary);
await writeFile(path.join(artifactRoot, "environment.json"), `${JSON.stringify({
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
  generatedAt: new Date().toISOString(),
  secretsIncluded: false
}, null, 2)}\n`, "utf8");
await writeFile(path.join(artifactRoot, "summary.md"), `# Live Codex development E2E\n\nStatus: **${summary.status}**\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n`, "utf8");
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
