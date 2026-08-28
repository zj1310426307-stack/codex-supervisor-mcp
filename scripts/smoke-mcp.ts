import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { loadConfig } from "../src/config.js";
import { redact } from "../src/core/redaction.js";
import { startHttpServer, type HttpSupervisorFacade } from "../src/http.js";
import { canonicalJson, createToolManifest } from "../src/mcp/tool-catalog.js";

type Mode = "restricted" | "full";

function scanFacade(mode: Mode): HttpSupervisorFacade {
  return {
    controlEnabled: () => mode === "full",
    health: async () => ({ status: "PASS", scanMode: mode, realCodexProcessStarted: false }),
    readinessProbe: async () => true,
    stop: async () => undefined
  } as unknown as HttpSupervisorFacade;
}

function hashTools(tools: unknown): string {
  return createHash("sha256").update(canonicalJson(tools), "utf8").digest("hex");
}

export async function scanMcpMode(mode: Mode): Promise<Record<string, unknown>> {
  const config = {
    ...loadConfig({
      CODEX_WORKSPACE_ROOTS: process.cwd(),
      CODEX_BIN: process.execPath,
      MCP_CONTROL_ENABLED: mode === "full" ? "true" : "false"
    }),
    port: 0,
    headersTimeoutMs: 10_000,
    httpRequestTimeoutMs: 30_000
  };
  const runtime = startHttpServer(config, scanFacade(mode));
  if (!runtime.server.listening) await once(runtime.server, "listening");
  const address = runtime.server.address();
  if (!address || typeof address === "string") throw new Error("MCP scan listener did not expose a TCP address");

  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}${config.mcpPath}`));
  const client = new Client({ name: "codex-supervisor-phase04-scan", version: "0.4.0" });
  let clientClosed = false;
  let serverClosed = false;
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const expected = createToolManifest(mode);
    const actualTools = listed.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      annotations: tool.annotations,
      inputSchema: tool.inputSchema
    }));
    const expectedTools = expected.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      annotations: tool.annotations,
      inputSchema: tool.inputSchema
    }));
    if (canonicalJson(actualTools) !== canonicalJson(expectedTools)) {
      const mismatch = actualTools.findIndex(
        (tool, index) => canonicalJson(tool) !== canonicalJson(expectedTools[index])
      );
      throw new Error(`${mode} tools/list did not match the frozen catalog at index ${mismatch}: ${JSON.stringify({
        actual: actualTools[mismatch],
        expected: expectedTools[mismatch]
      })}`);
    }
    const expectedCount = mode === "restricted" ? 13 : 23;
    if (actualTools.length !== expectedCount) throw new Error(`${mode} tool count was ${actualTools.length}, expected ${expectedCount}`);
    for (const tool of actualTools) {
      const annotations = tool.annotations ?? {};
      if (annotations.openWorldHint !== false) throw new Error(`${tool.name} is not closed-world`);
      if (mode === "restricted") {
        if (annotations.readOnlyHint !== true || annotations.destructiveHint !== false) {
          throw new Error(`${tool.name} is not genuinely read-only in Restricted mode`);
        }
      }
    }
    const health = await client.callTool({ name: "codex_health", arguments: {} });
    if (health.isError) throw new Error(`${mode} codex_health returned an MCP error`);
    const actualHash = hashTools(actualTools);
    if (actualHash !== expected.toolSchemaHash) throw new Error(`${mode} tool schema hash mismatch`);
    return redact({
      schemaVersion: 1,
      status: "PASS",
      checkedAt: new Date().toISOString(),
      mode,
      transport: "streamable-http",
      actualHttpListener: true,
      sdkClient: "@modelcontextprotocol/client@2.0.0",
      negotiatedProtocolVersion: client.getNegotiatedProtocolVersion(),
      serverVersion: client.getServerVersion(),
      toolCount: actualTools.length,
      toolSchemaHash: actualHash,
      catalogSchemaHash: expected.toolSchemaHash,
      annotationsValidated: true,
      schemasValidatedAgainstCatalog: true,
      health,
      tools: actualTools
    });
  } finally {
    try {
      await client.close();
      clientClosed = true;
    } finally {
      await runtime.close();
      serverClosed = true;
    }
    if (!clientClosed || !serverClosed) throw new Error(`${mode} MCP scan shutdown was not proven`);
  }
}

async function main(): Promise<void> {
  const outputDirectory = path.resolve("artifacts", "validation");
  await mkdir(outputDirectory, { recursive: true });
  const reports: Array<{ mode: Mode; file: string; report: Record<string, unknown> }> = [];
  for (const mode of ["restricted", "full"] as const) {
    const file = path.join(outputDirectory, `mcp-${mode}-scan.json`);
    try {
      const report = await scanMcpMode(mode);
      await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      reports.push({ mode, file, report });
    } catch (error) {
      const report = redact({
        schemaVersion: 1,
        status: "FAIL",
        checkedAt: new Date().toISOString(),
        mode,
        error: error instanceof Error ? error.message : String(error)
      });
      await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      reports.push({ mode, file, report });
      process.exitCode = 1;
    }
  }
  process.stdout.write(`${JSON.stringify({
    status: reports.every(({ report }) => report.status === "PASS") ? "PASS" : "FAIL",
    scans: reports.map(({ mode, file, report }) => ({
      mode,
      file: path.relative(process.cwd(), file).replaceAll("\\", "/"),
      status: report.status
    }))
  }, null, 2)}\n`);
}

const isEntryPoint = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isEntryPoint) await main();
