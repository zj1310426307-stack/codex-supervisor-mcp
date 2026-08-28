import { randomUUID } from "node:crypto";
import type { QuarantineRecord, QuarantineScope, ReconciliationProof } from "../types.js";
import { SupervisorError } from "../core/errors.js";

/** Create the smallest evidence-appropriate quarantine record. */
export function createQuarantine(input: {
  scope: QuarantineScope;
  reason: string;
  taskId?: string;
  worktree?: string;
  runId?: string;
  at?: string;
}): QuarantineRecord {
  if (!input.reason.trim()) throw new SupervisorError("INVALID_INPUT", "Quarantine reason is required", 400);
  if (input.scope === "task" && !input.taskId) throw new SupervisorError("INVALID_INPUT", "Task quarantine needs taskId", 400);
  if (input.scope === "worktree" && !input.worktree) {
    throw new SupervisorError("INVALID_INPUT", "Worktree quarantine needs worktree", 400);
  }
  return {
    quarantineId: randomUUID(),
    scope: input.scope,
    reason: input.reason.trim(),
    createdAt: input.at ?? new Date().toISOString(),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.worktree ? { worktree: input.worktree } : {}),
    ...(input.runId ? { runId: input.runId } : {})
  };
}

/** Clear only the exact scope covered by a deterministic termination proof. */
export function clearQuarantine(
  quarantine: QuarantineRecord,
  proof: ReconciliationProof,
  at = new Date().toISOString()
): QuarantineRecord {
  if (quarantine.clearedAt) return quarantine;
  if (quarantine.scope === "verification-domain" || quarantine.scope === "global") {
    throw new SupervisorError(
      "QUARANTINED",
      "A single verifier-run proof cannot clear domain or global quarantine",
      409
    );
  }
  if (proof.result !== "PROVEN_TERMINATED" || !quarantine.runId || proof.runId !== quarantine.runId) {
    throw new SupervisorError("QUARANTINED", "Quarantine remains because termination is not proven", 409);
  }
  return { ...quarantine, clearedAt: at, clearedByProofId: proof.proofId };
}

export function hasActiveQuarantine(quarantines: QuarantineRecord[], taskId?: string, worktree?: string): boolean {
  return quarantines.some(
    (entry) =>
      !entry.clearedAt &&
      (entry.scope === "global" ||
        entry.scope === "verification-domain" ||
        (entry.scope === "task" && entry.taskId === taskId) ||
        (entry.scope === "worktree" && entry.worktree === worktree))
  );
}
