import type { TurnLeaseV1 } from "../types.js";
import { TurnLeaseManager } from "./turn-lease.js";

export interface TurnWatchdogOptions {
  warnIdleMs: number;
  suspectIdleMs: number;
  hardDeadlineMs: number;
  pollIntervalMs?: number;
  autoInterruptHung?: boolean;
}

export interface TurnWatchdogHooks {
  onWarning?: (lease: TurnLeaseV1, idleMs: number) => void | Promise<void>;
  canInterrupt?: (lease: TurnLeaseV1) => boolean | Promise<boolean>;
  interrupt?: (lease: TurnLeaseV1) => void | Promise<void>;
  onHardDeadline?: (lease: TurnLeaseV1, ageMs: number) => void | Promise<void>;
}

export interface WatchdogObservation {
  leaseId: string;
  action: "healthy" | "warned" | "suspect" | "interrupting" | "lost";
  idleMs: number;
  ageMs: number;
}

/** Observe turn liveness without equating event silence with proof of a hung process. */
export class TurnWatchdog {
  private timer?: NodeJS.Timeout;
  private readonly warned = new Set<string>();

  constructor(
    private readonly leases: TurnLeaseManager,
    private readonly options: TurnWatchdogOptions,
    private readonly hooks: TurnWatchdogHooks = {}
  ) {
    if (
      options.warnIdleMs < 1 ||
      options.suspectIdleMs <= options.warnIdleMs ||
      options.hardDeadlineMs <= options.suspectIdleMs
    ) {
      throw new Error("Watchdog thresholds must be positive and strictly increasing");
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.inspect(), this.options.pollIntervalMs ?? 5_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Run one deterministic watchdog pass, useful for both production polling and tests. */
  async inspect(at = new Date()): Promise<WatchdogObservation[]> {
    const observations: WatchdogObservation[] = [];
    for (const lease of this.leases.list()) {
      if (!["active", "suspect", "interrupting"].includes(lease.state)) continue;
      const idleMs = Math.max(0, at.getTime() - Date.parse(lease.lastProtocolEventAt));
      const ageMs = Math.max(0, at.getTime() - Date.parse(lease.acquiredAt));
      if (ageMs >= this.options.hardDeadlineMs) {
        await this.leases.markState(lease.leaseId, "lost", at);
        await this.hooks.onHardDeadline?.(lease, ageMs);
        observations.push({ leaseId: lease.leaseId, action: "lost", idleMs, ageMs });
        continue;
      }
      if (idleMs >= this.options.suspectIdleMs) {
        if (lease.state === "active") await this.leases.markState(lease.leaseId, "suspect", at);
        if (
          this.options.autoInterruptHung === true &&
          this.leases.isOwnedActive(lease.leaseId) &&
          (await this.hooks.canInterrupt?.(lease)) === true &&
          this.hooks.interrupt
        ) {
          await this.leases.markState(lease.leaseId, "interrupting", at);
          await this.hooks.interrupt(lease);
          observations.push({ leaseId: lease.leaseId, action: "interrupting", idleMs, ageMs });
        } else {
          observations.push({ leaseId: lease.leaseId, action: "suspect", idleMs, ageMs });
        }
        continue;
      }
      if (idleMs >= this.options.warnIdleMs) {
        if (!this.warned.has(lease.leaseId)) {
          this.warned.add(lease.leaseId);
          await this.hooks.onWarning?.(lease, idleMs);
        }
        observations.push({ leaseId: lease.leaseId, action: "warned", idleMs, ageMs });
      } else {
        this.warned.delete(lease.leaseId);
        observations.push({ leaseId: lease.leaseId, action: "healthy", idleMs, ageMs });
      }
    }
    return observations;
  }
}
