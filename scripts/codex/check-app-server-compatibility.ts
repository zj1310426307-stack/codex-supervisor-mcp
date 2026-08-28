import { writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveCodexCommand } from "../../src/codex/command-resolution.js";
import { probeCodexRuntime } from "../../src/codex/runtime-probe.js";
import { redact } from "../../src/core/redaction.js";

const outIndex = process.argv.indexOf("--out");
const output = outIndex >= 0 && process.argv[outIndex + 1]
  ? path.resolve(process.argv[outIndex + 1])
  : undefined;
const codex = resolveCodexCommand({ configured: process.env.CODEX_BIN, env: process.env });

try {
  const probe = await probeCodexRuntime({
    codexBin: codex.command,
    experimentalApi: process.env.CODEX_EXPERIMENTAL_API === "1"
  });
  const report = redact({
    status: "PASS",
    commandSource: codex.source,
    ...probe
  });
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (output) await writeFile(output, rendered, "utf8");
  process.stdout.write(rendered);
} catch (error) {
  const report = redact({
    status: "FAIL",
    checkedAt: new Date().toISOString(),
    commandSource: codex.source,
    error: error instanceof Error ? error.message : String(error)
  });
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (output) await writeFile(output, rendered, "utf8");
  process.stderr.write(rendered);
  process.exitCode = 1;
}
