import { execFile } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { isLoopbackHost, isPlaceholderBearerToken } from "../src/config.js";
import { redact } from "../src/core/redaction.js";

const execFileAsync = promisify(execFile);

export type TunnelPreflightStatus = "PASS" | "BLOCKED_BY_CONFIGURATION" | "BLOCKED_BY_ENVIRONMENT";

export interface TunnelPreflightCheck {
  status: TunnelPreflightStatus;
  detail: string;
  command?: string;
}

export interface SecureTunnelPreflightReport {
  schemaVersion: 1;
  phase: "ORCH-PHASE-05";
  status: TunnelPreflightStatus;
  checkedAt: string;
  readOnly: true;
  mode: "restricted";
  containsSensitiveValues: false;
  localMcp: {
    scheme?: string;
    host?: string;
    port?: number;
    path?: string;
  };
  checks: Record<string, TunnelPreflightCheck>;
  blockers: string[];
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

export type TunnelPreflightRunner = (program: string, args: string[]) => Promise<CommandResult>;
export type TunnelReadinessProbe = (url: URL, authorization: string, timeoutMs: number) => Promise<{
  ok: boolean;
  detail: string;
}>;

async function defaultRunner(program: string, args: string[]): Promise<CommandResult> {
  try {
    const result = await execFileAsync(program, args, {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (caught) {
    const error = caught as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: String(error.stdout ?? "").trim(),
      stderr: String(error.stderr ?? "").trim(),
      error: error.message
    };
  }
}

async function defaultReadinessProbe(url: URL, authorization: string, timeoutMs: number): Promise<{
  ok: boolean;
  detail: string;
}> {
  const readyUrl = new URL("/readyz", url);
  try {
    const response = await fetch(readyUrl, {
      method: "GET",
      headers: { authorization },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const body = await response.text();
    if (response.status !== 200) return { ok: false, detail: `local readiness returned HTTP ${response.status}` };
    try {
      const parsed = JSON.parse(body) as { ok?: unknown; status?: unknown };
      if (parsed.ok !== true || parsed.status !== "ready") {
        return { ok: false, detail: "local readiness response was not ready" };
      }
    } catch {
      return { ok: false, detail: "local readiness response was not valid JSON" };
    }
    return { ok: true, detail: "local Supervisor readiness is PASS" };
  } catch (error) {
    return {
      ok: false,
      detail: `local Supervisor is unreachable: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function check(status: TunnelPreflightStatus, detail: string, command?: string): TunnelPreflightCheck {
  return { status, detail, ...(command ? { command } : {}) };
}

function validPort(raw: string | undefined): number | undefined {
  const value = raw?.trim() || "8787";
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : undefined;
}

function isRestricted(raw: string | undefined): boolean {
  return raw === undefined || ["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

function usesAuthorizationReference(raw: string | undefined): boolean {
  return (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .some((value) => /^authorization:\s*env:MCP_TUNNEL_AUTHORIZATION$/i.test(value));
}

function safeCommandDetail(result: CommandResult): string {
  if (result.ok) return (result.stdout || result.stderr || "command completed").split(/\r?\n/, 1)[0]!.slice(0, 300);
  return (result.stderr || result.error || "command failed").split(/\r?\n/, 1)[0]!.slice(0, 300);
}

export async function collectSecureTunnelPreflight(options: {
  env?: NodeJS.ProcessEnv;
  runner?: TunnelPreflightRunner;
  readinessProbe?: TunnelReadinessProbe;
  now?: () => Date;
} = {}): Promise<SecureTunnelPreflightReport> {
  const env = options.env ?? process.env;
  const runner = options.runner ?? defaultRunner;
  const readinessProbe = options.readinessProbe ?? defaultReadinessProbe;
  const now = options.now ?? (() => new Date());
  const checks: Record<string, TunnelPreflightCheck> = {};

  const host = env.MCP_HOST?.trim() || "127.0.0.1";
  checks.loopbackBind = isLoopbackHost(host)
    ? check("PASS", "Supervisor bind is loopback-only")
    : check("BLOCKED_BY_CONFIGURATION", "MCP_HOST must remain loopback for Secure MCP Tunnel");

  checks.restrictedMode = isRestricted(env.MCP_CONTROL_ENABLED)
    ? check("PASS", "MCP_CONTROL_ENABLED is restricted")
    : check("BLOCKED_BY_CONFIGURATION", "MCP_CONTROL_ENABLED must be false for the first tunnel acceptance");

  const port = validPort(env.MCP_PORT);
  checks.localPort = port
    ? check("PASS", "MCP_PORT is valid")
    : check("BLOCKED_BY_CONFIGURATION", "MCP_PORT must be an integer from 1 through 65535");

  const mcpPath = env.MCP_PATH?.trim() || "/mcp";
  const validPath = mcpPath.startsWith("/") && !mcpPath.startsWith("//") && !/[?#]/.test(mcpPath)
    && mcpPath !== "/healthz" && mcpPath !== "/readyz";
  checks.localPath = validPath
    ? check("PASS", "MCP_PATH is a dedicated absolute path")
    : check("BLOCKED_BY_CONFIGURATION", "MCP_PATH is invalid or conflicts with an operator endpoint");

  const bearer = env.MCP_BEARER_TOKEN?.trim();
  const validBearer = Boolean(
    bearer && Buffer.byteLength(bearer, "utf8") >= 32 && !isPlaceholderBearerToken(bearer)
  );
  checks.localCredential = validBearer
    ? check("PASS", "local MCP bearer token is configured and passes length/placeholder checks")
    : check("BLOCKED_BY_CONFIGURATION", "set a non-placeholder MCP_BEARER_TOKEN of at least 32 bytes");

  const tunnelAuthorization = env.MCP_TUNNEL_AUTHORIZATION?.trim();
  checks.tunnelCredentialMapping = validBearer && tunnelAuthorization === `Bearer ${bearer}`
    ? check("PASS", "tunnel-client authorization value matches the local MCP bearer token")
    : check(
      "BLOCKED_BY_CONFIGURATION",
      "MCP_TUNNEL_AUTHORIZATION must equal 'Bearer ' plus MCP_BEARER_TOKEN and must stay outside source control"
    );

  checks.runtimeHeader = usesAuthorizationReference(env.MCP_EXTRA_HEADERS)
    ? check("PASS", "MCP runtime requests use an environment-backed Authorization header")
    : check(
      "BLOCKED_BY_CONFIGURATION",
      "MCP_EXTRA_HEADERS must contain 'Authorization: env:MCP_TUNNEL_AUTHORIZATION'"
    );
  checks.discoveryHeader = usesAuthorizationReference(env.MCP_DISCOVERY_EXTRA_HEADERS)
    ? check("PASS", "MCP discovery requests use the same environment-backed Authorization header")
    : check(
      "BLOCKED_BY_CONFIGURATION",
      "MCP_DISCOVERY_EXTRA_HEADERS must contain 'Authorization: env:MCP_TUNNEL_AUTHORIZATION'"
    );

  const tunnelId = env.CONTROL_PLANE_TUNNEL_ID?.trim();
  checks.tunnelId = tunnelId && /^tunnel_[0-9a-f]{32}$/.test(tunnelId)
    ? check("PASS", "CONTROL_PLANE_TUNNEL_ID has the documented format")
    : check("BLOCKED_BY_CONFIGURATION", "CONTROL_PLANE_TUNNEL_ID must be tunnel_ followed by 32 lowercase hex characters");

  const controlPlaneKey = env.CONTROL_PLANE_API_KEY?.trim();
  checks.runtimeCredential = controlPlaneKey
    ? check("PASS", "CONTROL_PLANE_API_KEY is configured without being emitted")
    : check("BLOCKED_BY_CONFIGURATION", "CONTROL_PLANE_API_KEY is required for tunnel-client doctor/run");
  checks.credentialSeparation = controlPlaneKey && bearer && controlPlaneKey !== bearer
    ? check("PASS", "control-plane and local MCP credentials are distinct")
    : check("BLOCKED_BY_CONFIGURATION", "control-plane and local MCP credentials must be distinct");

  let localUrl: URL | undefined;
  try {
    localUrl = new URL(env.MCP_SERVER_URL?.trim() || "");
  } catch {
    localUrl = undefined;
  }
  const localUrlValid = Boolean(
    localUrl
    && ["http:", "https:"].includes(localUrl.protocol)
    && isLoopbackHost(localUrl.hostname)
    && !localUrl.username
    && !localUrl.password
    && !localUrl.search
    && !localUrl.hash
    && validPath
    && localUrl.pathname === mcpPath
    && port
    && Number(localUrl.port || (localUrl.protocol === "https:" ? 443 : 80)) === port
  );
  checks.localMcpUrl = localUrlValid
    ? check("PASS", "MCP_SERVER_URL points to the exact loopback MCP listener")
    : check("BLOCKED_BY_CONFIGURATION", "MCP_SERVER_URL must match the configured loopback host, port, and MCP path");

  const [versionResult, quickstartResult] = await Promise.all([
    runner("tunnel-client", ["--version"]),
    runner("tunnel-client", ["help", "quickstart"])
  ]);
  checks.tunnelClientVersion = versionResult.ok
    ? check("PASS", safeCommandDetail(versionResult), "tunnel-client --version")
    : check("BLOCKED_BY_ENVIRONMENT", safeCommandDetail(versionResult), "tunnel-client --version");
  checks.tunnelClientQuickstart = quickstartResult.ok
    ? check("PASS", "tunnel-client quickstart help is available", "tunnel-client help quickstart")
    : check("BLOCKED_BY_ENVIRONMENT", safeCommandDetail(quickstartResult), "tunnel-client help quickstart");

  if (
    localUrlValid
    && localUrl
    && validBearer
    && tunnelAuthorization === `Bearer ${bearer}`
    && usesAuthorizationReference(env.MCP_EXTRA_HEADERS)
    && usesAuthorizationReference(env.MCP_DISCOVERY_EXTRA_HEADERS)
  ) {
    const readiness = await readinessProbe(localUrl, tunnelAuthorization, 5_000);
    checks.localReadiness = readiness.ok
      ? check("PASS", readiness.detail)
      : check("BLOCKED_BY_ENVIRONMENT", readiness.detail);
  } else {
    checks.localReadiness = check(
      "BLOCKED_BY_CONFIGURATION",
      "local readiness was not attempted until the loopback URL and authorization are valid"
    );
  }

  const configBlockers = Object.entries(checks)
    .filter(([, value]) => value.status === "BLOCKED_BY_CONFIGURATION")
    .map(([name, value]) => `${name}: ${value.detail}`);
  const environmentBlockers = Object.entries(checks)
    .filter(([, value]) => value.status === "BLOCKED_BY_ENVIRONMENT")
    .map(([name, value]) => `${name}: ${value.detail}`);
  const status: TunnelPreflightStatus = configBlockers.length > 0
    ? "BLOCKED_BY_CONFIGURATION"
    : environmentBlockers.length > 0
      ? "BLOCKED_BY_ENVIRONMENT"
      : "PASS";

  return redact({
    schemaVersion: 1,
    phase: "ORCH-PHASE-05",
    status,
    checkedAt: now().toISOString(),
    readOnly: true,
    mode: "restricted",
    containsSensitiveValues: false,
    localMcp: localUrlValid && localUrl
      ? {
          scheme: localUrl.protocol.replace(":", ""),
          host: localUrl.hostname,
          port,
          path: localUrl.pathname
        }
      : {},
    checks,
    blockers: [...configBlockers, ...environmentBlockers]
  }) as SecureTunnelPreflightReport;
}

async function main(): Promise<void> {
  const report = await collectSecureTunnelPreflight();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "PASS") process.exitCode = 2;
}

const isEntryPoint = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isEntryPoint) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify(redact({
      phase: "ORCH-PHASE-05",
      status: "BLOCKED_BY_ENVIRONMENT",
      readOnly: true,
      containsSensitiveValues: false,
      error: error instanceof Error ? error.message : String(error)
    }), null, 2)}\n`);
    process.exitCode = 2;
  });
}
