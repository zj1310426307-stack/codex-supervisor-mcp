import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { captureWorkspaceSnapshot, sameWorkspaceSnapshot } from "../src/core/snapshot.js";

const exec = promisify(execFile);

test("snapshot identity covers full tracked and untracked content", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-snapshot-"));
  await exec("git", ["-C", repo, "init", "-q"]);
  await exec("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", repo, "config", "user.name", "Test"]);
  await fs.writeFile(path.join(repo, "base.txt"), "base\n");
  await exec("git", ["-C", repo, "add", "base.txt"]);
  await exec("git", ["-C", repo, "commit", "-qm", "base"]);
  await fs.writeFile(path.join(repo, "new.txt"), "one");
  const first = await captureWorkspaceSnapshot(repo);
  const duplicate = await captureWorkspaceSnapshot(repo);
  assert.equal(first.snapshotId, duplicate.snapshotId);
  assert.equal(sameWorkspaceSnapshot(first, duplicate), true);
  await fs.writeFile(path.join(repo, "new.txt"), "two");
  const changed = await captureWorkspaceSnapshot(repo);
  assert.notEqual(first.untrackedHash, changed.untrackedHash);
  assert.notEqual(first.diffHash, changed.diffHash);
  assert.notEqual(first.snapshotId, changed.snapshotId);
  assert.deepEqual(changed.changedFiles, ["new.txt"]);
});

test("snapshot independently binds staged and working-tree content", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-snapshot-"));
  await exec("git", ["-C", repo, "init", "-q"]);
  await exec("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", repo, "config", "user.name", "Test"]);
  await fs.writeFile(path.join(repo, "base.txt"), "base\n");
  await exec("git", ["-C", repo, "add", "base.txt"]);
  await exec("git", ["-C", repo, "commit", "-qm", "base"]);

  await fs.writeFile(path.join(repo, "base.txt"), "index-one\n");
  await exec("git", ["-C", repo, "add", "base.txt"]);
  await fs.writeFile(path.join(repo, "base.txt"), "stable-working-copy\n");
  const first = await captureWorkspaceSnapshot(repo);

  await fs.writeFile(path.join(repo, "base.txt"), "index-two\n");
  await exec("git", ["-C", repo, "add", "base.txt"]);
  await fs.writeFile(path.join(repo, "base.txt"), "stable-working-copy\n");
  const second = await captureWorkspaceSnapshot(repo);
  assert.notEqual(first.snapshotId, second.snapshotId);
  assert.notEqual(first.diffHash, second.diffHash);
  assert.deepEqual(second.changedFiles, ["base.txt"]);
});

test("snapshot binds ignored files and symbolic-link targets", async (t) => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-snapshot-"));
  await exec("git", ["-C", repo, "init", "-q"]);
  await exec("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", repo, "config", "user.name", "Test"]);
  await fs.writeFile(path.join(repo, ".gitignore"), ".env\nignored-link\n");
  await fs.writeFile(path.join(repo, "base.txt"), "base\n");
  await exec("git", ["-C", repo, "add", ".gitignore", "base.txt"]);
  await exec("git", ["-C", repo, "commit", "-qm", "base"]);
  await fs.writeFile(path.join(repo, ".env"), "MODE=one\n");
  const first = await captureWorkspaceSnapshot(repo);
  assert.deepEqual(first.changedFiles, [".env"]);
  await fs.writeFile(path.join(repo, ".env"), "MODE=two\n");
  const changed = await captureWorkspaceSnapshot(repo);
  assert.notEqual(changed.snapshotId, first.snapshotId);

  try {
    await fs.symlink("base.txt", path.join(repo, "ignored-link"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.diagnostic("symbolic-link creation is unavailable on this Windows host");
      return;
    }
    throw error;
  }
  const linked = await captureWorkspaceSnapshot(repo);
  assert.deepEqual(linked.changedFiles, [".env", "ignored-link"]);
  await fs.unlink(path.join(repo, "ignored-link"));
  await fs.symlink(".env", path.join(repo, "ignored-link"));
  const retargeted = await captureWorkspaceSnapshot(repo);
  assert.notEqual(retargeted.snapshotId, linked.snapshotId);
});

