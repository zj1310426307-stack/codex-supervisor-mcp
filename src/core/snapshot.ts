import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import fs, { type BigIntStats } from "node:fs";
import fsp, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { WorkspaceSnapshot } from "../types.js";
import { canonicalJson } from "./contracts.js";
import { SupervisorError } from "./errors.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_STDERR_BYTES = 64 * 1024;

export interface SnapshotLimits {
  maxChangedFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  maxGitOutputBytes: number;
}

export const DEFAULT_SNAPSHOT_LIMITS: Readonly<SnapshotLimits> = Object.freeze({
  maxChangedFiles: 50_000,
  maxTotalBytes: 512 * 1024 * 1024,
  maxFileBytes: 64 * 1024 * 1024,
  maxGitOutputBytes: 128 * 1024 * 1024
});

async function gitBuffer(workspace: string, args: string[], maxBuffer = 128 * 1024 * 1024): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", ["-C", workspace, ...args], {
    encoding: "buffer",
    maxBuffer,
    timeout: 120_000,
    windowsHide: true
  });
  return stdout as Buffer;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function snapshotLimit(message: string, details: Record<string, unknown>): SupervisorError {
  return new SupervisorError("WORKTREE_INVALID", message, 413, details);
}

/** Hash bytes through an already-open descriptor so a path replacement cannot redirect the read. */
async function hashOpenFile(handle: FileHandle, maxBytes: number): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes));
  let bytes = 0;
  while (true) {
    const result = await handle.read(buffer, 0, buffer.length, bytes);
    if (result.bytesRead === 0) break;
    bytes += result.bytesRead;
    if (bytes > maxBytes) {
      throw snapshotLimit("Snapshot file exceeds the per-file byte limit", { maxFileBytes: maxBytes });
    }
    hash.update(buffer.subarray(0, result.bytesRead));
  }
  return { sha256: hash.digest("hex"), bytes };
}

/** Compare the stable filesystem identity and mutation clocks required for a safe capture. */
function sameFilesystemIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

/** Build the fail-closed error used when a directory entry mutates during capture. */
function workspaceChangedDuringCapture(relative: string, kind: "file" | "symbolic link"): SupervisorError {
  return new SupervisorError("WORKTREE_INVALID", `Workspace changed while a ${kind} was captured`, 409, {
    path: relative
  });
}

/** Capture a regular file while proving the opened descriptor and final path are the same object. */
async function captureRegularFile(
  absolute: string,
  relative: string,
  initial: BigIntStats,
  maxBytes: number
): Promise<{ sha256: string; bytes: number }> {
  if (initial.size > BigInt(maxBytes)) {
    throw snapshotLimit("Snapshot file exceeds the per-file byte limit", {
      path: relative,
      bytes: initial.size.toString(),
      maxFileBytes: maxBytes
    });
  }
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  let handle: FileHandle;
  try {
    handle = await fsp.open(absolute, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOENT" || code === "ENOTDIR") {
      throw workspaceChangedDuringCapture(relative, "file");
    }
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFilesystemIdentity(initial, opened)) {
      throw workspaceChangedDuringCapture(relative, "file");
    }
    const hashed = await hashOpenFile(handle, maxBytes);
    const readComplete = await handle.stat({ bigint: true });
    if (
      !readComplete.isFile() ||
      !sameFilesystemIdentity(opened, readComplete) ||
      BigInt(hashed.bytes) !== readComplete.size
    ) {
      throw workspaceChangedDuringCapture(relative, "file");
    }
    const finalPath = await fsp.lstat(absolute, { bigint: true });
    if (!finalPath.isFile() || !sameFilesystemIdentity(readComplete, finalPath)) {
      throw workspaceChangedDuringCapture(relative, "file");
    }
    return hashed;
  } catch (error) {
    if (error instanceof SupervisorError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOENT" || code === "ENOTDIR") {
      throw workspaceChangedDuringCapture(relative, "file");
    }
    throw error;
  } finally {
    await handle.close();
  }
}

