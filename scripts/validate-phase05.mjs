import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const failures = [];
const requiredFiles = [
  "config/tunnel-client.restricted.example.yaml",
  "docs/ORCH-PHASE-05-DESIGN.md",
  "docs/ORCH-PHASE-05-CHATGPT-ACCEPTANCE.md",
  "scripts/preflight-secure-tunnel.ts",
  "tests/preflight-secure-tunnel.test.ts",
  "artifacts/validation/phase05-summary.json"
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

const [packageJson, summary, profile, preflight, design, acceptance] = await Promise.all([
  json("package.json"),
  json("artifacts/validation/phase05-summary.json"),
  text("config/tunnel-client.restricted.example.yaml"),
  text("scripts/preflight-secure-tunnel.ts"),
  text("docs/ORCH-PHASE-05-DESIGN.md"),
  text("docs/ORCH-PHASE-05-CHATGPT-ACCEPTANCE.md")
]);

if (packageJson) {
  if (packageJson.version !== "0.4.0") failures.push("Phase 05 preparation must preserve the v0.4.0 published identity");
  if (!String(packageJson.scripts?.["preflight:tunnel"]).includes("preflight-secure-tunnel.ts")) {
    failures.push("preflight:tunnel script is missing");
  }
  if (!String(packageJson.scripts?.check).includes("validate:phase05")) failures.push("check must include validate:phase05");
  if (String(packageJson.scripts?.check).includes("preflight:tunnel")) {
    failures.push("ordinary check must not require live tunnel credentials or a running tunnel client");
  }
}

if (summary) {
  if (summary.phase !== "ORCH-PHASE-05" || summary.project?.version !== "0.4.0") {
    failures.push("Phase 05 summary identity is stale");
  }
  if (summary.secureTunnel?.status !== "NOT_RUN") failures.push("Secure Tunnel must remain NOT_RUN without operator evidence");
  if (summary.chatGpt?.restricted !== "NOT_RUN" || summary.chatGpt?.full !== "NOT_RUN") {
    failures.push("ChatGPT tracks must remain NOT_RUN without operator evidence");
  }
  if (summary.chatGpt?.productionReady !== false) failures.push("Phase 05 preparation cannot claim Production Ready");
  if (summary.secureTunnel?.tunnelIdentifierIncluded !== false || summary.secureTunnel?.credentialsIncluded !== false) {
    failures.push("Phase 05 preparation summary must exclude tunnel identity and credentials");
  }
}

for (const marker of [
  "base_url: https://api.openai.com",
  "listen_addr: 127.0.0.1:8080",
  "url: http://127.0.0.1:8787/mcp",
  "Authorization: env:MCP_TUNNEL_AUTHORIZATION",
  "startup_wait_timeout: 30s"
]) {
  if (!profile.includes(marker)) failures.push(`tunnel profile missing ${marker}`);
}
for (const forbidden of [/api_key\s*:/i, /tunnel_id\s*:/i, /0\.0\.0\.0/, /localhost\.run/i, /ngrok/i]) {
  if (forbidden.test(profile)) failures.push(`tunnel profile contains forbidden pattern ${forbidden}`);
}

for (const marker of [
  "readOnly: true",
  "MCP_CONTROL_ENABLED",
  "BLOCKED_BY_CONFIGURATION",
  "tunnel-client",
  "help\", \"quickstart",
  "MCP_DISCOVERY_EXTRA_HEADERS",
  "CONTROL_PLANE_API_KEY"
]) {
  if (!preflight.includes(marker)) failures.push(`secure tunnel preflight missing ${marker}`);
}
for (const forbidden of ["npm install", "brew install", "wsl --install", "child_process.spawn", "process.env.PATH ="]) {
  if (preflight.includes(forbidden)) failures.push(`secure tunnel preflight contains repair/mutation action ${forbidden}`);
}

for (const document of [design, acceptance]) {
  for (const url of [
    "https://developers.openai.com/api/docs/guides/secure-mcp-tunnels",
    "https://developers.openai.com/plugins/deploy/connect-chatgpt"
  ]) {
    if (!document.includes(url)) failures.push(`Phase 05 document missing official reference ${url}`);
  }
}
if (!acceptance.includes("Exactly 13 tools") || !acceptance.includes("Restricted never upgrades")) {
  failures.push("Phase 05 acceptance boundaries are incomplete");
}

if (failures.length) {
  console.error("Phase 05 validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("Phase 05 Restricted tunnel preparation and honest external evidence boundaries passed.");
