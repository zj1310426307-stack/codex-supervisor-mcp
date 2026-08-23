import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { workspaceDiff } from "../src/core/git-inspector.js";

const exec = promisify(execFile);

test("workspace diff includes staged, unstaged and untracked changes", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-git-"));
  await exec("git", ["-C", repo, "init", "-q"]);
  await exec("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", repo, "config", "user.name", "Test"]);
  await fs.writeFile(path.join(repo, "tracked.txt"), "base\n");
  await exec("git", ["-C", repo, "add", "tracked.txt"]);
  await exec("git", ["-C", repo, "commit", "-qm", "base"]);

  await fs.writeFile(path.join(repo, "tracked.txt"), "staged\n");
  await exec("git", ["-C", repo, "add", "tracked.txt"]);
  await fs.appendFile(path.join(repo, "tracked.txt"), "unstaged\n");
  await fs.writeFile(path.join(repo, "new.txt"), "untracked content\n");

  const result = await workspaceDiff(repo, 20000);
  assert.match(result.text, /staged/);
  assert.match(result.text, /unstaged/);
  assert.match(result.text, /new\.txt/);
  assert.match(result.text, /untracked content/);
});
