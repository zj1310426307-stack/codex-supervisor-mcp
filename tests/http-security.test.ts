import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import type { Config } from "../src/config.js";
import { isLoopbackHost, loadConfig } from "../src/config.js";
import { startHttpServer, type HttpSupervisorFacade } from "../src/http.js";
import { evaluateRequestSecurity, FixedWindowRateLimiter, parseHostHeader } from "../src/http/security.js";

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    mcpPath: "/mcp",
    bearerToken: "a".repeat(32),
    allowedHosts: ["127.0.0.1", "localhost"],
    allowedOrigins: ["https://chatgpt.com"],
    codexBin: "codex",
    codexBinSource: "path",
    codexHome: undefined,
    codexExperimentalApi: false,
    codexReadRetries: 1,
    codexRetryBaseDelayMs: 1,
    codexRetryMaxDelayMs: 2,
    codexShutdownTimeoutMs: 100,
    workspaceRoots: [process.cwd()],
    stateFile: "state.json",
    worktreeRoot: "worktrees",
    verificationConfigFile: "config/verification.example.json",
    turnLeaseTtlMs: 30_000,
    turnWarnIdleMs: 60_000,
    turnSuspectIdleMs: 180_000,
    turnHardDeadlineMs: 3_600_000,
    verifierLeaseTtlMs: 20_000,
    maxVerificationOutputChars: 50_000,
    maxEventsPerTask: 10,
    maxEventPayloadChars: 100,
    maxDiffChars: 100,
    requestTimeoutMs: 1_000,
    maxBodyBytes: 8,
    rateLimitMaxRequests: 20,
    rateLimitWindowMs: 60_000,
    headersTimeoutMs: 5_000,
    httpRequestTimeoutMs: 5_000,
    readinessTimeoutMs: 500,
    controlEnabled: false,
    ...overrides
  };
}