/** Capture a symlink target while proving the directory entry was not replaced during readlink. */
async function captureSymbolicLink(
  absolute: string,
  relative: string,
  initial: BigIntStats,
  maxBytes: number
): Promise<{ target: string; bytes: number }> {
  let target: string;
  try {
    target = await fsp.readlink(absolute);
    const afterFirstRead = await fsp.lstat(absolute, { bigint: true });
    const verifiedTarget = await fsp.readlink(absolute);
    const finalPath = await fsp.lstat(absolute, { bigint: true });
    if (
      !afterFirstRead.isSymbolicLink() ||
      !finalPath.isSymbolicLink() ||
      !sameFilesystemIdentity(initial, afterFirstRead) ||
      !sameFilesystemIdentity(afterFirstRead, finalPath) ||
      verifiedTarget !== target
    ) {
      throw workspaceChangedDuringCapture(relative, "symbolic link");
    }
  } catch (error) {
    if (error instanceof SupervisorError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EINVAL" || code === "ENOENT" || code === "ENOTDIR") {
      throw workspaceChangedDuringCapture(relative, "symbolic link");
    }
    throw error;
  }
  const bytes = Buffer.byteLength(target, "utf8");
  if (bytes > maxBytes) {
    throw snapshotLimit("Snapshot symbolic-link target exceeds the per-file byte limit", {
      path: relative,
      bytes,
      maxFileBytes: maxBytes
    });
  }
  return { target, bytes };
}

interface UntrackedEntry {
  path: string;
  kind: "file" | "symlink";
  size: number;
  sha256: string;
  ignored: boolean;
}

function trackedChangedPaths(raw: Buffer): string[] {
  const tokens = raw.toString("utf8").split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < tokens.length;) {
    let status = tokens[index++]!;
    let inlinePath: string | undefined;
    const tab = status.indexOf("\t");
    if (tab >= 0) {
      inlinePath = status.slice(tab + 1);
      status = status.slice(0, tab);
    }
    const first = inlinePath ?? tokens[index++];
    if (!first || !/^[A-Z][0-9]*$/.test(status)) {
      throw new SupervisorError("WORKTREE_INVALID", "Unable to parse Git changed-path identity", 500);
    }
    paths.push(first.replace(/\\/g, "/"));
    if (status.startsWith("R") || status.startsWith("C")) {
      const second = tokens[index++];
      if (!second) throw new SupervisorError("WORKTREE_INVALID", "Git rename/copy record omitted a path", 500);
      paths.push(second.replace(/\\/g, "/"));
    }
  }
  return paths;
}

interface StagedBlobEntry {
  path: string;
  objectId: string;
}

function stagedBlobEntries(raw: Buffer): StagedBlobEntry[] {
  const tokens = raw.toString("utf8").split("\0").filter(Boolean);
  const entries: StagedBlobEntry[] = [];
  for (let index = 0; index < tokens.length;) {
    const header = tokens[index++]!;
    const match = /^:\d{6} (\d{6}) [a-f0-9]{40,64} ([a-f0-9]{40,64}) ([A-Z])\d*$/i.exec(header);
    if (!match) {
      throw new SupervisorError("WORKTREE_INVALID", "Unable to parse Git staged-object identity", 500);
    }
    const first = tokens[index++];
    if (!first) throw new SupervisorError("WORKTREE_INVALID", "Git staged record omitted a path", 500);
    const status = match[3]!;
    const selected = status === "R" || status === "C" ? tokens[index++] : first;
    if (!selected) throw new SupervisorError("WORKTREE_INVALID", "Git staged rename omitted its target path", 500);
    const newMode = match[1]!;
    const objectId = match[2]!.toLowerCase();
    if (newMode !== "000000" && !/^0+$/.test(objectId)) {
      entries.push({ path: selected.replace(/\\/g, "/"), objectId });
    }
  }
  return entries;
}

