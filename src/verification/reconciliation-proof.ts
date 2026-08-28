import { randomUUID } from "node:crypto";
import type { OciRuntimeConfig } from "../core/verification-config.js";
import type { ReconciliationProof, VerifierRunV1 } from "../types.js";
import { observeOwnedOciContainer } from "./execution-backend.js";

function processState(pid: number, group = false): "alive" | "dead" | "unknown" {
  if (!Number.isSafeInteger(pid) || pid <= 1) return "unknown";
  try {
    process.kill(group ? -pid : pid, 0);
    return "alive";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return "dead";
    return "unknown";
  }
}

/** Build a conservative proof, using the trusted engine for current OCI runs. */
export async function observeVerifierRun(
  run: VerifierRunV1,
  runtime?: OciRuntimeConfig,
  at = new Date()
): Promise<ReconciliationProof> {
  if (run.backend === "oci") {
    // The worker protocol persists its PID before sending the start payload.
    // Therefore a run with no PID and no exact-container event never granted a
    // worker authority to create a container and its absent worker is dead.
    const workerState = run.pid
      ? processState(run.pid)
      : !run.containerId && !run.containerOwnershipRecordedAt
        ? "dead"
        : "unknown";
    const leaseExpired = Date.parse(run.leaseExpiresAt) <= at.getTime();
    const observation = await observeOwnedOciContainer(run, runtime, workerState, leaseExpired, at);
    return {
      proofId: randomUUID(),
      runId: run.runId,
      ...observation
    };
  }
  let result: ReconciliationProof["result"] = "UNKNOWN";
  // A worker PID is never a substitute for the independently detached recipe
  // process group. Missing group ownership must remain UNKNOWN.
  const rootPid = run.backend === "process-group"
    ? run.processGroupId
    : run.backend === "windows-process-tree"
      ? run.windowsTreeRootPid
      : undefined;
  const observedProcess = rootPid ? processState(rootPid, run.backend === "process-group") : "unknown";
  const workerState = run.pid ? processState(run.pid) : "unknown";
  const leaseExpired = Date.parse(run.leaseExpiresAt) <= at.getTime();
  if (run.backend === "process-group" && observedProcess === "dead" && workerState === "dead" && leaseExpired) {
    result = "PROVEN_TERMINATED";
  }
  if (observedProcess === "alive" || workerState === "alive") result = "PROVEN_STILL_RUNNING";
  // Absence of the Windows root PID cannot prove detached descendants are gone.
  if (run.backend === "windows-process-tree" && observedProcess === "dead") result = "UNKNOWN";
  return {
    proofId: randomUUID(),
    runId: run.runId,
    result,
    observedAt: at.toISOString(),
    evidence: {
      backend: run.backend,
      assurance: run.assurance,
      engine: run.engine ?? "absent",
      containerIdHash: run.containerIdHash ?? "absent",
      exactContainerIdRecorded: Boolean(run.containerId),
      rootPidHash: rootPid ? `pid-present-${String(rootPid).length}` : "absent",
      rootProcessState: observedProcess,
      workerProcessState: workerState,
      leaseExpired
    }
  };
}
