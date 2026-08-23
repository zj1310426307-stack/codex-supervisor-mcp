import path from "node:path";

export interface Config {
  host: string;
  port: number;
  mcpPath: string;
  bearerToken?: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  codexBin: string;
  codexHome?: string;
  workspaceRoots: string[];
  stateFile: string;
  maxEventsPerTask: number;
  maxEventPayloadChars: number;
  maxDiffChars: number;
  requestTimeoutMs: number;
  controlEnabled: boolean;
}

function list(value?: string): string[] {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function roots(value?: string): string[] {
  return (value ?? "")
    .split(";")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => path.resolve(v));
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be a boolean`);
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function loadConfig(): Config {
  const host = process.env.MCP_HOST?.trim() || "127.0.0.1";
  const workspaceRoots = roots(process.env.CODEX_WORKSPACE_ROOTS);
  if (workspaceRoots.length === 0) {
    throw new Error("CODEX_WORKSPACE_ROOTS must contain at least one allowed project root");
  }

  const bearerToken = process.env.MCP_BEARER_TOKEN?.trim() || undefined;
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost" && !bearerToken) {
    throw new Error("MCP_BEARER_TOKEN is required when MCP_HOST is not loopback");
  }

  return {
    host,
    port: int("MCP_PORT", 8787),
    mcpPath: process.env.MCP_PATH?.trim() || "/mcp",
    bearerToken,
    allowedHosts: list(process.env.MCP_ALLOWED_HOSTS),
    allowedOrigins: list(process.env.MCP_ALLOWED_ORIGINS),
    codexBin: process.env.CODEX_BIN?.trim() || "codex",
    codexHome: process.env.CODEX_HOME?.trim() || undefined,
    workspaceRoots,
    stateFile: path.resolve(process.env.SUPERVISOR_STATE_FILE?.trim() || ".codex-supervisor/state.json"),
    maxEventsPerTask: int("SUPERVISOR_MAX_EVENTS_PER_TASK", 500),
    maxEventPayloadChars: int("SUPERVISOR_MAX_EVENT_PAYLOAD_CHARS", 30000),
    maxDiffChars: int("SUPERVISOR_MAX_DIFF_CHARS", 60000),
    requestTimeoutMs: int("SUPERVISOR_REQUEST_TIMEOUT_MS", 30000),
    controlEnabled: bool("MCP_CONTROL_ENABLED", true)
  };
}
