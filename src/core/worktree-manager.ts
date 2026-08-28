import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { SupervisorError } from "./errors.js";
import { inspectGitRepository } from "./git-inspector.js";

const execFileAsync = promisify(execFile);

export interface WorktreeManagerOptions {
  root: string;
  branchPrefix?: string;
  requireCleanBase?: boolean;
}

export interface WorktreeRecord {
  taskId: string;
  sourceWorkspace: string;
  worktree: string;
  branch: string;
  baseSha: string;
  createdAt: string;
}

export interface WorktreeValidation {
  valid: true;
  worktree: string;
  branch: string;
  headSha: string;
  baseSha: string;
  sourceWorkspace: string;
}

async function git(workspace: string, args: string[], timeout = 60_000): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", workspace, ...args], {
    encoding: "utf8",
    maxBuffer: 10_000_000,
    timeout,
    windowsHide: true
  });
  return stdout.trim();
}

function assertSafeTaskId(taskId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId)) {
    throw new SupervisorError("INVALID_INPUT", "taskId is not safe for a branch or worktree path", 400);
  }
}

function within(root: string, candidate: string): boolean {
  const relation = path.relative(root, candidate);
  return Boolean(relation) && relation !== ".." && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation);
}

function samePath(left: string, right: string): boolean {
  return path.relative(left, right) === "";
}

/** Own creation, validation and conservative cleanup of per-task git worktrees. */
export class WorktreeManager {
  private readonly root: string;
  private readonly branchPrefix: string;
  private readonly requireCleanBase: boolean;

  constructor(options: WorktreeManagerOptions | string) {
    const normalized = typeof options === "string" ? { root: options } : options;
    this.root = path.resolve(normalized.root);
    this.branchPrefix = (normalized.branchPrefix ?? "codex-supervisor").replace(/\/+$/, "");
    this.requireCleanBase = normalized.requireCleanBase ?? true;
    if (!this.branchPrefix || /[~^:?*\\\s]/.test(this.branchPrefix) || this.branchPrefix.includes("..")) {
      throw new SupervisorError("INVALID_INPUT", "branchPrefix is not a safe git ref prefix", 400);
    }
  }

  /** Create a clean task branch and isolated worktree from the source HEAD. */
  async create(sourceWorkspace: string, taskId: string): Promise<WorktreeRecord> {
    assertSafeTaskId(taskId);
    const source = await fs.realpath(path.resolve(sourceWorkspace));
    await fs.mkdir(this.root, { recursive: true });
    const isolationRoot = await fs.realpath(this.root);
    if (samePath(isolationRoot, source) || within(source, isolationRoot)) {
      throw new SupervisorError(
        "WORKTREE_INVALID",
        "Configured worktree root must be outside the source working tree",
        409
      );
    }
    const sourceState = await inspectGitRepository(source).catch((error) => {
      throw new SupervisorError("WORKTREE_INVALID", "Source workspace is not a readable Git repository", 400, undefined, {
        cause: error
      });
    });
    if (this.requireCleanBase && !sourceState.clean) {
      throw new SupervisorError(
        "WORKSPACE_NOT_CLEAN",
        "Source workspace must be clean before creating an isolated worktree",
        409,
        { status: sourceState.status.slice(0, 30_000), truncated: sourceState.status.length > 30_000 }
      );
    }
    const target = path.resolve(isolationRoot, taskId);
    if (!within(isolationRoot, target)) {
      throw new SupervisorError("WORKTREE_INVALID", "Computed worktree path escapes configured root", 400);
    }
    if (await fs.lstat(target).then(() => true, () => false)) {
      throw new SupervisorError("WORKTREE_INVALID", "Task worktree path already exists", 409, { taskId });
    }
    const branch = `${this.branchPrefix}/${taskId}`;
    try {
      await git(source, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
      throw new SupervisorError("WORKTREE_INVALID", "Task branch already exists", 409, { branch });
    } catch (error) {
      if (error instanceof SupervisorError) throw error;
      const exitCode = (error as { code?: unknown }).code;
      if (exitCode !== 1 && exitCode !== 128) throw error;
    }
    await git(source, ["worktree", "add", "-b", branch, target, sourceState.headSha], 120_000);
    const record: WorktreeRecord = {
      taskId,
      sourceWorkspace: source,
      worktree: await fs.realpath(target),
      branch,
      baseSha: sourceState.headSha,
      createdAt: new Date().toISOString()
    };
    await this.validate(record);
    return record;
  }

  /** Prove source/common-dir/branch/base ownership before a task is resumed or removed. */
  async validate(record: WorktreeRecord): Promise<WorktreeValidation> {
    assertSafeTaskId(record.taskId);
    const isolationRoot = await fs.realpath(this.root);
    const source = await fs.realpath(path.resolve(record.sourceWorkspace));
    const worktree = await fs.realpath(path.resolve(record.worktree));
    const expectedWorktree = path.resolve(isolationRoot, record.taskId);
    const expectedBranch = `${this.branchPrefix}/${record.taskId}`;
    if (!within(isolationRoot, worktree) || !samePath(worktree, expectedWorktree) || samePath(source, worktree)) {
      throw new SupervisorError("WORKTREE_INVALID", "Worktree is outside the configured isolation root", 409);
    }
    if (record.branch !== expectedBranch) {
      throw new SupervisorError("WORKTREE_INVALID", "Recorded branch is not bound to the recorded task id", 409);
    }
    const [sourceCommon, worktreeCommon, topLevel, branch, headSha] = await Promise.all([
      git(source, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      git(worktree, ["rev-parse", "--show-toplevel"]),
      git(worktree, ["branch", "--show-current"]),
      git(worktree, ["rev-parse", "--verify", "HEAD"])
    ]);
    if (path.resolve(sourceCommon) !== path.resolve(worktreeCommon)) {
      throw new SupervisorError("WORKTREE_INVALID", "Worktree is not attached to the recorded source repository", 409);
    }
    if (!samePath(path.resolve(topLevel), worktree) || branch !== record.branch) {
      throw new SupervisorError("WORKTREE_INVALID", "Worktree path or branch no longer matches the ledger", 409);
    }
    try {
      await git(worktree, ["merge-base", "--is-ancestor", record.baseSha, headSha]);
    } catch (error) {
      throw new SupervisorError("WORKTREE_INVALID", "Recorded base SHA is not an ancestor of worktree HEAD", 409, undefined, {
        cause: error
      });
    }
    return { valid: true, worktree, branch, headSha, baseSha: record.baseSha, sourceWorkspace: source };
  }

  /** Remove only a validated, clean task worktree; never force or delete its branch. */
  async cleanup(record: WorktreeRecord): Promise<{ worktree: string; branch: string; gitOutput: string }> {
    const validation = await this.validate(record);
    const status = await git(validation.worktree, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (status) {
      throw new SupervisorError(
        "WORKSPACE_NOT_CLEAN",
        "Refusing to remove a task worktree with uncommitted changes",
        409,
        { status: status.slice(0, 30_000), truncated: status.length > 30_000 }
      );
    }
    const output = await git(validation.sourceWorkspace, ["worktree", "remove", validation.worktree], 120_000);
    return { worktree: validation.worktree, branch: validation.branch, gitOutput: output };
  }
}
