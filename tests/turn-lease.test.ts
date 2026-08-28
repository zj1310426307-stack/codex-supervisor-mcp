import assert from "node:assert/strict";
import test from "node:test";
import { TurnLeaseManager } from "../src/core/turn-lease.js";
import { TurnWatchdog } from "../src/core/turn-watchdog.js";

test("turn leases enforce one writer per worktree and owner", async () => {
  const manager = new TurnLeaseManager({
    supervisorInstanceId: "supervisor",
    appServerInstanceId: "app-server",
    ttlMs: 1000
  });
  const acquired = await manager.acquire({ taskId: "a", threadId: "thread-a", turnId: "turn-a", worktree: "/repo/a" });
  await assert.rejects(
    manager.acquire({ taskId: "b", threadId: "thread-b", turnId: "turn-b", worktree: "/repo/a" }),
    /active turn already owns/i
  );
  await manager.markState(acquired.leaseId, "terminal");
  const next = await manager.acquire({ taskId: "b", threadId: "thread-b", turnId: "turn-b", worktree: "/repo/a" });
  assert.equal(next.taskId, "b");
  await manager.markState(next.leaseId, "terminal");
  const lost = await manager.recordLost({ taskId: "c", threadId: "thread-c", turnId: "turn-c", worktree: "/repo/a" });
  assert.equal(lost.state, "lost");
  await assert.rejects(
    manager.acquire({ taskId: "d", threadId: "thread-d", turnId: "turn-d", worktree: "/repo/a" }),
    /active turn already owns/i
  );
  await manager.reconcileTerminal({
    leaseId: lost.leaseId,
    taskId: lost.taskId,
    threadId: lost.threadId,
    turnId: lost.turnId,
    worktree: lost.worktree
  });
});

test("watchdog warns, suspects and loses without automatic interruption by default", async () => {
  const base = new Date("2026-01-01T00:00:00.000Z");
  const manager = new TurnLeaseManager({
    supervisorInstanceId: "supervisor",
    appServerInstanceId: "app-server",
    ttlMs: 1000
  });
  await manager.acquire({ taskId: "a", threadId: "thread", turnId: "turn", worktree: "/repo/a" }, base);
  let interrupts = 0;
  const watchdog = new TurnWatchdog(
    manager,
    { warnIdleMs: 100, suspectIdleMs: 200, hardDeadlineMs: 500 },
    { interrupt: () => { interrupts += 1; }, canInterrupt: () => true }
  );
  assert.equal((await watchdog.inspect(new Date(base.getTime() + 150)))[0]?.action, "warned");
  assert.equal((await watchdog.inspect(new Date(base.getTime() + 250)))[0]?.action, "suspect");
  assert.equal(interrupts, 0);
  assert.equal((await watchdog.inspect(new Date(base.getTime() + 600)))[0]?.action, "lost");
  await assert.rejects(
    manager.acquire({ taskId: "b", threadId: "other", turnId: "other", worktree: "/repo/a" }),
    /active turn already owns/i
  );
});
