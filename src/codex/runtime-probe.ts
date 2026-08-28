import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  assertProtocolCapabilities,
  createProtocolRuntimeBinding,
  evaluateProtocolCapabilities,
  type ProtocolCapabilityReport,
  type ProtocolRuntimeBinding
} from "./protocol-capabilities.js";
import { readProtocolSchemaBundle } from "./protocol-schema.js";

const execFileAsync = promisify(execFile);

export interface CodexRuntimeProbeOptions {
  codexBin: string;
  timeoutMs?: number;
  requiredMethods?: readonly string[];
  requiredClientMethods?: readonly string[];
  requiredServerMethods?: readonly string[];
  experimentalApi?: boolean;
  /** Injectable runner for deterministic tests; production uses execFile. */
  runner?: CodexCommandRunner;
}

export type CodexCommandRunner = (command: string, args: string[], timeoutMs: number) => Promise<string>;

export interface CodexRuntimeProbeResult {
  version: string;
  schemaHash: string;
  schemaFileCount: number;
  capabilities: ProtocolCapabilityReport;
  binding?: ProtocolRuntimeBinding;
}

async function run(command: string, args: string[], timeoutMs: number): Promise<string> {
  const result = await execFileAsync(command, args, {
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    encoding: "utf8"
  });
  return result.stdout.trim();
}

/**
 * Generates a version-specific schema in an isolated temporary directory and
 * refuses startup when the stable methods the supervisor needs are absent.
 */
export async function probeCodexRuntime(options: CodexRuntimeProbeOptions): Promise<CodexRuntimeProbeResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const runner = options.runner ?? run;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-schema-"));
  try {
    const version = await runner(options.codexBin, ["--version"], timeoutMs);
    if (!version) throw new Error("Codex CLI returned an empty version string");
    await runner(options.codexBin, ["app-server", "generate-json-schema", "--out", directory], timeoutMs);
    const schema = await readProtocolSchemaBundle(directory);
    const capabilities = evaluateProtocolCapabilities(schema.methods, {
      requiredMethods: options.requiredMethods,
      requiredClientMethods: options.requiredClientMethods,
      requiredServerMethods: options.requiredServerMethods,
      experimentalApi: options.experimentalApi,
      shapeValidation: schema.shapes
    });
    assertProtocolCapabilities(capabilities);
    const binding = createProtocolRuntimeBinding(version, schema.hash, capabilities);
    return {
      version,
      schemaHash: schema.hash,
      schemaFileCount: Object.keys(schema.files).length,
      capabilities,
      binding
    };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