function request(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path,
      method: options.method ?? "GET",
      headers: options.headers
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    req.once("error", reject);
    req.end(options.body);
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeFacade(onStop: () => void = () => undefined): HttpSupervisorFacade {
  return {
    health: async () => ({ ok: true }),
    readinessProbe: async () => true,
    stop: async () => onStop()
  } as unknown as HttpSupervisorFacade;
}

test("loopback and non-loopback configuration enforce secure defaults", () => {
  assert.equal(isLoopbackHost("127.20.1.2"), true);
  assert.equal(isLoopbackHost("[::1]"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.throws(() => loadConfig({ MCP_HOST: "0.0.0.0", CODEX_WORKSPACE_ROOTS: "D:\\work", CODEX_BIN: "codex" }), /BEARER_TOKEN/);
  assert.throws(() => loadConfig({
    MCP_HOST: "0.0.0.0",
    MCP_BEARER_TOKEN: "secret",
    CODEX_WORKSPACE_ROOTS: "D:\\work",
    CODEX_BIN: "codex"
  }), /ALLOWED_HOSTS/);
  assert.throws(() => loadConfig({
    MCP_HOST: "0.0.0.0",
    MCP_BEARER_TOKEN: "secret",
    MCP_ALLOWED_HOSTS: "example.test",
    CODEX_WORKSPACE_ROOTS: "D:\\work",
    CODEX_BIN: "codex"
  }), /ALLOWED_ORIGINS/);
  assert.throws(() => loadConfig({
    MCP_HOST: "0.0.0.0",
    MCP_BEARER_TOKEN: "too-short",
    MCP_ALLOWED_HOSTS: "example.test",
    MCP_ALLOWED_ORIGINS: "https://chatgpt.com",
    CODEX_WORKSPACE_ROOTS: "D:\\work",
    CODEX_BIN: "codex"
  }), /at least 32 bytes/);
  assert.throws(() => loadConfig({
    MCP_PORT: "65536",
    CODEX_WORKSPACE_ROOTS: "D:\\work",
    CODEX_BIN: "codex"
  }), /at most 65535/);

  const local = loadConfig({ CODEX_WORKSPACE_ROOTS: "D:\\work", CODEX_BIN: "codex" });
  assert.equal(local.host, "127.0.0.1");
  assert.ok(local.allowedHosts.includes("127.0.0.1"));
  assert.equal(local.codexExperimentalApi, false);
  assert.equal(local.codexModel, undefined);
  assert.equal(loadConfig({
    CODEX_WORKSPACE_ROOTS: "D:\\work",
    CODEX_BIN: "codex",
    CODEX_MODEL: "  gpt-5.4-mini  "
  }).codexModel, "gpt-5.4-mini");
  assert.equal(local.controlEnabled, false);
  for (const placeholder of [
    "changeme",
    "replace-me",
    "replace-with-a-long-random-secret",
    "example",
    "example-token",
    "test-token",
    "default",
    "password"
  ]) {
    assert.throws(() => loadConfig({
      MCP_BEARER_TOKEN: placeholder,
      CODEX_WORKSPACE_ROOTS: "D:\\work",
      CODEX_BIN: "codex"
    }), /placeholder|at least 32 bytes/);
  }
});

test("Host, Origin, and bearer token are evaluated independently", () => {
  const config = baseConfig();
  assert.equal(parseHostHeader("[::1]:8787"), "::1");
  assert.equal(parseHostHeader("localhost:99999"), undefined);
  assert.equal(parseHostHeader("good.test@evil.test"), undefined);

  const allowed = evaluateRequestSecurity({ headers: {
    host: "localhost:8787",
    origin: "https://chatgpt.com",
    authorization: `Bearer ${config.bearerToken}`
  } }, config, true);
  assert.deepEqual(allowed, { allowed: true });
  assert.deepEqual(evaluateRequestSecurity({ headers: { host: "evil.test" } }, config, false), {
    allowed: false,
    status: 403,
    reason: "host_forbidden"
  });
  assert.equal(evaluateRequestSecurity({ headers: { host: "localhost", origin: "https://evil.test" } }, config, false).allowed, false);
  assert.equal(evaluateRequestSecurity({ headers: { host: "localhost", authorization: "Bearer wrong" } }, config, true).allowed, false);
});

test("rate limiter is bounded by count and resets by time", () => {
  let now = 100;
  const limiter = new FixedWindowRateLimiter(2, 1_000, () => now);
  assert.equal(limiter.take("client").allowed, true);
  assert.equal(limiter.take("client").allowed, true);
  assert.equal(limiter.take("client").allowed, false);
  now = 1_101;
  assert.equal(limiter.take("client").allowed, true);
});

test("HTTP health and readiness are redacted; auth and body limits fail closed", async () => {
  let stopped = false;
  let readinessProbes = 0;
  const fake = {
    health: async () => ({ ok: true, account: { token: "must-not-leak", email: "private@example.test" } }),
    readinessProbe: async () => { readinessProbes += 1; return true; },
    stop: async () => { stopped = true; }
  } as unknown as HttpSupervisorFacade;
  const config = baseConfig();
  const running = startHttpServer(config, fake);
  if (!running.server.listening) await once(running.server, "listening");
  const address = running.server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  try {
    const health = await request(port, "/healthz");
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { ok: true, status: "alive" });

    const ready = await request(port, "/readyz");
    assert.equal(ready.status, 200);
    assert.equal(readinessProbes, 1);
    assert.deepEqual(JSON.parse(ready.body), { ok: true, status: "ready" });
    assert.doesNotMatch(ready.body, /token|email|private/i);

    const unauthorized = await request(port, "/mcp");
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers["www-authenticate"], "Bearer");

    const tooLarge = await request(port, "/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${config.bearerToken}`, "content-type": "application/json" },
      body: "0123456789"
    });
    assert.equal(tooLarge.status, 413);
    assert.deepEqual(JSON.parse(tooLarge.body), { error: "payload_too_large" });
  } finally {
    await running.close();
  }
  assert.equal(stopped, true);
});