test("snapshot rejects a same-size same-mtime untracked file replacement", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-snapshot-"));
  await exec("git", ["-C", repo, "init", "-q"]);
  await exec("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", repo, "config", "user.name", "Test"]);
  await fs.writeFile(path.join(repo, "base.txt"), "base\n");
  await exec("git", ["-C", repo, "add", "base.txt"]);
  await exec("git", ["-C", repo, "commit", "-qm", "base"]);

  const victim = path.join(repo, "race.bin");
  const replacement = path.join(repo, ".git", "replacement.bin");
  await fs.writeFile(victim, "original");
  await fs.writeFile(replacement, "replaced");
  const stableTimestamp = new Date(Math.floor(Date.now() / 1000) * 1000);
  await fs.utimes(victim, stableTimestamp, stableTimestamp);
  await fs.utimes(replacement, stableTimestamp, stableTimestamp);
  const victimStat = await fs.stat(victim);
  const replacementStat = await fs.stat(replacement);
  assert.equal(replacementStat.size, victimStat.size);
  assert.equal(replacementStat.mtimeMs, victimStat.mtimeMs);

  const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "lstat");
  assert.ok(originalDescriptor);
  const originalLstat = fs.lstat;
  let replaced = false;
  Object.defineProperty(fs, "lstat", {
    ...originalDescriptor,
    value: async (...args: unknown[]) => {
      const result = await Reflect.apply(originalLstat, fs, args);
      if (!replaced && path.resolve(String(args[0])) === path.resolve(victim)) {
        replaced = true;
        if (process.platform === "win32") await fs.unlink(victim);
        await fs.rename(replacement, victim);
      }
      return result;
    }
  });
  try {
    await assert.rejects(captureWorkspaceSnapshot(repo), /Workspace changed while a file was captured/);
  } finally {
    Object.defineProperty(fs, "lstat", originalDescriptor);
  }
  assert.equal(replaced, true);
});

test("snapshot rejects a same-target symlink replacement", {
  skip: process.platform === "win32" ? "requires POSIX symlink and atomic rename-overwrite semantics" : false
}, async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-snapshot-"));
  await exec("git", ["-C", repo, "init", "-q"]);
  await exec("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", repo, "config", "user.name", "Test"]);
  await fs.writeFile(path.join(repo, "base.txt"), "base\n");
  await exec("git", ["-C", repo, "add", "base.txt"]);
  await exec("git", ["-C", repo, "commit", "-qm", "base"]);

  const victim = path.join(repo, "race-link");
  const replacement = path.join(repo, ".git", "replacement-link");
  await fs.symlink("base.txt", victim);
  await fs.symlink("base.txt", replacement);
  const stableTimestamp = new Date(Math.floor(Date.now() / 1000) * 1000);
  await fs.lutimes(victim, stableTimestamp, stableTimestamp);
  await fs.lutimes(replacement, stableTimestamp, stableTimestamp);
  const victimStat = await fs.lstat(victim);
  const replacementStat = await fs.lstat(replacement);
  assert.equal(replacementStat.size, victimStat.size);
  assert.equal(replacementStat.mtimeMs, victimStat.mtimeMs);

  const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "lstat");
  assert.ok(originalDescriptor);
  const originalLstat = fs.lstat;
  let replaced = false;
  Object.defineProperty(fs, "lstat", {
    ...originalDescriptor,
    value: async (...args: unknown[]) => {
      const result = await Reflect.apply(originalLstat, fs, args);
      if (!replaced && path.resolve(String(args[0])) === path.resolve(victim)) {
        replaced = true;
        await fs.rename(replacement, victim);
      }
      return result;
    }
  });
  try {
    await assert.rejects(captureWorkspaceSnapshot(repo), /Workspace changed while a symbolic link was captured/);
  } finally {
    Object.defineProperty(fs, "lstat", originalDescriptor);
  }
  assert.equal(replaced, true);
});