async function gitObjectMetadata(
  workspace: string,
  objectIds: string[],
  maxOutputBytes: number
): Promise<Array<{ type: string; size: number }>> {
  if (objectIds.length === 0) return [];
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      ["-C", workspace, "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(snapshotLimit("Git staged-object inspection exceeded its time limit", {}));
    }, 120_000);
    timeout.unref();
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else {
        const lines = Buffer.concat(stdout).toString("utf8").trimEnd().split("\n");
        if (lines.length !== objectIds.length) {
          reject(new SupervisorError("WORKTREE_INVALID", "Git omitted staged-object metadata", 500));
          return;
        }
        const metadata: Array<{ type: string; size: number }> = [];
        for (let index = 0; index < lines.length; index += 1) {
          const match = /^([a-f0-9]{40,64}) (blob|commit) ([0-9]+)$/i.exec(lines[index]!.trim());
          const size = match ? Number(match[3]) : Number.NaN;
          if (
            !match ||
            match[1]!.toLowerCase() !== objectIds[index] ||
            !Number.isSafeInteger(size) ||
            size < 0
          ) {
            reject(new SupervisorError("WORKTREE_INVALID", "Git returned invalid staged-object metadata", 500));
            return;
          }
          metadata.push({ type: match[2]!.toLowerCase(), size });
        }
        resolve(metadata);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        child.kill("SIGKILL");
        finish(snapshotLimit("Git staged-object metadata exceeds the output limit", {
          maxGitOutputBytes: maxOutputBytes
        }));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_GIT_STDERR_BYTES) {
        child.kill("SIGKILL");
        finish(snapshotLimit("Git staged-object stderr exceeds the output limit", {
          maxGitStderrBytes: MAX_GIT_STDERR_BYTES
        }));
        return;
      }
      stderr.push(chunk);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code !== 0) {
        finish(new SupervisorError("WORKTREE_INVALID", "Git could not inspect staged objects", 500, {
          stderr: Buffer.concat(stderr).toString("utf8").slice(0, 4096)
        }));
        return;
      }
      finish();
    });
    child.stdin.end(`${objectIds.join("\n")}\n`);
  });
}

async function stagedContentBytes(
  workspace: string,
  entries: StagedBlobEntry[],
  limits: SnapshotLimits
): Promise<number> {
  const metadata = await gitObjectMetadata(
    workspace,
    entries.map((entry) => entry.objectId),
    limits.maxGitOutputBytes
  );
  let total = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const object = metadata[index]!;
    // A gitlink is a commit identity, not repository file content.
    const bytes = object.type === "blob" ? object.size : 0;
    if (bytes > limits.maxFileBytes) {
      throw snapshotLimit("Snapshot staged file exceeds the per-file byte limit", {
        path: entry.path,
        bytes,
        maxFileBytes: limits.maxFileBytes
      });
    }
    total += bytes;
    if (total > limits.maxTotalBytes) {
      throw snapshotLimit("Snapshot exceeds the total staged-content byte limit", {
        totalBytes: total,
        maxTotalBytes: limits.maxTotalBytes
      });
    }
  }
  return total;
}

async function untrackedManifest(workspace: string, limits: SnapshotLimits): Promise<UntrackedEntry[]> {
  const [ordinaryRaw, ignoredRaw] = await Promise.all([
    gitBuffer(workspace, ["ls-files", "--others", "--exclude-standard", "-z"], limits.maxGitOutputBytes),
    gitBuffer(
      workspace,
      ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
      limits.maxGitOutputBytes
    )
  ]);
  const ordinary = new Set(ordinaryRaw.toString("utf8").split("\0").filter(Boolean));
  const ignored = new Set(ignoredRaw.toString("utf8").split("\0").filter(Boolean));
  const names = [...new Set([...ordinary, ...ignored])].sort();
  if (names.length > limits.maxChangedFiles) {
    throw snapshotLimit("Snapshot exceeds the changed-file count limit", {
      changedFiles: names.length,
      maxChangedFiles: limits.maxChangedFiles
    });
  }
  const manifest: UntrackedEntry[] = [];
  const root = path.resolve(workspace);
  let totalBytes = 0;
  for (const relative of names) {
    const absolute = path.resolve(root, relative);
    if (absolute === root || !absolute.startsWith(root + path.sep)) {
      throw new SupervisorError("WORKTREE_INVALID", "Git returned an untracked path outside the worktree", 500);
    }
    const stat = await fsp.lstat(absolute, { bigint: true });
    if (stat.isSymbolicLink()) {
      const captured = await captureSymbolicLink(absolute, relative, stat, limits.maxFileBytes);
      totalBytes += captured.bytes;
      manifest.push({
        path: relative.replace(/\\/g, "/"),
        kind: "symlink",
        size: captured.bytes,
        sha256: sha256(captured.target),
        ignored: ignored.has(relative)
      });
    } else if (stat.isFile()) {
      const hashed = await captureRegularFile(absolute, relative, stat, limits.maxFileBytes);
      totalBytes += hashed.bytes;
      manifest.push({
        path: relative.replace(/\\/g, "/"),
        kind: "file",
        size: hashed.bytes,
        sha256: hashed.sha256,
        ignored: ignored.has(relative)
      });
    } else {
      throw new SupervisorError("WORKTREE_INVALID", "Snapshot encountered an unsupported untracked file type", 409, {
        path: relative
      });
    }
    if (totalBytes > limits.maxTotalBytes) {
      throw snapshotLimit("Snapshot exceeds the total untracked-content byte limit", {
        totalBytes,
        maxTotalBytes: limits.maxTotalBytes
      });
    }
  }
  return manifest;
}

