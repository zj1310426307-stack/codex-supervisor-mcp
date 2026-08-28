import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCombinedToolManifest } from "../../src/mcp/tool-catalog.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "../..");
const outputPath = path.join(projectRoot, "artifacts", "tool-manifest.json");

export async function exportToolManifest(target = outputPath): Promise<string> {
  const manifest = createCombinedToolManifest();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return target;
}

export async function checkToolManifest(target = outputPath): Promise<string> {
  const expected = `${JSON.stringify(createCombinedToolManifest(), null, 2)}\n`;
  let actual: string;
  try {
    actual = await fs.readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Generated tool manifest is missing: ${target}`);
    }
    throw error;
  }
  if (actual !== expected) {
    throw new Error(
      `Generated tool manifest is stale: ${target}. Run \"tsx scripts/chatgpt/export-tool-manifest.ts\".`
    );
  }
  return target;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const operation = process.argv.includes("--check") ? checkToolManifest : exportToolManifest;
  operation()
    .then((target) => {
      process.stdout.write(`${target}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
