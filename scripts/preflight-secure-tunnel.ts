import { execFile } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { isLoopbackHost, isPlaceholderBearerToken } from "../src/config.js";
import { redact } from "../src/core/redaction.js";
import { canonicalJson, createToolManifest, TOOL_SURFACE_VERSION } from "../src/mcp/tool-catalog.js";

const execFileAsync = promisify(execFile);

export type TunnelPreflightStatus = "PASS" | "BLOCKED_BY_CONFIGURATION" | "BLOCKED_BY_ENVIRONMENT";
export type TunnelPreflightMode = "restricted" | "full";

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
  mode: TunnelPreflightMode;
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
export type TunnelToolProbe = (
  url: URL,
  authorization: string,
  mode: TunnelPreflightMode,
  timeoutMs: number
) => Promise<{ ok: boolean; detail: string }>;

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

export async function probeLocalToolSurface(
  url: URL,
  authorization: string,
  mode: TunnelPreflightMode,
  timeoutMs: number
): Promise<{ ok: boolean; detail: string }> {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization } }
  });
  const client = new Client({ name: "codex-supervisor-tunnel-preflight", version: TOOL_SURFACE_VERSION });
  let timer: NodeJS.Timeout | undefined;
  try {
    const listed = await Promise.race([
      (async () => {
        await client.connect(transport);
        return client.listTools();
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("MCP tools/list probe timed out")), timeoutMs);
      })
    ]);
    const actual = listed.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      annotations: tool.annotations,
      inputSchema: tool.inputSchema
    }));
    const expected = createToolManifest(mode);
    if (canonicalJson(actual) !== canonicalJson(expected.tools)) {
      return { ok: false, detail: `local MCP tools/list does not match the frozen ${mode} catalog` };
    }
    return {
      ok: true,
      detail: `local MCP tools/list matches ${mode}: ${expected.toolCount} tools, schema ${expected.toolSchemaHash}`
    };
  } catch (error) {
    return {
      ok: false,
      detail: `local MCP tools/list failed: ${error instanceof Error ? error.message : String(error)}`
    };
  } finally {
    if (timer) clearTimeout(timer);
    await client.close().catch(() => undefined);
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

function isFull(raw: string | undefined): boolean {
  return raw !== undefined && ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function isExplicitTrue(raw: string | undefined): boolean {
  return raw?.trim().toLowerCase() === "true";
}

function configuredWorkspaceRoots(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => path.resolve(value));
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
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
  toolProbe?: TunnelToolProbe;
  mode?: TunnelPreflightMode;
  now?: () => Date;
} = {}): Promise<SecureTunnelPreflightReport> {
  const env = options.env ?? process.env;
  const runner = options.runner ?? defaultRunner;
  const readinessProbe = options.readinessProbe ?? defaultReadinessProbe;
  const toolProbe = options.toolProbe ?? probeLocalToolSurface;
  const mode = options.mode ?? "restricted";
  const now = options.now ?? (() => new Date());
  const checks: Record<string, TunnelPreflightCheck> = {};

  const host = env.MCP_HOST?.trim() || "127.0.0.1";
  checks.loopbackBind = isLoopbackHost(host)
    ? check("PASS", "Supervisor bind is loopback-only")
    : check("BLOCKED_BY_CONFIGURATION", "MCP_HOST must remain loopback for Secure MCP Tunnel");

  if (mode === "restricted") {
    checks.restrictedMode = isRestricted(env.MCP_CONTROL_ENABLED)
      ? check("PASS", "MCP_CONTROL_ENABLED is restricted")
      : check("BLOCKED_BY_CONFIGURATION", "MCP_CONTROL_ENABLED must be false for the first tunnel acceptance");
  } else {
    checks.fullControlMode = isFull(env.MCP_CONTROL_ENABLED)
      ? check("PASS", "MCP_CONTROL_ENABLED explicitly enables Full-control")
      : check("BLOCKED_BY_CONFIGURATION", "MCP_CONTROL_ENABLED must be true for a Full-control acceptance");
    checks.fullControlOptIn = isExplicitTrue(env.FULL_CONTROL_ACCEPTANCE_AUTHORIZED)
      ? check("PASS", "the operator recorded an explicit temporary Full-control opt-in")
      : check("BLOCKED_BY_CONFIGURATION", "the explicit Full-control opt-in flag must be exactly true");
    checks.separateChatGptApp = isExplicitTrue(env.FULL_CONTROL_NEW_CHATGPT_APP_REQUIRED)
      ? check("PASS", "the operator acknowledged that Full-control requires a new ChatGPT app instance")
      : check("BLOCKED_BY_CONFIGURATION", "FULL_CONTROL_NEW_CHATGPT_APP_REQUIRED must be exactly true; never reuse the Restricted app");

    const workspaceRoots = configuredWorkspaceRoots(env.CODEX_WORKSPACE_ROOTS);
    checks.singleTemporaryWorkspace = workspaceRoots.length === 1 && path.isAbsolute(workspaceRoots[0]!)
      ? check("PASS", "exactly one absolute temporary workspace root is configured")
      : check("BLOCKED_BY_CONFIGURATION", "Full-control acceptance requires exactly one absolute CODEX_WORKSPACE_ROOTS entry");

    const workspace = workspaceRoots.length === 1 ? workspaceRoots[0] : undefined;
    if (workspace) {
      const [topLevel, head, status, remotes] = await Promise.all([
        runner("git", ["-C", workspace, "rev-parse", "--show-toplevel"]),
        runner("git", ["-C", workspace, "rev-parse", "--verify", "HEAD"]),
        runner("git", ["-C", workspace, "status", "--porcelain"]),
        runner("git", ["-C", workspace, "remote"])
      ]);
      const exactRoot = topLevel.ok && path.resolve(topLevel.stdout) === workspace;
      const isolated = exactRoot && head.ok && status.ok && status.stdout.trim() === "" && remotes.ok && remotes.stdout.trim() === "";
      checks.temporaryRepository = isolated
        ? check("PASS", "workspace is a clean initialized Git repository with no remote")
        : check("BLOCKED_BY_CONFIGURATION", "workspace must be the exact root of a clean initialized Git repository with no remote");
    } else {
      checks.temporaryRepository = check("BLOCKED_BY_CONFIGURATION", "temporary repository checks require one workspace root");
    }

    const stateRaw = env.SUPERVISOR_STATE_FILE?.trim();
    const worktreeRaw = env.SUPERVISOR_WORKTREE_ROOT?.trim();
    const stateFile = stateRaw && path.isAbsolute(stateRaw) ? path.resolve(stateRaw) : undefined;
    const worktreeRoot = worktreeRaw && path.isAbsolute(worktreeRaw) ? path.resolve(worktreeRaw) : undefined;
    const stateDirectory = stateFile ? path.dirname(stateFile) : undefined;
    const stateIsolated = Boolean(
      workspace
      && stateFile
      && worktreeRoot
      && !isInside(workspace, stateFile)
      && !isInside(workspace, worktreeRoot)
      && stateDirectory
      && isInside(stateDirectory, worktreeRoot)
      && worktreeRoot !== stateDirectory
    );
    checks.isolatedSupervisorState = stateIsolated
      ? check("PASS", "state and worktrees use an explicit isolated directory outside the temporary repository")
      : check("BLOCKED_BY_CONFIGURATION", "set absolute isolated SUPERVISOR_STATE_FILE and SUPERVISOR_WORKTREE_ROOT outside the temporary repository");
  }

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
    const discovery = await toolProbe(localUrl, tunnelAuthorization, mode, 5_000);
    checks.localToolDiscovery = discovery.ok
      ? check("PASS", discovery.detail)
      : check("BLOCKED_BY_ENVIRONMENT", discovery.detail);
  } else {
    checks.localReadiness = check(
      "BLOCKED_BY_CONFIGURATION",
      "local readiness was not attempted until the loopback URL and authorization are valid"
    );
    checks.localToolDiscovery = check(
      "BLOCKED_BY_CONFIGURATION",
      "local tools/list was not attempted until the loopback URL and authorization are valid"
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
    mode,
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
  const modeIndex = process.argv.indexOf("--mode");
  const rawMode = modeIndex >= 0 ? process.argv[modeIndex + 1] : "restricted";
  if (rawMode !== "restricted" && rawMode !== "full") {
    throw new Error("--mode must be restricted or full");
  }
  const report = await collectSecureTunnelPreflight({ mode: rawMode });
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
