import assert from "node:assert/strict";
import test from "node:test";
import {
  collectSecureTunnelPreflight,
  type TunnelPreflightRunner,
  type TunnelReadinessProbe
} from "../scripts/preflight-secure-tunnel.js";

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

test("secure tunnel preflight passes a restricted loopback configuration without exposing secrets", async () => {
  const report = await collectSecureTunnelPreflight({
    env: validEnv(),
    runner: passingRunner,
    readinessProbe: passingReadiness,
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
    readinessProbe: async () => { throw new Error("must not run"); }
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
    readinessProbe: async () => ({ ok: false, detail: "connection refused" })
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
    readinessProbe: passingReadiness
  });
  assert.equal(report.status, "BLOCKED_BY_CONFIGURATION");
  assert.equal(report.checks.localCredential?.status, "BLOCKED_BY_CONFIGURATION");
  assert.equal(report.checks.tunnelId?.status, "BLOCKED_BY_CONFIGURATION");
});
