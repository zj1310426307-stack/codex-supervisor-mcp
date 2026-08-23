import fs from "node:fs/promises";
import path from "node:path";
import type { TaskRecord } from "../types.js";

interface StoredState {
  version: 1;
  tasks: TaskRecord[];
}

export class TaskStore {
  private readonly tasks = new Map<string, TaskRecord>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as StoredState;
      for (const task of parsed.tasks ?? []) {
        if (["starting", "running", "waiting_approval"].includes(task.status)) task.status = "stale";
        task.pendingApprovalIds = [];
        this.tasks.set(task.id, task);
      }
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") throw error;
    }
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): TaskRecord | undefined {
    return this.tasks.get(id);
  }

  async put(task: TaskRecord): Promise<void> {
    this.tasks.set(task.id, task);
    await this.flush();
  }

  async flush(): Promise<void> {
    const persist = async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const state: StoredState = { version: 1, tasks: this.list() };
      const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
      await fs.rename(tmp, this.file);
    };
    this.writeQueue = this.writeQueue.then(persist, persist);
    await this.writeQueue;
  }
}
