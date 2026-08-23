import fs from "node:fs/promises";
import path from "node:path";

export class WorkspaceGuard {
  constructor(private readonly allowedRoots: string[]) {}

  async resolveAllowed(candidate: string): Promise<string> {
    const resolved = path.resolve(candidate);
    const real = await fs.realpath(resolved);
    for (const configuredRoot of this.allowedRoots) {
      let root: string;
      try {
        root = await fs.realpath(configuredRoot);
      } catch {
        continue;
      }
      if (real === root || real.startsWith(root + path.sep)) return real;
    }
    throw new Error(`Workspace is outside CODEX_WORKSPACE_ROOTS: ${real}`);
  }
}
