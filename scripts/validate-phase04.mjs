import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const failures = [];
const requiredFiles = [
  ".env.example",
  "Dockerfile",
  "README.md",
  "VALIDATION.md",
  "config/verification.local.example.json",
  "docs/ORCH-PHASE-04-BASELINE-AUDIT.md",
  "docs/ORCH-PHASE-04-DESIGN.md",
  "docs/ORCH-PHASE-04-LIVE-CODEX-E2E.md",
  "docs/ORCH-PHASE-04-CHATGPT-WEB-ACCEPTANCE.md",
  "docs/ORCH-PHASE-04-VALIDATION.md",
  "docs/WSL2-RUNTIME.md",
  "docs/SECURE-MCP-TUNNEL.md",
  "docs/OPERATIONS.md",
  "docs/RECOVERY.md",
  "scripts/preflight-wsl2.ts",
  "scripts/smoke-mcp.ts",
  "scripts/verifier/Dockerfile",
  "scripts/verifier/build-local-image.sh",
  "scripts/verifier/inspect-image.sh",
  "artifacts/tool-manifest.json",
  "artifacts/validation/mcp-restricted-scan.json",
  "artifacts/validation/mcp-full-scan.json",
  "artifacts/validation/phase04-live-codex-handshake-summary.json",
  "artifacts/validation/phase04-live-codex-e2e-summary.json",
  "artifacts/validation/phase04-summary.json"
];

for (const relative of requiredFiles) {
  try {
    await stat(path.join(root, relative));
  } catch {
    failures.push(`${relative}: missing`);
  }
}

async function text(relative) {
  return readFile(path.join(root, relative), "utf8");
}