test("snapshot limits fail closed before oversized content becomes evidence", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-snapshot-"));
  await exec("git", ["-C", repo, "init", "-q"]);
  await exec("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", repo, "config", "user.name", "Test"]);
  await fs.writeFile(path.join(repo, "base.txt"), "base\n");
  await exec("git", ["-C", repo, "add", "base.txt"]);
  await exec("git", ["-C", repo, "commit", "-qm", "base"]);
  await fs.writeFile(path.join(repo, "large.bin"), Buffer.alloc(17));
  await assert.rejects(
    captureWorkspaceSnapshot(repo, "HEAD", {
      maxChangedFiles: 10,
      maxTotalBytes: 1024,
      maxFileBytes: 16,
      maxGitOutputBytes: 1024 * 1024
    }),
    /per-file byte limit/
  );
  await exec("git", ["-C", repo, "add", "large.bin"]);
  // Keep the live file below the limit so only the staged object proves the
  // per-file limit also applies to index content.
  await fs.writeFile(path.join(repo, "large.bin"), Buffer.alloc(1));
  await assert.rejects(
    captureWorkspaceSnapshot(repo, "HEAD", {
      maxChangedFiles: 10,
      maxTotalBytes: 1024,
      maxFileBytes: 16,
      maxGitOutputBytes: 1024 * 1024
    }),
    /staged file exceeds the per-file byte limit/
  );
});

test("staged-object stderr is independently bounded", {
  skip: process.platform === "win32" ? "uses a POSIX executable shim" : false
}, async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-snapshot-"));
  await exec("git", ["-C", repo, "init", "-q"]);
  await exec("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", repo, "config", "user.name", "Test"]);
  await fs.writeFile(path.join(repo, "base.txt"), "base\n");
  await exec("git", ["-C", repo, "add", "base.txt"]);
  await exec("git", ["-C", repo, "commit", "-qm", "base"]);
  await fs.writeFile(path.join(repo, "staged.txt"), "staged\n");
  await exec("git", ["-C", repo, "add", "staged.txt"]);

  const realGit = await fs.realpath((await exec("sh", ["-c", "command -v git"])).stdout.trim());
  const shimDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-git-shim-"));
  const shim = path.join(shimDirectory, "git");
  await fs.writeFile(shim, `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { writeSync } = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("cat-file")) {
  const payload = Buffer.alloc(70 * 1024, 120);
  let offset = 0;
  while (offset < payload.length) {
    offset += writeSync(2, payload, offset, payload.length - offset);
  }
  process.exit(2);
}
const result = spawnSync(process.env.SNAPSHOT_TEST_REAL_GIT, args, { stdio: "inherit" });
process.exit(typeof result.status === "number" ? result.status : 127);
`);
  await fs.chmod(shim, 0o755);

  const originalPath = process.env.PATH;
  const originalRealGit = process.env.SNAPSHOT_TEST_REAL_GIT;
  process.env.PATH = `${shimDirectory}${path.delimiter}${originalPath ?? ""}`;
  process.env.SNAPSHOT_TEST_REAL_GIT = realGit;
  try {
    await assert.rejects(
      captureWorkspaceSnapshot(repo, "HEAD", {
        maxChangedFiles: 10,
        maxTotalBytes: 1024,
        maxFileBytes: 1024,
        maxGitOutputBytes: 1024 * 1024
      }),
      /Git staged-object stderr exceeds the output limit/
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalRealGit === undefined) delete process.env.SNAPSHOT_TEST_REAL_GIT;
    else process.env.SNAPSHOT_TEST_REAL_GIT = originalRealGit;
  }
});

test("base-bound snapshot retains committed changes and both rename paths", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-snapshot-"));
  await exec("git", ["-C", repo, "init", "-q"]);
  await exec("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", repo, "config", "user.name", "Test"]);
  await fs.writeFile(path.join(repo, "old.txt"), "base\n");
  await exec("git", ["-C", repo, "add", "old.txt"]);
  await exec("git", ["-C", repo, "commit", "-qm", "base"]);
  const baseSha = (await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
  await exec("git", ["-C", repo, "mv", "old.txt", "new.txt"]);
  const renamed = await captureWorkspaceSnapshot(repo, baseSha);
  assert.deepEqual(renamed.changedFiles, ["new.txt", "old.txt"]);
  await exec("git", ["-C", repo, "commit", "-am", "rename", "-q"]);
  const committed = await captureWorkspaceSnapshot(repo, baseSha);
  assert.deepEqual(committed.changedFiles, ["new.txt", "old.txt"]);
  assert.equal(committed.comparisonBaseSha, baseSha);
});
