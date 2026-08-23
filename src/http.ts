import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { Config } from "./config.js";
import type { Orchestrator } from "./core/orchestrator.js";
import { createSupervisorMcp } from "./mcp/server.js";

function equalSecret(expected: string, actual: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorized(req: import("node:http").IncomingMessage, config: Config): boolean {
  if (config.allowedHosts.length) {
    const host = (req.headers.host ?? "").split(":")[0];
    if (!config.allowedHosts.includes(host)) return false;
  }
  if (config.allowedOrigins.length && req.headers.origin) {
    if (!config.allowedOrigins.includes(req.headers.origin)) return false;
  }
  if (!config.bearerToken) return true;
  const header = req.headers.authorization ?? "";
  const [scheme, token] = header.split(" ", 2);
  return scheme?.toLowerCase() === "bearer" && !!token && equalSecret(config.bearerToken, token);
}

export function startHttpServer(config: Config, orchestrator: Orchestrator) {
  const handler = createMcpHandler(() => createSupervisorMcp(orchestrator));
  const nodeHandler = toNodeHandler(handler);

  const server = createServer((req, res) => {
    if (req.url === "/healthz" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "codex-supervisor-mcp" }));
      return;
    }
    const pathname = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;
    if (pathname !== config.mcpPath) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
      return;
    }
    if (!authorized(req, config)) {
      res.writeHead(401, { "content-type": "text/plain", "www-authenticate": "Bearer" });
      res.end("Unauthorized");
      return;
    }
    void nodeHandler(req, res);
  });

  server.listen(config.port, config.host, () => {
    console.log(`codex-supervisor-mcp listening on http://${config.host}:${config.port}${config.mcpPath}`);
  });

  const close = async () => {
    await orchestrator.stop();
    await handler.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  process.on("SIGINT", () => void close().finally(() => process.exit(0)));
  process.on("SIGTERM", () => void close().finally(() => process.exit(0)));
  return { server, handler, close };
}
