/** Durable task states. Legacy values are retained only for deterministic ledger migration. */
export type TaskStatus =
  | "planned"
  | "preparing"
  | "running"
  | "waiting_approval"
  | "awaiting_verification"
  | "verifying"
  | "needs_correction"
  | "ready_for_human_review"
  | "blocked"
  | "failed"
  | "interrupted"
  | "cancelled"
  | "stale"
  | "legacy_unverified"
  // v1 compatibility values. New state transitions never target these states.
  | "starting"
  | "completed";

/** A Codex turn is tracked independently from task acceptance. */
export type TurnStatus = "none" | "starting" | "in_progress" | "completed" | "failed" | "interrupted";

export interface AcceptanceCriterion {
  id: string;
  description: string;
  evidence?: string;
}

/** Versioned contract supplied by the supervisor before any work starts. */
export interface DevelopmentContractV1 {
  contractVersion: "1.0";
  clientRequestId: string;
  title?: string;
  objective: string;
  plan: string[];
  scope: { in: string[]; out: string[] };
  constraints: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  requiredVerificationRecipes: string[];
  allowedChangePaths?: string[];
  forbiddenChangePaths?: string[];
  maxCorrectionPasses: number;
  metadata?: Record<string, string>;
}

export interface SupervisorEvent {
  seq: number;
  at: string;
  method: string;
  payload: unknown;
}

export interface PendingApproval {
  approvalId: string;
  requestId: string | number;
  method: string;
  threadId?: string;
  turnId?: string;
  params: Record<string, unknown>;
  risk: "normal" | "blocked";
  riskReasons: string[];
  createdAt: string;
}

export interface TaskStatusTransition {
  transitionId: string;
  from: TaskStatus;
  to: TaskStatus;
  reason: string;
  source: string;
  at: string;
  turnId?: string;
  verificationRunId?: string;
  decisionId?: string;
}

export interface TurnRecord {
  turnId: string;
  threadId: string;
  status: TurnStatus;
  startedAt: string;
  completedAt?: string;
  leaseId?: string;
  error?: string;
}

/** Durable marker for a turn/start request whose remote turn id is not yet bound. */
export interface PendingTurnStartRecord {
  nonce: string;
  taskId: string;
  threadId: string;
  worktree: string;
  supervisorInstanceId: string;
  appServerInstanceId: string;
  registeredAt: string;
  observedTurnId?: string;
}

export interface WorkspaceSnapshot {
  snapshotId: string;
  headSha: string;
  branch: string;
  statusHash: string;
  diffHash: string;
  untrackedHash: string;
  createdAt: string;
  changedFiles: string[];
  comparisonBaseSha?: string;
}

/** Evidence matrix entry binding one acceptance criterion to the current immutable snapshot. */
export interface AcceptanceEvidenceEntry {
  criterionId: string;
  description: string;
  evidencePlan?: string;
  snapshotId: string;
  verificationRunIds: string[];
  satisfied: boolean;
  observedAt: string;
}

export interface VerificationRecipeResult {
  recipeId: string;
  required: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  passed: boolean;
}

export type VerificationRunState =
  | "starting"
  | "running"
  | "terminating"
  | "passed"
  | "failed"
  | "timed_out"
  | "mutated_workspace"
  | "lost"
  | "quarantined";

/** Durable verifier run ownership and evidence record. */
export interface VerifierRunV1 {
  runId: string;
  taskId: string;
  profileId: string;
  recipeIds: string[];
  workerId: string;
  ownerInstanceId: string;
  leaseId: string;
  /** "docker" is retained only for legacy ledgers; new container runs use "oci" plus engine. */
  backend: "process-group" | "windows-process-tree" | "docker" | "oci";
  assurance: "standard" | "best-effort" | "high";
  engine?: "docker" | "podman";
  pid?: number;
  processGroupId?: number;
  windowsTreeRootPid?: number;
  /** Exact owned OCI container identity; never accepted from an MCP caller. */
  containerId?: string;
  containerIdHash?: string;
  /** Digest-pinned image identity used to create the owned OCI container. */
  containerImageDigest?: string;
  /** Recipe and deterministic label binding for the currently owned container. */
  containerRecipeId?: string;
  containerLabelsHash?: string;
  containerEngineNamespaceHash?: string;
  containerOwnershipRecordedAt?: string;
  startedAt: string;
  heartbeatAt: string;
  leaseExpiresAt: string;
  beforeSnapshotId: string;
  afterSnapshotId?: string;
  state: VerificationRunState;
  exitCode?: number;
  terminationEvidence?: Record<string, unknown>;
  logDigest?: string;
  completedAt?: string;
  results?: VerificationRecipeResult[];
  stale?: boolean;
}

