import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const failures = [];
const excluded = new Set([".git", "node_modules", "dist"]);
const textExtensions = new Set([".ts", ".mjs", ".js", ".json", ".md", ".yml", ".yaml", ".example"]);
const credentialPatterns = [
  ["OpenAI-style API key", /\bsk-[A-Za-z0-9_-]{24,}\b/g],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g]
];

async function filesUnder(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await filesUnder(absolute)));
    else if (textExtensions.has(path.extname(entry.name)) || entry.name === "Dockerfile") output.push(absolute);
  }
  return output;
}

for (const absolute of await filesUnder(root)) {
  const relative = path.relative(root, absolute);
  const text = await readFile(absolute, "utf8");
  for (const [label, pattern] of credentialPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) failures.push(`${relative}: possible ${label}`);
  }
}

const mcpSources = (await filesUnder(path.join(root, "src", "mcp"))).map((file) => readFile(file, "utf8"));
const mcpText = (await Promise.all(mcpSources)).join("\n");
for (const forbidden of ["codex_shell", "codex_exec", "codex_write_file", "codex_git_commit", "codex_git_push", "codex_deploy"]) {
  if (mcpText.includes(forbidden)) failures.push(`src/mcp: forbidden generic or publication tool found: ${forbidden}`);
}

if (failures.length > 0) {
  console.error("Security validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Security validation passed (credential patterns and forbidden MCP capabilities).");
