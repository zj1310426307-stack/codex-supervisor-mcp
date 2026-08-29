import assert from "node:assert/strict";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";
import {
  collectSecureTunnelPreflight,
  probeLocalToolSurface,
  type TunnelPreflightRunner,
  type TunnelReadinessProbe,
  type TunnelToolProbe
} from "../scripts/preflight-secure-tunnel.js";
import { loadConfig } from "../src/config.js";
import { startHttpServer, type HttpSupervisorFacade } from "../src/http.js";

const bearer = "local-supervisor-bearer-token-000000000000000000";

function validEnv(): NodeJS.ProcessEnv {
  return {
    MCP_HOST: "127.0.0.1",
    MCP_PORT: "8787",
    MCP_PATH: "/mcp",
    MCP_CONTROL_ENABLED: "false",
    MCP_BEARER_TOKEN: bearer,
    MCP_TUNNEL_AUTHORIZATION: `Bearer ${bearer}`,
    MCP_SERVER_URL: "http://127.0.0.1:8787/mcp",
    MCP_EXTRA_HEADERS: "Authorization: env:MCP_TUNNEL_AUTHORIZATION",
    MCP_DISCOVERY_EXTRA_HEADERS: "Authorization: env:MCP_TUNNEL_AUTHORIZATION",
    CONTROL_PLANE_TUNNEL_ID: "tunnel_0123456789abcdef0123456789abcdef",
    CONTROL_PLANE_API_KEY: "runtime-key-that-is-distinct-from-the-local-bearer"
  };
}

const passingRunner: TunnelPreflightRunner = async (_program, args) => ({
  ok: true,
  stdout: args.includes("--version") ? "tunnel-client v0.0.10" : "quickstart",
  stderr: ""
});

const passingReadiness: TunnelReadinessProbe = async (url, authorization) => {
  assert.equal(url.href, "http://127.0.0.1:8787/mcp");
  assert.equal(authorization, `Bearer ${bearer}`);
  return { ok: true, detail: "ready" };
};

const passingToolProbe: TunnelToolProbe = async (url, authorization, mode) => {
  assert.equal(url.href, "http://127.0.0.1:8787/mcp");
  assert.equal(authorization, `Bearer ${bearer}`);
  return { ok: true, detail: `${mode} tools/list passed` };
};

test("secure tunnel preflight passes a restricted loopback configuration without exposing secrets", async () => {
  const report = await collectSecureTunnelPreflight({
    env: validEnv(),
    runner: passingRunner,
    readinessProbe: passingReadiness,
    toolProbe: passingToolProbe,
    now: () => new Date("2026-08-29T00:00:00.000Z")
  });
  assert.equal(report.status, "PASS");
  assert.equal(report.readOnly, true);
  assert.equal(report.mode, "restricted");
  assert.equal(report.containsSensitiveValues, false);
  assert.deepEqual(report.localMcp, {
    scheme: "http",
    host: "127.0.0.1",
    port: 8787,
    path: "/mcp"
  });
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /local-supervisor-bearer|runtime-key-that-is-distinct/);
  assert.doesNotMatch(serialized, /tunnel_0123456789abcdef0123456789abcdef/);
});

test("secure tunnel preflight rejects public bind, full control, and literal or mismatched credentials", async () => {
  const env = validEnv();
  env.MCP_HOST = "0.0.0.0";
  env.MCP_CONTROL_ENABLED = "true";
  env.MCP_SERVER_URL = "https://public.example.test/mcp";
  env.MCP_TUNNEL_AUTHORIZATION = "Bearer wrong";
  env.MCP_EXTRA_HEADERS = `Authorization: Bearer ${bearer}`;
  env.CONTROL_PLANE_API_KEY = bearer;
  const report = await collectSecureTunnelPreflight({
    env,
    runner: passingRunner,
    readinessProbe: async () => { throw new Error("must not run"); },
    toolProbe: async () => { throw new Error("must not run"); }
  });
  assert.equal(report.status, "BLOCKED_BY_CONFIGURATION");
  for (const name of [
    "loopbackBind",
    "restrictedMode",
    "tunnelCredentialMapping",
    "runtimeHeader",
    "credentialSeparation",
    "localMcpUrl",
    "localReadiness"
  ]) {
    assert.equal(report.checks[name]?.status, "BLOCKED_BY_CONFIGURATION", name);
  }
  assert.doesNotMatch(JSON.stringify(report), /local-supervisor-bearer|Bearer wrong/);
});

test("secure tunnel preflight distinguishes missing binary and stopped local service from configuration errors", async () => {
  const failingRunner: TunnelPreflightRunner = async () => ({
    ok: false,
    stdout: "",
    stderr: "command not found"
  });
  const report = await collectSecureTunnelPreflight({
    env: validEnv(),
    runner: failingRunner,
    readinessProbe: async () => ({ ok: false, detail: "connection refused" }),
    toolProbe: async () => ({ ok: false, detail: "connection refused" })
  });
  assert.equal(report.status, "BLOCKED_BY_ENVIRONMENT");
  assert.equal(report.checks.tunnelClientVersion?.status, "BLOCKED_BY_ENVIRONMENT");
  assert.equal(report.checks.tunnelClientQuickstart?.status, "BLOCKED_BY_ENVIRONMENT");
  assert.equal(report.checks.localReadiness?.status, "BLOCKED_BY_ENVIRONMENT");
});