test("an MCP timeout remains fail-closed after the underlying operation completes", async () => {
  const first = deferred();
  let calls = 0;
  const config = baseConfig({ httpRequestTimeoutMs: 40 });
  const running = startHttpServer(config, fakeFacade(), {
    closeHandler: async () => undefined,
    nodeHandler: async (_req, res) => {
      calls += 1;
      if (calls === 1) await first.promise;
      if (!res.writableEnded) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, calls }));
      }
    }
  });
  if (!running.server.listening) await once(running.server, "listening");
  const address = running.server.address();
  assert.ok(address && typeof address === "object");
  const auth = { authorization: `Bearer ${config.bearerToken}`, "content-type": "application/json" };
  try {
    const timedOut = await request(address.port, "/mcp", { method: "POST", headers: auth, body: "{}" });
    assert.equal(timedOut.status, 504);
    assert.deepEqual(JSON.parse(timedOut.body), { error: "mcp_timeout_result_ambiguous" });

    const rejected = await request(address.port, "/mcp", { method: "POST", headers: auth, body: "{}" });
    assert.equal(rejected.status, 503);
    assert.deepEqual(JSON.parse(rejected.body), { error: "mcp_result_ambiguous" });
    assert.equal(calls, 1);

    first.resolve();
    await first.promise;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const stillRejected = await request(address.port, "/mcp", { method: "POST", headers: auth, body: "{}" });
    assert.equal(stillRejected.status, 503);
    assert.deepEqual(JSON.parse(stillRejected.body), { error: "mcp_result_ambiguous" });
    assert.equal(calls, 1);

    const ready = await request(address.port, "/readyz");
    assert.equal(ready.status, 503);
    assert.deepEqual(JSON.parse(ready.body), { ok: false, status: "not_ready" });
  } finally {
    first.resolve();
    await running.close();
  }
});

test("shutdown drains active handlers before stopping the orchestrator", async () => {
  const gate = deferred();
  let stopped = false;
  let entered = false;
  const config = baseConfig({ httpRequestTimeoutMs: 500 });
  const running = startHttpServer(config, fakeFacade(() => { stopped = true; }), {
    closeHandler: async () => undefined,
    nodeHandler: async (_req, res) => {
      entered = true;
      await gate.promise;
      if (!res.writableEnded) res.end("ok");
    }
  });
  if (!running.server.listening) await once(running.server, "listening");
  const address = running.server.address();
  assert.ok(address && typeof address === "object");
  const inFlight = request(address.port, "/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${config.bearerToken}` },
    body: "{}"
  });
  while (!entered) await new Promise((resolve) => setTimeout(resolve, 1));

  const closing = running.close();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stopped, false);
  gate.resolve();
  await inFlight;
  await closing;
  assert.equal(stopped, true);
});

test("bounded shutdown leaves the orchestrator running when a handler cannot drain", async () => {
  const gate = deferred();
  let stopped = false;
  let entered = false;
  const config = baseConfig({ httpRequestTimeoutMs: 30 });
  const running = startHttpServer(config, fakeFacade(() => { stopped = true; }), {
    closeHandler: async () => undefined,
    nodeHandler: async () => {
      entered = true;
      await gate.promise;
    }
  });
  if (!running.server.listening) await once(running.server, "listening");
  const address = running.server.address();
  assert.ok(address && typeof address === "object");
  const inFlight = request(address.port, "/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${config.bearerToken}` },
    body: "{}"
  }).catch(() => undefined);
  while (!entered) await new Promise((resolve) => setTimeout(resolve, 1));

  await assert.rejects(running.close(), /handlers were still active/);
  assert.equal(stopped, false);
  gate.resolve();
  await inFlight;
});
