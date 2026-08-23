import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskStore } from "../src/core/store.js";
import type { TaskRecord } from "../src/types.js";

function task(id: string): TaskRecord {
  const now = new Date().toISOString();
  return {
    id,
    objective: `task-${id}`,
    workspace: "/tmp/repo",
    status: "completed",
    createdAt: now,
    updatedAt: now,
    eventSeq: 0,
    events: [],
    pendingApprovalIds: []
  };
}

test("task store serializes concurrent writes without corrupting the ledger", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-store-"));
  const file = path.join(dir, "state.json");
  const store = new TaskStore(file);
  await Promise.all([store.put(task("a")), store.put(task("b")), store.put(task("c"))]);
  const parsed = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(parsed.version, 1);
  assert.deepEqual(new Set(parsed.tasks.map((value: TaskRecord) => value.id)), new Set(["a", "b", "c"]));
});

test("active tasks become stale after supervisor restart", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-store-"));
  const file = path.join(dir, "state.json");
  const first = new TaskStore(file);
  const running = task("running");
  running.status = "running";
  running.pendingApprovalIds = ["approval-1"];
  await first.put(running);

  const second = new TaskStore(file);
  await second.load();
  assert.equal(second.get("running")?.status, "stale");
  assert.deepEqual(second.get("running")?.pendingApprovalIds, []);
});
