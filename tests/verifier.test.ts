import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runVerification } from "../src/core/verification.js";
import { parseVerificationConfig } from "../src/core/verification-config.js";
import { clearQuarantine, createQuarantine } from "../src/verification/quarantine.js";
import { reconcileVerifierRun } from "../src/verification/verifier-reconciler.js";
import { runWorker } from "../src/verification/worker-client.js";
import {
  assertOciRuntimeAvailable,
  ociLabelsHash,
  ociOwnershipLabels
} from "../src/verification/execution-backend.js";
import type { ReconciliationProof, VerifierRunV1 } from "../src/types.js";
import type { OciRuntimeConfig } from "../src/core/verification-config.js";

const exec = promisify(execFile);
const fakeEngine = fileURLToPath(new URL("./fixtures/fake-oci-engine.mjs", import.meta.url));
const interventionWorker = fileURLToPath(new URL("./fixtures/intervention-verifier-worker.mjs", import.meta.url));
const fakeStateRoot = path.join(os.tmpdir(), `codex-supervisor-fake-oci-verifier-${process.pid}`);

async function repository(): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-verifier-"));
  await exec("git", ["-C", repo, "init", "-q"]);
  await exec("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", repo, "config", "user.name", "Test"]);
  await fs.writeFile(path.join(repo, "base.txt"), "base\n");
  await exec("git", ["-C", repo, "add", "base.txt"]);
  await exec("git", ["-C", repo, "commit", "-qm", "base"]);
  return repo;
}

function config(code: string, timeoutMs = 20_000) {
  return parseVerificationConfig({
    version: 2,
    runtime: {
      engine: "docker",
      engineExecutable: process.execPath,
      engineArguments: [fakeEngine, "--state-root", fakeStateRoot],
      image: `example.invalid/verifier@sha256:${"a".repeat(64)}`,
      user: "65532:65532",
      pidsLimit: 64,
      memoryBytes: 256 * 1024 * 1024,
      cpus: 1,
      tmpfsSizeBytes: 16 * 1024 * 1024
    },
    profiles: {
      test: {
        recipes: [{
          id: "node",
          program: process.execPath,
          args: ["-e", code],
          cwd: ".",
          timeoutMs,
          required: true
        }]
      }
    }
  });
}

async function syntheticOciRun(
  runtime: OciRuntimeConfig,
  state: "running" | "stopped" | "absent",
  recipeId = "node"
): Promise<{ run: VerifierRunV1; containerId: string; labels: Record<string, string> }> {
  const binding = await assertOciRuntimeAvailable(runtime);
  const containerId = createHash("sha256")
    .update(`${state}-${recipeId}-${Date.now()}-${Math.random()}`)
    .digest("hex");
  const runId = `run-${containerId.slice(0, 12)}`;
  const taskId = `task-${containerId.slice(0, 12)}`;
  const workerId = `worker-${containerId.slice(0, 12)}`;
  const labels = ociOwnershipLabels({
    taskId,
    runId,
    workerId,
    recipeId,
    imageDigest: runtime.image,
    engine: runtime.engine,
    engineNamespaceHash: binding.engineInstanceHash
  });
  if (state !== "absent") {
    await fs.mkdir(fakeStateRoot, { recursive: true });
    await fs.writeFile(path.join(fakeStateRoot, `${containerId}.json`), JSON.stringify({
      id: containerId,
      image: runtime.image,
      running: state === "running",
      pid: state === "running" ? 4242 : 0,
      exitCode: 0,
      labels
    }));
  }
  return {
    run: {
      runId,
      taskId,
      profileId: "test",
      recipeIds: [recipeId, "next"],
      workerId,
      ownerInstanceId: "prior-instance",
      leaseId: `lease-${containerId.slice(0, 12)}`,
      backend: "oci",
      engine: runtime.engine,
      assurance: "high",
      pid: 999_999_999,
      containerId,
      containerIdHash: createHash("sha256").update(containerId).digest("hex"),
      containerImageDigest: runtime.image,
      containerRecipeId: recipeId,
      containerLabelsHash: ociLabelsHash(labels),
      containerEngineNamespaceHash: binding.engineInstanceHash,
      containerOwnershipRecordedAt: new Date(0).toISOString(),
      startedAt: new Date(0).toISOString(),
      heartbeatAt: new Date(0).toISOString(),
      leaseExpiresAt: new Date(0).toISOString(),
      beforeSnapshotId: "snapshot",
      state: "lost"
    },
    containerId,
    labels
  };
}

