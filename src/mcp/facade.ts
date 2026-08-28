export interface CriterionConfirmationInput {
  criterionId: string;
  evidence: string;
}

interface TaskDecisionCommonInput {
  taskId: string;
  rationale: string;
  acceptedRisks?: string[];
  toolSurfaceVersion?: string;
}

export type TaskDecisionInput =
  | (TaskDecisionCommonInput & {
      decision: "accept";
      expectedSnapshotId: string;
      criterionConfirmations: CriterionConfirmationInput[];
    })
  | (TaskDecisionCommonInput & {
      decision: "request_changes" | "block" | "cancel";
      instruction?: string;
    });

/**
 * Stable boundary between transport adapters and the supervision engine.
 *
 * MCP and the operator CLI deliberately depend on this capability-oriented
 * interface instead of importing the concrete orchestrator.  That keeps both
 * transports on the same policy-enforced implementation while making the
 * tool surface independently testable.
 */
export interface SupervisorFacade {
  controlEnabled(): boolean;

  health(): Promise<unknown>;
  listTaskSummaries(): unknown[];
  getTaskSummary(taskId: string): unknown;
  getEvents(taskId: string, afterSeq?: number): unknown[];
  waitForChange(taskId: string, afterSeq: number, timeoutMs: number): Promise<unknown>;
  listApprovals(taskId?: string): unknown[];
  getWorkspaceStatus(taskId: string): Promise<unknown>;
  getWorkspaceDiff(taskId: string): Promise<unknown>;
  getTaskContract(taskId: string): Promise<unknown> | unknown;
  getTaskEvidence(taskId: string): Promise<unknown> | unknown;
  listVerificationProfiles(): Promise<unknown> | unknown;
  getRuntimeCapabilities(): Promise<unknown> | unknown;
  getVerifierStatus(input: { taskId?: string; runId?: string }): Promise<unknown> | unknown;

  startTask(input: Record<string, unknown>): Promise<unknown>;
  continueTask(input: { taskId: string; instruction: string; toolSurfaceVersion?: string }): Promise<unknown>;
  steerTask(taskId: string, instruction: string): Promise<unknown>;
  interruptTask(taskId: string): Promise<unknown>;
  decideApproval(
    approvalId: string,
    decision: "accept" | "decline" | "cancel",
    taskId?: string
  ): Promise<unknown>;
  recoverTask(input: { taskId: string; toolSurfaceVersion?: string }): Promise<unknown>;
  verifyTask(input: { taskId: string; profileId: string; toolSurfaceVersion?: string }): Promise<unknown>;
  decideTask(input: TaskDecisionInput): Promise<unknown>;
  cleanupTask(input: { taskId: string; toolSurfaceVersion?: string }): Promise<unknown>;
  reconcileVerifier(input: {
    runId: string;
    taskId?: string;
    toolSurfaceVersion?: string;
  }): Promise<unknown>;
}
