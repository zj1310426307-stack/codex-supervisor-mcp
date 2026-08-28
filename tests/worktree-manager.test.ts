import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { WorktreeManager } from "../src/core/worktree-manager.js";

const exec = promisify(execFile);

async function repository(): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-worktree-source-"));
  await exec("git", ["-C", repo, "init", "-q"]);
  await exec("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", repo, "config", "user.name", "Test"]);
  await fs.writeFile(path.join(repo, "base.txt"), "base\n");
  await exec("git", ["-C", repo, "add", "base.txt"]);
  await exec("git", ["-C", repo, "commit", "-qm", "base"]);
  return repo;
}

test("worktree manager creates, validates and conservatively removes isolated worktrees", async () => {
  const repo = await repository();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-worktrees-"));
  const manager = new WorktreeManager({ root });
  const record = await manager.create(repo, "task-1");
  const validated = await manager.validate(record);
  assert.equal(validated.branch, "codex-supervisor/task-1");
  assert.notEqual(validated.worktree, repo);
  const cleaned = await manager.cleanup(record);
  assert.equal(cleaned.worktree, record.worktree);
  await assert.rejects(fs.access(record.worktree));
  const { stdout } = await exec("git", ["-C", repo, "branch", "--list", record.branch]);
  assert.match(stdout, /codex-supervisor\/task-1/);
});

test("worktree manager rejects a dirty source and dirty cleanup", async () => {
  const repo = await repository();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-worktrees-"));
  const manager = new WorktreeManager({ root });
  await fs.writeFile(path.join(repo, "dirty.txt"), "dirty");
  await assert.rejects(manager.create(repo, "task-dirty"), /must be clean/i);
  await fs.unlink(path.join(repo, "dirty.txt"));
  const record = await manager.create(repo, "task-clean");
  await fs.writeFile(path.join(record.worktree, "change.txt"), "change");
  await assert.rejects(manager.cleanup(record), /uncommitted changes/i);
});
