import { randomUUID } from "node:crypto";
import type { TaskRecord, TaskStatus, TaskStatusTransition } from "../types.js";
import { SupervisorError } from "./errors.js";
import { isTrustedPassingVerifierRun } from "./verification.js";

const ACTIVE_TURN_STATUSES = new Set(["starting", "in_progress"]);
const TERMINAL_TASK_STATUSES = new Set<TaskStatus>([
  "ready_for_human_review",
  "blocked",
  "failed",
  "interrupted",
  "cancelled"
]);

const TRANSITIONS: Readonly<Record<string, ReadonlySet<TaskStatus>>> = {
  planned: new Set(["preparing", "blocked", "failed", "cancelled"]),
  preparing: new Set(["running", "blocked", "failed", "cancelled", "stale"]),
  running: new Set([
    "waiting_approval",
    "awaiting_verification",
    "blocked",
    "failed",
    "interrupted",
    "cancelled",
    "stale"
  ]),
  waiting_approval: new Set(["running", "blocked", "interrupted", "cancelled", "stale"]),
  awaiting_verification: new Set([
    "verifying",
    "needs_correction",
    "ready_for_human_review",
    "blocked",
    "cancelled",
    "stale"
  ]),
  verifying: new Set(["awaiting_verification", "needs_correction", "blocked", "failed", "cancelled", "stale"]),
  needs_correction: new Set(["running", "verifying", "ready_for_human_review", "blocked", "cancelled", "stale"]),
  stale: new Set(["blocked", "preparing", "awaiting_verification", "cancelled"]),
  interrupted: new Set(["running", "cancelled", "blocked"]),
  failed: new Set(["running", "blocked", "cancelled"]),
  legacy_unverified: new Set(["awaiting_verification", "blocked", "cancelled"]),
  blocked: new Set(["awaiting_verification"])
};

export interface TransitionContext {
  reason: string;
  source: string;
  at?: string;
  turnId?: string;
  verificationRunId?: string;
  decisionId?: string;
}

function pathMatchesPrefix(file: string, prefix: string): boolean {
  const normalizedFile = file.replace(/\\/g, "/").replace(/^\.\//, "");
  const normalizedPrefix = prefix.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  return normalizedPrefix === "." || normalizedFile === normalizedPrefix || normalizedFile.startsWith(`${normalizedPrefix}/`);
}

export interface ContractPathViolations {
  forbidden: string[];
  outsideAllowed: string[];
}

/** Evaluate forbidden-first, path-segment-aware Development Contract scope. */
export function contractPathViolations(task: TaskRecord, snapshot = task.snapshots?.at(-1)): ContractPathViolations {
  const files = [...new Set(snapshot?.changedFiles ?? [])];
  const forbiddenPrefixes = task.contract?.forbiddenChangePaths ?? [];
  const allowedPrefixes = task.contract?.allowedChangePaths;
  const forbidden = files.filter((file) => forbiddenPrefixes.some((prefix) => pathMatchesPrefix(file, prefix)));
  const outsideAllowed = allowedPrefixes === undefined
    ? []
    : files.filter((file) => !allowedPrefixes.some((prefix) => pathMatchesPrefix(file, prefix)));
  return { forbidden, outsideAllowed };
}

/** Return true only for an explicitly declared state transition. Unknown states fail closed. */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from]?.has(to) ?? false;
}

/** Whether the task has a locally owned turn that can still write to its worktree. */
export function hasActiveWriter(task: TaskRecord): boolean {
  const leaseMayStillWrite = ["active", "suspect", "interrupting"].includes(task.turnLease?.state ?? "");
  const turnMayStillWrite =
    Boolean(task.activeTurnId ?? task.turnId) && ACTIVE_TURN_STATUSES.has(task.turnStatus ?? "none");
  return leaseMayStillWrite || turnMayStillWrite;
}

/** Cleanup is allowed only after terminal resolution and with no active writer or verifier. */
export function isCleanupEligible(task: TaskRecord): boolean {
  if (!TERMINAL_TASK_STATUSES.has(task.status) || hasActiveWriter(task)) return false;
  if (task.pendingTurnStart) return false;
  if (task.pendingApprovalIds.length > 0) return false;
  if (task.turnLease && task.turnLease.state !== "terminal") return false;
  if (task.legacyUnreconciledVerifier || (task.quarantines ?? []).some((entry) => !entry.clearedAt)) return false;
  if ((task.verifierLeases ?? []).some((lease) => lease.state !== "terminal")) return false;
  return !(task.verificationRuns ?? []).some((run) =>
    ["starting", "running", "terminating", "lost", "quarantined"].includes(run.state)
  );
}

