import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import type {
  DevelopmentContractV1,
  IdempotencyRecord,
  StoredStateV3,
  TaskRecord,
  TaskStatus
} from "../types.js";
import { canonicalContractHash, normalizeDevelopmentContract } from "./contracts.js";
import { SupervisorError } from "./errors.js";
import { redact } from "./redaction.js";

interface LegacyState {
  version: 1 | 2;
  tasks?: unknown[];
  idempotency?: Record<string, unknown>;
  [key: string]: unknown;
}

const ACTIVE_LEGACY_STATUSES = new Set(["starting", "preparing", "running", "waiting_approval"]);
const KNOWN_TASK_STATUSES = new Set<TaskStatus>([
  "planned",
  "preparing",
  "running",
  "waiting_approval",
  "awaiting_verification",
  "verifying",
  "needs_correction",
  "ready_for_human_review",
  "blocked",
  "failed",
  "interrupted",
  "cancelled",
  "stale",
  "legacy_unverified",
  "starting",
  "completed"
]);

function now(): string {
  return new Date().toISOString();
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function legacyContract(raw: Record<string, unknown>): DevelopmentContractV1 {
  const objective = string(raw.objective, "Legacy task without an objective");
  return normalizeDevelopmentContract({
    contractVersion: "1.0",
    clientRequestId: `legacy-migrated-${string(raw.id, "unknown-task")}`,
    objective,
    plan: [],
    scope: { in: [objective], out: [] },
    constraints: [],
    acceptanceCriteria: [
      {
        id: "LEGACY-UNVERIFIED",
        description: "Legacy task requires independent review and verification"
      }
    ],
    requiredVerificationRecipes: [],
    maxCorrectionPasses: 3,
    metadata: { migratedFrom: "legacy-ledger" }
  });
}

function migratedStatus(value: unknown, version: 1 | 2 | 3): {
  status: TaskStatus;
  legacyUnreconciledVerifier: boolean;
} {
  const original = string(value, "failed") as TaskStatus;
  if (!KNOWN_TASK_STATUSES.has(original)) {
    if (version === 3) {
      throw new SupervisorError("INTERNAL_ERROR", `Unknown task status in v3 ledger: ${String(value)}`, 500);
    }
    return { status: "blocked", legacyUnreconciledVerifier: false };
  }
  if (original === "starting") return { status: "stale", legacyUnreconciledVerifier: false };
  if (original === "completed") return { status: "legacy_unverified", legacyUnreconciledVerifier: false };
  if (version === 3) return { status: original, legacyUnreconciledVerifier: false };
  if (original === "ready_for_human_review") {
    return { status: "legacy_unverified", legacyUnreconciledVerifier: false };
  }
  if (original === "verifying" && version === 2) {
    return { status: "blocked", legacyUnreconciledVerifier: true };
  }
  if (ACTIVE_LEGACY_STATUSES.has(original)) return { status: "stale", legacyUnreconciledVerifier: false };
  return { status: original, legacyUnreconciledVerifier: false };
}

/** Convert a structural v1/v2/v3 record into the complete in-memory v3 shape. */
function normalizeTask(value: unknown, version: 1 | 2 | 3): TaskRecord {
  const raw = object(value);
  const contract = raw.contract
    ? normalizeDevelopmentContract(raw.contract)
    : legacyContract(raw);
  const computedContractHash = canonicalContractHash(contract);
  const suppliedContractHash = typeof raw.contractHash === "string" && raw.contractHash
    ? raw.contractHash
    : undefined;
  if (version === 3 && suppliedContractHash && suppliedContractHash !== computedContractHash) {
    throw new SupervisorError("INTERNAL_ERROR", "Task ledger contract hash does not match canonical contract", 500, {
      taskId: string(raw.id)
    });
  }
  const migrated = migratedStatus(raw.status, version);
  const createdAt = string(raw.createdAt, now());
  const workspace = string(raw.workspace ?? raw.worktree ?? raw.sourceWorkspace);
  const sourceWorkspace = string(raw.sourceWorkspace, workspace);
  const events = Array.isArray(raw.events) ? (raw.events as TaskRecord["events"]) : [];
  const eventSeq = Number.isSafeInteger(raw.eventSeq) ? Number(raw.eventSeq) : events.at(-1)?.seq ?? 0;
  const activeTurnId = string(raw.activeTurnId ?? raw.turnId) || undefined;
  const task: TaskRecord = {
    ...(raw as unknown as TaskRecord),
    id: string(raw.id),
    objective: contract.objective,
    workspace,
    sourceWorkspace,
    contract,
    contractHash: computedContractHash,
    status: migrated.status,
    createdAt,
    updatedAt: string(raw.updatedAt, createdAt),
    eventSeq,
    oldestAvailableSeq: Number.isSafeInteger(raw.oldestAvailableSeq)
      ? Number(raw.oldestAvailableSeq)
      : events[0]?.seq ?? eventSeq + 1,
    events,
    pendingApprovalIds: version < 3 ? [] : stringArray(raw.pendingApprovalIds),
    turnStatus: (version < 3 && ACTIVE_LEGACY_STATUSES.has(string(raw.status)))
      ? "none"
      : ((raw.turnStatus as TaskRecord["turnStatus"]) ?? "none"),
    turnHistory: Array.isArray(raw.turnHistory) ? (raw.turnHistory as TaskRecord["turnHistory"]) : [],
    statusHistory: Array.isArray(raw.statusHistory) ? (raw.statusHistory as TaskRecord["statusHistory"]) : [],
    correctionPasses: Number.isSafeInteger(raw.correctionPasses) ? Number(raw.correctionPasses) : 0,
    snapshots: Array.isArray(raw.snapshots) ? (raw.snapshots as TaskRecord["snapshots"]) : [],
    acceptanceEvidence: Array.isArray(raw.acceptanceEvidence)
      ? (raw.acceptanceEvidence as TaskRecord["acceptanceEvidence"])
      : [],
    verificationRuns: Array.isArray(raw.verificationRuns)
      ? (raw.verificationRuns as TaskRecord["verificationRuns"])
      : [],
    verifierLeases: Array.isArray(raw.verifierLeases) ? (raw.verifierLeases as TaskRecord["verifierLeases"]) : [],
    quarantines: Array.isArray(raw.quarantines) ? (raw.quarantines as TaskRecord["quarantines"]) : [],
    reconciliationProofs: Array.isArray(raw.reconciliationProofs)
      ? (raw.reconciliationProofs as TaskRecord["reconciliationProofs"])
      : [],
    decisions: Array.isArray(raw.decisions) ? (raw.decisions as TaskRecord["decisions"]) : [],
    residualRisks: stringArray(raw.residualRisks),
    legacyUnreconciledVerifier:
      migrated.legacyUnreconciledVerifier || raw.legacyUnreconciledVerifier === true,
    ...(activeTurnId ? { activeTurnId, turnId: activeTurnId } : {})
  };
  if (migrated.legacyUnreconciledVerifier) {
    task.residualRisks = [
      ...new Set([...(task.residualRisks ?? []), "legacy_unreconciled_verifier"])
    ];
  }
  if (version < 3 && string(raw.status) === "ready_for_human_review") {
    task.acceptanceEvidence = [];
    for (const run of task.verificationRuns ?? []) run.stale = true;
    task.residualRisks = [
      ...new Set([...(task.residualRisks ?? []), "legacy_ready_requires_reverification"])
    ];
  }
  if (version === 2) {
    for (const run of task.verificationRuns ?? []) {
      if (run.state !== "passed") continue;
      const boundSnapshotId = run.afterSnapshotId ?? run.beforeSnapshotId;
      const complete =
        Boolean(boundSnapshotId) &&
        (task.snapshots ?? []).some((snapshot) => snapshot.snapshotId === boundSnapshotId) &&
        Array.isArray(run.recipeIds) &&
        run.recipeIds.length > 0;
      if (!complete) run.stale = true;
    }
    if (
      task.status === "ready_for_human_review" &&
      !(task.verificationRuns ?? []).some((run) => run.state === "passed" && !run.stale)
    ) {
      task.status = "awaiting_verification";
      task.residualRisks = [...new Set([...(task.residualRisks ?? []), "migrated_verification_evidence_incomplete"])];
    }
  }
  return redact(task);
}

function idempotencyKey(sourceWorkspace: string, clientRequestId: string): string {
  return createHash("sha256")
    .update(`${path.resolve(sourceWorkspace)}\0${clientRequestId}`, "utf8")
    .digest("hex");
}

function idempotencyRecordFor(task: TaskRecord): IdempotencyRecord {
  const sourceWorkspace = task.sourceWorkspace ?? task.workspace;
  if (!task.contract?.clientRequestId || !task.contractHash) {
    throw new SupervisorError(
      "INTERNAL_ERROR",
      "Task is missing the immutable identity required by the idempotency ledger",
      500,
      { taskId: task.id }
    );
  }
  return {
    taskId: task.id,
    sourceWorkspace,
    contractHash: task.contractHash,
    createdAt: task.createdAt
  };
}

function canonicalIdempotencyEntry(task: TaskRecord): [string, IdempotencyRecord] {
  const record = idempotencyRecordFor(task);
  return [idempotencyKey(record.sourceWorkspace, task.contract!.clientRequestId), record];
}

function assertSameTaskIdentity(previous: TaskRecord, next: TaskRecord): void {
  const previousSource = previous.sourceWorkspace ?? previous.workspace;
  const nextSource = next.sourceWorkspace ?? next.workspace;
  const previousClientRequestId = previous.contract?.clientRequestId;
  const nextClientRequestId = next.contract?.clientRequestId;
  if (
    previousSource !== nextSource ||
    previous.contractHash !== next.contractHash ||
    previousClientRequestId !== nextClientRequestId ||
    previous.createdAt !== next.createdAt
  ) {
    throw new SupervisorError(
      "IDEMPOTENCY_CONFLICT",
      "Task identity is immutable after it has been persisted",
      409,
      { taskId: previous.id }
    );
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return new Set(["ENOTSUP", "EOPNOTSUPP", "EINVAL", "EPERM", "EACCES", "EISDIR", "ENOSYS", "EBADF"])
    .has(code ?? "");
}

function emptyState(): StoredStateV3 {
  return {
    version: 3,
    tasks: [],
    idempotency: {},
    turnLeases: [],
    verifierRuns: [],
    verifierLeases: [],
    quarantines: [],
    reconciliationProofs: [],
    appServerInstanceHistory: [],
    chatgptConnectionEvidence: [],
    liveTestRuns: []
  };
}

function mergeBy<T>(base: T[], current: T[], key: (value: T) => string): T[] {
  const merged = new Map<string, T>();
  for (const value of base) merged.set(key(value), value);
  for (const value of current) merged.set(key(value), value);
  return [...merged.values()];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Atomic, serialized and migration-aware task ledger. */
export class TaskStore {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private operationQueue: Promise<unknown> = Promise.resolve();
  private ledgerMetadata: StoredStateV3 = emptyState();

  constructor(private readonly file: string) {}

  /** Load v1/v2/v3 state, creating a backup before an on-disk migration. */
  async load(): Promise<void> {
    let rawText: string;
    try {
      rawText = await fs.readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    let parsed: LegacyState | StoredStateV3;
    try {
      parsed = JSON.parse(rawText) as LegacyState | StoredStateV3;
    } catch (error) {
      throw new SupervisorError("INTERNAL_ERROR", "Task ledger contains invalid JSON", 500, undefined, {
        cause: error
      });
    }
    if (![1, 2, 3].includes(parsed.version)) {
      throw new SupervisorError("INTERNAL_ERROR", `Unsupported task ledger version: ${String(parsed.version)}`, 500);
    }

    const version = parsed.version as 1 | 2 | 3;
    const rawTasks = parsed.tasks ?? (version < 3 ? [] : undefined);
    if (!Array.isArray(rawTasks)) {
      throw new SupervisorError("INTERNAL_ERROR", "Task ledger tasks must be an array", 500);
    }

    const loadedTasks = new Map<string, TaskRecord>();
    for (const item of rawTasks) {
      const task = normalizeTask(item, version);
      if (!task.id) throw new SupervisorError("INTERNAL_ERROR", "Task ledger contains a task without an id", 500);
      if (loadedTasks.has(task.id)) {
        throw new SupervisorError("INTERNAL_ERROR", "Task ledger contains duplicate task ids", 500, {
          taskId: task.id
        });
      }
      loadedTasks.set(task.id, task);
    }

    const loadedIdempotency = version < 3
      ? this.migratedIdempotency(loadedTasks)
      : this.validatedV3Idempotency(parsed as StoredStateV3, loadedTasks);

    this.tasks.clear();
    this.idempotency.clear();
    for (const [taskId, task] of loadedTasks) this.tasks.set(taskId, task);
    for (const [key, entry] of loadedIdempotency) this.idempotency.set(key, entry);

    this.ledgerMetadata = version === 3
      ? { ...emptyState(), ...(parsed as StoredStateV3), tasks: [], idempotency: {} }
      : emptyState();

    if (version === 3) this.hydrateTopLevelEvidence(parsed as StoredStateV3);

    if (version === 1 || version === 2) {
      await this.backupBeforeMigration(version, rawText);
      await this.persist();
    }
  }

  private migratedIdempotency(tasks: Map<string, TaskRecord>): Map<string, IdempotencyRecord> {
    const migrated = new Map<string, IdempotencyRecord>();
    for (const task of tasks.values()) {
      const [key, entry] = canonicalIdempotencyEntry(task);
      if (migrated.has(key)) {
        throw new SupervisorError(
          "INTERNAL_ERROR",
          "Legacy task ledger contains duplicate idempotency identities",
          500,
          { taskId: task.id }
        );
      }
      migrated.set(key, entry);
    }
    return migrated;
  }

  private validatedV3Idempotency(
    state: StoredStateV3,
    tasks: Map<string, TaskRecord>
  ): Map<string, IdempotencyRecord> {
    const rawIdempotency = state.idempotency as unknown;
    if (!rawIdempotency || typeof rawIdempotency !== "object" || Array.isArray(rawIdempotency)) {
      throw new SupervisorError("INTERNAL_ERROR", "Task ledger idempotency map must be an object", 500);
    }

    const validated = new Map<string, IdempotencyRecord>();
    const mappedTaskIds = new Set<string>();
    for (const [key, rawEntry] of Object.entries(rawIdempotency as Record<string, unknown>)) {
      if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
        throw new SupervisorError("INTERNAL_ERROR", "Task ledger contains an invalid idempotency entry", 500, {
          key
        });
      }
      const entryObject = rawEntry as Record<string, unknown>;
      const fields = Object.keys(entryObject).sort();
      if (fields.join("\0") !== ["contractHash", "createdAt", "sourceWorkspace", "taskId"].join("\0")) {
        throw new SupervisorError("INTERNAL_ERROR", "Task ledger idempotency entry has invalid fields", 500, {
          key
        });
      }
      const entry: IdempotencyRecord = {
        taskId: string(entryObject.taskId),
        sourceWorkspace: string(entryObject.sourceWorkspace),
        contractHash: string(entryObject.contractHash),
        createdAt: string(entryObject.createdAt)
      };
      if (!entry.taskId || !entry.sourceWorkspace || !entry.contractHash || !entry.createdAt) {
        throw new SupervisorError("INTERNAL_ERROR", "Task ledger idempotency entry is incomplete", 500, {
          key
        });
      }
      const task = tasks.get(entry.taskId);
      if (!task) {
        throw new SupervisorError("INTERNAL_ERROR", "Idempotency ledger references a missing task", 500, {
          key,
          taskId: entry.taskId
        });
      }
      const [expectedKey, expectedEntry] = canonicalIdempotencyEntry(task);
      if (key !== expectedKey) {
        throw new SupervisorError("INTERNAL_ERROR", "Task ledger idempotency key is not canonical", 500, {
          key,
          taskId: entry.taskId
        });
      }
      if (
        entry.sourceWorkspace !== expectedEntry.sourceWorkspace ||
        entry.contractHash !== expectedEntry.contractHash ||
        entry.createdAt !== expectedEntry.createdAt
      ) {
        throw new SupervisorError("INTERNAL_ERROR", "Task ledger idempotency entry does not match its task", 500, {
          key,
          taskId: entry.taskId
        });
      }
      if (mappedTaskIds.has(entry.taskId)) {
        throw new SupervisorError("INTERNAL_ERROR", "Task ledger maps one task more than once", 500, {
          taskId: entry.taskId
        });
      }
      mappedTaskIds.add(entry.taskId);
      validated.set(key, entry);
    }

    for (const task of tasks.values()) {
      if (!mappedTaskIds.has(task.id)) {
        throw new SupervisorError("INTERNAL_ERROR", "Task ledger is missing an idempotency mapping", 500, {
          taskId: task.id
        });
      }
    }
    return validated;
  }

  /** Return task records newest first. */
  list(): TaskRecord[] {
    return [...this.tasks.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((task) => clone(task));
  }

  get(id: string): TaskRecord | undefined {
    const task = this.tasks.get(id);
    return task ? clone(task) : undefined;
  }

  /** Persist a task through the same serialized transaction queue as all other writes. */
  async put(task: TaskRecord): Promise<void> {
    await this.enqueue(async () => {
      const normalized = normalizeTask(redact(task), 3);
      const previous = this.tasks.get(normalized.id);
      const [key, entry] = canonicalIdempotencyEntry(normalized);
      const previousEntry = this.idempotency.get(key);
      if (previous) {
        assertSameTaskIdentity(previous, normalized);
        if (!previousEntry || previousEntry.taskId !== previous.id) {
          throw new SupervisorError(
            "INTERNAL_ERROR",
            "Existing task has no matching idempotency record",
            500,
            { taskId: previous.id }
          );
        }
      } else if (previousEntry) {
        throw new SupervisorError(
          "IDEMPOTENCY_CONFLICT",
          "Task identity is already assigned to another task",
          409,
          { taskId: previousEntry.taskId }
        );
      }
      this.tasks.set(normalized.id, normalized);
      if (!previous) this.idempotency.set(key, entry);
      try {
        await this.persist();
      } catch (error) {
        if (previous) this.tasks.set(normalized.id, previous);
        else this.tasks.delete(normalized.id);
        if (!previous) this.idempotency.delete(key);
        throw error;
      }
    });
  }

  /**
   * Create a task exactly once for a client request id.
   * Identical retries return the original task; semantic drift is a 409 conflict.
   */
  async putWithIdempotency(
    task: TaskRecord,
    clientRequestId = task.contract?.clientRequestId
  ): Promise<{ task: TaskRecord; created: boolean }> {
    return this.enqueue(async () => {
      const contractClientRequestId = task.contract?.clientRequestId;
      if (!clientRequestId || !contractClientRequestId) {
        throw new SupervisorError(
          "INVALID_CONTRACT",
          "Idempotent task creation requires clientRequestId",
          400
        );
      }
      if (clientRequestId !== contractClientRequestId) {
        throw new SupervisorError(
          "INVALID_CONTRACT",
          "Explicit clientRequestId must match contract.clientRequestId",
          400
        );
      }
      const normalized = normalizeTask(redact(task), 3);
      const sourceWorkspace = normalized.sourceWorkspace ?? normalized.workspace;
      const contractHash = normalized.contractHash!;
      const key = idempotencyKey(sourceWorkspace, clientRequestId);
      const existing = this.idempotency.get(key);
      if (existing) {
        const existingTask = this.tasks.get(existing.taskId);
        if (!existingTask) {
          throw new SupervisorError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency ledger references a missing task; refusing to create a duplicate",
            409,
            { clientRequestId }
          );
        }
        const [, canonicalExisting] = canonicalIdempotencyEntry(existingTask);
        if (
          existing.sourceWorkspace !== canonicalExisting.sourceWorkspace ||
          existing.contractHash !== canonicalExisting.contractHash ||
          existing.createdAt !== canonicalExisting.createdAt
        ) {
          throw new SupervisorError(
            "INTERNAL_ERROR",
            "Idempotency ledger entry does not match its task",
            500,
            { clientRequestId, existingTaskId: existing.taskId }
          );
        }
        if (
          existing.sourceWorkspace !== sourceWorkspace ||
          existing.contractHash !== contractHash
        ) {
          throw new SupervisorError(
            "IDEMPOTENCY_CONFLICT",
            "clientRequestId was already used with different task semantics",
            409,
            { clientRequestId, existingTaskId: existing.taskId }
          );
        }
        return { task: clone(existingTask), created: false };
      }

      const previousTask = this.tasks.get(normalized.id);
      if (previousTask) {
        throw new SupervisorError(
          "IDEMPOTENCY_CONFLICT",
          "Task id is already assigned to another idempotency identity",
          409,
          { clientRequestId, existingTaskId: previousTask.id }
        );
      }
      this.tasks.set(normalized.id, normalized);
      this.idempotency.set(key, idempotencyRecordFor(normalized));
      try {
        await this.persist();
      } catch (error) {
        this.tasks.delete(normalized.id);
        this.idempotency.delete(key);
        throw error;
      }
      return { task: clone(normalized), created: true };
    });
  }

  /** Force a serialized atomic write of the current ledger. */
  async flush(): Promise<void> {
    await this.enqueue(() => this.persist());
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private stateForPersistence(): StoredStateV3 {
    const tasks = this.list();
    const taskTurnLeases = tasks.flatMap((task) => (task.turnLease ? [task.turnLease] : []));
    const taskRuns = tasks.flatMap((task) => task.verificationRuns ?? []);
    const taskVerifierLeases = tasks.flatMap((task) => task.verifierLeases ?? []);
    const taskQuarantines = tasks.flatMap((task) => task.quarantines ?? []);
    const taskProofs = tasks.flatMap((task) => task.reconciliationProofs ?? []);
    return redact({
      ...this.ledgerMetadata,
      version: 3 as const,
      tasks,
      idempotency: Object.fromEntries([...this.idempotency.entries()].sort(([a], [b]) => a.localeCompare(b))),
      turnLeases: mergeBy(this.ledgerMetadata.turnLeases, taskTurnLeases, (lease) => lease.leaseId),
      verifierRuns: mergeBy(this.ledgerMetadata.verifierRuns, taskRuns, (run) => run.runId),
      verifierLeases: mergeBy(this.ledgerMetadata.verifierLeases, taskVerifierLeases, (lease) => lease.leaseId),
      quarantines: mergeBy(this.ledgerMetadata.quarantines, taskQuarantines, (entry) => entry.quarantineId),
      reconciliationProofs: mergeBy(
        this.ledgerMetadata.reconciliationProofs,
        taskProofs,
        (proof) => proof.proofId
      )
    });
  }

  private async persist(): Promise<void> {
    const directory = path.dirname(this.file);
    await fs.mkdir(directory, { recursive: true });
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    const content = `${JSON.stringify(this.stateForPersistence(), null, 2)}\n`;
    try {
      const temporaryHandle = await fs.open(temporary, "wx", 0o600);
      try {
        await temporaryHandle.writeFile(content, { encoding: "utf8" });
        await temporaryHandle.sync();
      } finally {
        await temporaryHandle.close();
      }
      await fs.rename(temporary, this.file);

      // Windows requires a write-capable handle for FlushFileBuffers/fsync.
      const finalHandle = await fs.open(this.file, "r+");
      try {
        await finalHandle.sync();
      } finally {
        await finalHandle.close();
      }

      let directoryHandle: FileHandle | undefined;
      try {
        directoryHandle = await fs.open(directory, "r");
        await directoryHandle.sync();
      } catch (error) {
        if (!isUnsupportedDirectorySync(error)) throw error;
      } finally {
        await directoryHandle?.close();
      }
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private hydrateTopLevelEvidence(state: StoredStateV3): void {
    const runToTask = new Map<string, string>();
    for (const task of this.tasks.values()) {
      for (const run of task.verificationRuns ?? []) runToTask.set(run.runId, task.id);
    }
    for (const run of state.verifierRuns ?? []) {
      const task = this.tasks.get(run.taskId);
      if (!task) continue;
      const runs = (task.verificationRuns ??= []);
      if (!runs.some((candidate) => candidate.runId === run.runId)) runs.push(redact(run));
      runToTask.set(run.runId, run.taskId);
    }
    for (const lease of state.turnLeases ?? []) {
      const task = this.tasks.get(lease.taskId);
      if (task && (!task.turnLease || task.turnLease.heartbeatAt < lease.heartbeatAt)) {
        task.turnLease = redact(lease);
      }
    }
    for (const lease of state.verifierLeases ?? []) {
      const task = this.tasks.get(lease.taskId);
      if (!task) continue;
      const leases = (task.verifierLeases ??= []);
      if (!leases.some((candidate) => candidate.leaseId === lease.leaseId)) leases.push(redact(lease));
    }
    for (const quarantine of state.quarantines ?? []) {
      if (!quarantine.taskId) continue;
      const task = this.tasks.get(quarantine.taskId);
      if (!task) continue;
      const quarantines = (task.quarantines ??= []);
      if (!quarantines.some((candidate) => candidate.quarantineId === quarantine.quarantineId)) {
        quarantines.push(redact(quarantine));
      }
    }
    for (const proof of state.reconciliationProofs ?? []) {
      const taskId = runToTask.get(proof.runId);
      const task = taskId ? this.tasks.get(taskId) : undefined;
      if (!task) continue;
      const proofs = (task.reconciliationProofs ??= []);
      if (!proofs.some((candidate) => candidate.proofId === proof.proofId)) proofs.push(redact(proof));
    }
  }

  private async backupBeforeMigration(version: 1 | 2, content: string): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${this.file}.v${version}.${stamp}.bak`;
    await fs.copyFile(this.file, backup, fsConstants.COPYFILE_EXCL);
    // Verify the backup byte-for-byte before replacing the original ledger.
    const copied = await fs.readFile(backup, "utf8");
    if (copied !== content) {
      throw new SupervisorError("INTERNAL_ERROR", "Task ledger migration backup verification failed", 500);
    }
  }
}
