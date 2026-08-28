import { readFile } from "node:fs/promises";
import path from "node:path";
import { createToolManifest, TOOL_SURFACE_VERSION } from "../src/mcp/tool-catalog.js";

const root = process.cwd();
const [packageJson, lockJson, artifact, readme] = await Promise.all([
  readFile(path.join(root, "package.json"), "utf8").then(JSON.parse),
  readFile(path.join(root, "package-lock.json"), "utf8").then(JSON.parse),
  readFile(path.join(root, "artifacts", "tool-manifest.json"), "utf8").then(JSON.parse),
  readFile(path.join(root, "README.md"), "utf8")
]);
const failures: string[] = [];
const restricted = createToolManifest("restricted");
const full = createToolManifest("full");

for (const [label, value] of [
  ["package.json", packageJson.version],
  ["package-lock.json", lockJson.version],
  ["package-lock root", lockJson.packages?.[""]?.version],
  ["tool surface", TOOL_SURFACE_VERSION],
  ["manifest serverVersion", artifact.serverVersion],
  ["manifest toolSurfaceVersion", artifact.toolSurfaceVersion]
] as Array<[string, unknown]>) {
  if (value !== "0.4.0") failures.push(`${label}: expected 0.4.0, received ${String(value)}`);
}
if (artifact.restricted?.toolCount !== restricted.toolCount) failures.push("restricted tool count drift");
if (artifact.full?.toolCount !== full.toolCount) failures.push("full tool count drift");
if (artifact.restricted?.toolSchemaHash !== restricted.toolSchemaHash) failures.push("restricted tool hash drift");
if (artifact.full?.toolSchemaHash !== full.toolSchemaHash) failures.push("full tool hash drift");
if (!readme.includes("v0.4.0") || !readme.includes("**23**") || !readme.includes("**13**")) {
  failures.push("README current version/tool counts are missing");
}

if (failures.length) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`Version/tool consistency passed: restricted=${restricted.toolCount}, full=${full.toolCount}.`);
