import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceGuard } from "../src/core/workspace.js";

test("workspace guard accepts child and rejects sibling", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-"));
  const allowed = path.join(base, "allowed");
  const child = path.join(allowed, "repo");
  const sibling = path.join(base, "other");
  await fs.mkdir(child, { recursive: true });
  await fs.mkdir(sibling, { recursive: true });
  const guard = new WorkspaceGuard([allowed]);
  assert.equal(await guard.resolveAllowed(child), await fs.realpath(child));
  await assert.rejects(() => guard.resolveAllowed(sibling));
});
