import assert from "node:assert/strict";
import test from "node:test";
import { scanMcpMode } from "../scripts/smoke-mcp.js";

test("real Streamable HTTP SDK scans match Restricted and Full catalogs", async () => {
  const restricted = await scanMcpMode("restricted");
  const full = await scanMcpMode("full");
  assert.equal(restricted.status, "PASS");
  assert.equal(restricted.toolCount, 13);
  assert.equal(full.status, "PASS");
  assert.equal(full.toolCount, 23);
  assert.equal(restricted.annotationsValidated, true);
  assert.equal(full.schemasValidatedAgainstCatalog, true);
});
