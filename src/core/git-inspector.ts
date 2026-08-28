import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitRepositoryState {
  workspace: string;
  gitDir: string;
  headSha: string;
  branch: string;
  status: string;
  clean: boolean;
}

/** Execute a fixed git program with argument arrays; callers never provide a shell string. */
export async function gitOutput(workspace: string, args: string[], maxBuffer = 5_000_000): Promise<string> {
  const { stdout, stderr } = await execFileAsync("git", ["-C", workspace, ...args], {
    encoding: "utf8",
    maxBuffer,
    windowsHide: true,
    timeout: 60_000
  });
  return (stdout + (stderr ? `\n[stderr]\n${stderr}` : "")).trim();
}

/** Capture identity and cleanliness without changing the repository. */
export async function inspectGitRepository(workspace: string): Promise<GitRepositoryState> {
  const [gitDir, headSha, branch, status] = await Promise.all([
    gitOutput(workspace, ["rev-parse", "--absolute-git-dir"]),
    gitOutput(workspace, ["rev-parse", "--verify", "HEAD"]),
    gitOutput(workspace, ["branch", "--show-current"]),
    gitOutput(workspace, ["status", "--porcelain=v1", "--untracked-files=all"], 10_000_000)
  ]);
  return { workspace, gitDir, headSha, branch, status, clean: status.length === 0 };
}

export async function workspaceStatus(workspace: string): Promise<string> {
  return gitOutput(workspace, ["status", "--short", "--branch"], 2_000_000);
}

async function untrackedPreview(workspace: string, maxChars: number): Promise<string> {
  const raw = await gitOutput(workspace, ["ls-files", "--others", "--exclude-standard", "-z"], 5_000_000);
  const files = raw.split("\0").filter(Boolean);
  if (!files.length) return "(none)";

  const parts: string[] = [];
  let used = 0;
  for (const relative of files) {
    const absolute = path.resolve(workspace, relative);
    if (absolute !== workspace && !absolute.startsWith(workspace + path.sep)) continue;
    try {
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) {
        parts.push(`## ${relative}\n[symbolic link content omitted]`);
        continue;
      }
      if (!stat.isFile()) continue;
      const header = `## ${relative} (${stat.size} bytes)`;
      if (used + header.length >= maxChars) break;
      const remaining = Math.max(0, maxChars - used - header.length - 8);
      const readLength = Math.min(stat.size, Math.max(8192, remaining + 1));
      const sample = Buffer.alloc(readLength);
      const handle = await fs.open(absolute, "r");
      let bytesRead: number;
      try {
        ({ bytesRead } = await handle.read(sample, 0, readLength, 0));
      } finally {
        await handle.close();
      }
      const boundedSample = sample.subarray(0, bytesRead);
      const isBinary = boundedSample.subarray(0, Math.min(boundedSample.length, 8192)).includes(0);
      let body: string;
      if (isBinary) {
        body = "[binary file omitted]";
      } else {
        const text = boundedSample.toString("utf8");
        body = stat.size > bytesRead || text.length > remaining
          ? text.slice(0, remaining) + "\n... [file preview truncated]"
          : text;
      }
      const block = `${header}\n${body}`;
      parts.push(block);
      used += block.length + 2;
      if (used >= maxChars) break;
    } catch (error) {
      parts.push(`## ${relative}\n[unable to read: ${(error as Error).message}]`);
    }
  }
  if (parts.length < files.length) parts.push(`... [${files.length - parts.length} additional untracked file(s) omitted]`);
  return parts.join("\n\n");
}

export async function workspaceDiff(
  workspace: string,
  maxChars: number
): Promise<{ truncated: boolean; text: string }> {
  // `HEAD` includes staged + unstaged tracked-file changes. Plain `git diff`
  // would miss staged changes, which is unacceptable for independent review.
  const stat = await gitOutput(workspace, ["diff", "HEAD", "--stat", "--"], 5_000_000);
  const diff = await gitOutput(
    workspace,
    ["diff", "HEAD", "--no-ext-diff", "--"],
    Math.max(maxChars * 4, 5_000_000)
  );
  const untracked = await untrackedPreview(workspace, Math.max(4000, Math.floor(maxChars / 3)));
  const combined = [
    `# Tracked diff stat\n${stat || "(no staged/unstaged tracked-file diff)"}`,
    `# Tracked diff\n${diff || "(empty)"}`,
    `# Untracked files\n${untracked}`
  ].join("\n\n");

  if (combined.length <= maxChars) return { truncated: false, text: combined };
  return {
    truncated: true,
    text: combined.slice(0, maxChars) + `\n\n... [truncated at ${maxChars} characters]`
  };
}
