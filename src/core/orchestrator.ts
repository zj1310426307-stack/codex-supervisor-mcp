import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Config } from "../config.js";
import type { TaskDecisionInput } from "../mcp/facade.js";
import { CodexAppServerClient, type RpcRequest } from "../codex/app-server-client.js";
import type { ProtocolRuntimeBinding } from "../codex/protocol-capabilities.js";
import { CODEX_SUPERVISOR_THREAD_OPTIONS } from "../codex/protocol-values.js";
import { probeCodexRuntime, type CodexRuntimeProbeResult } from "../codex/runtime-probe.js";
import type {
  PendingApproval,
  PendingTurnStartRecord,
  QuarantineRecord,
  ReconciliationProof,
  SupervisorDecision,
  SupervisorEvent,
  TaskRecord,
  TurnRecord,
  WorkspaceSnapshot,
  VerifierLeaseV1,
  VerifierRunV1
} from "../types.js";
import { normalizeStartTaskInput } from "./contracts.js";
import { SupervisorError } from "./errors.js";
import { workspaceDiff, workspaceStatus } from "./git-inspector.js";
import { InstanceLock } from "./instance-lock.js";
import { classifyApproval } from "./policy.js";
import { redact, redactAndTruncate, redactText } from "./redaction.js";
import { captureWorkspaceSnapshot } from "./snapshot.js";
import {
  canTransition,
  contractPathViolations,
  hasActiveWriter,
  isCleanupEligible,
  transitionTask
} from "./state-machine.js";
import { TaskStore } from "./store.js";
import { TurnLeaseManager } from "./turn-lease.js";
import { TurnWatchdog } from "./turn-watchdog.js";
import {
  hasCompleteOciTerminationEvidence,
  isTrustedPassingVerifierRun,
  resolveContainerEnvironment,
  runVerification
} from "./verification.js";
import {
  listVerificationProfiles,
  loadVerificationConfig,
  selectVerificationRecipes,
  type VerificationConfig
} from "./verification-config.js";
import { WorkspaceGuard } from "./workspace.js";
import { WorktreeManager, type WorktreeRecord } from "./worktree-manager.js";
import { reconcileVerifierRun } from "../verification/verifier-reconciler.js";
import { assertOciRuntimeAvailable } from "../verification/execution-backend.js";

const TOOL_SURFACE_VERSION = "0.4.0";

interface OrchestratorDependencies {
  client?: CodexAppServerClient;
  store?: TaskStore;
  guard?: WorkspaceGuard;
  worktrees?: WorktreeManager;
  instanceLock?: InstanceLock;
  verificationConfig?: VerificationConfig;
  runtimeProbe?: typeof probeCodexRuntime;
}

interface RuntimeCapabilityState {
  checkedAt: string;
  compatible: boolean;
  commandSource: Config["codexBinSource"];
  version?: string;
  schemaHash?: string;
  schemaFileCount?: number;
  capabilities?: CodexRuntimeProbeResult["capabilities"];
  error?: string;
  connectionGeneration?: number;
}

interface ContinueTaskInput {
  taskId: string;
  instruction: string;
  toolSurfaceVersion?: string;
}

interface PendingTurnStartRuntime {
  record: PendingTurnStartRecord;
  bufferedNotifications: unknown[];
  deferredPriorTurnTelemetry: unknown[];
}

interface TaskOperationState {
  name: string;
  token: string;
  done: Promise<void>;
  release: () => void;
}

function iso(): string {
  return new Date().toISOString();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new SupervisorError("INVALID_INPUT", `${label} must be a non-empty string`, 400);
  }
  return value.trim();
}

function extractId(value: unknown, container: string): string {
  const candidate = record(value)[container];
  const id = record(candidate).id;
  if (typeof id !== "string" || !id) {
    throw new SupervisorError("RUNTIME_UNAVAILABLE", `Codex ${container} response did not contain an id`, 502);
  }
  return id;
}

function taskWorktree(task: TaskRecord): string {
  const worktree = task.worktree ?? task.workspace;
  if (!worktree) throw new SupervisorError("WORKTREE_INVALID", "Task has no isolated worktree", 409);
  return worktree;
}

function worktreeRecord(task: TaskRecord): WorktreeRecord {
  if (!task.sourceWorkspace || !task.worktree || !task.branch || !task.baseSha) {
    throw new SupervisorError("WORKTREE_INVALID", "Task worktree ownership record is incomplete", 409);
  }
  return {
    taskId: task.id,
    sourceWorkspace: task.sourceWorkspace,
    worktree: task.worktree,
    branch: task.branch,
    baseSha: task.baseSha,
    createdAt: task.createdAt
  };
}

/** A planned idempotency reservation is resumable only before any side effect was recorded. */
function isPristinePlannedReservation(task: TaskRecord): boolean {
  const sourceWorkspace = task.sourceWorkspace;
  return task.status === "planned" &&
    Boolean(sourceWorkspace) &&
    path.resolve(task.workspace) === path.resolve(sourceWorkspace!) &&
    Boolean(task.contract?.clientRequestId) &&
    Boolean(task.contractHash) &&
    !task.worktree &&
    !task.branch &&
    !task.baseSha &&
    !task.headSha &&
    !task.threadId &&
    !task.activeTurnId &&
    !task.turnId &&
    !task.turnLease &&
    !task.pendingTurnStart &&
    task.turnStatus === "none" &&
    (task.turnHistory?.length ?? 0) === 0 &&
    (task.statusHistory?.length ?? 0) === 0 &&
    (task.correctionPasses ?? 0) === 0 &&
    (task.snapshots?.length ?? 0) === 0 &&
    (task.acceptanceEvidence?.length ?? 0) === 0 &&
    (task.verificationRuns?.length ?? 0) === 0 &&
    (task.verifierLeases?.length ?? 0) === 0 &&
    (task.quarantines?.length ?? 0) === 0 &&
    (task.reconciliationProofs?.length ?? 0) === 0 &&
    (task.decisions?.length ?? 0) === 0 &&
    (task.residualRisks?.length ?? 0) === 0 &&
    !task.legacyUnreconciledVerifier &&
    !task.lastAgentMessage &&
    !task.error &&
    task.eventSeq === 0 &&
    (task.oldestAvailableSeq ?? 1) === 1 &&
    task.events.length === 0 &&
    task.pendingApprovalIds.length === 0;
}

function implementationBrief(task: TaskRecord, instruction?: string): string {
  const contract = task.contract!;
  const lines = [
    "You are the implementation agent. ChatGPT or the local operator is the supervisor.",
    "Work only inside the current isolated Git worktree. Do not commit, push, merge, release, or deploy.",
    "Do not broaden scope, weaken tests, or treat turn completion as task acceptance.",
    "Inspect the repository before editing and preserve unrelated user work.",
    "At the end report changed files, checks actually run, their results, blockers, and residual risks.",
    `\nContract objective:\n${contract.objective}`,
    `\nIn scope:\n${contract.scope.in.map((item, index) => `${index + 1}. ${item}`).join("\n")}`,
    contract.scope.out.length
      ? `\nOut of scope:\n${contract.scope.out.map((item, index) => `${index + 1}. ${item}`).join("\n")}`
      : "",
    contract.plan.length
      ? `\nImplementation plan:\n${contract.plan.map((item, index) => `${index + 1}. ${item}`).join("\n")}`
      : "",
    `\nAcceptance criteria:\n${contract.acceptanceCriteria
      .map((item) => `${item.id}: ${item.description}`)
      .join("\n")}`,
    contract.constraints.length
      ? `\nConstraints:\n${contract.constraints.map((item, index) => `${index + 1}. ${item}`).join("\n")}`
      : "",
    instruction ? `\nSupervisor follow-up:\n${instruction}` : ""
  ];
  return lines.filter(Boolean).join("\n");
}

function verifierLease(run: VerifierRunV1): VerifierLeaseV1 {
  const terminal = ["passed", "failed", "timed_out", "mutated_workspace", "lost", "quarantined"].includes(run.state);
  return {
    leaseId: run.leaseId,
    runId: run.runId,
    taskId: run.taskId,
    workerId: run.workerId,
    ownerInstanceId: run.ownerInstanceId,
    acquiredAt: run.startedAt,
    heartbeatAt: run.heartbeatAt,
    expiresAt: run.leaseExpiresAt,
    state: run.state === "terminating"
      ? "terminating"
      : terminal
        ? (run.state === "lost" ? "lost" : "terminal")
        : "active"
  };
}

export class Orchestrator {
  private readonly client: CodexAppServerClient;
  private readonly store: TaskStore;
  private readonly guard: WorkspaceGuard;
  private readonly worktrees: WorktreeManager;
  private readonly instanceLock: InstanceLock;
  private readonly instanceId: string;
  private readonly appServerInstanceId = randomUUID();
  private readonly turnLeases: TurnLeaseManager;
  private readonly watchdog: TurnWatchdog;
  private readonly runtimeProbe: typeof probeCodexRuntime;
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly taskOperations = new Map<string, TaskOperationState>();
  private readonly startupOperations = new Set<Promise<void>>();
  private notificationQueue: Promise<void> = Promise.resolve();
  private pendingTurnStart?: PendingTurnStartRuntime;
  private replayingPendingStartTaskId?: string;
  private runtimeProbePromise?: Promise<RuntimeCapabilityState>;
  private runtimeCapabilities?: RuntimeCapabilityState;
  private verificationConfig?: VerificationConfig;
  private initialized = false;
  private stopping = false;
  private protocolEventsClosed = false;
  private stopPromise?: Promise<void>;

  constructor(private readonly config: Config, dependencies: OrchestratorDependencies = {}) {
    const stateDirectory = path.dirname(config.stateFile);
    this.runtimeProbe = dependencies.runtimeProbe ?? probeCodexRuntime;
    this.client = dependencies.client ?? new CodexAppServerClient(
      config.codexBin,
      config.codexHome,
      config.requestTimeoutMs,
      {
        experimentalApi: config.codexExperimentalApi,
        maxReadRetries: config.codexReadRetries,
        retryBaseDelayMs: config.codexRetryBaseDelayMs,
        retryMaxDelayMs: config.codexRetryMaxDelayMs,
        shutdownTimeoutMs: config.codexShutdownTimeoutMs,
        validateProtocolBinding: (generation) => this.validateRuntimeBindingForGeneration(generation)
      }
    );
    this.store = dependencies.store ?? new TaskStore(config.stateFile);
    this.guard = dependencies.guard ?? new WorkspaceGuard(config.workspaceRoots);
    this.worktrees = dependencies.worktrees ?? new WorktreeManager({
      root: config.worktreeRoot ?? path.join(stateDirectory, "worktrees"),
      requireCleanBase: true
    });
    this.instanceLock = dependencies.instanceLock ?? new InstanceLock(`${config.stateFile}.lock`, {
      stateFile: config.stateFile,
      codexHome: config.codexHome
    });
    this.instanceId = this.instanceLock.instanceId;
    this.verificationConfig = dependencies.verificationConfig;
    this.turnLeases = new TurnLeaseManager({
      supervisorInstanceId: this.instanceId,
      appServerInstanceId: this.appServerInstanceId,
      ttlMs: config.turnLeaseTtlMs ?? 30_000,
      onChange: async (leases) => {
        for (const lease of leases) {
          const task = this.store.get(lease.taskId);
          if (task) {
            task.turnLease = lease;
            await this.store.put(task);
          }
        }
      }
    });
    this.watchdog = new TurnWatchdog(
      this.turnLeases,
      {
        warnIdleMs: config.turnWarnIdleMs ?? 60_000,
        suspectIdleMs: config.turnSuspectIdleMs ?? 180_000,
        hardDeadlineMs: config.turnHardDeadlineMs ?? 3_600_000,
        autoInterruptHung: false
      },
      {
        onWarning: async (lease, idleMs) => {
          const task = this.store.get(lease.taskId);
          if (!task) return;
          await this.appendEvent(task, "supervisor/turnIdleWarning", { leaseId: lease.leaseId, idleMs });
          await this.store.put(task);
          this.signal(task.id);
        },
        onHardDeadline: async (lease, ageMs) => {
          const task = this.store.get(lease.taskId);
          if (!task) return;
          if (canTransition(task.status, "stale")) {
            transitionTask(task, "stale", {
              reason: "Turn watchdog hard deadline reached without terminal proof",
              source: "turn-watchdog",
              turnId: lease.turnId
            });
          }
          task.turnStatus = "failed";
          task.error = `Turn lease lost after ${ageMs}ms without terminal evidence`;
          await this.appendEvent(task, "supervisor/turnLeaseLost", { leaseId: lease.leaseId, ageMs });
          await this.store.put(task);
          this.signal(task.id);
        }
      }
    );

    this.client.on("notification", (message) => {
      this.enqueueProtocolWork("notification", message, () => this.onNotification(message));
    });
    this.client.on("serverRequest", (request: RpcRequest) => {
      this.enqueueProtocolWork("serverRequest", request, () => this.onServerRequest(request));
    });
    this.client.on("exit", () => {
      this.enqueueProtocolWork("exit", undefined, () =>
        this.markActiveTasksStale("Codex App Server exited without task terminal proof")
      );
    });
    this.client.on("processError", (error: Error) => {
      this.enqueueProtocolWork("processError", error, () =>
        this.markActiveTasksStale(`Codex App Server process error: ${redactText(error.message)}`)
      );
    });
    this.client.on("protocolError", (error: Error) => {
      const reason = `Codex protocol error: ${redactText(error.message)}`;
      console.error("[codex protocol]", reason);
      this.enqueueProtocolWork("protocolError", error, () => this.markActiveTasksStale(reason));
    });
    this.client.on("stderr", (line: string) => console.error("[codex]", redactText(line)));
  }

