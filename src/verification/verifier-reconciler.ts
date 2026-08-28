import type { QuarantineRecord, ReconciliationProof, VerifierRunV1 } from "../types.js";
import type { OciRuntimeConfig } from "../core/verification-config.js";
import { clearQuarantine, createQuarantine } from "./quarantine.js";
import { observeVerifierRun } from "./reconciliation-proof.js";

export interface ReconciliationResult {
  run: VerifierRunV1;
  proof: ReconciliationProof;
  quarantines: QuarantineRecord[];
}

/** Reconcile one ledger-selected run; callers cannot supply process identities. */
export async function reconcileVerifierRun(
  run: VerifierRunV1,
  quarantines: QuarantineRecord[],
  runtime?: OciRuntimeConfig,
  at = new Date()
): Promise<ReconciliationResult> {
  const proof = await observeVerifierRun(run, runtime, at);
  let updated = quarantines.map((quarantine) => {
    if (
      quarantine.runId !== run.runId ||
      quarantine.clearedAt ||
      proof.result !== "PROVEN_TERMINATED" ||
      quarantine.scope === "verification-domain" ||
      quarantine.scope === "global"
    ) {
      return quarantine;
    }
    return clearQuarantine(quarantine, proof, at.toISOString());
  });
  if (
    proof.result !== "PROVEN_TERMINATED" &&
    !updated.some(
      (quarantine) =>
        !quarantine.clearedAt &&
        quarantine.scope === "task" &&
        quarantine.taskId === run.taskId &&
        quarantine.runId === run.runId
    )
  ) {
    updated = [
      ...updated,
      createQuarantine({
        scope: "task",
        taskId: run.taskId,
        runId: run.runId,
        reason: proof.result === "PROVEN_STILL_RUNNING"
          ? "Exact verifier container is proven still running"
          : "Exact verifier container termination remains unknown",
        at: at.toISOString()
      })
    ];
  }
  return {
    run: {
      ...run,
      state:
        proof.result === "PROVEN_TERMINATED"
          ? ["starting", "running", "terminating", "quarantined", "lost"].includes(run.state)
            ? "failed"
            : run.state
          : proof.result === "PROVEN_STILL_RUNNING"
            // Keep the run in a cleanup-blocking active state. The exact task
            // quarantine above is an additional durable ownership barrier.
            ? "running"
            : run.state
    },
    proof,
    quarantines: updated
  };
}
