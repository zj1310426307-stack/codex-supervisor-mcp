import { randomUUID } from "node:crypto";
import type { TurnLeaseV1 } from "../types.js";
import { SupervisorError } from "./errors.js";

const BLOCKING_STATES = new Set<TurnLeaseV1["state"]>(["active", "suspect", "interrupting", "lost"]);
const STATE_TRANSITIONS: Readonly<Record<TurnLeaseV1["state"], ReadonlySet<TurnLeaseV1["state"]>>> = {
  active: new Set(["suspect", "interrupting", "terminal", "lost"]),
  suspect: new Set(["active", "interrupting", "terminal", "lost"]),
  interrupting: new Set(["terminal", "lost"]),
  lost: new Set(["terminal"]),
  terminal: new Set()
};

export interface TurnLeaseManagerOptions {
  supervisorInstanceId: string;
  appServerInstanceId: string;
  ttlMs: number;
  minPersistIntervalMs?: number;
  onChange?: (leases: TurnLeaseV1[]) => void | Promise<void>;
}

export interface AcquireTurnLeaseInput {
  taskId: string;
  threadId: string;
  turnId: string;
  worktree: string;
}

export interface ReconcileTerminalTurnLeaseInput extends AcquireTurnLeaseInput {
  leaseId: string;
}

/** Enforce one active writer across task, thread, turn and worktree ownership domains. */
export class TurnLeaseManager {
  private readonly leases = new Map<string, TurnLeaseV1>();
  private lastPersistedAt = 0;

  constructor(private readonly options: TurnLeaseManagerOptions) {
    if (
      !options.supervisorInstanceId ||
      !options.appServerInstanceId ||
      !Number.isSafeInteger(options.ttlMs) ||
      options.ttlMs < 1
    ) {
      throw new SupervisorError("INVALID_INPUT", "Invalid turn lease manager options", 500);
    }
  }

  restore(leases: TurnLeaseV1[]): void {
    this.leases.clear();
    for (const lease of leases) {
      if (BLOCKING_STATES.has(lease.state)) {
        const conflict = [...this.leases.values()].find(
          (existing) =>
            BLOCKING_STATES.has(existing.state) &&
            (existing.taskId === lease.taskId ||
              existing.threadId === lease.threadId ||
              existing.turnId === lease.turnId ||
              existing.worktree === lease.worktree)
        );
        if (conflict) {
          throw new SupervisorError(
            "LEASE_CONFLICT",
            "Ledger contains conflicting active turn leases; recovery is blocked",
            409,
            { leaseIds: [conflict.leaseId, lease.leaseId] }
          );
        }
      }
      this.leases.set(lease.leaseId, { ...lease });
    }
  }

  async acquire(input: AcquireTurnLeaseInput, at = new Date()): Promise<TurnLeaseV1> {
    const conflict = [...this.leases.values()].find(
      (lease) =>
        BLOCKING_STATES.has(lease.state) &&
        (lease.taskId === input.taskId ||
          lease.threadId === input.threadId ||
          lease.turnId === input.turnId ||
          lease.worktree === input.worktree)
    );
    if (conflict) {
      throw new SupervisorError("ACTIVE_WRITER_CONFLICT", "An active turn already owns this task/thread/worktree", 409, {
        leaseId: conflict.leaseId,
        taskId: conflict.taskId
      });
    }
    const timestamp = at.toISOString();
    const lease: TurnLeaseV1 = {
      leaseId: randomUUID(),
      ...input,
      supervisorInstanceId: this.options.supervisorInstanceId,
      appServerInstanceId: this.options.appServerInstanceId,
      acquiredAt: timestamp,
      heartbeatAt: timestamp,
      expiresAt: new Date(at.getTime() + this.options.ttlMs).toISOString(),
      lastProtocolEventAt: timestamp,
      state: "active"
    };
    this.leases.set(lease.leaseId, lease);
    try {
      await this.changed(true);
    } catch (error) {
      this.leases.delete(lease.leaseId);
      throw error;
    }
    return { ...lease };
  }

  /** Record an unresolved remote start directly as a blocking lost lease. */
  async recordLost(input: AcquireTurnLeaseInput, at = new Date()): Promise<TurnLeaseV1> {
    const conflict = [...this.leases.values()].find(
      (lease) =>
        BLOCKING_STATES.has(lease.state) &&
        (lease.taskId === input.taskId ||
          lease.threadId === input.threadId ||
          lease.turnId === input.turnId ||
          lease.worktree === input.worktree)
    );
    if (conflict) {
      if (
        conflict.taskId === input.taskId &&
        conflict.threadId === input.threadId &&
        conflict.turnId === input.turnId &&
        conflict.worktree === input.worktree
      ) {
        return { ...conflict };
      }
      throw new SupervisorError(
        "ACTIVE_WRITER_CONFLICT",
        "An unresolved turn already owns this task/thread/worktree",
        409,
        { leaseId: conflict.leaseId, taskId: conflict.taskId }
      );
    }
    const timestamp = at.toISOString();
    const lease: TurnLeaseV1 = {
      leaseId: randomUUID(),
      ...input,
      supervisorInstanceId: this.options.supervisorInstanceId,
      appServerInstanceId: this.options.appServerInstanceId,
      acquiredAt: timestamp,
      heartbeatAt: timestamp,
      expiresAt: timestamp,
      lastProtocolEventAt: timestamp,
      state: "lost"
    };
    this.leases.set(lease.leaseId, lease);
    try {
      await this.changed(true);
    } catch (error) {
      this.leases.delete(lease.leaseId);
      throw error;
    }
    return { ...lease };
  }