test("verification runs in a worker and binds passing evidence to an unchanged snapshot", async () => {
  const repo = await repository();
  const selectedConfig = config("process.stdout.write('verified\\nBearer split'); setImmediate(() => process.stdout.write('secret\\n'))");
  const run = await runVerification({
    taskId: "task",
    worktree: repo,
    profileId: "test",
    config: selectedConfig,
    ownerInstanceId: "instance"
  });
  assert.equal(run.state, "passed", JSON.stringify(run, null, 2));
  assert.equal(run.beforeSnapshotId, run.afterSnapshotId);
  assert.match(run.results?.[0]?.stdout ?? "", /verified/);
  assert.doesNotMatch(run.results?.[0]?.stdout ?? "", /splitsecret/);
  assert.match(run.logDigest ?? "", /^[a-f0-9]{64}$/);
  assert.match(run.containerId ?? "", /^[a-f0-9]{64}$/);
  assert.match(run.containerIdHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(run.containerImageDigest, selectedConfig.runtime.image);
  const evidence = (run.terminationEvidence?.attempts as Array<Record<string, unknown>>)[0];
  assert.equal(evidence?.containerIdHash, run.containerIdHash);
  assert.equal(evidence?.containerImageDigest, run.containerImageDigest);
});

test("missing OCI runtime fails as RUNTIME_UNAVAILABLE without host fallback", async () => {
  const repo = await repository();
  const missing = config("process.exit(0)");
  missing.runtime.engineExecutable = path.join(repo, "missing-container-engine.exe");
  await assert.rejects(
    runVerification({
      taskId: "task",
      worktree: repo,
      profileId: "test",
      config: missing,
      ownerInstanceId: "instance"
    }),
    (error: unknown) => (error as { code?: string }).code === "RUNTIME_UNAVAILABLE"
  );
});

test("container creation fails closed when inspect reports a different image", async () => {
  const repo = await repository();
  const selected = config("process.exit(0)");
  const stateRoot = path.join(os.tmpdir(), `codex-supervisor-fake-oci-image-mismatch-${process.pid}-${Date.now()}`);
  selected.runtime.engineArguments = [
    fakeEngine,
    "--state-root",
    stateRoot,
    "--inspect-image",
    `example.invalid/attacker@sha256:${"8".repeat(64)}`
  ];
  const run = await runVerification({
    taskId: "task-image-mismatch",
    worktree: repo,
    profileId: "test",
    config: selected,
    ownerInstanceId: "instance"
  });
  assert.equal(run.state, "lost");
  const remaining = await fs.readdir(stateRoot).catch(() => []);
  assert.deepEqual(remaining.filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry)), []);
  await fs.rm(stateRoot, { recursive: true, force: true });
});

test("verification timeout records bounded termination assurance", async () => {
  const repo = await repository();
  const run = await runVerification({
    taskId: "task",
    worktree: repo,
    profileId: "test",
    config: config("setInterval(() => {}, 1000)", 200),
    ownerInstanceId: "instance"
  });
  assert.equal(run.results?.[0]?.timedOut, true);
  assert.equal(run.state, "timed_out");
  assert.equal(Array.isArray(run.terminationEvidence?.attempts), true);
});