/** Alias retained for Phase 02 integrations. */
export type VerificationRun = VerifierRunV1;

export interface SupervisorDecision {
  decisionId: string;
  decision: "accept" | "request_changes" | "block" | "cancel";
  rationale: string;
  acceptedRisks: string[];
  snapshotId?: string;
  verificationRunIds: string[];
  at: string;
}

export interface TurnLeaseV1 {
  leaseId: string;
  taskId: string;
  threadId: string;
  turnId: string;
  worktree: string;
  supervisorInstanceId: string;
  appServerInstanceId: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  lastProtocolEventAt: string;
  state: "active" | "suspect" | "interrupting" | "terminal" | "lost";
}

export interface VerifierLeaseV1 {
  leaseId: string;
  runId: string;
  taskId: string;
  workerId: string;
  ownerInstanceId: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  state: "active" | "terminating" | "terminal" | "lost";
}

export type QuarantineScope = "task" | "worktree" | "verification-domain" | "global";

export interface QuarantineRecord {
  quarantineId: string;
  scope: QuarantineScope;
  taskId?: string;
  worktree?: string;
  runId?: string;
  reason: string;
  createdAt: string;
  clearedAt?: string;
  clearedByProofId?: string;
}

export interface ReconciliationProof {
  proofId: string;
  runId: string;
  result: "PROVEN_TERMINATED" | "PROVEN_STILL_RUNNING" | "UNKNOWN";
  observedAt: string;
  evidence: Record<string, unknown>;
}

export interface TaskRecord {
  id: string;
  objective: string;
  workspace: string;
  sourceWorkspace?: string;
  worktree?: string;
  branch?: string;
  baseSha?: string;
  headSha?: string;
  contract?: DevelopmentContractV1;
  contractHash?: string;
  threadId?: string;
  activeTurnId?: string;
  /** @deprecated Use activeTurnId. */
  turnId?: string;
  turnStatus?: TurnStatus;
  turnHistory?: TurnRecord[];
  turnLease?: TurnLeaseV1;
  pendingTurnStart?: PendingTurnStartRecord;
  status: TaskStatus;
  statusHistory?: TaskStatusTransition[];
  correctionPasses?: number;
  snapshots?: WorkspaceSnapshot[];
  acceptanceEvidence?: AcceptanceEvidenceEntry[];
  verificationRuns?: VerifierRunV1[];
  verifierLeases?: VerifierLeaseV1[];
  quarantines?: QuarantineRecord[];
  reconciliationProofs?: ReconciliationProof[];
  decisions?: SupervisorDecision[];
  residualRisks?: string[];
  createdAt: string;
  updatedAt: string;
  lastAgentMessage?: string;
  error?: string;
  eventSeq: number;
  oldestAvailableSeq?: number;
  events: SupervisorEvent[];
  pendingApprovalIds: string[];
  legacyUnreconciledVerifier?: boolean;
  runtimeCapabilitySnapshot?: Record<string, unknown>;
  toolSurfaceVersion?: string;
  toolSchemaHash?: string;
}

export interface IdempotencyRecord {
  taskId: string;
  sourceWorkspace: string;
  contractHash: string;
  createdAt: string;
}

export interface StoredStateV3 {
  version: 3;
  tasks: TaskRecord[];
  idempotency: Record<string, IdempotencyRecord>;
  turnLeases: TurnLeaseV1[];
  verifierRuns: VerifierRunV1[];
  verifierLeases: VerifierLeaseV1[];
  quarantines: QuarantineRecord[];
  reconciliationProofs: ReconciliationProof[];
  runtimeCapabilitySnapshot?: Record<string, unknown>;
  appServerInstanceHistory: Array<Record<string, unknown>>;
  chatgptConnectionEvidence: Array<Record<string, unknown>>;
  toolSurfaceVersion?: string;
  toolSchemaHash?: string;
  liveTestRuns: Array<Record<string, unknown>>;
}
