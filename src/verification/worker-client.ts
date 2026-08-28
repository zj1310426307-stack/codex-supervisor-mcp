import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { VerificationRecipeResult } from "../types.js";
import { redactAndTruncate, redactText } from "../core/redaction.js";
import { ociLabelsHash, ociOwnershipLabels } from "./execution-backend.js";
import type { WorkerEvent, WorkerStartMessage } from "./worker-protocol.js";

export interface WorkerClientOptions {
  entry?: string;
  onEvent?: (event: WorkerEvent) => void;
  onStarted?: (pid: number) => void | Promise<void>;
}

export interface WorkerClientResult {
  workerPid: number;
  passed: boolean;
  results: VerificationRecipeResult[];
  stderr: string;
  terminationEvidence: Record<string, unknown>[];
}

function workerEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "ComSpec",
    "TMP",
    "TEMP",
    "HOME",
    "USERPROFILE",
    "LANG"
  ]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

async function resolveWorkerCommand(entry?: string): Promise<{ program: string; args: string[] }> {
  if (entry) return { program: process.execPath, args: [path.resolve(entry)] };
  const js = fileURLToPath(new URL("./worker-entry.js", import.meta.url));
  if (await fs.access(js).then(() => true, () => false)) return { program: process.execPath, args: [js] };
  const ts = fileURLToPath(new URL("./worker-entry.ts", import.meta.url));
  return { program: process.execPath, args: ["--import", "tsx", ts] };
}