test("a live container descendant is killed and can never count as passing", async () => {
  const repo = await repository();
  const unsafe = parseVerificationConfig({
    version: 2,
    runtime: {
      engine: "docker",
      engineExecutable: process.execPath,
      engineArguments: [fakeEngine, "--state-root", fakeStateRoot],
      image: `example.invalid/verifier@sha256:${"b".repeat(64)}`,
      user: "65532:65532",
      pidsLimit: 64,
      memoryBytes: 256 * 1024 * 1024,
      cpus: 1,
      tmpfsSizeBytes: 16 * 1024 * 1024
    },
    profiles: {
      test: {
        recipes: [{
          id: "background",
          program: "__FAKE_BACKGROUND__",
          args: [],
          cwd: ".",
          timeoutMs: 5_000,
          required: true
        }]
      }
    }
  });
  const run = await runVerification({
    taskId: "task",
    worktree: repo,
    profileId: "test",
    config: unsafe,
    ownerInstanceId: "instance"
  });
  assert.equal(run.state, "failed");
  assert.equal(run.results?.[0]?.passed, false);
  const evidence = (run.terminationEvidence?.attempts as Array<Record<string, unknown>>)[0];
  assert.equal(evidence?.provenComplete, true);
  assert.equal(evidence?.requiredIntervention, true);
});

test("parent worker client independently rejects intervention-marked pass evidence", async () => {
  const selected = config("process.exit(0)");
  const binding = await assertOciRuntimeAvailable(selected.runtime);
  const result = await runWorker({
    type: "start",
    runId: "run-parent-check",
    taskId: "task-parent-check",
    workerId: "worker-parent-check",
    sequence: 1,
    at: new Date().toISOString(),
    workspace: process.cwd(),
    runtime: selected.runtime,
    runtimeBinding: binding,
    recipes: selected.profiles.test.recipes,
    containerEnvironment: {},
    maxOutputChars: 10_000
  }, { entry: interventionWorker });
  assert.equal(result.results[0]?.passed, true);
  assert.equal(result.terminationEvidence[0]?.requiredIntervention, true);
  assert.equal(result.passed, false);
});

test("Podman evidence is recorded as OCI with its exact engine identity", async () => {
  const repo = await repository();
  const selected = config("process.exit(0)");
  selected.runtime.engine = "podman";
  const run = await runVerification({
    taskId: "task-podman",
    worktree: repo,
    profileId: "test",
    config: selected,
    ownerInstanceId: "instance"
  });
  assert.equal(run.state, "passed");
  assert.equal(run.backend, "oci");
  assert.equal(run.engine, "podman");
  const evidence = (run.terminationEvidence?.attempts as Array<Record<string, unknown>>)[0];
  assert.equal(evidence?.backend, "oci");
  assert.equal(evidence?.engine, "podman");
});

test("OCI reconciliation observes an exact running container without killing it", async () => {
  const runtime = config("process.exit(0)").runtime;
  const { run, containerId, labels } = await syntheticOciRun(runtime, "running");
  const reconciled = await reconcileVerifierRun(run, [], runtime);
  assert.equal(reconciled.proof.result, "PROVEN_STILL_RUNNING");
  assert.equal(reconciled.run.state, "running");
  assert.equal(reconciled.quarantines.some((entry) => !entry.clearedAt), true);
  assert.equal(await fs.access(path.join(fakeStateRoot, `${containerId}.json`)).then(() => true, () => false), true);
  await fs.writeFile(path.join(fakeStateRoot, `${containerId}.json`), JSON.stringify({
    id: containerId,
    image: runtime.image,
    running: false,
    pid: 0,
    exitCode: 0,
    labels
  }));
  const terminated = await reconcileVerifierRun(reconciled.run, reconciled.quarantines, runtime);
  assert.equal(terminated.proof.result, "PROVEN_TERMINATED");
  assert.equal(terminated.run.state, "failed");
  assert.equal(terminated.quarantines.some((entry) => !entry.clearedAt), false);
});

test("OCI reconciliation removes one exact stopped container and proves termination", async () => {
  const runtime = config("process.exit(0)").runtime;
  const { run, containerId } = await syntheticOciRun(runtime, "stopped");
  const quarantine = createQuarantine({ scope: "task", taskId: run.taskId, runId: run.runId, reason: "restart" });
  const reconciled = await reconcileVerifierRun(run, [quarantine], runtime);
  assert.equal(reconciled.proof.result, "PROVEN_TERMINATED");
  assert.equal(reconciled.quarantines[0]?.clearedByProofId, reconciled.proof.proofId);
  assert.equal(await fs.access(path.join(fakeStateRoot, `${containerId}.json`)).then(() => true, () => false), false);
});

