import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { redact } from "../src/core/redaction.js";

const execFileAsync = promisify(execFile);

type CheckStatus = "PASS" | "BLOCKED_BY_ENVIRONMENT";

export interface PreflightCheck {
  status: CheckStatus;
  command?: string;
  detail: string;
}

export interface Wsl2PreflightReport {
  schemaVersion: 1;
  status: CheckStatus;
  checkedAt: string;
  readOnly: true;
  platform: NodeJS.Platform;
  architecture: string;
  checks: Record<string, PreflightCheck>;
  blockers: string[];
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

export type PreflightRunner = (program: string, args: string[]) => Promise<CommandResult>;

async function defaultRunner(program: string, args: string[]): Promise<CommandResult> {
  try {
    const result = await execFileAsync(program, args, {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (caught) {
    const error = caught as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: String(error.stdout ?? "").trim(),
      stderr: String(error.stderr ?? "").trim(),
      error: error.message
    };
  }
}

function commandDetail(result: CommandResult): string {
  return result.ok
    ? (result.stdout || result.stderr || "command completed")
    : (result.stderr || result.error || "command failed");
}

async function commandCheck(
  runner: PreflightRunner,
  program: string,
  args: string[],
  command: string
): Promise<PreflightCheck> {
  const result = await runner(program, args);
  return {
    status: result.ok ? "PASS" : "BLOCKED_BY_ENVIRONMENT",
    command,
    detail: commandDetail(result)
  };
}

async function accessCheck(target: string, label: string): Promise<PreflightCheck> {
  let candidate = path.resolve(target);
  while (true) {
    try {
      const stats = await fs.stat(candidate);
      if (!stats.isDirectory()) {
        return { status: "BLOCKED_BY_ENVIRONMENT", detail: `${label} is not a directory: ${candidate}` };
      }
      await fs.access(candidate, fs.constants.R_OK | fs.constants.W_OK);
      return {
        status: "PASS",
        detail: candidate === path.resolve(target)
          ? `${label} directory is readable and writable`
          : `${label} nearest existing parent is readable and writable: ${candidate}`
      };
    } catch (error) {
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        return {
          status: "BLOCKED_BY_ENVIRONMENT",
          detail: `${label} has no accessible parent: ${error instanceof Error ? error.message : String(error)}`
        };
      }
      candidate = parent;
    }
  }
}

export async function collectWsl2Preflight(options: {
  runner?: PreflightRunner;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  platform?: NodeJS.Platform;
} = {}): Promise<Wsl2PreflightReport> {
  const runner = options.runner ?? defaultRunner;
  const env = options.env ?? process.env;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const platform = options.platform ?? process.platform;
  const stateFile = path.resolve(env.SUPERVISOR_STATE_FILE?.trim() || path.join(cwd, ".codex-supervisor", "state.json"));
  const worktreeRoot = path.resolve(
    env.SUPERVISOR_WORKTREE_ROOT?.trim() || path.join(path.dirname(stateFile), "worktrees")
  );
  const isWsl = platform === "linux" && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
  const checks: Record<string, PreflightCheck> = {
    operatingSystem: {
      status: platform === "linux" ? "PASS" : "BLOCKED_BY_ENVIRONMENT",
      detail: `${platform}/${process.arch}`
    },
    wsl2: {
      status: isWsl ? "PASS" : "BLOCKED_BY_ENVIRONMENT",
      detail: isWsl
        ? `WSL distribution: ${env.WSL_DISTRO_NAME ?? "detected through WSL_INTEROP"}`
        : "Run this preflight inside a WSL2 Linux distribution"
    }
  };

  const codex = env.CODEX_BIN?.trim() || "codex";
  const [node, npm, git, codexPath, codexVersion, appServerHelp, auth, dockerCli, dockerDaemon] = await Promise.all([
    commandCheck(runner, "node", ["--version"], "node --version"),
    commandCheck(runner, "npm", ["--version"], "npm --version"),
    commandCheck(runner, "git", ["--version"], "git --version"),
    commandCheck(runner, "which", [codex], "which codex"),
    commandCheck(runner, codex, ["--version"], "codex --version"),
    commandCheck(runner, codex, ["app-server", "--help"], "codex app-server --help"),
    commandCheck(runner, codex, ["login", "status"], "codex login status"),
    commandCheck(runner, "docker", ["version", "--format", "{{json .Client.Version}}"], "docker version"),
    commandCheck(runner, "docker", ["info", "--format", "{{json .ServerVersion}}"], "docker info")
  ]);
  Object.assign(checks, { node, npm, git, codexPath, codexVersion, appServerHelp, auth, dockerCli, dockerDaemon });

  checks.workspace = await accessCheck(cwd, "workspace");
  checks.gitWorkspace = await commandCheck(
    runner,
    "git",
    ["-C", cwd, "rev-parse", "--show-toplevel"],
    "git rev-parse --show-toplevel"
  );
  checks.stateDirectory = await accessCheck(path.dirname(stateFile), "state");
  checks.worktreeDirectory = await accessCheck(worktreeRoot, "worktree");

  const blockers = Object.entries(checks)
    .filter(([, check]) => check.status === "BLOCKED_BY_ENVIRONMENT")
    .map(([name, check]) => `${name}: ${check.detail}`);
  return redact({
    schemaVersion: 1,
    status: blockers.length === 0 ? "PASS" : "BLOCKED_BY_ENVIRONMENT",
    checkedAt: new Date().toISOString(),
    readOnly: true,
    platform,
    architecture: process.arch,
    checks,
    blockers
  }) as Wsl2PreflightReport;
}

async function main(): Promise<void> {
  const report = await collectWsl2Preflight();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "PASS") process.exitCode = 2;
}

const isEntryPoint = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isEntryPoint) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify(redact({
      status: "BLOCKED_BY_ENVIRONMENT",
      readOnly: true,
      error: error instanceof Error ? error.message : String(error)
    }), null, 2)}\n`);
    process.exitCode = 2;
  });
}
