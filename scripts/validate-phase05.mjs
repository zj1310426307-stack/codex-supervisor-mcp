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
  "artifacts/validation/phase05-summary.json",
  "artifacts/validation/phase05-chatgpt-restricted-live.json",
  "artifacts/validation/phase05-chatgpt-fullcontrol-attempt.json"
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

const [packageJson, summary, liveAcceptance, fullControlAttempt, profile, preflight, design, acceptance] = await Promise.all([
  json("package.json"),
  json("artifacts/validation/phase05-summary.json"),
  json("artifacts/validation/phase05-chatgpt-restricted-live.json"),
  json("artifacts/validation/phase05-chatgpt-fullcontrol-attempt.json"),
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
  if (!String(packageJson.scripts?.["preflight:tunnel:full"]).includes("--mode full")) {
    failures.push("preflight:tunnel:full script is missing");
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
  if (summary.secureTunnel?.status !== "PASS") failures.push("Secure Tunnel live acceptance must be PASS");
  if (summary.chatGpt?.restricted !== "PASS" || summary.chatGpt?.full !== "BLOCKED_BY_ENVIRONMENT") {
    failures.push("Restricted must be PASS while Full-control records the observed environment block");
  }
  if (summary.chatGpt?.productionReady !== false) failures.push("Restricted acceptance must not claim Production Ready");
  if (summary.secureTunnel?.tunnelIdentifierIncluded !== false || summary.secureTunnel?.credentialsIncluded !== false) {
    failures.push("Phase 05 preparation summary must exclude tunnel identity and credentials");
  }
}

if (fullControlAttempt) {
  if (fullControlAttempt.status !== "BLOCKED_BY_ENVIRONMENT" || fullControlAttempt.reasonCode !== "FULL_CONTROL_TOOL_UNAVAILABLE") {
    failures.push("Full-control attempt must preserve the observed tool-unavailable result");
  }
  if (fullControlAttempt.repositoryAgentExecutedChatGptCalls !== false) {
    failures.push("Full-control evidence provenance must not claim repository-agent ChatGPT calls");
  }
  if (fullControlAttempt.containsSensitiveValues !== false || fullControlAttempt.redaction?.credentialsIncluded !== false) {
    failures.push("Full-control evidence must exclude sensitive values");
  }
  if (fullControlAttempt.supervisor?.mode !== "full" || fullControlAttempt.supervisor?.controlEnabled !== true || fullControlAttempt.supervisor?.advertisedToolCount !== 23) {
    failures.push("Full-control local surface evidence is incomplete");
  }
  if (fullControlAttempt.chatGptSurface?.targetToolAvailableInCurrentSession !== false) {
    failures.push("Full-control attempt must preserve that codex_task_start was unavailable");
  }
  for (const field of ["controlToolCalled", "taskStarted", "repositoryWritePerformed", "commitPerformed", "pushPerformed", "mergePerformed", "releasePerformed", "deployPerformed"]) {
    if (fullControlAttempt.execution?.[field] !== false) failures.push(`Full-control safety evidence ${field} must be false`);
  }
  for (const field of ["supervisorStopped", "tunnelClientStopped", "supervisorPortClosed", "tunnelHealthPortClosed"]) {
    if (fullControlAttempt.shutdown?.[field] !== true) failures.push(`Full-control shutdown evidence ${field} must be true`);
  }
  if (fullControlAttempt.productionReady !== false) failures.push("Blocked Full-control acceptance must not claim Production Ready");
}

if (liveAcceptance) {
  if (liveAcceptance.result !== "PASS" || liveAcceptance.fullControl !== "NOT_RUN") {
    failures.push("Live acceptance result must preserve Restricted PASS and Full-control NOT_RUN");
  }
  if (liveAcceptance.repositoryAgentExecutedLiveCalls !== false) {
    failures.push("Live evidence provenance must state that the repository agent did not execute external calls");
  }
  if (liveAcceptance.containsSensitiveValues !== false || liveAcceptance.redaction?.credentialsIncluded !== false) {
    failures.push("Live evidence must exclude sensitive values");
  }
  if (liveAcceptance.toolDiscovery?.toolCount !== 13 || liveAcceptance.toolDiscovery?.toolSchemaHash !== "ff8bdcd4a57a6657c34a51fce89f8763adf9e658ab0833efce183163d3fdc23c") {
    failures.push("Live Restricted tool discovery evidence is stale");
  }
  for (const name of ["health", "boundedList", "followUp", "unsupportedMutation", "invalidIdentifier"]) {
    if (liveAcceptance.cases?.[name]?.status !== "PASS") failures.push(`Live acceptance case ${name} must be PASS`);
  }
  if (liveAcceptance.shutdown?.supervisor !== "LOCAL_MCP_STOPPED" || liveAcceptance.shutdown?.tunnelClient !== "TUNNEL_STOPPED") {
    failures.push("Live acceptance shutdown evidence is incomplete");
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
  "CONTROL_PLANE_API_KEY",
  "FULL_CONTROL_ACCEPTANCE_AUTHORIZED",
  "FULL_CONTROL_NEW_CHATGPT_APP_REQUIRED",
  "localToolDiscovery"
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
if (!acceptance.includes("Exactly 13 tools") || !acceptance.includes("Restricted never upgrades") || !acceptance.includes("new ChatGPT developer-mode app")) {
  failures.push("Phase 05 acceptance boundaries are incomplete");
}

if (failures.length) {
  console.error("Phase 05 validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("Phase 05 Restricted PASS and blocked Full-control attempt evidence boundaries passed.");
