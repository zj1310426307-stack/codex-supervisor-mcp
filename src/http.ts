import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { isLoopbackHost, type Config } from "./config.js";
import { FixedWindowRateLimiter, evaluateRequestSecurity } from "./http/security.js";
import type { SupervisorFacade } from "./mcp/facade.js";
import { createSupervisorMcp } from "./mcp/server.js";

export type HttpSupervisorFacade = SupervisorFacade & {
  stop(): Promise<unknown>;
  readinessProbe(): Promise<boolean>;
};

export interface HttpServerDependencies {
  /** Injectable only for deterministic lifecycle tests. */
  nodeHandler?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  closeHandler?: () => void | Promise<void>;
}

const JSON_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
});

function json(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  if (res.writableEnded || res.destroyed) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { ...JSON_HEADERS, ...extraHeaders });
  res.end(JSON.stringify(value));
}

function requestPath(req: IncomingMessage): string | undefined {
  try {
    return new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    return undefined;
  }
}

function requestKey(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

function monitorBody(req: IncomingMessage, res: ServerResponse, maxBytes: number): boolean {
  const rawLength = req.headers["content-length"];
  if (rawLength !== undefined) {
    if (!/^\d+$/.test(rawLength)) {
      json(res, 400, { error: "invalid_request" });
      return false;
    }
    if (Number(rawLength) > maxBytes) {
      json(res, 413, { error: "payload_too_large" }, { connection: "close" });
      res.once("finish", () => req.destroy());
      return false;
    }
  }

  let received = 0;
  const onData = (chunk: Buffer | string) => {
    received += Buffer.byteLength(chunk);
    if (received <= maxBytes || res.writableEnded) return;
    req.pause();
    json(res, 413, { error: "payload_too_large" }, { connection: "close" });
    res.once("finish", () => req.destroy());
  };
  req.on("data", onData);
  res.once("close", () => req.off("data", onData));
  return true;
}

async function readiness(probe: Promise<boolean>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      probe,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      })
    ]);
    return result === true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function startHttpServer(
  config: Config,
  orchestrator: HttpSupervisorFacade,
  dependencies: HttpServerDependencies = {}
) {
  const handler = createMcpHandler(() => createSupervisorMcp(orchestrator));
  const nodeHandler = dependencies.nodeHandler ?? toNodeHandler(handler);
  const closeHandler = dependencies.closeHandler ?? (() => handler.close());
  const limiter = new FixedWindowRateLimiter(config.rateLimitMaxRequests, config.rateLimitWindowMs);
  const activeHandlers = new Set<Promise<unknown>>();
  // Sticky by design: once a 504 is visible, the caller cannot know whether a
  // mutation committed. Completion only makes shutdown safe; it cannot make a
  // retry safe. A fresh process (or a future explicit reconciliation API) is
  // required to clear this state.
  let mcpAmbiguous = false;
  let accepting = true;

  const track = <T>(work: Promise<T>): Promise<T> => {
    let tracked!: Promise<T>;
    tracked = work.finally(() => activeHandlers.delete(tracked));
    activeHandlers.add(tracked);
    return tracked;
  };

  const server = createServer((req, res) => {
    const rate = limiter.take(requestKey(req));
    if (!rate.allowed) {
      json(res, 429, { error: "rate_limited" }, { "retry-after": String(rate.retryAfterSeconds) });
      return;
    }

    const pathname = requestPath(req);
    if (!pathname) {
      json(res, 400, { error: "invalid_request" });
      return;
    }

    const security = evaluateRequestSecurity(req, config, pathname === config.mcpPath || !isLoopbackHost(config.host));
    if (!security.allowed) {
      const headers: Record<string, string> = security.status === 401 ? { "www-authenticate": "Bearer" } : {};
      json(res, security.status, { error: security.reason }, headers);
      return;
    }

    if (!accepting) {
      json(res, 503, { error: "server_draining" }, { connection: "close" });
      return;
    }

    if (pathname === "/healthz" && req.method === "GET") {
      json(res, 200, { ok: true, status: "alive" });
      return;
    }
    if (pathname === "/readyz" && req.method === "GET") {
      if (mcpAmbiguous) {
        json(res, 503, { ok: false, status: "not_ready" });
        return;
      }
      const probe = track(Promise.resolve().then(() => orchestrator.readinessProbe()));
      const response = track(readiness(probe, config.readinessTimeoutMs));
      void response.then(
        (ready) => json(res, ready ? 200 : 503, { ok: ready, status: ready ? "ready" : "not_ready" }),
        () => json(res, 503, { ok: false, status: "not_ready" })
      );
      return;
    }
    if (pathname !== config.mcpPath) {
      json(res, 404, { error: "not_found" });
      return;
    }
    if (mcpAmbiguous) {
      json(res, 503, { error: "mcp_result_ambiguous" }, { connection: "close" });
      return;
    }
    if (!monitorBody(req, res, config.maxBodyBytes)) return;
    let settled = false;
    let timedOut = false;
    const work = track(Promise.resolve().then(() => nodeHandler(req, res)));
    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      mcpAmbiguous = true;
      if (!res.headersSent) json(res, 504, { error: "mcp_timeout_result_ambiguous" }, { connection: "close" });
      else if (!res.writableEnded) res.destroy();
    }, config.httpRequestTimeoutMs);
    void work.then(
      () => {
        settled = true;
        clearTimeout(timeout);
      },
      () => {
        settled = true;
        clearTimeout(timeout);
        if (!timedOut) json(res, 500, { error: "internal_error" });
      }
    );
  });

  server.headersTimeout = config.headersTimeoutMs;
  server.requestTimeout = config.httpRequestTimeoutMs;
  server.keepAliveTimeout = Math.min(5_000, config.httpRequestTimeoutMs);
  server.maxHeadersCount = 100;
  server.listen(config.port, config.host, () => {
    console.log(`codex-supervisor-mcp listening on http://${config.host}:${config.port}${config.mcpPath}`);
  });

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      accepting = false;
      const serverClosed = new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      void serverClosed.catch(() => undefined);
      if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();

      const handlersDrained = await waitForHandlers(activeHandlers, config.httpRequestTimeoutMs);
      if (!handlersDrained) {
        if (typeof server.closeAllConnections === "function") server.closeAllConnections();
        await waitWithTimeout(serverClosed, Math.min(config.httpRequestTimeoutMs, 5_000));
        throw new Error(
          "HTTP shutdown timed out while handlers were still active; orchestrator was left running to avoid concurrent writes"
        );
      }

      const failures: unknown[] = [];
      try {
        await closeHandler();
      } catch (error) {
        failures.push(error);
      }
      try {
        await orchestrator.stop();
      } catch (error) {
        failures.push(error);
      }
      if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
      if (!await waitWithTimeout(serverClosed, Math.min(config.httpRequestTimeoutMs, 5_000))) {
        if (typeof server.closeAllConnections === "function") server.closeAllConnections();
        if (!await waitWithTimeout(serverClosed, Math.min(config.httpRequestTimeoutMs, 5_000))) {
          failures.push(new Error("HTTP listener did not close within the shutdown deadline"));
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, "Supervisor shutdown was incomplete");
    })();
    return closing;
  };
  const onSignal = () => void close().then(
    () => process.exit(0),
    (error) => {
      console.error("codex-supervisor-mcp shutdown failed", error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  );
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return { server, handler, close };
}

async function waitForHandlers(activeHandlers: Set<Promise<unknown>>, timeoutMs: number): Promise<boolean> {
  if (activeHandlers.size === 0) return true;
  return waitWithTimeout(Promise.allSettled([...activeHandlers]).then(() => undefined), timeoutMs);
}

async function waitWithTimeout(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