function currentSnapshotIsVerified(task: TaskRecord): boolean {
  if (task.legacyUnreconciledVerifier || (task.quarantines ?? []).some((entry) => !entry.clearedAt)) return false;
  if ((task.verifierLeases ?? []).some((lease) => lease.state !== "terminal")) return false;
  if ((task.verificationRuns ?? []).some((run) =>
    ["starting", "running", "terminating", "lost", "quarantined"].includes(run.state)
  )) return false;
  const snapshotId = task.snapshots?.at(-1)?.snapshotId;
  if (!snapshotId) return false;
  const pathViolations = contractPathViolations(task);
  if (pathViolations.forbidden.length > 0 || pathViolations.outsideAllowed.length > 0) return false;
  const required = new Set(task.contract?.requiredVerificationRecipes ?? []);
  const matching = (task.verificationRuns ?? []).filter(
    (run) => isTrustedPassingVerifierRun(run, snapshotId)
  );
  if (matching.length === 0) return false;
  const passed = new Set(
    matching.flatMap((run) => {
      const selected = new Set(run.recipeIds);
      return (run.results ?? [])
        .filter(
          (result) =>
            selected.has(result.recipeId) &&
            result.passed === true &&
            result.timedOut !== true &&
            result.exitCode === 0
        )
        .map((result) => result.recipeId);
    })
  );
  if (passed.size === 0) return false;
  if (![...required].every((recipeId) => passed.has(recipeId))) return false;
  const runIds = new Set(matching.map((run) => run.runId));
  const criteria = task.contract?.acceptanceCriteria ?? [];
  const evidence = task.acceptanceEvidence ?? [];
  if (criteria.length === 0 || evidence.length < criteria.length) return false;
  if (
    evidence.some(
      (entry) =>
        !entry.satisfied ||
        entry.snapshotId !== snapshotId ||
        entry.verificationRunIds.length === 0 ||
        !entry.verificationRunIds.every((runId) => runIds.has(runId))
    )
  ) {
    return false;
  }
  const satisfiedCriteria = new Set(evidence.map((entry) => entry.criterionId));
  return criteria.every((criterion) => satisfiedCriteria.has(criterion.id));
}

/** Mutate a task through the centralized fail-closed state machine and append audit history. */
export function transitionTask(task: TaskRecord, to: TaskStatus, context: TransitionContext): TaskStatusTransition {
  if (!context.reason?.trim() || !context.source?.trim()) {
    throw new SupervisorError(
      "INVALID_STATE_TRANSITION",
      "State transition requires non-empty reason and source",
      400
    );
  }
  if (!canTransition(task.status, to)) {
    throw new SupervisorError(
      "INVALID_STATE_TRANSITION",
      `Illegal task state transition: ${task.status} -> ${to}`,
      409,
      { taskId: task.id, from: task.status, to }
    );
  }
  if (task.status === "blocked" && to === "awaiting_verification") {
    const latestTransition = task.statusHistory?.at(-1);
    const proof = context.verificationRunId
      ? task.reconciliationProofs?.find(
          (candidate) =>
            candidate.runId === context.verificationRunId && candidate.result === "PROVEN_TERMINATED"
        )
      : undefined;
    const hasQuarantine = (task.quarantines ?? []).some((entry) => !entry.clearedAt);
    if (
      context.source.trim() !== "verifier-reconcile" ||
      !context.verificationRunId ||
      !["task-verify", "startup-recovery"].includes(latestTransition?.source ?? "") ||
      latestTransition?.verificationRunId !== context.verificationRunId ||
      !proof ||
      hasQuarantine
    ) {
      throw new SupervisorError(
        "INVALID_STATE_TRANSITION",
        "A blocked verifier task may resume only after exact proven reconciliation and quarantine clearance",
        409,
        { taskId: task.id, from: task.status, to, source: context.source.trim() }
      );
    }
  }
  if (["verifying", "ready_for_human_review"].includes(to) && task.pendingApprovalIds.length > 0) {
    throw new SupervisorError(
      "INVALID_STATE_TRANSITION",
      `Cannot enter ${to} while approvals are pending`,
      409,
      { pendingApprovalIds: task.pendingApprovalIds }
    );
  }
  if (["verifying", "ready_for_human_review"].includes(to) && hasActiveWriter(task)) {
    throw new SupervisorError("ACTIVE_WRITER_CONFLICT", `Cannot enter ${to} while a turn is active`, 409);
  }
  if (
    ["verifying", "ready_for_human_review"].includes(to) &&
    task.turnLease &&
    task.turnLease.state !== "terminal"
  ) {
    throw new SupervisorError("LEASE_CONFLICT", `Cannot enter ${to} while a turn lease is unresolved`, 409);
  }
  if (to === "ready_for_human_review" && !currentSnapshotIsVerified(task)) {
    throw new SupervisorError(
      "VERIFICATION_NOT_ALLOWED",
      "Current workspace snapshot does not have all required passing verification evidence",
      409
    );
  }
  const at = context.at ?? new Date().toISOString();
  const transition: TaskStatusTransition = {
    transitionId: randomUUID(),
    from: task.status,
    to,
    reason: context.reason.trim(),
    source: context.source.trim(),
    at,
    ...(context.turnId ? { turnId: context.turnId } : {}),
    ...(context.verificationRunId ? { verificationRunId: context.verificationRunId } : {}),
    ...(context.decisionId ? { decisionId: context.decisionId } : {})
  };
  task.status = to;
  task.updatedAt = at;
  (task.statusHistory ??= []).push(transition);
  return transition;
}