async function json(relative) {
  try {
    return JSON.parse(await text(relative));
  } catch (error) {
    failures.push(`${relative}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    return undefined;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

function hash(tools) {
  return createHash("sha256").update(JSON.stringify(canonical(tools)), "utf8").digest("hex");
}

const [packageJson, manifest, restrictedScan, fullScan, handshake, liveE2e, summary] = await Promise.all([
  json("package.json"),
  json("artifacts/tool-manifest.json"),
  json("artifacts/validation/mcp-restricted-scan.json"),
  json("artifacts/validation/mcp-full-scan.json"),
  json("artifacts/validation/phase04-live-codex-handshake-summary.json"),
  json("artifacts/validation/phase04-live-codex-e2e-summary.json"),
  json("artifacts/validation/phase04-summary.json")
]);

if (packageJson) {
  if (packageJson.version !== "0.4.0") failures.push("package version must be 0.4.0");
  if (packageJson.dependencies?.["@modelcontextprotocol/client"] !== "2.0.0") failures.push("official MCP client must be pinned to 2.0.0");
  if (!String(packageJson.scripts?.check).includes("smoke:mcp")) failures.push("check must execute the real local MCP scan");
  if (!String(packageJson.scripts?.check).includes("validate:phase04")) failures.push("check must include validate:phase04");
}

if (manifest) {
  if (manifest.serverVersion !== "0.4.0" || manifest.toolSurfaceVersion !== "0.4.0") failures.push("tool manifest version drift");
  for (const [mode, count] of [["restricted", 13], ["full", 23]]) {
    const surface = manifest[mode];
    if (surface?.toolCount !== count || surface?.tools?.length !== count) failures.push(`${mode} tool count must be ${count}`);
    if (surface && hash(surface.tools) !== surface.toolSchemaHash) failures.push(`${mode} manifest hash is stale`);
  }
}

for (const [mode, scan, count] of [["restricted", restrictedScan, 13], ["full", fullScan, 23]]) {
  if (scan?.status !== "PASS") failures.push(`${mode} MCP scan is not PASS`);
  if (scan?.transport !== "streamable-http" || scan?.actualHttpListener !== true) failures.push(`${mode} scan did not use the real HTTP stack`);
  if (scan?.toolCount !== count || scan?.tools?.length !== count) failures.push(`${mode} scan count must be ${count}`);
  if (scan?.toolSchemaHash !== manifest?.[mode]?.toolSchemaHash) failures.push(`${mode} scan hash differs from manifest`);
  if (scan?.annotationsValidated !== true || scan?.schemasValidatedAgainstCatalog !== true) failures.push(`${mode} scan did not validate annotations and schemas`);
}

if (summary) {
  if (summary.phase !== "ORCH-PHASE-04" || summary.project?.version !== "0.4.0") failures.push("Phase 04 summary identity is stale");
  if (summary.chatGptWeb?.restricted === "PASS" || summary.chatGptWeb?.full === "PASS") failures.push("ChatGPT Web cannot be PASS without operator evidence");
}

if (handshake) {
  if (handshake.status !== "PASS" || handshake.realProcess !== true || handshake.processExitProven !== true) {
    failures.push("real Codex handshake summary is not proven PASS");
  }
  if (handshake.secretsIncluded !== false) failures.push("real Codex handshake summary must exclude secrets");
}

if (liveE2e) {
  if (liveE2e.status !== "PASS" || liveE2e.realCodexTurn !== true || liveE2e.verificationState !== "passed") {
    failures.push("real Codex development E2E summary is not proven PASS");
  }
  if (liveE2e.execpolicyAmendmentApplied !== false || liveE2e.networkPolicyAmendmentApplied !== false) {
    failures.push("live E2E must not apply persistent approval policy amendments");
  }
  if (!Object.values(liveE2e.cleanupProof ?? {}).every(Boolean)) failures.push("live E2E cleanup proof is incomplete");
  if (liveE2e.secretsIncluded !== false) failures.push("real Codex E2E summary must exclude secrets");
}

const envExample = await text(".env.example");
if (!/^MCP_BEARER_TOKEN=\s*$/m.test(envExample)) failures.push(".env.example bearer token must be empty");
if (!/^MCP_CONTROL_ENABLED=false\s*$/m.test(envExample)) failures.push(".env.example must default to Restricted mode");

const configSource = await text("src/config.ts");
for (const placeholder of ["changeme", "replace-me", "replace-with-a-long-random-secret", "example-token", "test-token", "default", "password"]) {
  if (!configSource.includes(`"${placeholder}"`)) failures.push(`placeholder rejection is missing ${placeholder}`);
}

const mcpServer = await text("src/mcp/server.ts");
const operator = await text("src/cli/operator.ts");
if (!mcpServer.includes("../core/redaction.js") || mcpServer.includes("const SECRET_KEY")) failures.push("MCP server does not exclusively use shared redaction");
if (!operator.includes("../core/redaction.js")) failures.push("Operator CLI does not use shared redaction");

const preflight = await text("scripts/preflight-wsl2.ts");
for (const marker of ["BLOCKED_BY_ENVIRONMENT", "codex app-server --help", "codex login status", "docker info", "readOnly: true"]) {
  if (!preflight.includes(marker)) failures.push(`WSL2 preflight missing ${marker}`);
}
for (const forbidden of ["wsl --install", "npm install -g", "setx ", "reg add", "docker desktop"]) {
  if (preflight.toLowerCase().includes(forbidden)) failures.push(`WSL2 preflight contains forbidden repair action: ${forbidden}`);
}

const workflow = await text(".github/workflows/ci.yml");
if (!workflow.includes("ubuntu-latest") || !workflow.includes("windows-latest")) failures.push("CI must retain Ubuntu and Windows");
if (workflow.includes("smoke:codex") || workflow.includes("e2e:codex")) failures.push("ordinary CI must not run live Codex tracks");

const rootDockerfile = await text("Dockerfile");
if (!rootDockerfile.includes("experimental-mcp-server-only") || !rootDockerfile.includes('includes-codex="false"')) failures.push("root Docker image scope is not explicit");

if (failures.length) {
  console.error("Phase 04 validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("Phase 04 files, security defaults, MCP scans, and evidence boundaries passed.");