test("OCI reconciliation rejects a label-matched container whose inspected image is different", async () => {
  const runtime = config("process.exit(0)").runtime;
  const { run, containerId, labels } = await syntheticOciRun(runtime, "stopped");
  await fs.writeFile(path.join(fakeStateRoot, `${containerId}.json`), JSON.stringify({
    id: containerId,
    image: `example.invalid/attacker@sha256:${"9".repeat(64)}`,
    running: false,
    pid: 0,
    exitCode: 0,
    labels
  }));
  const reconciled = await reconcileVerifierRun(run, [], runtime);
  assert.equal(reconciled.proof.result, "UNKNOWN");
  assert.equal(await fs.access(path.join(fakeStateRoot, `${containerId}.json`)).then(() => true, () => false), true);
  await fs.unlink(path.join(fakeStateRoot, `${containerId}.json`));
});

test("pre-container OCI reconciliation proves only run-wide absence and never removes an unknown container", async () => {
  const runtime = config("process.exit(0)").runtime;
  const binding = await assertOciRuntimeAvailable(runtime);
  const suffix = createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("hex").slice(0, 12);
  const run: VerifierRunV1 = {
    runId: `run-starting-${suffix}`,
    taskId: `task-starting-${suffix}`,
    profileId: "test",
    recipeIds: ["node"],
    workerId: `worker-starting-${suffix}`,
    ownerInstanceId: "prior-instance",
    leaseId: `lease-starting-${suffix}`,
    backend: "oci",
    engine: runtime.engine,
    assurance: "high",
    containerImageDigest: runtime.image,
    containerEngineNamespaceHash: binding.engineInstanceHash,
    startedAt: new Date(0).toISOString(),
    heartbeatAt: new Date(0).toISOString(),
    leaseExpiresAt: new Date(0).toISOString(),
    beforeSnapshotId: "snapshot",
    state: "lost"
  };
  const absent = await reconcileVerifierRun(run, [], runtime);
  assert.equal(absent.proof.result, "PROVEN_TERMINATED");
  assert.equal(absent.proof.evidence.exactContainerOwnershipRecorded, false);

  const unknownId = createHash("sha256").update(`unknown-${suffix}`).digest("hex");
  const labels = ociOwnershipLabels({
    taskId: run.taskId,
    runId: run.runId,
    workerId: run.workerId,
    recipeId: "node",
    imageDigest: runtime.image,
    engine: runtime.engine,
    engineNamespaceHash: binding.engineInstanceHash
  });
  await fs.writeFile(path.join(fakeStateRoot, `${unknownId}.json`), JSON.stringify({
    id: unknownId,
    image: runtime.image,
    running: false,
    pid: 0,
    exitCode: 0,
    labels
  }));
  const guarded = await reconcileVerifierRun(run, [], runtime);
  assert.equal(guarded.proof.result, "UNKNOWN");
  assert.equal(await fs.access(path.join(fakeStateRoot, `${unknownId}.json`)).then(() => true, () => false), true);
  await fs.unlink(path.join(fakeStateRoot, `${unknownId}.json`));
});

