import fs from "node:fs/promises";
import path from "node:path";
import { SupervisorError } from "./errors.js";

/** Resolve workspaces through real paths and enforce configured ownership roots. */
export class WorkspaceGuard {
  private resolvedRoots?: Promise<string[]>;

  constructor(private readonly allowedRoots: string[]) {
    if (allowedRoots.length === 0) {
      throw new SupervisorError("WORKSPACE_NOT_ALLOWED", "At least one workspace root is required", 500);
    }
  }

  async resolveAllowed(candidate: string): Promise<string> {
    if (!candidate?.trim()) {
      throw new SupervisorError("WORKSPACE_NOT_ALLOWED", "Workspace path must be non-empty", 400);
    }
    const resolved = path.resolve(candidate);
    let real: string;
    try {
      real = await fs.realpath(resolved);
    } catch (error) {
      throw new SupervisorError("WORKSPACE_NOT_ALLOWED", "Workspace does not exist or is not readable", 400, {
        candidate: resolved
      }, { cause: error });
    }
    const roots = await (this.resolvedRoots ??= this.resolveRoots());
    for (const root of roots) {
      if (real === root || real.startsWith(root + path.sep)) return real;
    }
    throw new SupervisorError(
      "WORKSPACE_NOT_ALLOWED",
      `Workspace is outside CODEX_WORKSPACE_ROOTS: ${real}`,
      403
    );
  }

  private async resolveRoots(): Promise<string[]> {
    const roots: string[] = [];
    for (const configuredRoot of this.allowedRoots) {
      try {
        roots.push(await fs.realpath(path.resolve(configuredRoot)));
      } catch {
        // An unavailable configured root grants no access.
      }
    }
    if (roots.length === 0) {
      throw new SupervisorError("WORKSPACE_NOT_ALLOWED", "No configured workspace root is readable", 500);
    }
    return [...new Set(roots)];
  }
}