test("secure tunnel preflight validates tunnel identifiers and bearer strength", async () => {
  const env = validEnv();
  env.MCP_BEARER_TOKEN = "changeme";
  env.MCP_TUNNEL_AUTHORIZATION = "Bearer changeme";
  env.CONTROL_PLANE_TUNNEL_ID = "tunnel_NOT_VALID";
  const report = await collectSecureTunnelPreflight({
    env,
    runner: passingRunner,
    readinessProbe: passingReadiness,
    toolProbe: passingToolProbe
  });
  assert.equal(report.status, "BLOCKED_BY_CONFIGURATION");
  assert.equal(report.checks.localCredential?.status, "BLOCKED_BY_CONFIGURATION");
  assert.equal(report.checks.tunnelId?.status, "BLOCKED_BY_CONFIGURATION");
});

test("full-control preflight requires a separate app acknowledgement and an isolated no-remote repository", async () => {
  const env = validEnv();
  env.MCP_CONTROL_ENABLED = "true";
  env.FULL_CONTROL_ACCEPTANCE_AUTHORIZED = "true";
  env.FULL_CONTROL_NEW_CHATGPT_APP_REQUIRED = "true";
  env.CODEX_WORKSPACE_ROOTS = path.resolve("temporary-full-control-repository");
  env.SUPERVISOR_STATE_FILE = path.resolve("..", "full-control-state", "state.json");
  env.SUPERVISOR_WORKTREE_ROOT = path.resolve("..", "full-control-state", "worktrees");
  const gitRunner: TunnelPreflightRunner = async (program, args) => {
    if (program === "tunnel-client") return passingRunner(program, args);
    const operation = args.slice(2).join(" ");
    if (operation === "rev-parse --show-toplevel") return { ok: true, stdout: env.CODEX_WORKSPACE_ROOTS!, stderr: "" };
    if (operation === "rev-parse --verify HEAD") return { ok: true, stdout: "0123456789abcdef", stderr: "" };
    if (operation === "status --porcelain" || operation === "remote") return { ok: true, stdout: "", stderr: "" };
    return { ok: false, stdout: "", stderr: "unexpected git command" };
  };
  const report = await collectSecureTunnelPreflight({
    env,
    mode: "full",
    runner: gitRunner,
    readinessProbe: passingReadiness,
    toolProbe: passingToolProbe
  });
  assert.equal(report.status, "PASS");
  assert.equal(report.mode, "full");
  for (const name of [
    "fullControlMode",
    "fullControlOptIn",
    "separateChatGptApp",
    "singleTemporaryWorkspace",
    "temporaryRepository",
    "isolatedSupervisorState",
    "localToolDiscovery"
  ]) {
    assert.equal(report.checks[name]?.status, "PASS", name);
  }
  assert.doesNotMatch(JSON.stringify(report), /local-supervisor-bearer|runtime-key-that-is-distinct/);
});

test("full-control preflight fails closed when authorization, app isolation, repository, or state isolation is missing", async () => {
  const env = validEnv();
  env.MCP_CONTROL_ENABLED = "true";
  env.CODEX_WORKSPACE_ROOTS = path.resolve("temporary-full-control-repository");
  const dirtyRemoteRunner: TunnelPreflightRunner = async (program, args) => {
    if (program === "tunnel-client") return passingRunner(program, args);
    const operation = args.slice(2).join(" ");
    if (operation === "rev-parse --show-toplevel") return { ok: true, stdout: env.CODEX_WORKSPACE_ROOTS!, stderr: "" };
    if (operation === "rev-parse --verify HEAD") return { ok: true, stdout: "0123456789abcdef", stderr: "" };
    if (operation === "status --porcelain") return { ok: true, stdout: " M README.md", stderr: "" };
    if (operation === "remote") return { ok: true, stdout: "origin", stderr: "" };
    return { ok: false, stdout: "", stderr: "unexpected git command" };
  };
  const report = await collectSecureTunnelPreflight({
    env,
    mode: "full",
    runner: dirtyRemoteRunner,
    readinessProbe: passingReadiness,
    toolProbe: passingToolProbe
  });
  assert.equal(report.status, "BLOCKED_BY_CONFIGURATION");
  for (const name of ["fullControlOptIn", "separateChatGptApp", "temporaryRepository", "isolatedSupervisorState"]) {
    assert.equal(report.checks[name]?.status, "BLOCKED_BY_CONFIGURATION", name);
  }
});

test("live MCP tool probe reads the exact restricted and full catalogs over authenticated Streamable HTTP", async () => {
  for (const mode of ["restricted", "full"] as const) {
    const config = {
      ...loadConfig({
        CODEX_WORKSPACE_ROOTS: process.cwd(),
        CODEX_BIN: process.execPath,
        MCP_BEARER_TOKEN: bearer,
        MCP_CONTROL_ENABLED: mode === "full" ? "true" : "false"
      }),
      port: 0
    };
    const facade = {
      controlEnabled: () => mode === "full",
      health: async () => ({ ok: true }),
      readinessProbe: async () => true,
      stop: async () => undefined
    } as unknown as HttpSupervisorFacade;
    const runtime = startHttpServer(config, facade);
    if (!runtime.server.listening) await once(runtime.server, "listening");
    const address = runtime.server.address();
    assert.ok(address && typeof address === "object");
    try {
      const result = await probeLocalToolSurface(
        new URL(`http://127.0.0.1:${address.port}/mcp`),
        `Bearer ${bearer}`,
        mode,
        5_000
      );
      assert.equal(result.ok, true, result.detail);
      assert.match(result.detail, new RegExp(mode === "full" ? "23 tools" : "13 tools"));
    } finally {
      await runtime.close();
    }
  }
});
