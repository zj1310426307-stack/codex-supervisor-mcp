import { randomUUID } from "node:crypto";
import type { VerifierLeaseV1 } from "../types.js";
import { SupervisorError } from "../core/errors.js";

const BLOCKING_STATES = new Set<VerifierLeaseV1["state"]>(["active", "terminating", "lost"]);

export interface VerifierLeaseManagerOptions {
  ownerInstanceId: string;
  ttlMs: number;
  onChange?: (leases: VerifierLeaseV1[]) => void | Promise<void>;
}

/** In-memory lease owner with a persistence callback for atomic ledger integration. */
export class VerifierLeaseManager {
  private readonly leases = new Map<string, VerifierLeaseV1>();

  constructor(private readonly options: VerifierLeaseManagerOptions) {
    if (!options.ownerInstanceId || !Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1) {
      throw new SupervisorError("INVALID_INPUT", "Invalid verifier lease manager options", 500);
    }
  }

  restore(leases: VerifierLeaseV1[]): void {
    this.leases.clear();
    for (const lease of leases) {
      const conflict = [...this.leases.values()].find(
        (existing) =>
          BLOCKING_STATES.has(existing.state) &&
          BLOCKING_STATES.has(lease.state) &&
          (existing.runId === lease.runId || existing.taskId === lease.taskId)
      );
      if (conflict) {
        throw new SupervisorError(
          "LEASE_CONFLICT",
          "Ledger contains conflicting active verifier leases; recovery is blocked",
          409,
          { leaseIds: [conflict.leaseId, lease.leaseId] }
        );
      }
      this.leases.set(lease.leaseId, { ...lease });
    }
  }

  async acquire(runId: string, taskId: string, workerId: string, at = new Date()): Promise<VerifierLeaseV1> {
    const conflict = [...this.leases.values()].find(
      (lease) => BLOCKING_STATES.has(lease.state) && (lease.runId === runId || lease.taskId === taskId)
    );
    if (conflict) {
      throw new SupervisorError("LEASE_CONFLICT", "Task or verifier run already has an active lease", 409, {
        leaseId: conflict.leaseId
      });
    }
    const timestamp = at.toISOString();
    const lease: VerifierLeaseV1 = {
      leaseId: randomUUID(),
      runId,
      taskId,
      workerId,
      ownerInstanceId: this.options.ownerInstanceId,
      acquiredAt: timestamp,
      heartbeatAt: timestamp,
      expiresAt: new Date(at.getTime() + this.options.ttlMs).toISOString(),
      state: "active"
    };
    this.leases.set(lease.leaseId, lease);
    await this.changed();
    return { ...lease };
  }

  async heartbeat(leaseId: string, at = new Date()): Promise<VerifierLeaseV1> {
    const lease = this.owned(leaseId);
    if (lease.state !== "active") throw new SupervisorError("LEASE_CONFLICT", "Verifier lease is not active", 409);
    lease.heartbeatAt = at.toISOString();
    lease.expiresAt = new Date(at.getTime() + this.options.ttlMs).toISOString();
    await this.changed();
    return { ...lease };
  }

  async finish(leaseId: string, state: "terminal" | "lost", at = new Date()): Promise<VerifierLeaseV1> {
    const lease = this.owned(leaseId);
    lease.state = state;
    lease.heartbeatAt = at.toISOString();
    lease.expiresAt = at.toISOString();
    await this.changed();
    return { ...lease };
  }

  list(): VerifierLeaseV1[] {
    return [...this.leases.values()].map((lease) => ({ ...lease }));
  }

  private owned(leaseId: string): VerifierLeaseV1 {
    const lease = this.leases.get(leaseId);
    if (!lease) throw new SupervisorError("NOT_FOUND", `Unknown verifier lease: ${leaseId}`, 404);
    if (lease.ownerInstanceId !== this.options.ownerInstanceId) {
      throw new SupervisorError("LEASE_CONFLICT", "Verifier lease belongs to another instance", 409);
    }
    return lease;
  }

  private async changed(): Promise<void> {
    await this.options.onChange?.(this.list());
  }
}
