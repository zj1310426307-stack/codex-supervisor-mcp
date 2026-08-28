import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const failures = [];

async function requirePath(relativePath) {
  try {
    await stat(path.join(root, relativePath));
  } catch {
    failures.push(`${relativePath}: missing`);
  }
}

for (const required of [
  "package.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "tsconfig.scripts.json",
  "src/index.ts",
  "src/core/orchestrator.ts",
  "src/mcp/server.ts",
  "src/codex/app-server-client.ts",
  "schemas/development-contract.schema.json",
  "schemas/verifier-run.schema.json",
  "examples/development-contract.example.json"
]) {
  await requirePath(required);
}

const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
if (packageJson.name !== "codex-supervisor-mcp") failures.push("package.json:name must be codex-supervisor-mcp");
if (packageJson.version !== "0.4.0") failures.push(`package.json:version expected 0.4.0, received ${packageJson.version}`);
if (packageJson.private !== true) failures.push("package.json:private must remain true");

for (const command of ["typecheck", "test", "build", "validate:phase03", "validate:security", "smoke:codex", "e2e:codex"]) {
  if (typeof packageJson.scripts?.[command] !== "string") failures.push(`package.json:scripts.${command} is missing`);
}

if (failures.length > 0) {
  console.error("Generic validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Generic validation passed.");
