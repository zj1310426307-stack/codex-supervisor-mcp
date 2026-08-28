import { execFile } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resolveCodexCommand } from "../../src/codex/command-resolution.js";
import { readProtocolSchemaBundle } from "../../src/codex/protocol-schema.js";

const runFile = promisify(execFile);
const outIndex = process.argv.indexOf("--out");
const outputArgument = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;
if (!outputArgument) throw new Error("Usage: npm exec tsx scripts/codex/generate-app-server-schema.ts -- --out <directory>");

const output = path.resolve(outputArgument);
await mkdir(output, { recursive: true });
if ((await readdir(output)).length > 0) {
  throw new Error(`Refusing to generate into a non-empty directory: ${output}`);
}

const codex = resolveCodexCommand({ configured: process.env.CODEX_BIN, env: process.env });
const version = await runFile(codex.command, ["--version"], {
  encoding: "utf8",
  timeout: 15_000,
  windowsHide: true
});
await runFile(codex.command, ["app-server", "generate-json-schema", "--out", output], {
  encoding: "utf8",
  timeout: 60_000,
  windowsHide: true,
  maxBuffer: 4 * 1024 * 1024
});
const bundle = await readProtocolSchemaBundle(output);
await writeFile(
  path.join(output, "codex-supervisor-schema-summary.json"),
  `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    codexVersion: version.stdout.trim(),
    schemaHash: bundle.hash,
    schemaFileCount: Object.keys(bundle.files).length,
    methods: bundle.methods
  }, null, 2)}\n`,
  "utf8"
);
process.stdout.write(`${output}\n`);