  async init(): Promise<void> {
    await this.instanceLock.acquire();
    try {
      await this.store.load();
      for (const task of this.store.list()) {
        let changed = false;
        if (task.pendingTurnStart) {
          const pending = task.pendingTurnStart;
          const unresolvedTurnId = pending.observedTurnId ?? `unresolved-${pending.nonce}`;
          if (!task.turnLease) {
            task.turnLease = {
              leaseId: randomUUID(),
              taskId: task.id,
              threadId: pending.threadId,
              turnId: unresolvedTurnId,
              worktree: pending.worktree,
              supervisorInstanceId: pending.supervisorInstanceId,
              appServerInstanceId: pending.appServerInstanceId,
              acquiredAt: pending.registeredAt,
              heartbeatAt: iso(),
              expiresAt: iso(),
              lastProtocolEventAt: pending.registeredAt,
              state: "lost"
            };
          }
          task.activeTurnId = unresolvedTurnId;
          task.turnId = unresolvedTurnId;
          task.turnStatus = "failed";
          task.residualRisks = [
            ...new Set([...(task.residualRisks ?? []), "prior_runtime_turn_start_unresolved"])
          ];
          if (canTransition(task.status, "stale")) {
            transitionTask(task, "stale", {
              reason: "Recovered ledger contained an unbound prior-runtime turn/start request",
              source: "startup-recovery",
              turnId: unresolvedTurnId
            });
          }
          await this.appendEvent(task, "supervisor/pendingTurnStartLost", {
            nonce: pending.nonce,
            observedTurnId: pending.observedTurnId
          });
          changed = true;
        }
        if (task.turnLease && ["active", "suspect", "interrupting"].includes(task.turnLease.state)) {
          task.turnLease.state = "lost";
          task.turnLease.expiresAt = iso();
          task.turnStatus = "failed";
          if (canTransition(task.status, "stale")) {
            transitionTask(task, "stale", {
              reason: "Recovered ledger contained a turn lease owned by a prior runtime",
              source: "startup-recovery",
              turnId: task.turnLease.turnId
            });
          }
          changed = true;
        }
        if (task.status === "preparing") {
          task.residualRisks = [
            ...new Set([...(task.residualRisks ?? []), "prior_runtime_task_start_side_effect_ambiguous"])
          ];
          transitionTask(task, "stale", {
            reason: "Prior runtime stopped after task-start preparation began; external worktree or thread side effects may be ambiguous",
            source: "startup-recovery"
          });
          await this.appendEvent(task, "supervisor/priorTaskStartAmbiguous", {});
          changed = true;
        }
        const ambiguousLegacyRuns = (task.verificationRuns ?? []).filter((run) =>
          run.backend === "docker" ||
          (run.backend === "oci" && (!run.engine || !run.containerEngineNamespaceHash))
        );
        if (ambiguousLegacyRuns.length > 0) {
          for (const run of ambiguousLegacyRuns) run.stale = true;
          task.acceptanceEvidence = [];
          task.residualRisks = [
            ...new Set([...(task.residualRisks ?? []), "legacy_verifier_engine_identity_ambiguous"])
          ];
          await this.appendEvent(task, "supervisor/legacyVerifierEvidenceInvalidated", {
            runIds: ambiguousLegacyRuns.map((run) => run.runId)
          });
          changed = true;
        }
        const priorRuntimeActiveLeases = (task.verifierLeases ?? []).filter((lease) =>
          ["active", "terminating"].includes(lease.state)
        );
        const priorRuntimeRuns = (task.verificationRuns ?? []).filter((run) =>
          ["starting", "running", "terminating"].includes(run.state)
        );
        if (priorRuntimeRuns.length > 0) {
          const recoveredAt = iso();
          for (const run of priorRuntimeRuns) {
            run.state = "lost";
            run.stale = true;
            run.heartbeatAt = recoveredAt;
            run.leaseExpiresAt = recoveredAt;
            run.terminationEvidence = {
              ...(run.terminationEvidence ?? {}),
              startupRecovery: {
                observedAt: recoveredAt,
                result: "UNKNOWN",
                detail: "Verifier ownership belonged to a prior Supervisor runtime"
              }
            };
            if (!(task.quarantines ?? []).some((entry) => entry.runId === run.runId && !entry.clearedAt)) {
              (task.quarantines ??= []).push({
                quarantineId: randomUUID(),
                scope: "task",
                taskId: task.id,
                worktree: task.worktree,
                runId: run.runId,
                reason: "Prior-runtime verifier termination requires exact reconciliation",
                createdAt: recoveredAt
              });
            }
            await this.appendEvent(task, "supervisor/priorVerifierLost", {
              runId: run.runId,
              backend: run.backend,
              engine: run.engine
            });
          }
          changed = true;
        }
        const recoveredAt = iso();
        const runsById = new Map((task.verificationRuns ?? []).map((run) => [run.runId, run]));
        const unresolvedLeaseRunIds = new Set<string>();
        // Independently invalidate every lease owned by the prior runtime. A
        // terminal run may release its contradictory active lease only when its
        // durable OCI evidence proves every container was already removed.
        for (const lease of priorRuntimeActiveLeases) {
          const ownedRun = runsById.get(lease.runId);
          lease.heartbeatAt = recoveredAt;
          lease.expiresAt = recoveredAt;
          if (ownedRun && ["passed", "failed", "timed_out", "mutated_workspace"].includes(ownedRun.state)) {
            if (hasCompleteOciTerminationEvidence(ownedRun)) {
              lease.state = "terminal";
              task.residualRisks = [
                ...new Set([...(task.residualRisks ?? []), "prior_runtime_terminal_verifier_lease_normalized"])
              ];
            } else {
              ownedRun.stale = true;
              task.acceptanceEvidence = [];
              ownedRun.state = "lost";
              ownedRun.heartbeatAt = recoveredAt;
              ownedRun.leaseExpiresAt = recoveredAt;
              lease.state = "lost";
              unresolvedLeaseRunIds.add(lease.runId);
              task.residualRisks = [
                ...new Set([...(task.residualRisks ?? []), "prior_runtime_terminal_verifier_evidence_unproven"])
              ];
            }
            await this.appendEvent(task, "supervisor/priorVerifierLeaseInvalidated", {
              runId: lease.runId,
              terminalEvidenceComplete: lease.state === "terminal"
            });
          } else {
            lease.state = "lost";
            unresolvedLeaseRunIds.add(lease.runId);
          }
          if (
            lease.state === "lost" &&
            !(task.quarantines ?? []).some((entry) => entry.runId === lease.runId && !entry.clearedAt)
          ) {
            (task.quarantines ??= []).push({
              quarantineId: randomUUID(),
              scope: "task",
              taskId: task.id,
              worktree: task.worktree,
              runId: lease.runId,
              reason: ownedRun
                ? "Prior-runtime verifier lease lacks complete terminal container evidence"
                : "Prior-runtime verifier lease has no durable run ownership record",
              createdAt: recoveredAt
            });
          }
          changed = true;
        }
        const unresolvedRuns = (task.verificationRuns ?? []).filter((run) =>
          ["lost", "quarantined"].includes(run.state)
        );
        for (const run of unresolvedRuns) {
          if (!(task.quarantines ?? []).some((entry) => entry.runId === run.runId && !entry.clearedAt)) {
            (task.quarantines ??= []).push({
              quarantineId: randomUUID(),
              scope: "task",
              taskId: task.id,
              worktree: task.worktree,
              runId: run.runId,
              reason: "Lost verifier run requires exact reconciliation",
              createdAt: recoveredAt
            });
            changed = true;
          }
        }
        if (task.status === "verifying") {
          if (unresolvedRuns.length > 0 || unresolvedLeaseRunIds.size > 0) {
            const unresolvedLeaseRunId = unresolvedLeaseRunIds.values().next().value as string | undefined;
            transitionTask(task, "blocked", {
              reason: "Prior-runtime verifier ownership is lost and quarantined pending exact reconciliation",
              source: "startup-recovery",
              verificationRunId: unresolvedRuns[0]?.runId ?? unresolvedLeaseRunId
            });
          } else {
            for (const run of task.verificationRuns ?? []) run.stale = true;
            task.acceptanceEvidence = [];
            task.residualRisks = [
              ...new Set([...(task.residualRisks ?? []), "prior_runtime_verification_interrupted_before_ownership"])
            ];
            transitionTask(task, "awaiting_verification", {
              reason: "Prior runtime stopped before durable verifier ownership was created; verification may be retried",
              source: "startup-recovery"
            });
          }
          changed = true;
        }
        if (task.pendingApprovalIds.length > 0) {
          const invalidatedApprovalIds = [...task.pendingApprovalIds];
          task.pendingApprovalIds = [];
          task.residualRisks = [...new Set([...(task.residualRisks ?? []), "prior_runtime_approvals_invalidated"])];
          if (canTransition(task.status, "stale")) {
            transitionTask(task, "stale", {
              reason: "Prior-runtime approvals cannot be reconstructed or accepted after restart",
              source: "startup-recovery",
              turnId: task.turnLease?.turnId ?? task.activeTurnId
            });
          }
          await this.appendEvent(task, "supervisor/priorApprovalsInvalidated", {
            count: invalidatedApprovalIds.length
          });
          changed = true;
        }
        if (changed) await this.store.put(task);
      }
      this.turnLeases.restore(
        this.store.list().flatMap((task) => task.turnLease ? [task.turnLease] : [])
      );
      if (!this.verificationConfig) {
        const verificationFile = path.resolve(
          this.config.verificationConfigFile ??
            process.env.SUPERVISOR_VERIFICATION_CONFIG?.trim() ??
            "config/verification.example.json"
        );
        this.verificationConfig = await loadVerificationConfig(verificationFile);
      }
      this.initialized = true;
      this.watchdog.start();
      await this.refreshRuntimeCapabilities();
    } catch (error) {
      await this.instanceLock.release().catch(() => undefined);
      throw error;
    }
  }

  controlEnabled(): boolean {
    return this.config.controlEnabled;
  }

  async health(): Promise<Record<string, unknown>> {
    const runtime = this.runtimeCapabilities ?? await this.refreshRuntimeCapabilities();
    const live = await this.readinessProbe();
    return redact({
      ok: live,
      initialized: this.initialized,
      controlEnabled: this.config.controlEnabled,
      codex: {
        runtimeCompatible: runtime.compatible,
        appServerReady: this.client.isReady(),
        freshReadProbe: live,
        initializedConnections: this.client.connectionCount(),
        version: runtime.version,
        schemaHash: runtime.schemaHash,
        error: runtime.error
      }
    });
  }

  async readinessProbe(): Promise<boolean> {
    if (!this.initialized) return false;
    const runtime = this.runtimeCapabilities ?? await this.refreshRuntimeCapabilities();
    if (!runtime.compatible) return false;
    try {
      await this.client.request("account/read", {});
      return this.client.isReady();
    } catch {
      return false;
    }
  }

  listTasks(): TaskRecord[] {
    return this.store.list();
  }

  listTaskSummaries(): Array<Record<string, unknown>> {
    return this.store.list().map((task) => this.taskSummary(task));
  }

  getTaskSummary(taskId: string): Record<string, unknown> {
    return this.taskSummary(this.getTask(taskId));
  }

  getTask(taskId: string): TaskRecord {
    const task = this.store.get(taskId);
    if (!task) throw new SupervisorError("NOT_FOUND", `Unknown task: ${taskId}`, 404);
    return task;
  }

  getTaskContract(taskId: string): Record<string, unknown> {
    const task = this.getTask(taskId);
    return redact({
      taskId: task.id,
      contract: task.contract,
      contractHash: task.contractHash,
      sourceWorkspace: task.sourceWorkspace,
      worktree: task.worktree
    });
  }

