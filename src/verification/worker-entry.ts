import { createInterface } from "node:readline";
import { redactAndTruncate, redactText } from "../core/redaction.js";
import {
  finalizeOwnedExecution,
  ociLabelsHash,
  startOwnedExecution,
  terminateOwnedExecution,
  type OwnedExecution
} from "./execution-backend.js";
import { isWorkerStartMessage, type WorkerEvent, type WorkerStartMessage } from "./worker-protocol.js";

let sequence = 0;
let activeOwned: OwnedExecution | undefined;
let activeStart: WorkerStartMessage | undefined;
let shuttingDown = false;

function emit(start: WorkerStartMessage, event: Omit<WorkerEvent, "runId" | "workerId" | "sequence" | "at">): void {
  sequence += 1;
  const message: WorkerEvent = {
    ...event,
    runId: start.runId,
    workerId: start.workerId,
    sequence,
    at: new Date().toISOString()
  };
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function execute(start: WorkerStartMessage): Promise<void> {
  let allRequiredPassed = true;
  let anyRecipePassed = false;
  let outputChars = 0;
  for (const recipe of start.recipes) {
    const started = Date.now();
    const owned = await startOwnedExecution(recipe, {
      runtime: start.runtime,
      runtimeBinding: start.runtimeBinding,
      workspace: start.workspace,
      taskId: start.taskId,
      runId: start.runId,
      workerId: start.workerId,
      containerEnvironment: start.containerEnvironment
    });
    activeOwned = owned;
    activeStart = start;
    emit(start, {
      type: "recipe_started",
      recipeId: recipe.id,
      execution: {
        backend: owned.backend,
        engine: owned.engine,
        assurance: owned.assurance,
        containerId: owned.containerId,
        containerIdHash: owned.containerIdHash,
        containerLabelsHash: ociLabelsHash(owned.labels),
        containerEngineNamespaceHash: owned.engineInstanceHash
      }
    });
    let timedOut = false;
    let outputTruncated = false;
    let terminationEvidence: Record<string, unknown> | undefined;
    let terminationPromise: Promise<void> | undefined;
    const heartbeat = setInterval(() => emit(start, { type: "heartbeat", recipeId: recipe.id }), 5_000);
    heartbeat.unref();
    const rawLimit = Math.max(start.maxOutputChars * 2, 16_384);
    let stdoutRaw = "";
    let stderrRaw = "";
    const capture = (stream: "stdout" | "stderr", chunk: string) => {
      const previous = stream === "stdout" ? stdoutRaw : stderrRaw;
      if (previous.length >= rawLimit) {
        outputTruncated = true;
        return;
      }
      const combined = previous + chunk;
      if (combined.length > rawLimit) outputTruncated = true;
      if (stream === "stdout") stdoutRaw = combined.slice(0, rawLimit);
      else stderrRaw = combined.slice(0, rawLimit);
    };
    owned.child.stdout.setEncoding("utf8");
    owned.child.stderr.setEncoding("utf8");
    owned.child.stdout.on("data", (chunk: string) => capture("stdout", chunk));
    owned.child.stderr.on("data", (chunk: string) => capture("stderr", chunk));
    const timeout = setTimeout(() => {
      timedOut = true;
      emit(start, { type: "termination_started", recipeId: recipe.id });
      terminationPromise = terminateOwnedExecution(owned)
        .then((evidence) => {
          terminationEvidence = evidence as unknown as Record<string, unknown>;
          emit(start, { type: "termination_completed", recipeId: recipe.id, terminationEvidence });
        })
        .catch((error) => {
          terminationEvidence = { provenComplete: false, error: redactText((error as Error).message) };
          emit(start, { type: "termination_completed", recipeId: recipe.id, terminationEvidence });
        });
    }, recipe.timeoutMs);
    timeout.unref();
    const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      owned.child.once("error", reject);
      owned.child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
    }).catch((error) => ({ exitCode: null, signal: null, error })) as {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      error?: unknown;
    };
    clearTimeout(timeout);
    clearInterval(heartbeat);
    await terminationPromise;
    if (!terminationPromise) {
      try {
        const evidence = await finalizeOwnedExecution(owned);
        terminationEvidence = evidence as unknown as Record<string, unknown>;
        emit(start, { type: "termination_completed", recipeId: recipe.id, terminationEvidence });
      } catch (error) {
        terminationEvidence = { provenComplete: false, error: redactText((error as Error).message) };
        emit(start, { type: "termination_completed", recipeId: recipe.id, terminationEvidence });
      }
    }
    activeOwned = undefined;
    activeStart = undefined;

    const forwardCaptured = (type: "stdout_chunk" | "stderr_chunk", raw: string) => {
      const remaining = Math.max(0, start.maxOutputChars - outputChars);
      const safe = redactAndTruncate(raw, remaining);
      outputTruncated ||= safe.truncated || (remaining === 0 && raw.length > 0);
      for (let offset = 0; offset < safe.text.length; offset += 16_384) {
        const chunk = safe.text.slice(offset, offset + 16_384);
        outputChars += chunk.length;
        emit(start, { type, recipeId: recipe.id, chunk });
      }
    };
    forwardCaptured("stdout_chunk", stdoutRaw);
    forwardCaptured("stderr_chunk", stderrRaw);
    const terminationProven = terminationEvidence?.provenComplete === true;
    const requiredIntervention = terminationEvidence?.requiredIntervention === true;
    const containerExitCode = typeof terminationEvidence?.containerExitCode === "number"
      ? terminationEvidence.containerExitCode
      : result.exitCode;
    const passed =
      !timedOut &&
      result.exitCode === 0 &&
      containerExitCode === 0 &&
      !result.error &&
      terminationProven &&
      !requiredIntervention;
    if (passed) anyRecipePassed = true;
    if (recipe.required && !passed) allRequiredPassed = false;
    emit(start, {
      type: "recipe_completed",
      recipeId: recipe.id,
      exitCode: containerExitCode,
      signal: result.signal,
      timedOut,
      durationMs: Date.now() - started,
      passed,
      truncated: outputTruncated,
      ...(terminationEvidence ? { terminationEvidence } : {}),
      ...(result.error ? { error: redactText(String((result.error as Error).message ?? result.error)) } : {})
    });
  }
  emit(start, { type: "verification_completed", passed: allRequiredPassed && anyRecipePassed });
}

process.on("SIGTERM", () => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!activeOwned) {
    process.exit(143);
    return;
  }
  const start = activeStart;
  if (start) emit(start, { type: "termination_started" });
  void terminateOwnedExecution(activeOwned)
    .then((evidence) => {
      if (start) {
        emit(start, {
          type: "termination_completed",
          terminationEvidence: evidence as unknown as Record<string, unknown>
        });
      }
      process.exit(evidence.provenComplete ? 143 : 2);
    })
    .catch(() => process.exit(2));
});

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let received = false;
lines.on("line", (line) => {
  if (received) return;
  received = true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    process.stderr.write("invalid verifier worker JSON\n");
    process.exitCode = 2;
    return;
  }
  if (!isWorkerStartMessage(parsed)) {
    process.stderr.write("invalid verifier worker start message\n");
    process.exitCode = 2;
    return;
  }
  void execute(parsed).catch((error) => {
    emit(parsed, { type: "fatal_error", error: redactText((error as Error).message) });
    process.exitCode = 1;
  });
});
