import path from "node:path";
import { resolveCodexCommand, type CodexCommandSource } from "./codex/command-resolution.js";

export interface Config {
  host: string;
  port: number;
  mcpPath: string;
  bearerToken?: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  codexBin: string;
  codexBinSource: CodexCommandSource;
  codexHome?: string;
  codexModel?: string;
  codexExperimentalApi: boolean;
  codexReadRetries: number;
  codexRetryBaseDelayMs: number;
  codexRetryMaxDelayMs: number;
  codexShutdownTimeoutMs: number;
  workspaceRoots: string[];
  stateFile: string;
  worktreeRoot: string;
  verificationConfigFile: string;
  turnLeaseTtlMs: number;
  turnWarnIdleMs: number;
  turnSuspectIdleMs: number;
  turnHardDeadlineMs: number;
  verifierLeaseTtlMs: number;
  maxVerificationOutputChars: number;
  maxEventsPerTask: number;
  maxEventPayloadChars: number;
  maxDiffChars: number;
  requestTimeoutMs: number;
  maxBodyBytes: number;
  rateLimitMaxRequests: number;
  rateLimitWindowMs: number;
  headersTimeoutMs: number;
  httpRequestTimeoutMs: number;
  readinessTimeoutMs: number;
  controlEnabled: boolean;
}

function list(value?: string): string[] {
  return [...new Set((value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean))];
}