  /** Heartbeat the exact owned lease, rate-limiting persistence without losing memory liveness. */
  async heartbeat(leaseId: string, protocolEventAt = new Date(), forcePersist = false): Promise<TurnLeaseV1> {
    const lease = this.owned(leaseId);
    if (!["active", "suspect", "interrupting"].includes(lease.state)) {
      throw new SupervisorError("LEASE_CONFLICT", "Turn lease is no longer active", 409);
    }
    const previous = { ...lease };
    lease.heartbeatAt = protocolEventAt.toISOString();
    lease.lastProtocolEventAt = protocolEventAt.toISOString();
    lease.expiresAt = new Date(protocolEventAt.getTime() + this.options.ttlMs).toISOString();
    if (lease.state === "suspect") lease.state = "active";
    try {
      await this.changed(forcePersist);
    } catch (error) {
      this.leases.set(leaseId, previous);
      throw error;
    }
    return { ...lease };
  }

  async markState(
    leaseId: string,
    state: TurnLeaseV1["state"],
    at = new Date()
  ): Promise<TurnLeaseV1> {
    const lease = this.owned(leaseId);
    if (lease.state !== state && !STATE_TRANSITIONS[lease.state].has(state)) {
      throw new SupervisorError(
        "LEASE_CONFLICT",
        `Illegal turn lease state transition: ${lease.state} -> ${state}`,
        409
      );
    }
    const previous = { ...lease };
    lease.state = state;
    lease.heartbeatAt = at.toISOString();
    if (["terminal", "lost"].includes(state)) lease.expiresAt = at.toISOString();
    try {
      await this.changed(true);
    } catch (error) {
      this.leases.set(leaseId, previous);
      throw error;
    }
    return { ...lease };
  }

  /**
   * Close an old-runtime lost lease only after the caller has independently
   * read exact terminal thread/turn evidence. Every recorded ownership field
   * must match, so a proof for one turn cannot release another worktree.
   */
  async reconcileTerminal(
    input: ReconcileTerminalTurnLeaseInput,
    at = new Date()
  ): Promise<TurnLeaseV1> {
    const lease = this.leases.get(input.leaseId);
    if (!lease) throw new SupervisorError("NOT_FOUND", `Unknown turn lease: ${input.leaseId}`, 404);
    if (
      lease.state !== "lost" ||
      lease.taskId !== input.taskId ||
      lease.threadId !== input.threadId ||
      lease.turnId !== input.turnId ||
      lease.worktree !== input.worktree
    ) {
      throw new SupervisorError(
        "LEASE_CONFLICT",
        "Terminal evidence does not exactly match the unresolved turn lease",
        409,
        { leaseId: lease.leaseId, taskId: lease.taskId }
      );
    }
    const previous = { ...lease };
    lease.state = "terminal";
    lease.heartbeatAt = at.toISOString();
    lease.expiresAt = at.toISOString();
    try {
      await this.changed(true);
    } catch (error) {
      this.leases.set(lease.leaseId, previous);
      throw error;
    }
    return { ...lease };
  }

  get(leaseId: string): TurnLeaseV1 | undefined {
    const lease = this.leases.get(leaseId);
    return lease ? { ...lease } : undefined;
  }

  list(): TurnLeaseV1[] {
    return [...this.leases.values()].map((lease) => ({ ...lease }));
  }

  isOwnedActive(leaseId: string): boolean {
    const lease = this.leases.get(leaseId);
    return Boolean(
      lease &&
        lease.supervisorInstanceId === this.options.supervisorInstanceId &&
        lease.appServerInstanceId === this.options.appServerInstanceId &&
        ["active", "suspect", "interrupting"].includes(lease.state)
    );
  }

  private owned(leaseId: string): TurnLeaseV1 {
    const lease = this.leases.get(leaseId);
    if (!lease) throw new SupervisorError("NOT_FOUND", `Unknown turn lease: ${leaseId}`, 404);
    if (
      lease.supervisorInstanceId !== this.options.supervisorInstanceId ||
      lease.appServerInstanceId !== this.options.appServerInstanceId
    ) {
      throw new SupervisorError("LEASE_CONFLICT", "Turn lease belongs to another runtime instance", 409);
    }
    return lease;
  }

  private async changed(force: boolean): Promise<void> {
    if (!this.options.onChange) return;
    const interval = this.options.minPersistIntervalMs ?? 1_000;
    const current = Date.now();
    if (!force && current - this.lastPersistedAt < interval) return;
    const previous = this.lastPersistedAt;
    this.lastPersistedAt = current;
    try {
      await this.options.onChange(this.list());
    } catch (error) {
      this.lastPersistedAt = previous;
      throw error;
    }
  }
}
