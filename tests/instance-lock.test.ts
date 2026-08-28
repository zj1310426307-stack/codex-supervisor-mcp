import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InstanceLock } from "../src/core/instance-lock.js";

test("instance lock rejects a live owner and releases only its own identity", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-lock-"));
  const file = path.join(dir, "instance.lock");
  const first = new InstanceLock(file, { instanceId: "first" });
  await first.acquire();
  const second = new InstanceLock(file, { instanceId: "second" });
  await assert.rejects(second.acquire(), /Another supervisor instance may own/);
  await first.release();
  await second.acquire();
  await second.release();
});

test("instance lock reclaims only a provably dead same-host owner", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-lock-"));
  const file = path.join(dir, "instance.lock");
  await fs.writeFile(file, JSON.stringify({
    version: 1,
    instanceId: "dead",
    pid: 2_000_000_000,
    hostname: os.hostname(),
    startedAt: new Date(0).toISOString()
  }));
  const current = new InstanceLock(file, { instanceId: "current" });
  assert.equal((await current.acquire()).instanceId, "current");
  assert.equal((await fs.readdir(dir)).some((name) => name.includes(".stale.")), true);
  await current.release();
});
