import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);

interface ProbeResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

function redactLocalPaths<T>(value: T): T {
  const prefixes = [process.env.USERPROFILE, process.env.APPDATA, process.env.LOCALAPPDATA]
    .filter((entry): entry is string => Boolean(entry))
    .sort((left, right) => right.length - left.length);
  const visit = (entry: unknown): unknown => {
    if (typeof entry === "string") {
      return prefixes.reduce(
        (text, prefix) => text.replaceAll(prefix, "[USER_PROFILE]"),
        entry
      );
    }
    if (Array.isArray(entry)) return entry.map(visit);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(Object.entries(entry as Record<string, unknown>).map(([key, child]) => [key, visit(child)]));
    }
    return entry;
  };
  return visit(value) as T;
}

async function probe(file: string, args: string[]): Promise<ProbeResult> {
  const command = [file, ...args].join(" ");
  try {
    const result = await runFile(file, args, {
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    return { command, ok: true, exitCode: 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (caught) {
    const error = caught as NodeJS.ErrnoException & { code?: string | number; stdout?: string; stderr?: string };
    return {
      command,
      ok: false,
      exitCode: typeof error.code === "number" ? error.code : null,
      stdout: String(error.stdout ?? "").trim(),
      stderr: String(error.stderr ?? "").trim(),
      error: error.message
    };
  }
}

const npmCli = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const npmBin = process.platform === "win32" ? process.execPath : "npm";
const npmPrefix = process.platform === "win32" ? [npmCli] : [];
const probes: Array<Promise<ProbeResult>> = [
  probe(process.platform === "win32" ? "where.exe" : "which", ["codex"]),
  probe(npmBin, [...npmPrefix, "root", "-g"]),
  probe(npmBin, [...npmPrefix, "ls", "-g", "@openai/codex", "--depth=0"]),
  probe(process.env.CODEX_BIN?.trim() || "codex", ["--version"]),
  probe(process.env.CODEX_BIN?.trim() || "codex", ["app-server", "--help"])
];

if (process.platform === "win32") {
  probes.push(
    probe("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-Command codex -All -ErrorAction SilentlyContinue | Select-Object CommandType,Name,Source,Path,Version | ConvertTo-Json -Depth 3"
    ])
  );
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  readOnly: true,
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
  probes: await Promise.all(probes)
};

const rendered = `${JSON.stringify(redactLocalPaths(report), null, 2)}\n`;
const outIndex = process.argv.indexOf("--out");
if (outIndex >= 0) {
  const outputPath = process.argv[outIndex + 1];
  if (!outputPath) throw new Error("--out requires a file path");
  await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await writeFile(outputPath, rendered, { encoding: "utf8", flag: "w" });
}
process.stdout.write(rendered);
