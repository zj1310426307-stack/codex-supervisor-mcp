import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SupervisorError } from "./errors.js";

export interface InstanceLockRecord {
  version: 1;
  instanceId: string;
  pid: number;
  hostname: string;
  startedAt: string;
  stateFile?: string;
  codexHome?: string;
}

export interface InstanceLockOptions {
  instanceId?: string;
  stateFile?: string;
  codexHome?: string;
  hostname?: string;
  pid?: number;
}

function processState(pid: number): "alive" | "dead" | "unknown" {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    return "unknown";
  }
}

/** Single-instance lock that reclaims only provably stale same-host owners. */
export class InstanceLock {
  readonly instanceId: string;
  private acquired = false;
  private readonly hostname: string;
  private readonly pid: number;

  constructor(private readonly file: string, private readonly options: InstanceLockOptions = {}) {
    this.instanceId = options.instanceId ?? randomUUID();
    this.hostname = options.hostname ?? os.hostname();
    this.pid = options.pid ?? process.pid;
  }

  async acquire(): Promise<InstanceLockRecord> {
    const record: InstanceLockRecord = {
      version: 1,
      instanceId: this.instanceId,
      pid: this.pid,
      hostname: this.hostname,
      startedAt: new Date().toISOString(),
      ...(this.options.stateFile ? { stateFile: path.resolve(this.options.stateFile) } : {}),
      ...(this.options.codexHome ? { codexHome: path.resolve(this.options.codexHome) } : {})
    };
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await fs.open(this.file, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        this.acquired = true;
        return record;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await this.readExisting();
        if (existing.instanceId === this.instanceId && existing.pid === this.pid) {
          this.acquired = true;
          return existing;
        }
        if (existing.hostname !== this.hostname || processState(existing.pid) !== "dead") {
          throw new SupervisorError(
            "LOCK_CONFLICT",
            "Another supervisor instance may own this state/Codex domain",
            409,
            {
              ownerInstanceId: existing.instanceId,
              ownerPid: existing.pid,
              ownerHostname: existing.hostname
            }
          );
        }
        const stale = `${this.file}.stale.${Date.now()}.${existing.instanceId}`;
        try {
          await fs.rename(this.file, stale);
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw renameError;
        }
      }
    }
    throw new SupervisorError("LOCK_CONFLICT", "Unable to acquire supervisor instance lock", 409);
  }

  /** Release only a lock whose identity still matches this process instance. */
  async release(): Promise<void> {
    if (!this.acquired) return;
    const existing = await this.readExisting().catch(() => undefined);
    if (existing?.instanceId !== this.instanceId || existing.pid !== this.pid) {
      this.acquired = false;
      throw new SupervisorError("LOCK_CONFLICT", "Refusing to remove a lock now owned by another instance", 409);
    }
    await fs.unlink(this.file);
    this.acquired = false;
  }

  private async readExisting(): Promise<InstanceLockRecord> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch (error) {
      throw new SupervisorError(
        "LOCK_CONFLICT",
        "Existing instance lock is unreadable; ownership cannot be proven stale",
        409,
        undefined,
        { cause: error }
      );
    }
    const record = parsed as Partial<InstanceLockRecord>;
    if (
      record.version !== 1 ||
      typeof record.instanceId !== "string" ||
      typeof record.pid !== "number" ||
      typeof record.hostname !== "string" ||
      typeof record.startedAt !== "string"
    ) {
      throw new SupervisorError("LOCK_CONFLICT", "Existing instance lock has an unknown format", 409);
    }
    return record as InstanceLockRecord;
  }
}