/** Start and validate the bounded line-delimited verifier worker protocol. */
export async function runWorker(
  start: WorkerStartMessage,
  options: WorkerClientOptions = {}
): Promise<WorkerClientResult> {
  const timeoutTotal = start.recipes.reduce((sum, recipe) => sum + recipe.timeoutMs, 0);
  if (!Number.isSafeInteger(timeoutTotal) || timeoutTotal > 2_147_000_000 - 30_000) {
    throw new Error("Verifier overall timeout exceeds the supported timer range");
  }
  const command = await resolveWorkerCommand(options.entry);
  const child = spawn(command.program, command.args, {
    env: workerEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true
  });
  if (!child.pid) throw new Error("Verifier worker did not produce a process id");
  const workerPid = child.pid;
  const started = new Map<string, { at: string; containerIdHash: string; containerLabelsHash: string }>();
  const stdout = new Map<string, string>();
  const stderrByRecipe = new Map<string, string>();
  const results: VerificationRecipeResult[] = [];
  const terminationEvidence: Record<string, unknown>[] = [];
  let expectedSequence = 1;
  let completed: WorkerEvent | undefined;
  let protocolFailure: Error | undefined;
  let workerStderr = "";
  type Exit = { code: number | null; signal: NodeJS.Signals | null };
  let settled = false;
  let settleExit!: (exit: Exit) => void;
  const exitPromise = new Promise<Exit>((resolve) => {
    settleExit = resolve;
  });
  let forceStopTimer: NodeJS.Timeout | undefined;
  let abandonTimer: NodeJS.Timeout | undefined;
  const settle = (exit: Exit) => {
    if (settled) return;
    settled = true;
    if (forceStopTimer) clearTimeout(forceStopTimer);
    if (abandonTimer) clearTimeout(abandonTimer);
    settleExit(exit);
  };
  const requestStop = (reason: string) => {
    child.kill("SIGTERM");
    forceStopTimer ??= setTimeout(() => child.kill("SIGKILL"), 2_000);
    abandonTimer ??= setTimeout(() => {
      protocolFailure ??= new Error(`Verifier worker did not stop after ${reason}`);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      settle({ code: null, signal: null });
    }, 5_000);
  };
  child.once("exit", (code, signal) => settle({ code, signal }));
  child.once("error", (error) => {
    protocolFailure = error;
    settle({ code: null, signal: null });
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (protocolFailure) return;
    let event: WorkerEvent;
    try {
      event = JSON.parse(line) as WorkerEvent;
    } catch {
      protocolFailure = new Error("Verifier worker emitted invalid JSON");
      requestStop("a protocol failure");
      return;
    }
    if (event.runId !== start.runId || event.workerId !== start.workerId || event.sequence !== expectedSequence) {
      protocolFailure = new Error("Verifier worker identity or sequence mismatch");
      requestStop("an identity or sequence mismatch");
      return;
    }
    expectedSequence += 1;
    if (event.type === "recipe_started") {
      const containerId = event.execution?.containerId;
      const containerIdHash = event.execution?.containerIdHash;
      const expectedHash = typeof containerId === "string"
        ? createHash("sha256").update(containerId, "utf8").digest("hex")
        : undefined;
      const expectedLabelsHash = event.recipeId
        ? ociLabelsHash(ociOwnershipLabels({
            taskId: start.taskId,
            runId: start.runId,
            workerId: start.workerId,
            recipeId: event.recipeId,
            imageDigest: start.runtime.image,
            engine: start.runtime.engine,
            engineNamespaceHash: start.runtimeBinding.engineInstanceHash
          }))
        : undefined;
      if (
        !event.recipeId ||
        !start.recipes.some((recipe) => recipe.id === event.recipeId) ||
        started.has(event.recipeId) ||
        event.execution?.backend !== "oci" ||
        event.execution.engine !== start.runtime.engine ||
        event.execution.assurance !== "high" ||
        typeof containerId !== "string" ||
        !/^[a-f0-9]{64}$/.test(containerId) ||
        containerIdHash !== expectedHash ||
        event.execution.containerLabelsHash !== expectedLabelsHash ||
        event.execution.containerEngineNamespaceHash !== start.runtimeBinding.engineInstanceHash
      ) {
        protocolFailure = new Error("Verifier worker emitted invalid exact OCI ownership evidence");
        requestStop("invalid OCI ownership evidence");
        return;
      }
    }
    try {
      options.onEvent?.(event);
    } catch (error) {
      protocolFailure = error instanceof Error ? error : new Error(String(error));
      requestStop("an event callback failure");
      return;
    }
    if (event.type === "recipe_started" && event.recipeId && event.execution) {
      started.set(event.recipeId, {
        at: event.at,
        containerIdHash: event.execution.containerIdHash,
        containerLabelsHash: event.execution.containerLabelsHash
      });
    }
    if (event.type === "stdout_chunk" && event.recipeId) {
      const prior = stdout.get(event.recipeId) ?? "";
      stdout.set(event.recipeId, redactAndTruncate(prior + (event.chunk ?? ""), start.maxOutputChars).text);
    }
    if (event.type === "stderr_chunk" && event.recipeId) {
      const prior = stderrByRecipe.get(event.recipeId) ?? "";
      stderrByRecipe.set(event.recipeId, redactAndTruncate(prior + (event.chunk ?? ""), start.maxOutputChars).text);
    }
    if (event.type === "termination_completed" && event.terminationEvidence) {
      const ownership = event.recipeId ? started.get(event.recipeId) : undefined;
      const evidence = event.terminationEvidence;
      if (
        !event.recipeId ||
        !ownership ||
        terminationEvidence.some((candidate) => candidate.recipeId === event.recipeId) ||
        evidence.backend !== "oci" ||
        evidence.engine !== start.runtime.engine ||
        evidence.assurance !== "high" ||
        evidence.ownershipVerified !== true ||
        evidence.containerIdHash !== ownership.containerIdHash ||
        evidence.containerLabelsHash !== ownership.containerLabelsHash ||
        evidence.containerImageDigest !== start.runtime.image ||
        evidence.containerEngineNamespaceHash !== start.runtimeBinding.engineInstanceHash
      ) {
        protocolFailure = new Error("Verifier worker emitted unbound OCI termination evidence");
        requestStop("unbound OCI termination evidence");
        return;
      }
      terminationEvidence.push({ ...evidence, recipeId: event.recipeId });
    }
    if (event.type === "recipe_completed" && event.recipeId) {
      const recipe = start.recipes.find((candidate) => candidate.id === event.recipeId);
      if (
        !recipe ||
        !started.has(event.recipeId) ||
        results.some((result) => result.recipeId === event.recipeId) ||
        !terminationEvidence.some((evidence) => evidence.recipeId === event.recipeId)
      ) {
        protocolFailure = new Error(`Verifier worker emitted an unbound or duplicate recipe result: ${event.recipeId}`);
        requestStop("an invalid recipe result");
        return;
      }
      results.push({
        recipeId: event.recipeId,
        required: recipe.required,
        startedAt: started.get(event.recipeId)?.at ?? event.at,
        completedAt: event.at,
        durationMs: event.durationMs ?? 0,
        exitCode: event.exitCode ?? null,
        signal: event.signal ?? null,
        stdout: stdout.get(event.recipeId) ?? "",
        stderr: `${stderrByRecipe.get(event.recipeId) ?? ""}${event.error ? `\n${event.error}` : ""}`.trim(),
        truncated:
          event.truncated === true ||
          (stdout.get(event.recipeId) ?? "").includes("... [truncated]") ||
          (stderrByRecipe.get(event.recipeId) ?? "").includes("... [truncated]"),
        timedOut: event.timedOut === true,
        passed: event.passed === true
      });
    }
    if (event.type === "fatal_error") {
      protocolFailure = new Error(event.error ?? "Verifier worker fatal error");
      requestStop("a fatal worker error");
    }
    if (event.type === "verification_completed") {
      if (completed) {
        protocolFailure = new Error("Verifier worker emitted duplicate completion evidence");
        requestStop("duplicate completion evidence");
        return;
      }
      completed = event;
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    workerStderr = redactAndTruncate(workerStderr + chunk.toString("utf8"), start.maxOutputChars).text;
  });

  try {
    await options.onStarted?.(workerPid);
  } catch (error) {
    requestStop("a durable ownership failure");
    await exitPromise;
    throw error;
  }
  child.stdin.end(`${JSON.stringify(start)}\n`);

  const overallTimeout = timeoutTotal + 30_000;
  const timer = setTimeout(() => requestStop("the overall verification deadline"), overallTimeout);
  const exit = await exitPromise;
  clearTimeout(timer);
  if (protocolFailure) throw protocolFailure;
  if (!completed) {
    throw new Error(
      `Verifier worker exited before completion (code=${exit.code}, signal=${exit.signal}, stderr=${redactText(workerStderr)})`
    );
  }
  if (results.length !== start.recipes.length) throw new Error("Verifier worker omitted recipe results");
  if (
    terminationEvidence.length !== start.recipes.length ||
    terminationEvidence.some((evidence) => evidence.provenComplete !== true)
  ) {
    throw new Error("Verifier worker omitted exact OCI termination proof");
  }
  return {
    workerPid,
    passed:
      completed.passed === true &&
      terminationEvidence.every((evidence) => evidence.requiredIntervention !== true) &&
      results.some((result) => result.passed) &&
      results.filter((result) => result.required).every((result) => result.passed),
    results,
    stderr: workerStderr,
    terminationEvidence
  };
}