  getTaskEvidence(taskId: string): Record<string, unknown> {
    const task = this.getTask(taskId);
    return redact({
      taskId: task.id,
      status: task.status,
      contractHash: task.contractHash,
      currentSnapshot: task.snapshots?.at(-1),
      snapshots: task.snapshots ?? [],
      acceptanceCriteriaEvidence: task.acceptanceEvidence ?? [],
      unverifiedAcceptanceCriteria: (task.acceptanceEvidence ?? [])
        .filter((entry) => !entry.satisfied)
        .map((entry) => entry.criterionId),
      verificationRuns: task.verificationRuns ?? [],
      decisions: task.decisions ?? [],
      statusHistory: task.statusHistory ?? [],
      residualRisks: task.residualRisks ?? [],
      quarantines: task.quarantines ?? []
    });
  }

  listVerificationProfiles(): unknown {
    if (!this.verificationConfig) {
      throw new SupervisorError("VERIFICATION_CONFIG_INVALID", "Verification configuration is not loaded", 503);
    }
    return { profiles: listVerificationProfiles(this.verificationConfig) };
  }

  async getRuntimeCapabilities(): Promise<RuntimeCapabilityState> {
    return redact(this.runtimeCapabilities ?? await this.refreshRuntimeCapabilities());
  }

  getVerifierStatus(input: { taskId?: string; runId?: string }): Record<string, unknown> {
    const tasks = input.taskId ? [this.getTask(input.taskId)] : this.store.list();
    const runs = tasks.flatMap((task) => task.verificationRuns ?? [])
      .filter((run) => !input.runId || run.runId === input.runId)
      .map((run) => ({
        runId: run.runId,
        taskId: run.taskId,
        profileId: run.profileId,
        state: run.state,
        assurance: run.assurance,
        startedAt: run.startedAt,
        heartbeatAt: run.heartbeatAt,
        leaseExpiresAt: run.leaseExpiresAt,
        completedAt: run.completedAt,
        stale: run.stale === true
      }));
    const quarantines = tasks.flatMap((task) => task.quarantines ?? [])
      .filter((item) => !input.runId || item.runId === input.runId)
      .map((item) => ({
        quarantineId: item.quarantineId,
        scope: item.scope,
        taskId: item.taskId,
        runId: item.runId,
        reason: item.reason,
        createdAt: item.createdAt,
        clearedAt: item.clearedAt
      }));
    return redact({ runs, quarantines });
  }

