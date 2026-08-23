import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(workspace: string, args: string[], maxBuffer: number): Promise<string> {
  const { stdout, stderr } = await execFileAsync("git", ["-C", workspace, ...args], {
    encoding: "utf8",
    maxBuffer
  });
  return (stdout + (stderr ? `\n[stderr]\n${stderr}` : "")).trim();
}

export async function workspaceStatus(workspace: string): Promise<string> {
  return git(workspace, ["status", "--short", "--branch"], 2_000_000);
}

async function untrackedPreview(workspace: string, maxChars: number): Promise<string> {
  const raw = await git(workspace, ["ls-files", "--others", "--exclude-standard", "-z"], 5_000_000);
  const files = raw.split("\0").filter(Boolean);
  if (!files.length) return "(none)";

  const parts: string[] = [];
  let used = 0;
  for (const relative of files) {
    const absolute = path.resolve(workspace, relative);
    if (absolute !== workspace && !absolute.startsWith(workspace + path.sep)) continue;
    try {
      const stat = await fs.stat(absolute);
      if (!stat.isFile()) continue;
      const header = `## ${relative} (${stat.size} bytes)`;
      if (used + header.length >= maxChars) break;
      const sample = await fs.readFile(absolute);
      const isBinary = sample.subarray(0, Math.min(sample.length, 8192)).includes(0);
      let body: string;
      if (isBinary) {
        body = "[binary file omitted]";
      } else {
        const remaining = Math.max(0, maxChars - used - header.length - 8);
        const text = sample.toString("utf8");
        body = text.length > remaining ? text.slice(0, remaining) + "\n... [file preview truncated]" : text;
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
  const stat = await git(workspace, ["diff", "HEAD", "--stat", "--"], 5_000_000);
  const diff = await git(
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
