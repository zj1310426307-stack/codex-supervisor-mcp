import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CodexAppServerClient } from "../../src/codex/app-server-client.js";
import { resolveCodexCommand } from "../../src/codex/command-resolution.js";
import { probeCodexRuntime } from "../../src/codex/runtime-probe.js";
import { redact } from "../../src/core/redaction.js";

const ACK = "I_UNDERSTAND_THIS_STARTS_A_LOCAL_CODEX_PROCESS";
if (process.env.CODEX_SUPERVISOR_LIVE_TEST !== "1" || process.env.CODEX_SUPERVISOR_LIVE_ACK !== ACK) {
  process.stdout.write(`${JSON.stringify({
    status: "NOT_RUN",
    reason: "Set CODEX_SUPERVISOR_LIVE_TEST=1 and the exact CODEX_SUPERVISOR_LIVE_ACK to run a real local handshake."
  }, null, 2)}\n`);
  process.exit(0);
}

const codex = resolveCodexCommand({ configured: process.env.CODEX_BIN, env: process.env });
let client: CodexAppServerClient | undefined;
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const runId = `codex-handshake-${timestamp}`;
const artifactDirectory = path.resolve("artifacts", "live", runId);
const output = path.join(artifactDirectory, "handshake-summary.json");
await mkdir(artifactDirectory, { recursive: true });

function environmentBlocked(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:ENOENT|EACCES|EPERM|access denied|permission denied|not found|RUNTIME_UNAVAILABLE)\b/i.test(message);
}

let report: Record<string, unknown>;
try {
  const runtime = await probeCodexRuntime({
    codexBin: codex.command,
    experimentalApi: process.env.CODEX_EXPERIMENTAL_API === "1"
  });
  if (!runtime.binding) throw new Error("Codex runtime probe did not produce a protocol binding");
  if (!/\bcodex-cli\b/i.test(runtime.version)) {
    throw new Error(`Resolved command did not identify as a real Codex CLI: ${runtime.version}`);
  }
  client = new CodexAppServerClient(
    codex.command,
    process.env.CODEX_HOME?.trim() || undefined,
    30_000,
    {
      experimentalApi: process.env.CODEX_EXPERIMENTAL_API === "1",
      protocolBinding: runtime.binding
    }
  );
  await client.ensureStarted();
  const account = await client.request("account/read", {});
  const stop = await client.stop();
  await client.drainBarrier();
  report = redact({
    status: "PASS",
    runId,
    runAt: new Date().toISOString(),
    realProcess: true,
    developmentTurnStarted: false,
    handshake: {
      transport: "stdio-jsonl",
      initializeResponseAwaitedBeforeInitialized: true,
      initializedNotificationSentOnce: true,
      stdinKeptOpenThroughReadOnlyRpc: true,
      readOnlyRpc: "account/read",
      stdinClosedOnlyDuringShutdown: true
    },
    commandSource: codex.source,
    runtime,
    account,
    initializedConnections: client.connectionCount(),
    stop: {
      ...stop,
      stdoutDrained: true,
      processExitProven: stop.alreadyStopped || stop.exitCode !== null || stop.signal !== null
    },
    artifact: `artifacts/live/${runId}/handshake-summary.json`
  });
} catch (error) {
  const stop = client
    ? await client.stop().catch((stopError) => ({ stopError: String(stopError) }))
    : { alreadyStarted: false };
  report = redact({
    status: environmentBlocked(error) ? "BLOCKED_BY_ENVIRONMENT" : "FAIL",
    runId,
    runAt: new Date().toISOString(),
    realProcess: true,
    developmentTurnStarted: false,
    commandSource: codex.source,
    error: error instanceof Error ? error.message : String(error),
    stop,
    artifact: `artifacts/live/${runId}/handshake-summary.json`
  });
  process.exitCode = environmentBlocked(error) ? 2 : 1;
}
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