  async startTask(input: Record<string, unknown>): Promise<TaskRecord> {
    this.assertControlEnabled();
    let release!: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });
    this.startupOperations.add(done);
    try {
      return await this.startTaskTracked(input);
    } finally {
      this.startupOperations.delete(done);
      release();
    }
  }

  private async startTaskTracked(input: Record<string, unknown>): Promise<TaskRecord> {
    this.assertSurfaceVersion(input.toolSurfaceVersion);
    await this.requireCompatibleRuntime();
    const normalized = normalizeStartTaskInput(input);
    const sourceWorkspace = await this.guard.resolveAllowed(normalized.workspace);
    const timestamp = iso();
    const task: TaskRecord = {
      id: randomUUID(),
      objective: normalized.contract.objective,
      workspace: sourceWorkspace,
      sourceWorkspace,
      contract: normalized.contract,
      contractHash: normalized.contractHash,
      status: "planned",
      statusHistory: [],
      turnStatus: "none",
      turnHistory: [],
      correctionPasses: 0,
      snapshots: [],
      acceptanceEvidence: [],
      verificationRuns: [],
      verifierLeases: [],
      quarantines: [],
      reconciliationProofs: [],
      decisions: [],
      residualRisks: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      eventSeq: 0,
      oldestAvailableSeq: 1,
      events: [],
      pendingApprovalIds: [],
      runtimeCapabilitySnapshot: redact(this.runtimeCapabilities ?? {}),
      toolSurfaceVersion: TOOL_SURFACE_VERSION
    };
    const idempotent = await this.store.putWithIdempotency(task, normalized.clientRequestId);
    const reservedTask = idempotent.created ? task : idempotent.task;
    if (!idempotent.created) {
      const active = this.taskOperations.get(reservedTask.id);
      if (active) {
        throw new SupervisorError(
          "ACTIVE_WRITER_CONFLICT",
          `Task operation ${active.name} is already in progress`,
          409,
          { taskId: reservedTask.id, activeOperation: active.name, requestedOperation: "start" }
        );
      }
      if (reservedTask.status !== "planned") return reservedTask;
      if (!isPristinePlannedReservation(reservedTask)) {
        throw new SupervisorError(
          "IDEMPOTENCY_CONFLICT",
          "Planned task reservation contains side-effect evidence and cannot be replayed safely",
          409,
          { taskId: reservedTask.id, clientRequestId: normalized.clientRequestId }
        );
      }
    }

    return this.runTaskOperation(reservedTask.id, "start", () =>
      this.resumePlannedTaskStart(reservedTask, sourceWorkspace)
    );
  }

  private async resumePlannedTaskStart(task: TaskRecord, sourceWorkspace: string): Promise<TaskRecord> {
    try {
      this.assertControlEnabled();
      transitionTask(task, "preparing", {
          reason: "Validated Development Contract and reserved idempotent task identity",
          source: "task-start"
      });
      await this.store.put(task);
      const isolated = await this.worktrees.create(sourceWorkspace, task.id);
      task.worktree = isolated.worktree;
      task.workspace = isolated.worktree;
      task.branch = isolated.branch;
      task.baseSha = isolated.baseSha;
      task.headSha = isolated.baseSha;
      task.snapshots!.push(await captureWorkspaceSnapshot(isolated.worktree, isolated.baseSha));
      await this.appendEvent(task, "supervisor/worktreeCreated", {
        branch: isolated.branch,
        baseSha: isolated.baseSha,
        worktree: isolated.worktree
      });
      await this.store.put(task);

      this.assertControlEnabled();
      const started = await this.client.request("thread/start", {
        cwd: isolated.worktree,
        ...CODEX_SUPERVISOR_THREAD_OPTIONS,
        ...(this.config.codexModel ? { model: this.config.codexModel } : {}),
        serviceName: "codex_supervisor_mcp"
      });
      task.threadId = extractId(started, "thread");
      await this.store.put(task);
      this.assertControlEnabled();
      const pendingStart = await this.registerPendingTurnStart(task);
      try {
        const turn = await this.client.request("turn/start", {
          threadId: task.threadId,
          clientUserMessageId: `supervisor-${task.id}`,
          input: [{ type: "text", text: implementationBrief(task) }]
        });
        const turnId = extractId(turn, "turn");
        return await this.bindTurnStartResponse(task.id, task.threadId, turnId, pendingStart.nonce);
      } catch (error) {
        await this.abandonPendingTurnStart(task.id, pendingStart.nonce, "turn/start failed before exact binding");
        throw error;
      }
    } catch (error) {
      await this.failTask(this.store.get(task.id) ?? task, error, "task-start");
      throw error;
    }
  }

  async continueTask(input: ContinueTaskInput): Promise<TaskRecord> {
    return this.runTaskOperation(input.taskId, "continue", () => this.continueTaskUnlocked(input));
  }

  private async continueTaskUnlocked(input: ContinueTaskInput): Promise<TaskRecord> {
    this.assertControlEnabled();
    this.assertSurfaceVersion(input.toolSurfaceVersion);
    await this.requireCompatibleRuntime();
    const task = this.getTask(input.taskId);
    const instruction = nonEmptyString(input.instruction, "instruction");
    if (!task.threadId) throw new SupervisorError("INVALID_STATE_TRANSITION", "Task has no Codex thread id", 409);
    if (hasActiveWriter(task) || (task.turnLease && task.turnLease.state !== "terminal") || task.pendingApprovalIds.length) {
      throw new SupervisorError("ACTIVE_WRITER_CONFLICT", "Task already has active work or a pending approval", 409);
    }
    await this.worktrees.validate(worktreeRecord(task));
    if (task.status === "awaiting_verification") {
      transitionTask(task, "needs_correction", {
        reason: "Supervisor explicitly requested another implementation pass",
        source: "task-continue"
      });
    }
    if (!["needs_correction", "interrupted", "failed"].includes(task.status)) {
      throw new SupervisorError(
        "INVALID_STATE_TRANSITION",
        `Task cannot start another turn from ${task.status}`,
        409
      );
    }
    const passes = (task.correctionPasses ?? 0) + 1;
    if (passes > (task.contract?.maxCorrectionPasses ?? 3)) {
      throw new SupervisorError("INVALID_STATE_TRANSITION", "Development Contract correction-pass limit reached", 409);
    }
    task.correctionPasses = passes;
    await this.store.put(task);
    const resumed = await this.client.request("thread/resume", {
      threadId: task.threadId,
      cwd: taskWorktree(task),
      ...CODEX_SUPERVISOR_THREAD_OPTIONS
    });
    task.threadId = extractId(resumed, "thread");
    const pendingStart = await this.registerPendingTurnStart(task);
    try {
      const turn = await this.client.request("turn/start", {
        threadId: task.threadId,
        clientUserMessageId: `supervisor-followup-${randomUUID()}`,
        input: [{ type: "text", text: implementationBrief(task, instruction) }]
      });
      return await this.bindTurnStartResponse(
        task.id,
        task.threadId,
        extractId(turn, "turn"),
        pendingStart.nonce
      );
    } catch (error) {
      await this.abandonPendingTurnStart(task.id, pendingStart.nonce, "turn/start failed before exact binding");
      throw error;
    }
  }

  async steerTask(taskId: string, instruction: string): Promise<TaskRecord> {
    return this.runTaskOperation(taskId, "steer", () => this.steerTaskUnlocked(taskId, instruction));
  }

  private async steerTaskUnlocked(taskId: string, instruction: string): Promise<TaskRecord> {
    this.assertControlEnabled();
    const task = this.getTask(taskId);
    if (!task.threadId || !task.activeTurnId || !hasActiveWriter(task)) {
      throw new SupervisorError("INVALID_STATE_TRANSITION", "Task has no active owned Codex turn", 409);
    }
    if (!task.turnLease || !this.turnLeases.isOwnedActive(task.turnLease.leaseId)) {
      throw new SupervisorError("LEASE_CONFLICT", "Active turn lease is not owned by this Supervisor", 409);
    }
    await this.client.request("turn/steer", {
      threadId: task.threadId,
      expectedTurnId: task.activeTurnId,
      clientUserMessageId: `supervisor-steer-${randomUUID()}`,
      input: [{ type: "text", text: nonEmptyString(instruction, "instruction") }]
    });
    await this.appendEvent(task, "supervisor/turnSteered", { turnId: task.activeTurnId });
    await this.store.put(task);
    this.signal(task.id);
    return task;
  }

  async interruptTask(taskId: string): Promise<TaskRecord> {
    return this.runTaskOperation(taskId, "interrupt", () => this.interruptTaskUnlocked(taskId));
  }

  private async interruptTaskUnlocked(taskId: string): Promise<TaskRecord> {
    this.assertControlEnabled();
    const task = this.getTask(taskId);
    if (!task.threadId || !task.activeTurnId || !hasActiveWriter(task)) {
      throw new SupervisorError("INVALID_STATE_TRANSITION", "Task has no active Codex turn", 409);
    }
    const turnId = task.activeTurnId;
    if (!task.turnLease || !this.turnLeases.isOwnedActive(task.turnLease.leaseId)) {
      throw new SupervisorError("LEASE_CONFLICT", "Active turn lease is not owned by this Supervisor", 409);
    }
    task.turnLease = await this.turnLeases.markState(task.turnLease.leaseId, "interrupting");
    await this.store.put(task);
    await this.client.request("turn/interrupt", { threadId: task.threadId, turnId });
    const terminal = await this.waitForTurnTerminal(task.id, turnId, Math.min(this.config.requestTimeoutMs, 30_000));
    if (!terminal) {
      task.turnLease = await this.turnLeases.markState(task.turnLease.leaseId, "lost");
      task.turnStatus = "failed";
      if (canTransition(task.status, "stale")) {
        transitionTask(task, "stale", {
          reason: "Interrupt request lacked terminal turn evidence",
          source: "task-interrupt",
          turnId
        });
      }
      await this.store.put(task);
      throw new SupervisorError("LEASE_CONFLICT", "Interrupt was not confirmed by terminal turn evidence", 409);
    }
    return this.getTask(task.id);
  }

  async recoverTask(input: { taskId: string; toolSurfaceVersion?: string }): Promise<TaskRecord> {
    return this.runTaskOperation(input.taskId, "recover", () => this.recoverTaskUnlocked(input));
  }

  private async recoverTaskUnlocked(input: { taskId: string; toolSurfaceVersion?: string }): Promise<TaskRecord> {
    this.assertControlEnabled();
    this.assertSurfaceVersion(input.toolSurfaceVersion);
    await this.requireCompatibleRuntime();
    const task = this.getTask(input.taskId);
    const validation = await this.worktrees.validate(worktreeRecord(task));
    if (task.threadId) {
      const remoteThread = await this.client.request("thread/read", {
        threadId: task.threadId,
        includeTurns: true
      });
      const terminal = this.assertThreadTerminalForRecovery(
        remoteThread,
        task.threadId,
        task.turnLease?.turnId ?? task.activeTurnId ?? task.turnId
      );
      if (task.turnLease?.state === "lost") {
        task.turnLease = await this.turnLeases.reconcileTerminal({
          leaseId: task.turnLease.leaseId,
          taskId: task.id,
          threadId: task.threadId,
          turnId: terminal.turnId,
          worktree: validation.worktree
        });
      }
      if (task.pendingTurnStart?.observedTurnId === terminal.turnId) {
        task.pendingTurnStart = undefined;
        task.residualRisks = (task.residualRisks ?? []).filter(
          (risk) => risk !== "prior_runtime_turn_start_unresolved" && risk !== "turn_start_identity_unresolved"
        );
      }
      task.turnStatus = terminal.status;
    } else if (task.turnLease?.state === "lost") {
      throw new SupervisorError(
        "LEASE_CONFLICT",
        "A lost turn lease cannot be reconciled without its recorded Codex thread",
        409
      );
    }
    const snapshot = await captureWorkspaceSnapshot(validation.worktree, task.baseSha ?? "HEAD");
    this.appendSnapshot(task, snapshot);
    if (task.status === "stale") {
      transitionTask(task, "awaiting_verification", {
        reason: "Worktree and persisted Codex thread were read and reconciled without starting a turn",
        source: "task-recover"
      });
    }
    await this.appendEvent(task, "supervisor/taskRecovered", {
      snapshotId: snapshot.snapshotId,
      headSha: snapshot.headSha
    });
    await this.store.put(task);
    this.signal(task.id);
    return task;
  }

  async verifyTask(input: {
    taskId: string;
    profileId: string;
    toolSurfaceVersion?: string;
  }): Promise<VerifierRunV1> {
    return this.runTaskOperation(input.taskId, "verify", () => this.verifyTaskUnlocked(input));
  }

  private async verifyTaskUnlocked(input: {
    taskId: string;
    profileId: string;
    toolSurfaceVersion?: string;
  }): Promise<VerifierRunV1> {
    this.assertControlEnabled();
    this.assertSurfaceVersion(input.toolSurfaceVersion);
    const task = this.getTask(input.taskId);
    if (!this.verificationConfig) {
      throw new SupervisorError("VERIFICATION_CONFIG_INVALID", "Verification configuration is not loaded", 503);
    }
    if (hasActiveWriter(task) || (task.turnLease && task.turnLease.state !== "terminal") || task.pendingApprovalIds.length) {
      throw new SupervisorError("VERIFICATION_NOT_ALLOWED", "Verification requires no active turn or approval", 409);
    }
    if ((task.quarantines ?? []).some((item) => !item.clearedAt)) {
      throw new SupervisorError("QUARANTINED", "Task has an unresolved verifier quarantine", 409);
    }
    if (!["awaiting_verification", "needs_correction"].includes(task.status)) {
      throw new SupervisorError("VERIFICATION_NOT_ALLOWED", `Cannot verify task from ${task.status}`, 409);
    }
    const profileId = nonEmptyString(input.profileId, "profileId");
    selectVerificationRecipes(this.verificationConfig, profileId);
    await this.worktrees.validate(worktreeRecord(task));
    const before = await captureWorkspaceSnapshot(taskWorktree(task), task.baseSha ?? "HEAD");
    this.appendSnapshot(task, before);
    this.assertContractPaths(task, before);
    // Runtime/image absence is environmental and retryable. Probe before the
    // durable task transition so it cannot strand the task in failed/verifying.
    const runtimeBinding = await assertOciRuntimeAvailable(this.verificationConfig.runtime);
    const containerEnvironment = resolveContainerEnvironment(this.verificationConfig.environmentAllowlist);
    transitionTask(task, "verifying", {
      reason: `Starting trusted verification profile ${profileId}`,
      source: "task-verify"
    });
    await this.store.put(task);
    try {
      const run = await runVerification({
        taskId: task.id,
        worktree: taskWorktree(task),
        baseSha: task.baseSha,
        profileId,
        config: this.verificationConfig,
        runtimeBinding,
        containerEnvironment,
        ownerInstanceId: this.instanceId,
        maxOutputChars: this.config.maxVerificationOutputChars ?? 50_000,
        leaseTtlMs: this.config.verifierLeaseTtlMs ?? 20_000,
        onRunUpdate: async (update) => {
          const runs = (task.verificationRuns ??= []);
          const index = runs.findIndex((candidate) => candidate.runId === update.runId);
          if (index >= 0) runs[index] = update;
          else runs.push(update);
          const leases = (task.verifierLeases ??= []);
          const lease = verifierLease(update);
          const leaseIndex = leases.findIndex((candidate) => candidate.leaseId === lease.leaseId);
          if (leaseIndex >= 0) leases[leaseIndex] = lease;
          else leases.push(lease);
          await this.store.put(task);
          this.signal(task.id);
        }
      });
      const after = await captureWorkspaceSnapshot(taskWorktree(task), task.baseSha ?? "HEAD");
      this.appendSnapshot(task, after);
      task.acceptanceEvidence = this.buildAcceptanceEvidence(task, after);
      if (run.state === "lost") {
        const quarantine: QuarantineRecord = {
          quarantineId: randomUUID(),
          scope: "task",
          taskId: task.id,
          worktree: task.worktree,
          runId: run.runId,
          reason: "Verifier worker termination could not be proven",
          createdAt: iso()
        };
        (task.quarantines ??= []).push(quarantine);
        transitionTask(task, "blocked", {
          reason: "Verifier worker was lost and task scope is quarantined",
          source: "task-verify",
          verificationRunId: run.runId
        });
      } else if (run.state === "passed") {
        transitionTask(task, "awaiting_verification", {
          reason: "Trusted verifier passed; explicit supervisor acceptance is still required",
          source: "task-verify",
          verificationRunId: run.runId
        });
      } else {
        transitionTask(task, "needs_correction", {
          reason: `Verifier result requires correction: ${run.state}`,
          source: "task-verify",
          verificationRunId: run.runId
        });
      }
      await this.appendEvent(task, "supervisor/verificationCompleted", {
        runId: run.runId,
        profileId: run.profileId,
        state: run.state,
        beforeSnapshotId: run.beforeSnapshotId,
        afterSnapshotId: run.afterSnapshotId
      });
      await this.store.put(task);
      this.signal(task.id);
      return run;
    } catch (error) {
      if (canTransition(task.status, "failed")) {
        transitionTask(task, "failed", {
          reason: "Verification orchestration failed before durable completion",
          source: "task-verify"
        });
      }
      task.error = redactText(error instanceof Error ? error.message : String(error));
      await this.store.put(task);
      this.signal(task.id);
      throw error;
    }
  }

  async decideTask(input: TaskDecisionInput): Promise<TaskRecord> {
    return this.runTaskOperation(input.taskId, `decision:${input.decision}`, () => this.decideTaskUnlocked(input));
  }

  private async decideTaskUnlocked(input: TaskDecisionInput): Promise<TaskRecord> {
    this.assertControlEnabled();
    this.assertSurfaceVersion(input.toolSurfaceVersion);
    let task = this.getTask(input.taskId);
    const rationale = nonEmptyString(input.rationale, "rationale");
    let decisionSnapshotId = task.snapshots?.at(-1)?.snapshotId;
    let decisionVerificationRunIds = (task.verificationRuns ?? []).map((run) => run.runId);
    if (["block", "cancel"].includes(input.decision) && hasActiveWriter(task)) {
      task = await this.interruptTaskUnlocked(task.id);
    }
    if (input.decision === "accept") {
      await this.worktrees.validate(worktreeRecord(task));
      const expectedSnapshot = task.snapshots?.at(-1);
      if (!expectedSnapshot || input.expectedSnapshotId !== expectedSnapshot.snapshotId) {
        throw new SupervisorError(
          "VERIFICATION_NOT_ALLOWED",
          "Acceptance expectedSnapshotId does not match the latest verification snapshot",
          409
        );
      }
      const liveSnapshot = await captureWorkspaceSnapshot(taskWorktree(task), task.baseSha ?? "HEAD");
      if (!expectedSnapshot || liveSnapshot.snapshotId !== expectedSnapshot.snapshotId) {
        this.appendSnapshot(task, liveSnapshot);
        for (const run of task.verificationRuns ?? []) run.stale = true;
        task.acceptanceEvidence = (task.acceptanceEvidence ?? []).map((entry) => ({
          ...entry,
          satisfied: false
        }));
        if (task.status !== "needs_correction" && canTransition(task.status, "needs_correction")) {
          transitionTask(task, "needs_correction", {
            reason: "Live worktree changed after verification evidence was captured",
            source: "task-decide"
          });
        }
        await this.appendEvent(task, "supervisor/acceptanceSnapshotMismatch", {
          expectedSnapshotId: expectedSnapshot?.snapshotId,
          liveSnapshotId: liveSnapshot.snapshotId
        });
        await this.store.put(task);
        this.signal(task.id);
        throw new SupervisorError(
          "VERIFICATION_NOT_ALLOWED",
          "Worktree changed after verification; acceptance requires a new verification run",
          409
        );
      }
      this.assertContractPaths(task, liveSnapshot);
      const criteria = task.contract?.acceptanceCriteria ?? [];
      const confirmations = new Map<string, string>();
      for (const confirmation of input.criterionConfirmations) {
        const criterionId = nonEmptyString(confirmation.criterionId, "criterionId");
        if (confirmations.has(criterionId)) {
          throw new SupervisorError("INVALID_INPUT", `Duplicate criterion confirmation: ${criterionId}`, 400);
        }
        confirmations.set(criterionId, nonEmptyString(confirmation.evidence, `evidence for ${criterionId}`));
      }
      const expectedCriterionIds = new Set(criteria.map((criterion) => criterion.id));
      const unknown = [...confirmations.keys()].filter((criterionId) => !expectedCriterionIds.has(criterionId));
      const missing = criteria.filter((criterion) => !confirmations.has(criterion.id)).map((criterion) => criterion.id);
      if (unknown.length > 0 || missing.length > 0 || confirmations.size !== criteria.length) {
        throw new SupervisorError(
          "VERIFICATION_NOT_ALLOWED",
          "Acceptance confirmations must exactly cover every Development Contract criterion",
          409,
          { unknownCriterionIds: unknown, missingCriterionIds: missing }
        );
      }
      const candidates = new Map((task.acceptanceEvidence ?? []).map((entry) => [entry.criterionId, entry]));
      task.acceptanceEvidence = criteria.map((criterion) => {
        const candidate = candidates.get(criterion.id);
        if (
          !candidate ||
          candidate.snapshotId !== liveSnapshot.snapshotId ||
          candidate.verificationRunIds.length === 0
        ) {
          throw new SupervisorError(
            "VERIFICATION_NOT_ALLOWED",
            `Criterion ${criterion.id} has no current snapshot-bound verification candidate`,
            409
          );
        }
        return {
          ...candidate,
          description: criterion.description,
          evidencePlan: confirmations.get(criterion.id)!,
          satisfied: true,
          observedAt: iso()
        };
      });
      decisionSnapshotId = liveSnapshot.snapshotId;
      decisionVerificationRunIds = [...new Set(
        task.acceptanceEvidence.flatMap((entry) => entry.verificationRunIds)
      )];
    }
    const decision: SupervisorDecision = {
      decisionId: randomUUID(),
      decision: input.decision,
      rationale,
      acceptedRisks: (input.acceptedRisks ?? []).map((risk) => nonEmptyString(risk, "acceptedRisk")),
      snapshotId: decisionSnapshotId,
      verificationRunIds: decisionVerificationRunIds,
      at: iso()
    };
    (task.decisions ??= []).push(decision);
    task.residualRisks = [...new Set([...(task.residualRisks ?? []), ...decision.acceptedRisks])];
    if (input.decision === "accept") {
      transitionTask(task, "ready_for_human_review", {
        reason: rationale,
        source: "task-decide",
        decisionId: decision.decisionId
      });
    } else if (input.decision === "request_changes") {
      if (task.status !== "needs_correction") {
        transitionTask(task, "needs_correction", {
          reason: rationale,
          source: "task-decide",
          decisionId: decision.decisionId
        });
      }
      await this.store.put(task);
      return this.continueTaskUnlocked({
        taskId: task.id,
        instruction: nonEmptyString(input.instruction, "instruction"),
        toolSurfaceVersion: input.toolSurfaceVersion
      });
    } else if (input.decision === "block") {
      transitionTask(task, "blocked", {
        reason: rationale,
        source: "task-decide",
        decisionId: decision.decisionId
      });
    } else {
      transitionTask(task, "cancelled", {
        reason: rationale,
        source: "task-decide",
        decisionId: decision.decisionId
      });
    }
    await this.appendEvent(task, "supervisor/taskDecision", decision);
    await this.store.put(task);
    this.signal(task.id);
    return task;
  }

  async cleanupTask(input: { taskId: string; toolSurfaceVersion?: string }): Promise<Record<string, unknown>> {
    return this.runTaskOperation(input.taskId, "cleanup", () => this.cleanupTaskUnlocked(input));
  }

  private async cleanupTaskUnlocked(input: { taskId: string; toolSurfaceVersion?: string }): Promise<Record<string, unknown>> {
    this.assertControlEnabled();
    this.assertSurfaceVersion(input.toolSurfaceVersion);
    const task = this.getTask(input.taskId);
    if (!isCleanupEligible(task)) {
      throw new SupervisorError("INVALID_STATE_TRANSITION", "Task is not eligible for worktree cleanup", 409);
    }
    const cleaned = await this.worktrees.cleanup(worktreeRecord(task));
    await this.appendEvent(task, "supervisor/worktreeCleaned", {
      worktree: cleaned.worktree,
      branch: cleaned.branch
    });
    task.worktree = undefined;
    task.workspace = task.sourceWorkspace ?? task.workspace;
    await this.store.put(task);
    this.signal(task.id);
    return redact({ taskId: task.id, removedWorktree: cleaned.worktree, retainedBranch: cleaned.branch });
  }

  async reconcileVerifier(input: {
    runId: string;
    taskId?: string;
    toolSurfaceVersion?: string;
  }): Promise<ReconciliationProof> {
    const runId = nonEmptyString(input.runId, "runId");
    const owner = this.store.list().find((task) =>
      (task.verificationRuns ?? []).some((run) => run.runId === runId)
    );
    if (!owner) throw new SupervisorError("NOT_FOUND", `No owned verifier run for runId ${runId}`, 404);
    return this.runTaskOperation(owner.id, "verifier-reconcile", () => this.reconcileVerifierUnlocked(input));
  }

  private async reconcileVerifierUnlocked(input: {
    runId: string;
    taskId?: string;
    toolSurfaceVersion?: string;
  }): Promise<ReconciliationProof> {
    this.assertControlEnabled();
    this.assertSurfaceVersion(input.toolSurfaceVersion);
    const runId = nonEmptyString(input.runId, "runId");
    const matches = this.store.list().flatMap((task) =>
      (task.verificationRuns ?? [])
        .filter((run) => run.runId === runId)
        .map((run) => ({ task, run }))
    );
    if (matches.length !== 1) {
      throw new SupervisorError("NOT_FOUND", `No unique owned verifier run for runId ${runId}`, 404);
    }
    const { task, run } = matches[0];
    if (input.taskId && input.taskId !== task.id) {
      throw new SupervisorError("LEASE_CONFLICT", "taskId does not own the selected verifier run", 409);
    }
    const lease = (task.verifierLeases ?? []).find((candidate) => candidate.runId === runId);
    const isQuarantinedReobservation =
      run.state === "running" &&
      (task.quarantines ?? []).some((entry) => entry.runId === runId && !entry.clearedAt);
    if (
      (!["lost", "quarantined"].includes(run.state) && !isQuarantinedReobservation) ||
      Date.parse(run.leaseExpiresAt) > Date.now() ||
      (lease && lease.state !== "lost")
    ) {
      throw new SupervisorError(
        "LEASE_CONFLICT",
        "Verifier reconciliation requires an expired lost/quarantined (or previously re-observed running) exact run and lost lease",
        409
      );
    }
    const reconciled = await reconcileVerifierRun(
      run,
      task.quarantines ?? [],
      this.verificationConfig?.runtime
    );
    const proof = reconciled.proof;
    const runIndex = task.verificationRuns!.findIndex((candidate) => candidate.runId === runId);
    task.verificationRuns![runIndex] = reconciled.run;
    if (
      proof.result === "PROVEN_TERMINATED" &&
      ["starting", "running", "terminating", "lost", "quarantined"].includes(task.verificationRuns![runIndex]!.state)
    ) {
      task.verificationRuns![runIndex] = {
        ...task.verificationRuns![runIndex]!,
        state: "failed",
        completedAt: proof.observedAt
      };
    }
    task.quarantines = reconciled.quarantines;
    if (lease && proof.result === "PROVEN_TERMINATED") {
      lease.state = "terminal";
      lease.heartbeatAt = proof.observedAt;
      lease.expiresAt = proof.observedAt;
    } else if (lease && proof.result === "PROVEN_STILL_RUNNING") {
      lease.state = "lost";
      lease.heartbeatAt = proof.observedAt;
      lease.expiresAt = proof.observedAt;
    }
    if (
      proof.result === "PROVEN_STILL_RUNNING" &&
      !(task.quarantines ?? []).some((quarantine) => quarantine.runId === runId && !quarantine.clearedAt)
    ) {
      (task.quarantines ??= []).push({
        quarantineId: randomUUID(),
        scope: "task",
        taskId: task.id,
        worktree: task.worktree,
        runId,
        reason: "Verifier reconciliation proved the worker is still running",
        createdAt: proof.observedAt
      });
    }
    (task.reconciliationProofs ??= []).push(proof);
    if (
      proof.result === "PROVEN_TERMINATED" &&
      !(task.quarantines ?? []).some((quarantine) => !quarantine.clearedAt) &&
      task.status === "blocked" &&
      ["task-verify", "startup-recovery"].includes(task.statusHistory?.at(-1)?.source ?? "") &&
      canTransition(task.status, "awaiting_verification")
    ) {
      transitionTask(task, "awaiting_verification", {
        reason: "Exact verifier run was proven terminated and its scoped quarantine was cleared",
        source: "verifier-reconcile",
        verificationRunId: runId
      });
    }
    await this.appendEvent(task, "supervisor/verifierReconciled", proof);
    await this.store.put(task);
    this.signal(task.id);
    return proof;
  }

  getEvents(taskId: string, afterSeq = 0): SupervisorEvent[] {
    return this.getTask(taskId).events.filter((event) => event.seq > afterSeq).map((event) => redact(event));
  }

  listApprovals(taskId?: string): PendingApproval[] {
    return [...this.approvals.values()]
      .filter((approval) => !taskId || this.findTaskByThread(approval.threadId)?.id === taskId)
      .map((approval) => redact(approval));
  }

  async decideApproval(
    approvalId: string,
    decision: "accept" | "decline" | "cancel",
    taskId?: string
  ): Promise<PendingApproval> {
    const approval = this.approvals.get(approvalId);
    if (!approval) throw new SupervisorError("NOT_FOUND", `Unknown or resolved approval: ${approvalId}`, 404);
    const task = this.findTaskByThread(approval.threadId);
    if (!task) throw new SupervisorError("NOT_FOUND", "Approval no longer belongs to a supervised task", 404);
    return this.runTaskOperation(task.id, "approval-decision", () =>
      this.decideApprovalUnlocked(approvalId, decision, taskId)
    );
  }

  private async decideApprovalUnlocked(
    approvalId: string,
    decision: "accept" | "decline" | "cancel",
    taskId?: string
  ): Promise<PendingApproval> {
    this.assertControlEnabled();
    const approval = this.approvals.get(approvalId);
    if (!approval) throw new SupervisorError("NOT_FOUND", `Unknown or resolved approval: ${approvalId}`, 404);
    const task = this.findTaskByThread(approval.threadId);
    if (!task) throw new SupervisorError("NOT_FOUND", "Approval no longer belongs to a supervised task", 404);
    if (taskId && taskId !== task.id) {
      throw new SupervisorError("LEASE_CONFLICT", "taskId does not own the selected approval", 409);
    }
    const exactOwnedLease = Boolean(
      task.status === "waiting_approval" &&
      task.pendingApprovalIds.includes(approvalId) &&
      task.threadId === approval.threadId &&
      task.activeTurnId === approval.turnId &&
      task.turnLease &&
      task.turnLease.threadId === approval.threadId &&
      task.turnLease.turnId === approval.turnId &&
      this.turnLeases.isOwnedActive(task.turnLease.leaseId)
    );
    if (!exactOwnedLease) {
      try {
        await this.client.respondError(approval.requestId, -32602, "Approval lost exact owned active turn authority");
      } catch {
        // Best effort: the request may already have been closed by App Server.
      }
      this.approvals.delete(approvalId);
      task.pendingApprovalIds = task.pendingApprovalIds.filter((id) => id !== approvalId);
      await this.appendEvent(task, "supervisor/approvalInvalidated", { approvalId, reason: "lease authority lost" });
      await this.loseTurnOwnership(task, "Approval decision attempted without exact active lease authority", "approval-decide");
      throw new SupervisorError("LEASE_CONFLICT", "Approval no longer has exact active turn authority", 409);
    }
    if (approval.risk === "blocked" && decision === "accept") {
      throw new SupervisorError(
        "INVALID_INPUT",
        `Approval is hard-blocked by local policy: ${approval.riskReasons.join("; ")}`,
        403
      );
    }
    try {
      await this.client.respond(approval.requestId, { decision });
    } catch (error) {
      this.approvals.delete(approvalId);
      task.pendingApprovalIds = task.pendingApprovalIds.filter((id) => id !== approvalId);
      await this.appendEvent(task, "supervisor/approvalInvalidated", {
        approvalId,
        reason: "approval response transport failed"
      });
      await this.loseTurnOwnership(
        task,
        `Approval response could not be delivered: ${redactText(error instanceof Error ? error.message : String(error))}`,
        "approval-decide"
      );
      throw new SupervisorError(
        "LEASE_CONFLICT",
        "Approval response delivery was not proven; turn authority was revoked",
        409,
        { approvalId },
        { cause: error }
      );
    }
    this.approvals.delete(approvalId);
    task.pendingApprovalIds = task.pendingApprovalIds.filter((id) => id !== approvalId);
    if (task.pendingApprovalIds.length === 0 && task.status === "waiting_approval") {
      transitionTask(task, "running", {
        reason: "All pending approvals were resolved",
        source: "approval-decide",
        turnId: task.activeTurnId
      });
    }
    await this.appendEvent(task, "supervisor/approvalDecided", { approvalId, decision });
    await this.store.put(task);
    this.signal(task.id);
    return redact(approval);
  }

  async getWorkspaceStatus(taskId: string): Promise<string> {
    return redactText(await workspaceStatus(taskWorktree(this.getTask(taskId))));
  }

  async getWorkspaceDiff(taskId: string): Promise<{ truncated: boolean; text: string }> {
    const diff = await workspaceDiff(taskWorktree(this.getTask(taskId)), this.config.maxDiffChars);
    return { ...diff, text: redactText(diff.text) };
  }

  async waitForChange(taskId: string, afterSeq: number, timeoutMs: number): Promise<TaskRecord> {
    const task = this.getTask(taskId);
    if (
      task.eventSeq > afterSeq ||
      ["ready_for_human_review", "blocked", "failed", "interrupted", "cancelled", "stale", "waiting_approval"].includes(task.status)
    ) {
      return task;
    }
    await new Promise<void>((resolve) => {
      const bucket = this.waiters.get(taskId) ?? new Set<() => void>();
      const done = () => {
        clearTimeout(timer);
        bucket.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.min(Math.max(timeoutMs, 1), 25_000));
      bucket.add(done);
      this.waiters.set(taskId, bucket);
    });
    return this.getTask(taskId);
  }

  private enqueueProtocolWork(
    kind: "notification" | "serverRequest" | "exit" | "processError" | "protocolError",
    payload: unknown,
    operation: () => Promise<void>
  ): void {
    if (this.protocolEventsClosed) return;
    const execute = async () => {
      try {
        await operation();
      } catch (error) {
        await this.handleProtocolHandlerFailure(kind, payload, error).catch((nested) => {
          console.error("[supervisor] fail-closed protocol handling failed", redactText(String(nested)));
        });
      }
    };
    this.notificationQueue = this.notificationQueue.then(execute, execute);
  }

  private async handleProtocolHandlerFailure(
    kind: "notification" | "serverRequest" | "exit" | "processError" | "protocolError",
    payload: unknown,
    error: unknown
  ): Promise<void> {
    const reason = `${kind} handler failed: ${redactText(error instanceof Error ? error.message : String(error))}`;
    console.error("[supervisor]", reason);
    const envelope = record(payload);
    if (kind === "serverRequest") {
      const request = payload as RpcRequest;
      try {
        await this.client.respondError(request.id, -32603, "Supervisor rejected request after an internal fail-closed error");
      } catch {
        // The transport may already be closed.
      }
    }
    const params = record(envelope.params);
    const nestedTurn = record(params.turn);
    const turnId = typeof params.turnId === "string"
      ? params.turnId
      : typeof nestedTurn.id === "string"
        ? nestedTurn.id
        : undefined;
    const threadId = typeof params.threadId === "string"
      ? params.threadId
      : typeof nestedTurn.threadId === "string"
        ? nestedTurn.threadId
        : undefined;
    const task = this.findTaskByTurn(turnId) ?? this.findTaskByThread(threadId);
    if (task) {
      await this.loseTurnOwnership(task, reason, `protocol-${kind}`);
      return;
    }
    const pending = this.pendingTurnStart;
    if (pending && (!threadId || pending.record.threadId === threadId)) {
      await this.abandonPendingTurnStart(pending.record.taskId, pending.record.nonce, reason);
      if (!["exit", "processError", "protocolError"].includes(kind)) return;
    }
    if (["exit", "processError", "protocolError"].includes(kind)) {
      await this.markActiveTasksStale(reason);
    }
  }

  private async drainProtocolQueue(): Promise<void> {
    while (true) {
      const observed = this.notificationQueue;
      await observed;
      if (observed === this.notificationQueue) return;
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  private async stopInternal(): Promise<void> {
    this.stopping = true;
    this.initialized = false;
    this.watchdog.stop();
    let failure: unknown;
    try {
      await this.client.stop();
    } catch (error) {
      failure = error;
    }
    try {
      await this.drainProtocolQueue();
      await this.drainTaskOperations();
      await this.drainProtocolQueue();
      await this.markActiveTasksStale("Supervisor stopped before a terminal turn proof was retained");
      await this.store.flush();
    } catch (error) {
      failure ??= error;
    } finally {
      this.protocolEventsClosed = true;
      try {
        await this.instanceLock.release();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }

  private assertControlEnabled(): void {
    if (this.stopping) {
      throw new SupervisorError("RUNTIME_UNAVAILABLE", "Supervisor is stopping and no longer accepts control operations", 503);
    }
    if (!this.config.controlEnabled) {
      throw new SupervisorError("INVALID_INPUT", "Supervisor is running with control tools disabled", 403);
    }
    const runtime = this.runtimeCapabilities;
    if (!runtime?.compatible) {
      throw new SupervisorError(
        runtime?.error ? "RUNTIME_UNAVAILABLE" : "PROTOCOL_INCOMPATIBLE",
        runtime?.error ?? "Codex App Server compatibility is unknown or incompatible; control is fail-closed",
        503,
        runtime?.capabilities
          ? {
              missingMethods: runtime.capabilities.missingMethods,
              shapeErrors: runtime.capabilities.shapeErrors
            }
          : undefined
      );
    }
  }

  private async runTaskOperation<T>(taskId: string, name: string, operation: () => Promise<T>): Promise<T> {
    const active = this.taskOperations.get(taskId);
    if (active) {
      throw new SupervisorError(
        "ACTIVE_WRITER_CONFLICT",
        `Task operation ${active.name} is already in progress`,
        409,
        { taskId, activeOperation: active.name, requestedOperation: name }
      );
    }
    let release!: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });
    const state: TaskOperationState = { name, token: randomUUID(), done, release };
    this.taskOperations.set(taskId, state);
    try {
      return await operation();
    } finally {
      if (this.taskOperations.get(taskId)?.token === state.token) this.taskOperations.delete(taskId);
      state.release();
    }
  }

  private async waitForTaskOperation(taskId: string, method: string): Promise<void> {
    const active = this.taskOperations.get(taskId);
    if (!active || this.replayingPendingStartTaskId === taskId) return;
    if (
      active.name === "start" &&
      ["thread/started", "mcpServer/startupStatus/updated"].includes(method)
    ) {
      // App Server can emit these non-authoritative thread startup telemetry
      // notifications immediately after thread/start responds. Waiting for the
      // enclosing start operation here would deadlock that operation when it
      // later drains the protocol queue before binding the exact turn id.
      return;
    }
    if (
      method === "turn/completed" &&
      ["interrupt", "decision:block", "decision:cancel"].includes(active.name)
    ) {
      return;
    }
    await active.done;
  }

  private async drainTaskOperations(): Promise<void> {
    while (this.taskOperations.size > 0 || this.startupOperations.size > 0) {
      await Promise.all([
        ...[...this.taskOperations.values()].map((operation) => operation.done),
        ...this.startupOperations
      ]);
    }
  }

  private assertSurfaceVersion(value: unknown): void {
    if (value !== undefined && value !== TOOL_SURFACE_VERSION) {
      throw new SupervisorError(
        "INVALID_INPUT",
        `Tool surface version mismatch: expected ${TOOL_SURFACE_VERSION}`,
        409
      );
    }
  }

  private async refreshRuntimeCapabilities(): Promise<RuntimeCapabilityState> {
    if (this.runtimeProbePromise) return this.runtimeProbePromise;
    this.runtimeProbePromise = (async () => {
      try {
        const result = await this.runtimeProbe({
          codexBin: this.config.codexBin,
          timeoutMs: Math.max(this.config.readinessTimeoutMs, 15_000),
          experimentalApi: this.config.codexExperimentalApi
        });
        return {
          checkedAt: iso(),
          compatible: result.capabilities.compatible,
          commandSource: this.config.codexBinSource,
          version: result.version,
          schemaHash: result.schemaHash,
          schemaFileCount: result.schemaFileCount,
          capabilities: result.capabilities
        } satisfies RuntimeCapabilityState;
      } catch (error) {
        return {
          checkedAt: iso(),
          compatible: false,
          commandSource: this.config.codexBinSource,
          error: redactText(error instanceof Error ? error.message : String(error))
        } satisfies RuntimeCapabilityState;
      }
    })();
    try {
      this.runtimeCapabilities = await this.runtimeProbePromise;
      return this.runtimeCapabilities;
    } finally {
      this.runtimeProbePromise = undefined;
    }
  }

  private async validateRuntimeBindingForGeneration(generation: number): Promise<ProtocolRuntimeBinding> {
    try {
      const result = await this.runtimeProbe({
        codexBin: this.config.codexBin,
        timeoutMs: Math.max(this.config.readinessTimeoutMs, 15_000),
        experimentalApi: this.config.codexExperimentalApi
      });
      this.runtimeCapabilities = {
        checkedAt: iso(),
        compatible: result.capabilities.compatible,
        commandSource: this.config.codexBinSource,
        version: result.version,
        schemaHash: result.schemaHash,
        schemaFileCount: result.schemaFileCount,
        capabilities: result.capabilities,
        connectionGeneration: generation
      };
      if (!result.capabilities.compatible || !result.binding) {
        throw new SupervisorError(
          "PROTOCOL_INCOMPATIBLE",
          `Codex connection generation ${generation} failed fresh protocol binding validation`,
          503,
          { missingMethods: result.capabilities.missingMethods }
        );
      }
      return result.binding;
    } catch (error) {
      const message = redactText(error instanceof Error ? error.message : String(error));
      this.runtimeCapabilities = {
        checkedAt: iso(),
        compatible: false,
        commandSource: this.config.codexBinSource,
        connectionGeneration: generation,
        error: message
      };
      if (error instanceof SupervisorError) throw error;
      throw new SupervisorError(
        "RUNTIME_UNAVAILABLE",
        `Codex connection generation ${generation} protocol probe failed: ${message}`,
        503,
        undefined,
        { cause: error }
      );
    }
  }

  private async requireCompatibleRuntime(): Promise<void> {
    const runtime = this.runtimeCapabilities ?? await this.refreshRuntimeCapabilities();
    if (!runtime.compatible) {
      throw new SupervisorError(
        runtime.error ? "RUNTIME_UNAVAILABLE" : "PROTOCOL_INCOMPATIBLE",
        runtime.error ?? "Codex App Server is missing required stable protocol capabilities",
        503,
        runtime.capabilities ? { missingMethods: runtime.capabilities.missingMethods } : undefined
      );
    }
  }

  private async beginTurn(task: TaskRecord, turnId: string): Promise<void> {
    if (!task.threadId || !task.worktree) {
      throw new SupervisorError("INVALID_STATE_TRANSITION", "Cannot start a turn without thread/worktree ownership", 409);
    }
    task.activeTurnId = turnId;
    task.turnId = turnId;
    task.turnStatus = "in_progress";
    task.acceptanceEvidence = [];
    for (const run of task.verificationRuns ?? []) run.stale = true;
    const turn: TurnRecord = {
      turnId,
      threadId: task.threadId,
      status: "in_progress",
      startedAt: iso()
    };
    (task.turnHistory ??= []).push(turn);
    task.turnLease = await this.turnLeases.acquire({
      taskId: task.id,
      threadId: task.threadId,
      turnId,
      worktree: task.worktree
    });
    turn.leaseId = task.turnLease.leaseId;
    if (task.status !== "running") {
      transitionTask(task, "running", {
        reason: "Codex turn started with an owned Turn Lease",
        source: "codex-turn",
        turnId
      });
    }
    await this.appendEvent(task, "supervisor/turnLeaseAcquired", {
      leaseId: task.turnLease.leaseId,
      turnId
    });
    await this.store.put(task);
    this.signal(task.id);
  }

  private async onServerRequest(request: RpcRequest): Promise<void> {
    const params = request.params ?? {};
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
    const task = this.findTaskByThread(threadId);
    if (!task) {
      await this.client.respondError(request.id, -32602, `No supervised task for Codex thread: ${threadId ?? "unknown"}`);
      return;
    }
    let activeOperation = this.taskOperations.get(task.id);
    if (activeOperation?.name === "approval-decision") {
      // App Server may synchronously issue its next approval as soon as it
      // receives the prior single-use response. That request belongs to the
      // same exact owned turn; queue it until the prior decision has been
      // durably recorded instead of treating normal request chaining as a
      // writer conflict. No response or authority is granted by this wait.
      await activeOperation.done;
      activeOperation = this.taskOperations.get(task.id);
    }
    if (activeOperation) {
      await this.client.respondError(request.id, -32602, `Task operation ${activeOperation.name} is in progress`);
      const pending = this.pendingTurnStart;
      if (pending?.record.taskId === task.id) {
        await this.abandonPendingTurnStart(task.id, pending.record.nonce, "Server request raced an unbound turn/start");
      } else if (task.turnLease && this.turnLeases.isOwnedActive(task.turnLease.leaseId)) {
        await this.loseTurnOwnership(task, "Server request raced an atomic supervisor operation", "approval-ownership");
      }
      return;
    }
    if (!turnId || !task.activeTurnId || turnId !== task.activeTurnId) {
      await this.client.respondError(request.id, -32602, "Approval request does not belong to the active supervised turn");
      await this.loseTurnOwnership(
        task,
        `Approval request turn mismatch: expected ${task.activeTurnId ?? "none"}, received ${turnId ?? "missing"}`,
        "approval-ownership"
      );
      return;
    }
    const exactOwnedLease = Boolean(
      ["running", "waiting_approval"].includes(task.status) &&
      task.turnLease &&
      task.turnLease.threadId === threadId &&
      task.turnLease.turnId === turnId &&
      this.turnLeases.isOwnedActive(task.turnLease.leaseId)
    );
    if (!exactOwnedLease) {
      await this.client.respondError(request.id, -32602, "Approval request has no exact current-instance active turn lease");
      await this.loseTurnOwnership(task, "Approval request arrived after exact turn lease authority was lost", "approval-ownership");
      return;
    }
    if (request.method === "item/permissions/requestApproval") {
      await this.client.respond(request.id, { scope: "turn", permissions: {} });
      await this.appendEvent(task, request.method, { supervisorDecision: "denyAdditionalPermissions" });
      await this.store.put(task);
      this.signal(task.id);
      return;
    }
    const supported =
      request.method === "item/commandExecution/requestApproval" ||
      request.method === "item/fileChange/requestApproval";
    if (!supported) {
      await this.client.respondError(request.id, -32601, `Unsupported Codex server request: ${request.method}`);
      return;
    }
    const risk = classifyApproval(request.method, params, taskWorktree(task));
    const approval: PendingApproval = {
      approvalId: randomUUID(),
      requestId: request.id,
      method: request.method,
      threadId,
      turnId,
      params: redact(params),
      risk: risk.risk,
      riskReasons: risk.reasons,
      createdAt: iso()
    };
    this.approvals.set(approval.approvalId, approval);
    task.pendingApprovalIds.push(approval.approvalId);
    if (task.status === "running") {
      transitionTask(task, "waiting_approval", {
        reason: "Codex requested an exact supervised approval",
        source: request.method,
        turnId
      });
    }
    await this.appendEvent(task, `serverRequest:${request.method}`, {
      approvalId: approval.approvalId,
      method: approval.method,
      risk
    });
    await this.store.put(task);
    this.signal(task.id);
  }

  private async onNotification(message: unknown): Promise<void> {
    const envelope = record(message);
    const method = typeof envelope.method === "string" ? envelope.method : "unknown";
    const params = record(envelope.params);
    const nestedTurn = record(params.turn);
    const turnId = typeof params.turnId === "string"
      ? params.turnId
      : typeof nestedTurn.id === "string"
        ? nestedTurn.id
        : undefined;
    const threadId = typeof params.threadId === "string"
      ? params.threadId
      : typeof record(params.thread).id === "string"
        ? String(record(params.thread).id)
        : typeof nestedTurn.threadId === "string"
          ? nestedTurn.threadId
          : undefined;
    if (await this.maybeBufferPendingTurnNotification(message, method, turnId, threadId)) return;
    let task = this.findTaskByTurn(turnId) ?? this.findTaskByThread(threadId);
    if (!task) return;
    await this.waitForTaskOperation(task.id, method);
    task = this.findTaskByTurn(turnId) ?? this.findTaskByThread(threadId);
    if (!task) return;

    if (method === "turn/started") {
      if (typeof turnId === "string") {
        if (task.activeTurnId && task.activeTurnId !== turnId) {
          await this.loseTurnOwnership(
            task,
            `turn/started id mismatch: expected ${task.activeTurnId}, received ${turnId}`,
            "turn/started"
          );
          return;
        }
        if (task.turnLease && task.turnLease.turnId !== turnId) {
          await this.loseTurnOwnership(task, "turn/started did not match the owned Turn Lease", "turn/started");
          return;
        }
        if (!task.activeTurnId) {
          task.activeTurnId = turnId;
          task.turnId = turnId;
          task.turnStatus = "in_progress";
        }
        if (task.turnLease) await this.turnLeases.heartbeat(task.turnLease.leaseId, new Date(), true).catch(() => undefined);
      }
      if (task.status === "preparing" && task.activeTurnId && task.threadId && task.worktree && !task.turnLease) {
        await this.beginTurn(task, task.activeTurnId);
      }
    } else if (method === "turn/completed") {
      const completedTurnId = record(params.turn).id;
      if (
        typeof completedTurnId !== "string" ||
        !task.activeTurnId ||
        completedTurnId !== task.activeTurnId ||
        (task.turnLease && task.turnLease.turnId !== completedTurnId)
      ) {
        await this.loseTurnOwnership(
          task,
          `turn/completed ownership mismatch: expected ${task.activeTurnId ?? "none"}, received ${String(completedTurnId ?? "missing")}`,
          "turn/completed"
        );
        return;
      }
      await this.completeTurn(task, params);
    } else if (method === "serverRequest/resolved") {
      const requestId = params.requestId;
      for (const [approvalId, approval] of this.approvals) {
        if (String(approval.requestId) === String(requestId)) {
          this.approvals.delete(approvalId);
          task.pendingApprovalIds = task.pendingApprovalIds.filter((id) => id !== approvalId);
        }
      }
      if (task.pendingApprovalIds.length === 0 && task.status === "waiting_approval") {
        transitionTask(task, "running", {
          reason: "Codex reported all server requests resolved",
          source: method,
          turnId: task.activeTurnId
        });
      }
    } else if (method === "item/completed") {
      const item = record(params.item);
      if (item.type === "agentMessage" && typeof item.text === "string") task.lastAgentMessage = redactText(item.text);
    } else if (method === "error") {
      const error = record(params.error);
      task.error = redactText(typeof error.message === "string" ? error.message : JSON.stringify(error));
    } else if (
      method.startsWith("item/") ||
      method === "thread/started" ||
      method === "thread/status/changed" ||
      method === "turn/diff/updated" ||
      method === "turn/plan/updated"
    ) {
      // These notifications carry observable progress only. They still renew
      // the exact owned lease and are persisted below after redaction.
    } else {
      // Unknown notifications are untrusted telemetry: retain a bounded,
      // redacted audit record, but neither renew nor revoke writer ownership.
      await this.appendEvent(task, `unrecognized:${method}`, params);
      await this.store.put(task);
      this.signal(task.id);
      return;
    }
    if (task.turnLease && ["active", "suspect", "interrupting"].includes(task.turnLease.state)) {
      task.turnLease = await this.turnLeases.heartbeat(task.turnLease.leaseId, new Date(), method === "turn/completed")
        .catch(() => task.turnLease);
    }
    await this.appendEvent(task, method, params);
    await this.store.put(task);
    this.signal(task.id);
  }

  private async maybeBufferPendingTurnNotification(
    message: unknown,
    method: string,
    turnId?: string,
    threadId?: string
  ): Promise<boolean> {
    const pending = this.pendingTurnStart;
    if (!pending) return false;
    const exactThread = threadId === pending.record.threadId;
    const alreadyOwnedTask = turnId ? this.findTaskByTurn(turnId) : undefined;
    if (alreadyOwnedTask?.id === pending.record.taskId) {
      pending.deferredPriorTurnTelemetry.push(message);
      return true;
    }
    const orderedThreadlessTurn =
      !threadId &&
      Boolean(turnId) &&
      !alreadyOwnedTask &&
      (method.startsWith("turn/") || turnId === pending.record.observedTurnId);
    if (!exactThread && !orderedThreadlessTurn) return false;
    if (turnId && pending.record.observedTurnId && pending.record.observedTurnId !== turnId) {
      await this.abandonPendingTurnStart(
        pending.record.taskId,
        pending.record.nonce,
        "Buffered turn notification conflicted with the pending start identity"
      );
      throw new SupervisorError("LEASE_CONFLICT", "Conflicting turn ids arrived while turn/start was pending", 409);
    }
    if (turnId && !pending.record.observedTurnId) {
      pending.record.observedTurnId = turnId;
      const task = this.store.get(pending.record.taskId);
      if (task?.pendingTurnStart?.nonce === pending.record.nonce) {
        task.pendingTurnStart.observedTurnId = turnId;
        await this.store.put(task);
      }
    }
    pending.bufferedNotifications.push(message);
    return true;
  }

  private async completeTurn(task: TaskRecord, params: Record<string, unknown>): Promise<void> {
    const turn = record(params.turn);
    const turnId = typeof turn.id === "string" ? turn.id : task.activeTurnId;
    const rawStatus = typeof turn.status === "string" ? turn.status : undefined;
    if (!rawStatus || !["completed", "failed", "interrupted"].includes(rawStatus)) {
      await this.loseTurnOwnership(
        task,
        `Codex emitted turn/completed with unknown terminal status: ${rawStatus ?? "missing"}`,
        "turn/completed"
      );
      return;
    }
    const status = rawStatus as "completed" | "failed" | "interrupted";
    let completionSnapshot: WorkspaceSnapshot | undefined;
    if (status === "completed") {
      try {
        completionSnapshot = await captureWorkspaceSnapshot(taskWorktree(task), task.baseSha ?? "HEAD");
      } catch (error) {
        await this.loseTurnOwnership(
          task,
          `Terminal turn snapshot failed: ${redactText(error instanceof Error ? error.message : String(error))}`,
          "turn/completed"
        );
        throw new SupervisorError(
          "WORKTREE_INVALID",
          "Terminal turn could not be bound to a durable workspace snapshot",
          409,
          { taskId: task.id, turnId }
        );
      }
    }
    task.turnStatus = status;
    const history = (task.turnHistory ?? []).find((candidate) => candidate.turnId === turnId);
    if (history) {
      history.status = status;
      history.completedAt = iso();
      if (status === "failed") history.error = redactText(String(record(turn.error).message ?? "Codex turn failed"));
    }
    if (task.turnLease) {
      try {
        task.turnLease = await this.turnLeases.markState(task.turnLease.leaseId, "terminal");
      } catch (error) {
        await this.loseTurnOwnership(task, "Terminal turn lease could not be durably closed", "turn/completed");
        throw error;
      }
    }
    await this.clearApprovalsForThread(task.threadId);
    task.pendingApprovalIds = [];
    if (task.status === "waiting_approval") {
      transitionTask(task, "running", {
        reason: "Turn ended and its pending approvals are no longer live",
        source: "turn/completed",
        turnId
      });
    }
    if (task.status === "preparing") {
      transitionTask(task, "running", {
        reason: "Observed terminal turn after a missed start notification",
        source: "turn/completed",
        turnId
      });
    }
    if (status === "interrupted" && canTransition(task.status, "interrupted")) {
      transitionTask(task, "interrupted", {
        reason: "Codex reported the active turn interrupted",
        source: "turn/completed",
        turnId
      });
    } else if (status === "failed" && canTransition(task.status, "failed")) {
      transitionTask(task, "failed", {
        reason: "Codex reported the active turn failed",
        source: "turn/completed",
        turnId
      });
    } else if (status === "completed" && canTransition(task.status, "awaiting_verification")) {
      if (!completionSnapshot) {
        throw new SupervisorError("WORKTREE_INVALID", "Terminal snapshot was not captured", 409);
      }
      this.appendSnapshot(task, completionSnapshot);
      transitionTask(task, "awaiting_verification", {
        reason: "Codex turn completed; independent verification and explicit acceptance remain",
        source: "turn/completed",
        turnId
      });
    }
    const items = Array.isArray(turn.items) ? turn.items : [];
    const finalMessage = items.map(record).find((item) => item.type === "agentMessage")?.text;
    if (typeof finalMessage === "string") task.lastAgentMessage = redactText(finalMessage);
  }

  private async failTask(task: TaskRecord, error: unknown, source: string): Promise<void> {
    if (canTransition(task.status, "failed")) {
      transitionTask(task, "failed", {
        reason: "Supervisor operation failed",
        source,
        turnId: task.activeTurnId
      });
    }
    task.error = redactText(error instanceof Error ? error.message : String(error));
    await this.appendEvent(task, "supervisor/operationFailed", { source, error: task.error });
    await this.store.put(task);
    this.signal(task.id);
  }

  private buildAcceptanceEvidence(task: TaskRecord, snapshot: WorkspaceSnapshot) {
    const passingRuns = (task.verificationRuns ?? []).filter(
      (run) => isTrustedPassingVerifierRun(run, snapshot.snapshotId)
    );
    const successfulRuns = passingRuns.map((run) => {
      const selected = new Set(run.recipeIds);
      const recipes = (run.results ?? [])
        .filter(
          (result) =>
            selected.has(result.recipeId) &&
            result.passed === true &&
            result.timedOut !== true &&
            result.exitCode === 0
        )
        .map((result) => result.recipeId);
      return { run, recipes };
    }).filter((entry) => entry.recipes.length > 0);
    const passedRecipes = new Set(successfulRuns.flatMap((entry) => entry.recipes));
    const requiredRecipes = task.contract?.requiredVerificationRecipes ?? [];
    const verificationSatisfied =
      passedRecipes.size > 0 && requiredRecipes.every((recipeId) => passedRecipes.has(recipeId));
    const verificationRunIds = verificationSatisfied
      ? successfulRuns.map((entry) => entry.run.runId)
      : [];
    const observedAt = iso();
    return (task.contract?.acceptanceCriteria ?? []).map((criterion) => ({
      criterionId: criterion.id,
      description: criterion.description,
      evidencePlan:
        criterion.evidence ??
        `Snapshot-bound trusted verification (${[...passedRecipes].sort().join(", ") || "no passing recipes"})`,
      snapshotId: snapshot.snapshotId,
      verificationRunIds,
      // Machine checks generate a snapshot-bound candidate. Only an explicit
      // per-criterion supervisor confirmation can mark it satisfied.
      satisfied: false,
      observedAt
    }));
  }

  private assertContractPaths(task: TaskRecord, snapshot: WorkspaceSnapshot): void {
    const violations = contractPathViolations(task, snapshot);
    if (violations.forbidden.length > 0 || violations.outsideAllowed.length > 0) {
      throw new SupervisorError(
        "VERIFICATION_NOT_ALLOWED",
        "Worktree changes violate Development Contract path constraints",
        409,
        { ...violations }
      );
    }
  }

  private async registerPendingTurnStart(task: TaskRecord): Promise<PendingTurnStartRecord> {
    if (this.pendingTurnStart) {
      throw new SupervisorError(
        "ACTIVE_WRITER_CONFLICT",
        "Another turn/start request is awaiting an exact remote turn identity",
        409,
        { taskId: this.pendingTurnStart.record.taskId }
      );
    }
    if (!task.threadId || !task.worktree) {
      throw new SupervisorError("INVALID_STATE_TRANSITION", "Cannot register turn/start without thread/worktree", 409);
    }
    const pending: PendingTurnStartRecord = {
      nonce: randomUUID(),
      taskId: task.id,
      threadId: task.threadId,
      worktree: task.worktree,
      supervisorInstanceId: this.instanceId,
      appServerInstanceId: this.appServerInstanceId,
      registeredAt: iso()
    };
    this.pendingTurnStart = { record: pending, bufferedNotifications: [], deferredPriorTurnTelemetry: [] };
    task.pendingTurnStart = pending;
    task.activeTurnId = undefined;
    task.turnId = undefined;
    task.turnStatus = "starting";
    try {
      await this.appendEvent(task, "supervisor/turnStartRegistered", { nonce: pending.nonce, threadId: pending.threadId });
      await this.store.put(task);
      return pending;
    } catch (error) {
      if (this.pendingTurnStart?.record.nonce === pending.nonce) this.pendingTurnStart = undefined;
      throw error;
    }
  }

  private async abandonPendingTurnStart(taskId: string, nonce: string, reason: string): Promise<void> {
    const runtime = this.pendingTurnStart;
    const task = this.store.get(taskId);
    const durable = task?.pendingTurnStart;
    const pending = runtime?.record.nonce === nonce
      ? runtime.record
      : durable?.nonce === nonce
        ? durable
        : undefined;
    if (!task || !pending) return;
    if (runtime?.record.nonce === nonce) this.pendingTurnStart = undefined;
    const turnId = pending.observedTurnId ?? `unresolved-${pending.nonce}`;
    task.pendingTurnStart = undefined;
    task.activeTurnId = turnId;
    task.turnId = turnId;
    task.turnStatus = "starting";
    try {
      task.turnLease = await this.turnLeases.recordLost({
        taskId: task.id,
        threadId: pending.threadId,
        turnId,
        worktree: pending.worktree
      });
    } catch {
      const existing = this.turnLeases.list().find((lease) =>
        lease.taskId === task.id &&
        lease.threadId === pending.threadId &&
        lease.turnId === turnId &&
        lease.worktree === pending.worktree
      );
      if (!existing) {
        task.turnLease = {
          leaseId: randomUUID(),
          taskId: task.id,
          threadId: pending.threadId,
          turnId,
          worktree: pending.worktree,
          supervisorInstanceId: pending.supervisorInstanceId,
          appServerInstanceId: pending.appServerInstanceId,
          acquiredAt: pending.registeredAt,
          heartbeatAt: iso(),
          expiresAt: iso(),
          lastProtocolEventAt: pending.registeredAt,
          state: "lost"
        };
      } else {
        task.turnLease = existing;
      }
    }
    task.residualRisks = [...new Set([...(task.residualRisks ?? []), "turn_start_identity_unresolved"])];
    await this.loseTurnOwnership(task, reason, "turn/start");
  }

  private async bindTurnStartResponse(
    taskId: string,
    threadId: string,
    turnId: string,
    nonce: string
  ): Promise<TaskRecord> {
    // The stream may deliver started/completed before the response. Those
    // notifications are buffered under a single durable nonce and replayed
    // only after the response binds the exact remote turn id.
    const previousReplayTaskId = this.replayingPendingStartTaskId;
    this.replayingPendingStartTaskId = taskId;
    try {
      // A thread/started notification can arrive immediately after the
      // thread/start response while durable thread state is still being
      // written. Mark this task as replaying before draining the queue so that
      // such telemetry is buffered instead of waiting on the start operation
      // that is itself waiting for this drain.
      await this.notificationQueue;
      const pending = this.pendingTurnStart;
      if (!pending || pending.record.nonce !== nonce || pending.record.taskId !== taskId) {
        throw new SupervisorError("LEASE_CONFLICT", "turn/start response has no matching pending start identity", 409);
      }
      if (pending.record.threadId !== threadId || (pending.record.observedTurnId && pending.record.observedTurnId !== turnId)) {
        await this.abandonPendingTurnStart(taskId, nonce, "turn/start response conflicted with buffered protocol identity");
        throw new SupervisorError("LEASE_CONFLICT", "turn/start response conflicts with buffered turn identity", 409);
      }
      const buffered = [...pending.bufferedNotifications];
      const deferredPriorTurnTelemetry = [...pending.deferredPriorTurnTelemetry];
      const current = this.getTask(taskId);
      if (current.threadId !== threadId) {
        await this.abandonPendingTurnStart(taskId, nonce, "turn/start response thread identity mismatch");
        throw new SupervisorError("LEASE_CONFLICT", "turn/start response does not own the supervised thread", 409);
      }
      this.pendingTurnStart = undefined;
      current.pendingTurnStart = undefined;
      try {
        await this.beginTurn(current, turnId);
        for (const telemetry of deferredPriorTurnTelemetry) {
          await this.appendEvent(current, "supervisor/deferredPriorTurnTelemetry", telemetry);
        }
        if (deferredPriorTurnTelemetry.length > 0) await this.store.put(current);
        for (const notification of buffered) await this.onNotification(notification);
        return this.getTask(taskId);
      } catch (error) {
        const latest = this.store.get(taskId) ?? current;
        await this.loseTurnOwnership(latest, "Buffered turn/start protocol sequence could not be bound safely", "turn/start");
        throw error;
      }
    } finally {
      if (this.replayingPendingStartTaskId === taskId) {
        this.replayingPendingStartTaskId = previousReplayTaskId;
      }
    }
  }

  private async loseTurnOwnership(task: TaskRecord, reason: string, source: string): Promise<void> {
    if (task.turnLease) {
      const managed = this.turnLeases.get(task.turnLease.leaseId);
      if (managed && ["active", "suspect", "interrupting"].includes(managed.state)) {
        try {
          task.turnLease = await this.turnLeases.markState(managed.leaseId, "lost");
        } catch {
          const latestManaged = this.turnLeases.get(managed.leaseId);
          task.turnLease = latestManaged?.state === "lost"
            ? latestManaged
            : { ...managed, state: "lost", expiresAt: iso(), heartbeatAt: iso() };
        }
      } else if (managed) {
        task.turnLease = managed;
      } else if (["active", "suspect", "interrupting"].includes(task.turnLease.state)) {
        task.turnLease = { ...task.turnLease, state: "lost", expiresAt: iso(), heartbeatAt: iso() };
      }
    }
    task.turnStatus = "failed";
    task.error = redactText(reason);
    task.pendingTurnStart = undefined;
    task.pendingApprovalIds = [];
    await this.clearApprovalsForThread(task.threadId);
    if (canTransition(task.status, "stale")) {
      transitionTask(task, "stale", {
        reason: redactText(reason),
        source,
        turnId: task.activeTurnId
      });
    }
    await this.appendEvent(task, "supervisor/turnOwnershipLost", { source, reason });
    await this.store.put(task);
    this.signal(task.id);
  }

  private assertThreadTerminalForRecovery(
    value: unknown,
    expectedThreadId: string,
    expectedTurnId?: string
  ): { turnId: string; status: "completed" | "failed" | "interrupted" } {
    const thread = record(record(value).thread);
    if (thread.id !== expectedThreadId) {
      throw new SupervisorError(
        "LEASE_CONFLICT",
        "Codex thread/read returned a different thread identity; recovery remains stale",
        409
      );
    }
    if (!Array.isArray(thread.turns) || thread.turns.length === 0) {
      throw new SupervisorError(
        "LEASE_CONFLICT",
        "Codex thread/read did not provide terminal turn evidence; recovery remains stale",
        409
      );
    }
    const lastTurn = record(thread.turns.at(-1));
    const status = lastTurn.status;
    if (typeof status !== "string" || !["completed", "failed", "interrupted"].includes(status)) {
      throw new SupervisorError(
        "ACTIVE_WRITER_CONFLICT",
        `Codex thread is active or its last turn status is unknown: ${String(status ?? "missing")}`,
        409
      );
    }
    if (typeof lastTurn.id !== "string" || (expectedTurnId && lastTurn.id !== expectedTurnId)) {
      throw new SupervisorError(
        "LEASE_CONFLICT",
        "Codex thread/read terminal turn does not match the unresolved turn lease",
        409
      );
    }
    return {
      turnId: lastTurn.id,
      status: status as "completed" | "failed" | "interrupted"
    };
  }

  private async appendEvent(task: TaskRecord, method: string, payload: unknown): Promise<void> {
    task.eventSeq += 1;
    const safe = redact(payload);
    let bounded: unknown = safe;
    try {
      const raw = JSON.stringify(safe);
      if (raw.length > this.config.maxEventPayloadChars) {
        const clipped = redactAndTruncate(raw, this.config.maxEventPayloadChars);
        bounded = { truncated: true, originalChars: raw.length, preview: clipped.text };
      }
    } catch {
      bounded = { truncated: true, preview: redactText(String(safe)).slice(0, this.config.maxEventPayloadChars) };
    }
    task.events.push({ seq: task.eventSeq, at: iso(), method, payload: bounded });
    if (task.events.length > this.config.maxEventsPerTask) {
      task.events.splice(0, task.events.length - this.config.maxEventsPerTask);
    }
    task.oldestAvailableSeq = task.events[0]?.seq ?? task.eventSeq + 1;
    task.updatedAt = iso();
  }

  private appendSnapshot(task: TaskRecord, snapshot: WorkspaceSnapshot): void {
    const snapshots = (task.snapshots ??= []);
    if (!snapshots.some((candidate) => candidate.snapshotId === snapshot.snapshotId)) snapshots.push(snapshot);
    task.headSha = snapshot.headSha;
  }

  private signal(taskId: string): void {
    const bucket = this.waiters.get(taskId);
    if (!bucket) return;
    for (const wake of [...bucket]) wake();
  }

  private taskSummary(task: TaskRecord): Record<string, unknown> {
    const { events: _events, contract: _contract, verificationRuns: _runs, ...summary } = redact(task);
    return {
      ...summary,
      latestSeq: task.eventSeq,
      oldestAvailableSeq: task.oldestAvailableSeq,
      verificationRunCount: task.verificationRuns?.length ?? 0
    };
  }

  private findTaskByThread(threadId?: string): TaskRecord | undefined {
    return threadId ? this.store.list().find((task) => task.threadId === threadId) : undefined;
  }

  private findTaskByTurn(turnId?: string): TaskRecord | undefined {
    if (!turnId) return undefined;
    const matches = this.store.list().filter(
      (task) =>
        task.activeTurnId === turnId ||
        task.turnId === turnId ||
        task.turnLease?.turnId === turnId ||
        (task.turnHistory ?? []).some((turn) => turn.turnId === turnId)
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  private async clearApprovalsForThread(threadId?: string): Promise<void> {
    if (!threadId) return;
    const responses: Promise<void>[] = [];
    for (const [approvalId, approval] of this.approvals) {
      if (approval.threadId !== threadId) continue;
      responses.push(
        Promise.resolve()
          .then(() => this.client.respondError(
            approval.requestId,
            -32602,
            "Approval invalidated because turn authority ended"
          ))
          .catch(() => undefined)
      );
      this.approvals.delete(approvalId);
    }
    await Promise.all(responses);
  }

  private async markActiveTasksStale(reason: string): Promise<void> {
    for (const task of this.store.list()) {
      const unresolvedTurn = Boolean(
        task.pendingTurnStart ||
        (task.turnLease && ["active", "suspect", "interrupting"].includes(task.turnLease.state))
      );
      if (!["preparing", "running", "waiting_approval"].includes(task.status) && !unresolvedTurn) continue;
      if (this.pendingTurnStart?.record.taskId === task.id) {
        await this.abandonPendingTurnStart(task.id, this.pendingTurnStart.record.nonce, reason);
        continue;
      }
      await this.loseTurnOwnership(task, reason, "app-server-exit");
    }
    this.approvals.clear();
  }

  private async waitForTurnTerminal(taskId: string, turnId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const task = this.getTask(taskId);
      if (task.activeTurnId === turnId && ["completed", "failed", "interrupted"].includes(task.turnStatus ?? "none")) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }
}
