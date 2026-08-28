import fs from "node:fs";
import path from "node:path";

export type CodexCommandSource = "explicit" | "npm-native" | "path";

export interface ResolvedCodexCommand {
  command: string;
  source: CodexCommandSource;
  checkedNativeCandidates: string[];
}

export interface ResolveCodexCommandOptions {
  configured?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  npmRoots?: string[];
  exists?: (candidate: string) => boolean;
}

interface NativeTarget {
  packageName: string;
  triple: string;
  executable: string;
}

function nativeTarget(platform: NodeJS.Platform, arch: string): NativeTarget | undefined {
  const key = `${platform}-${arch}`;
  const targets: Record<string, NativeTarget> = {
    "win32-x64": {
      packageName: "@openai/codex-win32-x64",
      triple: "x86_64-pc-windows-msvc",
      executable: "codex.exe"
    },
    "win32-arm64": {
      packageName: "@openai/codex-win32-arm64",
      triple: "aarch64-pc-windows-msvc",
      executable: "codex.exe"
    },
    "darwin-x64": {
      packageName: "@openai/codex-darwin-x64",
      triple: "x86_64-apple-darwin",
      executable: "codex"
    },
    "darwin-arm64": {
      packageName: "@openai/codex-darwin-arm64",
      triple: "aarch64-apple-darwin",
      executable: "codex"
    },
    "linux-x64": {
      packageName: "@openai/codex-linux-x64",
      triple: "x86_64-unknown-linux-musl",
      executable: "codex"
    },
    "linux-arm64": {
      packageName: "@openai/codex-linux-arm64",
      triple: "aarch64-unknown-linux-musl",
      executable: "codex"
    }
  };
  return targets[key];
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)).map((value) => path.resolve(value)))];
}

export function npmGlobalRootCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const prefix = env.NPM_CONFIG_PREFIX ?? env.npm_config_prefix;
  const appDataRoot = env.APPDATA ? path.join(env.APPDATA, "npm", "node_modules") : undefined;
  const prefixRoots = prefix
    ? [path.join(prefix, "node_modules"), path.join(prefix, "lib", "node_modules")]
    : [];
  const executableDir = path.dirname(process.execPath);
  return unique([
    appDataRoot,
    ...prefixRoots,
    path.join(executableDir, "node_modules"),
    path.join(executableDir, "..", "lib", "node_modules")
  ]);
}

export function officialNpmNativeCandidates(
  roots: readonly string[],
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string[] {
  const target = nativeTarget(platform, arch);
  if (!target) return [];
  return roots.map((root) => path.join(
    root,
    "@openai",
    "codex",
    "node_modules",
    "@openai",
    target.packageName.replace("@openai/", ""),
    "vendor",
    target.triple,
    "bin",
    target.executable
  ));
}

function isPathLike(value: string): boolean {
  return path.isAbsolute(value) || value.includes("/") || value.includes("\\");
}

export function resolveCodexCommand(options: ResolveCodexCommandOptions = {}): ResolvedCodexCommand {
  const env = options.env ?? process.env;
  const configured = options.configured?.trim() || env.CODEX_BIN?.trim();
  const exists = options.exists ?? ((candidate: string) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (configured) {
    if (isPathLike(configured) && !exists(configured)) {
      throw new Error(`Configured CODEX_BIN does not exist: ${configured}`);
    }
    return { command: configured, source: "explicit", checkedNativeCandidates: [] };
  }

  const roots = options.npmRoots ?? npmGlobalRootCandidates(env);
  const candidates = officialNpmNativeCandidates(roots, options.platform ?? process.platform, options.arch ?? process.arch);
  const native = candidates.find(exists);
  if (native) return { command: native, source: "npm-native", checkedNativeCandidates: candidates };

  return {
    command: (options.platform ?? process.platform) === "win32" ? "codex.exe" : "codex",
    source: "path",
    checkedNativeCandidates: candidates
  };
}
