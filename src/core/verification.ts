import { createHash, randomUUID } from "node:crypto";
import type { VerifierRunV1 } from "../types.js";
import { runWorker } from "../verification/worker-client.js";
import type { WorkerEvent, WorkerStartMessage } from "../verification/worker-protocol.js";
import {
  assertOciRuntimeAvailable,
  type OciRuntimeBinding
} from "../verification/execution-backend.js";
import { canonicalJson } from "./contracts.js";
import { SupervisorError } from "./errors.js";
import { redactText } from "./redaction.js";
import { captureWorkspaceSnapshot, sameWorkspaceSnapshot } from "./snapshot.js";
import {
  selectVerificationRecipes,
  type VerificationConfig
} from "./verification-config.js";

export interface RunVerificationOptions {
  taskId: string;
  worktree: string;
  baseSha?: string;
  profileId: string;
  config: VerificationConfig;
  recipeIds?: string[];
  ownerInstanceId: string;
  maxOutputChars?: number;
  leaseTtlMs?: number;
  workerEntry?: string;
  /** Trusted in-process callers may reuse an immediately preceding exact runtime probe. */
  runtimeBinding?: OciRuntimeBinding;
  containerEnvironment?: Record<string, string>;
  onRunUpdate?: (run: VerifierRunV1) => void | Promise<void>;
  onWorkerEvent?: (event: WorkerEvent) => void;
}

function evidenceRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Accept durable OCI termination evidence only when every selected recipe has
 * one identity-bound, positively completed container record.
 */
export function hasCompleteOciTerminationEvidence(run: VerifierRunV1): boolean {
  if (
    run.backend !== "oci" ||
    run.engine === undefined ||
    run.assurance !== "high" ||
    !run.containerImageDigest ||
    !run.containerEngineNamespaceHash ||
    !run.containerOwnershipRecordedAt
  ) {
    return false;
  }
  const attempts = Array.isArray(run.terminationEvidence?.attempts)
    ? run.terminationEvidence.attempts
    : [];
  if (attempts.length !== run.recipeIds.length || attempts.length === 0) return false;
  const recipeIds = new Set<string>();
  for (const value of attempts) {
    const attempt = evidenceRecord(value);
    if (
      !attempt ||
      typeof attempt.recipeId !== "string" ||
      !run.recipeIds.includes(attempt.recipeId) ||
      recipeIds.has(attempt.recipeId) ||
      attempt.backend !== "oci" ||
      attempt.engine !== run.engine ||
      attempt.assurance !== "high" ||
      attempt.containerImageDigest !== run.containerImageDigest ||
      attempt.containerEngineNamespaceHash !== run.containerEngineNamespaceHash ||
      typeof attempt.containerIdHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(attempt.containerIdHash) ||
      typeof attempt.containerLabelsHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(attempt.containerLabelsHash) ||
      attempt.ownershipVerified !== true ||
      attempt.provenComplete !== true
    ) {
      return false;
    }
    recipeIds.add(attempt.recipeId);
  }
  return recipeIds.size === run.recipeIds.length;
}

/** Return true only for a current snapshot-bound OCI pass with clean shutdown proof. */
export function isTrustedPassingVerifierRun(run: VerifierRunV1, snapshotId: string): boolean {
  if (
    run.state !== "passed" ||
    run.stale ||
    (run.afterSnapshotId ?? run.beforeSnapshotId) !== snapshotId ||
    !hasCompleteOciTerminationEvidence(run)
  ) {
    return false;
  }
  const attempts = run.terminationEvidence!.attempts as Array<Record<string, unknown>>;
  return attempts.every((attempt) => attempt.requiredIntervention !== true);
}

function cloneRun(run: VerifierRunV1): VerifierRunV1 {
  return JSON.parse(JSON.stringify(run)) as VerifierRunV1;
}

export function resolveContainerEnvironment(names: string[]): Record<string, string> {
  const environment = Object.create(null) as Record<string, string>;
  for (const name of names) {
    const value = process.env[name];
    if (value === undefined) continue;
    if (value.length > 8_192) {
      throw new SupervisorError(
        "VERIFICATION_CONFIG_INVALID",
        `Verification environment value is too large: ${name}`,
        500
      );
    }
    environment[name] = value;
  }
  return environment;
}

/**
 * Execute an allowlisted profile in an independent worker and bind the result to
 * deterministic before/after workspace snapshots.
 */
