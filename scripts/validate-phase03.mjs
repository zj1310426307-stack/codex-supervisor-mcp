import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const failures = [];

const requiredFiles = [
  ".env.example",
  "Dockerfile",
  "README.md",
  "docs/ARCHITECTURE.md",
  "docs/CHATGPT-WEB.md",
  "docs/CHATGPT-WEB-MANUAL-TEST.md",
  "docs/CHATGPT-PLAN-CAPABILITY-MATRIX.md",
  "docs/OPERATIONS.md",
  "docs/RECOVERY.md",
  "docs/SECURE-MCP-TUNNEL.md",
  "docs/SECURE-OPERATIONS.md",
  "docs/SUPERVISION-PROTOCOL.md",
  "docs/VERIFICATION.md",
  "docs/STATE-MIGRATION-V1-V2.md",
  "docs/STATE-MIGRATION-V2-V3.md",
  "docs/ORCH-PHASE-03-BASELINE-AUDIT.md",
  "docs/ORCH-PHASE-02-BASELINE-AUDIT.md",
  "docs/ORCH-PHASE-02-DESIGN.md",
  "docs/ORCH-PHASE-02-VALIDATION.md",
  "docs/ORCH-PHASE-03-DESIGN.md",
  "docs/ORCH-PHASE-03-LIVE-CODEX-E2E.md",
  "docs/ORCH-PHASE-03-CHATGPT-WEB.md",
  "docs/ORCH-PHASE-03-VERIFIER-LEASES.md",
  "docs/ORCH-PHASE-03-SECURE-OPERATIONS.md",
  "docs/ORCH-PHASE-03-VALIDATION.md",
  "schemas/development-contract.schema.json",
  "schemas/verifier-run.schema.json",
  "artifacts/tool-manifest.json",
  "artifacts/validation/phase03-local-validation-summary.json",
  "scripts/live/codex-handshake-smoke.ts",
  "scripts/live/codex-development-e2e.ts",
  "scripts/codex/generate-app-server-schema.ts",
  "scripts/codex/check-app-server-compatibility.ts",
  "scripts/chatgpt/export-tool-manifest.ts"
];

for (const relativePath of requiredFiles) {
  try {
    await stat(path.join(root, relativePath));
  } catch {
    failures.push(`${relativePath}: missing`);
  }
}

const readme = await readFile(path.join(root, "README.md"), "utf8");
for (const obsolete of [
  "Version 0.2 adds",
  "v0.2 surface contains 20",
  "only the 11 genuine read tools",
  "all 20 tools",
  "Important Phase 02 settings",
  "npm run smoke:live"
]) {
  if (readme.includes(obsolete)) failures.push(`README.md contains obsolete current-state text: ${obsolete}`);
}

for (const current of [
  "0.3.0",
  "23",
  "13",
  "Turn Lease",
  "Verifier Lease",
  "codex_runtime_capabilities",
  "codex_verifier_status",
  "codex_verifier_reconcile"
]) {
  if (!readme.includes(current)) failures.push(`README.md is missing current-state marker: ${current}`);
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortValue(child)])
    );
  }
  return value;
}

function schemaHash(tools) {
  return createHash("sha256").update(JSON.stringify(sortValue(tools))).digest("hex");
}

async function readJson(relativePath) {
  try {
    return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
  } catch (error) {
    failures.push(`${relativePath}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    return undefined;
  }
}

const packageJson = await readJson("package.json");
const manifest = await readJson("artifacts/tool-manifest.json");
const summary = await readJson("artifacts/validation/phase03-local-validation-summary.json");

if (packageJson && manifest && summary) {
  const version = packageJson.version;
  for (const [label, actual] of [
    ["manifest serverVersion", manifest.serverVersion],
    ["manifest toolSurfaceVersion", manifest.toolSurfaceVersion],
    ["validation summary project.version", summary.project?.version]
  ]) {
    if (actual !== version) failures.push(`${label} (${String(actual)}) does not match package version ${String(version)}`);
  }

  for (const mode of ["restricted", "full"]) {
    const surface = manifest[mode];
    const recorded = summary.toolSurface;
    const countKey = `${mode}Count`;
    const hashKey = `${mode}SchemaHash`;
    if (!surface || !Array.isArray(surface.tools)) {
      failures.push(`artifacts/tool-manifest.json: missing ${mode} tool surface`);
      continue;
    }
    if (surface.toolCount !== surface.tools.length) {
      failures.push(`${mode} toolCount does not match the manifest tool array`);
    }
    const computedHash = schemaHash(surface.tools);
    if (surface.toolSchemaHash !== computedHash) {
      failures.push(`${mode} toolSchemaHash does not match the canonical manifest content`);
    }
    if (recorded?.[countKey] !== surface.toolCount || recorded?.[hashKey] !== surface.toolSchemaHash) {
      failures.push(`validation summary ${mode} tool metadata is stale`);
    }
  }

  if (summary.schemaVersion !== 1) failures.push("validation summary schemaVersion must be 1");
  if (summary.localCheck?.exitCode !== 0 || summary.localCheck?.tests?.failed !== 0) {
    failures.push("validation summary does not record a passing local check");
  }
  for (const key of [
    "typecheck",
    "build",
    "genericValidation",
    "phase03Validation",
    "toolSurfaceValidation",
    "versionConsistency",
    "securityValidation"
  ]) {
    if (summary.localCheck?.[key] !== "PASS") failures.push(`validation summary ${key} is not PASS`);
  }
}

if (failures.length > 0) {
  console.error("Phase 03 validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Phase 03 file and documentation validation passed.");