function roots(value?: string): string[] {
  return [...new Set((value ?? "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item)))];
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be a boolean`);
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, allowZero = false): number {
  const raw = env[name];
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return parsed;
}

function boundedInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum: number,
  allowZero = false
): number {
  const parsed = int(env, name, fallback, allowZero);
  if (parsed > maximum) throw new Error(`${name} must be at most ${maximum}`);
  return parsed;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const parts = normalized.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d+$/.test(part) && Number(part) <= 255);
}

function validateMcpPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("?") || value.includes("#")) {
    throw new Error("MCP_PATH must be a single absolute URL path without query or fragment");
  }
  if (value === "/healthz" || value === "/readyz") throw new Error("MCP_PATH conflicts with a health endpoint");
  return value;
}

const PLACEHOLDER_BEARER_TOKENS = new Set([
  "changeme",
  "replace-me",
  "replace-with-a-long-random-secret",
  "example",
  "example-token",
  "test-token",
  "default",
  "password"
]);

export function isPlaceholderBearerToken(value: string): boolean {
  return PLACEHOLDER_BEARER_TOKENS.has(value.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.MCP_HOST?.trim() || "127.0.0.1";
  const workspaceRoots = roots(env.CODEX_WORKSPACE_ROOTS);
  if (workspaceRoots.length === 0) {
    throw new Error("CODEX_WORKSPACE_ROOTS must contain at least one allowed project root");
  }

  const bearerToken = env.MCP_BEARER_TOKEN?.trim() || undefined;
  const configuredHosts = list(env.MCP_ALLOWED_HOSTS).map((value) => value.toLowerCase());
  const allowedHosts = configuredHosts.length > 0
    ? configuredHosts
    : (isLoopbackHost(host) ? [...new Set([host.toLowerCase(), "localhost", "127.0.0.1", "::1"])] : []);
  const allowedOrigins = list(env.MCP_ALLOWED_ORIGINS);
  if (!isLoopbackHost(host)) {
    if (!bearerToken) throw new Error("MCP_BEARER_TOKEN is required when MCP_HOST is not loopback");
    if (allowedHosts.length === 0) throw new Error("MCP_ALLOWED_HOSTS is required when MCP_HOST is not loopback");
    if (allowedOrigins.length === 0) throw new Error("MCP_ALLOWED_ORIGINS is required when MCP_HOST is not loopback");
  }
  if (bearerToken && Buffer.byteLength(bearerToken, "utf8") < 32) {
    throw new Error("MCP_BEARER_TOKEN must contain at least 32 bytes");
  }
  if (bearerToken && isPlaceholderBearerToken(bearerToken)) {
    throw new Error("MCP_BEARER_TOKEN must not use an obvious placeholder value");
  }

  const codex = resolveCodexCommand({ configured: env.CODEX_BIN, env });
  const stateFile = path.resolve(env.SUPERVISOR_STATE_FILE?.trim() || ".codex-supervisor/state.json");
  const turnWarnIdleMs = int(env, "SUPERVISOR_TURN_WARN_IDLE_MS", 60_000);
  const turnSuspectIdleMs = int(env, "SUPERVISOR_TURN_SUSPECT_IDLE_MS", 180_000);
  const turnHardDeadlineMs = int(env, "SUPERVISOR_TURN_HARD_DEADLINE_MS", 3_600_000);
  if (!(turnWarnIdleMs < turnSuspectIdleMs && turnSuspectIdleMs < turnHardDeadlineMs)) {
    throw new Error("Turn watchdog thresholds must satisfy WARN < SUSPECT < HARD_DEADLINE");
  }
  return {
    host,
    port: boundedInt(env, "MCP_PORT", 8787, 65_535),
    mcpPath: validateMcpPath(env.MCP_PATH?.trim() || "/mcp"),
    bearerToken,
    allowedHosts,
    allowedOrigins,
    codexBin: codex.command,
    codexBinSource: codex.source,
    codexHome: env.CODEX_HOME?.trim() || undefined,
    codexModel: env.CODEX_MODEL?.trim() || undefined,
    codexExperimentalApi: bool(env, "CODEX_EXPERIMENTAL_API", false),
    codexReadRetries: int(env, "CODEX_READ_RETRIES", 2, true),
    codexRetryBaseDelayMs: int(env, "CODEX_RETRY_BASE_DELAY_MS", 50),
    codexRetryMaxDelayMs: int(env, "CODEX_RETRY_MAX_DELAY_MS", 1_000),
    codexShutdownTimeoutMs: int(env, "CODEX_SHUTDOWN_TIMEOUT_MS", 5_000),
    workspaceRoots,
    stateFile,
    worktreeRoot: path.resolve(env.SUPERVISOR_WORKTREE_ROOT?.trim() || path.join(path.dirname(stateFile), "worktrees")),
    verificationConfigFile: path.resolve(
      env.SUPERVISOR_VERIFICATION_CONFIG?.trim() || "config/verification.example.json"
    ),
    turnLeaseTtlMs: int(env, "SUPERVISOR_TURN_LEASE_TTL_MS", 30_000),
    turnWarnIdleMs,
    turnSuspectIdleMs,
    turnHardDeadlineMs,
    verifierLeaseTtlMs: int(env, "SUPERVISOR_VERIFIER_LEASE_TTL_MS", 20_000),
    maxVerificationOutputChars: int(env, "SUPERVISOR_MAX_VERIFICATION_OUTPUT_CHARS", 50_000),
    maxEventsPerTask: int(env, "SUPERVISOR_MAX_EVENTS_PER_TASK", 500),
    maxEventPayloadChars: int(env, "SUPERVISOR_MAX_EVENT_PAYLOAD_CHARS", 30_000),
    maxDiffChars: int(env, "SUPERVISOR_MAX_DIFF_CHARS", 60_000),
    requestTimeoutMs: int(env, "SUPERVISOR_REQUEST_TIMEOUT_MS", 30_000),
    maxBodyBytes: int(env, "MCP_MAX_BODY_BYTES", 1024 * 1024),
    rateLimitMaxRequests: int(env, "MCP_RATE_LIMIT_MAX_REQUESTS", 120),
    rateLimitWindowMs: int(env, "MCP_RATE_LIMIT_WINDOW_MS", 60_000),
    headersTimeoutMs: int(env, "MCP_HEADERS_TIMEOUT_MS", 10_000),
    httpRequestTimeoutMs: int(env, "MCP_REQUEST_TIMEOUT_MS", 30_000),
    readinessTimeoutMs: int(env, "MCP_READINESS_TIMEOUT_MS", 3_000),
    controlEnabled: bool(env, "MCP_CONTROL_ENABLED", false)
  };
}