export async function runVerification(options: RunVerificationOptions): Promise<VerifierRunV1> {
  const recipes = selectVerificationRecipes(options.config, options.profileId, options.recipeIds);
  // This probe happens before any run/lease is created. Missing Docker/Podman,
  // an unavailable daemon, or an absent digest image is a hard runtime error;
  // host-process execution is never a fallback.
  const runtimeBinding = options.runtimeBinding ?? await assertOciRuntimeAvailable(options.config.runtime);
  if (
    runtimeBinding.engine !== options.config.runtime.engine ||
    runtimeBinding.image !== options.config.runtime.image
  ) {
    throw new Error("OCI runtime binding does not match verification configuration");
  }
  const before = await captureWorkspaceSnapshot(options.worktree, options.baseSha ?? "HEAD");
  const startedAt = new Date();
  const ttlMs = options.leaseTtlMs ?? 20_000;
  const run: VerifierRunV1 = {
    runId: randomUUID(),
    taskId: options.taskId,
    profileId: options.profileId,
    recipeIds: recipes.map((recipe) => recipe.id),
    workerId: randomUUID(),
    ownerInstanceId: options.ownerInstanceId,
    leaseId: randomUUID(),
    backend: "oci",
    engine: options.config.runtime.engine,
    assurance: "high",
    containerImageDigest: options.config.runtime.image,
    containerEngineNamespaceHash: runtimeBinding.engineInstanceHash,
    startedAt: startedAt.toISOString(),
    heartbeatAt: startedAt.toISOString(),
    leaseExpiresAt: new Date(startedAt.getTime() + ttlMs).toISOString(),
    beforeSnapshotId: before.snapshotId,
    state: "starting"
  };
  let updateChain: Promise<void> = Promise.resolve();
  let updateFailure: unknown;
  const update = (): Promise<void> => {
    if (!options.onRunUpdate) return Promise.resolve();
    const snapshot = cloneRun(run);
    const operation = updateChain.then(() => options.onRunUpdate!(snapshot)).then(() => undefined);
    updateChain = operation.catch((error) => {
      updateFailure ??= error;
    });
    return operation;
  };
  // The starting run and lease identity must be durable before a worker exists.
  await update();
  const start: WorkerStartMessage = {
    type: "start",
    runId: run.runId,
    taskId: run.taskId,
    workerId: run.workerId,
    sequence: 1,
    at: startedAt.toISOString(),
    workspace: options.worktree,
    runtime: options.config.runtime,
    runtimeBinding,
    recipes,
    containerEnvironment: options.containerEnvironment ?? resolveContainerEnvironment(options.config.environmentAllowlist),
    maxOutputChars: options.maxOutputChars ?? 50_000
  };
  try {
    const result = await runWorker(start, {
      ...(options.workerEntry ? { entry: options.workerEntry } : {}),
      onStarted: async (pid) => {
        run.pid = pid;
        if (process.platform === "win32") run.windowsTreeRootPid = pid;
        run.state = "running";
        // Persist the exact worker PID before giving the worker its start message.
        await update();
      },
      onEvent: (event) => {
        options.onWorkerEvent?.(event);
        if (event.type === "recipe_started" && event.execution) {
          run.backend = event.execution.backend;
          run.assurance = event.execution.assurance;
          run.containerId = event.execution.containerId;
          run.containerIdHash = event.execution.containerIdHash;
          run.engine = event.execution.engine;
          run.containerRecipeId = event.recipeId;
          run.containerLabelsHash = event.execution.containerLabelsHash;
          run.containerEngineNamespaceHash = event.execution.containerEngineNamespaceHash;
          run.containerOwnershipRecordedAt = event.at;
        }
        if (event.type === "heartbeat" || event.type === "recipe_started" || event.type === "recipe_completed") {
          const at = new Date(event.at);
          run.heartbeatAt = at.toISOString();
          run.leaseExpiresAt = new Date(at.getTime() + ttlMs).toISOString();
          update();
        }
      }
    });
    run.results = result.results;
    run.exitCode = result.passed ? 0 : result.results.find((recipe) => !recipe.passed)?.exitCode ?? 1;
    if (result.terminationEvidence.length) {
      run.terminationEvidence = { attempts: result.terminationEvidence };
    }
    const after = await captureWorkspaceSnapshot(options.worktree, options.baseSha ?? "HEAD");
    run.afterSnapshotId = after.snapshotId;
    run.completedAt = new Date().toISOString();
    run.heartbeatAt = run.completedAt;
    run.leaseExpiresAt = run.completedAt;
    const terminationUnproven = result.terminationEvidence.some(
      (evidence) => evidence.provenComplete !== true
    );
    if (terminationUnproven) {
      run.state = "lost";
    } else if (!sameWorkspaceSnapshot(before, after)) {
      run.state = "mutated_workspace";
    } else if (result.results.some((recipe) => recipe.timedOut)) {
      run.state = "timed_out";
    } else {
      run.state = result.passed ? "passed" : "failed";
    }
    run.logDigest = createHash("sha256")
      .update(canonicalJson(result.results.map((recipe) => ({
        recipeId: recipe.recipeId,
        required: recipe.required,
        exitCode: recipe.exitCode,
        signal: recipe.signal,
        timedOut: recipe.timedOut,
        stdout: recipe.stdout,
        stderr: recipe.stderr
      }))))
      .digest("hex");
  } catch (error) {
    run.state = "lost";
    run.completedAt = new Date().toISOString();
    run.leaseExpiresAt = run.completedAt;
    run.terminationEvidence = {
      provenComplete: false,
      error: redactText(error instanceof Error ? error.message : String(error))
    };
  }
  update();
  await updateChain;
  if (updateFailure) throw updateFailure;
  return cloneRun(run);
}