test("OCI absence proof survives image rotation but rejects an unrecorded next-recipe container", async () => {
  const originalRuntime = config("process.exit(0)").runtime;
  const { run } = await syntheticOciRun(originalRuntime, "absent");
  const rotatedRuntime: OciRuntimeConfig = {
    ...originalRuntime,
    image: `example.invalid/verifier@sha256:${"d".repeat(64)}`
  };
  const absent = await reconcileVerifierRun(run, [], rotatedRuntime);
  assert.equal(absent.proof.result, "PROVEN_TERMINATED");

  const nextId = "e".repeat(64);
  const nextLabels = ociOwnershipLabels({
    taskId: run.taskId,
    runId: run.runId,
    workerId: run.workerId,
    recipeId: "next",
    imageDigest: run.containerImageDigest!,
    engine: run.engine!,
    engineNamespaceHash: run.containerEngineNamespaceHash!
  });
  await fs.writeFile(path.join(fakeStateRoot, `${nextId}.json`), JSON.stringify({
    id: nextId,
    image: run.containerImageDigest,
    running: true,
    pid: 4343,
    exitCode: 0,
    labels: nextLabels
  }));
  const guarded = await reconcileVerifierRun(run, [], rotatedRuntime);
  assert.equal(guarded.proof.result, "UNKNOWN");
  await fs.unlink(path.join(fakeStateRoot, `${nextId}.json`));

  const otherNamespace: OciRuntimeConfig = {
    ...rotatedRuntime,
    engineArguments: [fakeEngine, "--state-root", `${fakeStateRoot}-other`]
  };
  const wrongEngineInstance = await reconcileVerifierRun(run, [], otherNamespace);
  assert.equal(wrongEngineInstance.proof.result, "UNKNOWN");
});

test("verification that changes the worktree cannot count as passing evidence", async () => {
  const repo = await repository();
  const run = await runVerification({
    taskId: "task",
    worktree: repo,
    profileId: "test",
    config: config("require('node:fs').writeFileSync('generated.txt', 'changed')"),
    ownerInstanceId: "instance"
  });
  assert.equal(run.results?.[0]?.passed, true);
  assert.equal(run.state, "mutated_workspace");
  assert.notEqual(run.beforeSnapshotId, run.afterSnapshotId);
});

test("unknown reconciliation keeps quarantine; proven termination clears only its run", async () => {
  const run: VerifierRunV1 = {
    runId: "run",
    taskId: "task",
    profileId: "test",
    recipeIds: ["node"],
    workerId: "worker",
    ownerInstanceId: "instance",
    leaseId: "lease",
    backend: "windows-process-tree",
    assurance: "best-effort",
    startedAt: new Date(0).toISOString(),
    heartbeatAt: new Date(0).toISOString(),
    leaseExpiresAt: new Date(0).toISOString(),
    beforeSnapshotId: "snapshot",
    state: "quarantined"
  };
  const own = createQuarantine({ scope: "task", taskId: "task", runId: "run", reason: "lost worker" });
  const other = createQuarantine({ scope: "task", taskId: "other", runId: "other-run", reason: "other" });
  const unknown = await reconcileVerifierRun(run, [own, other]);
  assert.equal(unknown.proof.result, "UNKNOWN");
  assert.equal(unknown.quarantines[0]?.clearedAt, undefined);

  const proof: ReconciliationProof = {
    proofId: "proof",
    runId: "run",
    result: "PROVEN_TERMINATED",
    observedAt: new Date().toISOString(),
    evidence: {}
  };
  const cleared = clearQuarantine(own, proof);
  assert.equal(cleared.clearedByProofId, "proof");
  assert.equal(other.clearedAt, undefined);
});

test("proven-still-running reconciliation creates an exact active quarantine", async () => {
  const run: VerifierRunV1 = {
    runId: "run-alive",
    taskId: "task-alive",
    profileId: "test",
    recipeIds: ["node"],
    workerId: "worker",
    ownerInstanceId: "instance",
    leaseId: "lease",
    backend: "process-group",
    assurance: "standard",
    pid: process.pid,
    processGroupId: process.pid,
    startedAt: new Date(0).toISOString(),
    heartbeatAt: new Date(0).toISOString(),
    leaseExpiresAt: new Date(0).toISOString(),
    beforeSnapshotId: "snapshot",
    state: "running"
  };
  const reconciled = await reconcileVerifierRun(run, []);
  assert.equal(reconciled.proof.result, "PROVEN_STILL_RUNNING");
  assert.equal(reconciled.run.state, "running");
  assert.equal(reconciled.quarantines.length, 1);
  assert.equal(reconciled.quarantines[0]?.taskId, run.taskId);
  assert.equal(reconciled.quarantines[0]?.runId, run.runId);
  assert.equal(reconciled.quarantines[0]?.clearedAt, undefined);
});