async function trackedContentBytes(
  workspace: string,
  trackedPaths: string[],
  limits: SnapshotLimits
): Promise<number> {
  const root = path.resolve(workspace);
  let total = 0;
  for (const relative of [...new Set(trackedPaths)]) {
    const absolute = path.resolve(root, relative);
    if (absolute === root || !absolute.startsWith(root + path.sep)) {
      throw new SupervisorError("WORKTREE_INVALID", "Git returned a tracked path outside the worktree", 500);
    }
    let stat;
    try {
      stat = await fsp.lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    let bytes = 0;
    if (stat.isFile()) bytes = stat.size;
    else if (stat.isSymbolicLink()) bytes = Buffer.byteLength(await fsp.readlink(absolute), "utf8");
    else if (stat.isDirectory()) continue; // A changed Git submodule is represented by its commit identity.
    else {
      throw new SupervisorError("WORKTREE_INVALID", "Snapshot encountered an unsupported tracked file type", 409, {
        path: relative
      });
    }
    if (bytes > limits.maxFileBytes) {
      throw snapshotLimit("Snapshot tracked file exceeds the per-file byte limit", {
        path: relative,
        bytes,
        maxFileBytes: limits.maxFileBytes
      });
    }
    total += bytes;
    if (total > limits.maxTotalBytes) {
      throw snapshotLimit("Snapshot exceeds the total tracked-content byte limit", {
        totalBytes: total,
        maxTotalBytes: limits.maxTotalBytes
      });
    }
  }
  return total;
}

/** Capture a deterministic full-content hash while keeping only bounded metadata in the ledger. */
export async function captureWorkspaceSnapshot(
  workspace: string,
  comparisonBase = "HEAD",
  limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS
): Promise<WorkspaceSnapshot> {
  const root = await fsp.realpath(path.resolve(workspace));
  if (
    !Number.isSafeInteger(limits.maxChangedFiles) || limits.maxChangedFiles < 1 ||
    !Number.isSafeInteger(limits.maxTotalBytes) || limits.maxTotalBytes < 1 ||
    !Number.isSafeInteger(limits.maxFileBytes) || limits.maxFileBytes < 1 ||
    !Number.isSafeInteger(limits.maxGitOutputBytes) || limits.maxGitOutputBytes < 1
  ) {
    throw new SupervisorError("WORKTREE_INVALID", "Snapshot limits must be positive safe integers", 500);
  }
  if (comparisonBase !== "HEAD" && !/^[a-f0-9]{40,64}$/i.test(comparisonBase)) {
    throw new SupervisorError("WORKTREE_INVALID", "Snapshot comparison base is not a commit identity", 500);
  }
  const [
    headRaw,
    baseRaw,
    branchRaw,
    statusRaw,
    stagedDiff,
    workingDiff,
    stagedNames,
    workingNames,
    stagedObjects,
    untracked
  ] = await Promise.all([
    gitBuffer(root, ["rev-parse", "--verify", "HEAD"], limits.maxGitOutputBytes),
    gitBuffer(root, ["rev-parse", "--verify", comparisonBase], limits.maxGitOutputBytes),
    gitBuffer(root, ["branch", "--show-current"], limits.maxGitOutputBytes),
    gitBuffer(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], limits.maxGitOutputBytes),
    gitBuffer(root, [
      "diff", "--cached", comparisonBase, "--binary", "--full-index", "--no-ext-diff", "--"
    ], limits.maxGitOutputBytes),
    gitBuffer(root, [
      "diff", "--binary", "--full-index", "--no-ext-diff", "--"
    ], limits.maxGitOutputBytes),
    gitBuffer(root, [
      "diff", "--cached", comparisonBase, "--name-status", "-z", "--find-renames", "--find-copies-harder", "--"
    ], limits.maxGitOutputBytes),
    gitBuffer(root, [
      "diff", "--name-status", "-z", "--find-renames", "--find-copies-harder", "--"
    ], limits.maxGitOutputBytes),
    gitBuffer(root, [
      "diff", "--cached", comparisonBase, "--raw", "--no-abbrev", "-z", "--find-renames", "--find-copies-harder", "--"
    ], limits.maxGitOutputBytes),
    untrackedManifest(root, limits)
  ]);
  const headSha = headRaw.toString("utf8").trim();
  const comparisonBaseSha = baseRaw.toString("utf8").trim();
  const branch = branchRaw.toString("utf8").trim();
  const statusHash = sha256(statusRaw);
  const untrackedHash = sha256(canonicalJson(untracked));
  const diffHash = sha256(Buffer.concat([
    Buffer.from("staged\0", "utf8"),
    stagedDiff,
    Buffer.from("\0working\0", "utf8"),
    workingDiff,
    Buffer.from(`\0untracked\0${untrackedHash}`, "utf8")
  ]));
  const trackedPaths = [
    ...trackedChangedPaths(stagedNames),
    ...trackedChangedPaths(workingNames)
  ];
  const stagedEntries = stagedBlobEntries(stagedObjects);
  const changedFiles = [
    ...trackedPaths,
    ...untracked.map((entry) => entry.path)
  ].sort();
  const uniqueChangedFiles = [...new Set(changedFiles)];
  if (uniqueChangedFiles.length > limits.maxChangedFiles) {
    throw snapshotLimit("Snapshot exceeds the changed-file count limit", {
      changedFiles: uniqueChangedFiles.length,
      maxChangedFiles: limits.maxChangedFiles
    });
  }
  const [trackedBytes, stagedBytes, untrackedBytes] = await Promise.all([
    trackedContentBytes(root, trackedPaths, limits),
    stagedContentBytes(root, stagedEntries, limits),
    Promise.resolve(untracked.reduce((sum, entry) => sum + entry.size, 0))
  ]);
  if (untrackedBytes + trackedBytes + stagedBytes > limits.maxTotalBytes) {
    throw snapshotLimit("Snapshot exceeds the total changed-content byte limit", {
      totalBytes: untrackedBytes + trackedBytes + stagedBytes,
      maxTotalBytes: limits.maxTotalBytes
    });
  }
  const identity = canonicalJson({
    branch,
    changedFiles: uniqueChangedFiles,
    comparisonBaseSha,
    diffHash,
    headSha,
    statusHash,
    untrackedHash
  });
  return {
    snapshotId: sha256(identity),
    headSha,
    branch,
    statusHash,
    diffHash,
    untrackedHash,
    createdAt: new Date().toISOString(),
    changedFiles: uniqueChangedFiles,
    comparisonBaseSha
  };
}

/** Compare immutable snapshot identity fields, ignoring capture time. */
export function sameWorkspaceSnapshot(a: WorkspaceSnapshot, b: WorkspaceSnapshot): boolean {
  return a.snapshotId === b.snapshotId && a.headSha === b.headSha && a.statusHash === b.statusHash && a.diffHash === b.diffHash;
}
