export const CODEX_APP_SERVER_CLIENT_INFO = Object.freeze({
  name: "codex_supervisor_mcp",
  title: "Codex Supervisor MCP",
  version: "0.4.0"
});

/** Stable App Server wire values applied to Supervisor-owned Codex threads. */
export const CODEX_SUPERVISOR_THREAD_OPTIONS = Object.freeze({
  approvalPolicy: "untrusted",
  sandbox: "workspace-write",
  approvalsReviewer: "user"
} as const);

/** Methods which are safe to repeat after an overload or transport timeout. */
export const READ_ONLY_CODEX_METHODS = new Set([
  "account/read",
  "collaborationMode/list",
  "config/read",
  "experimentalFeature/list",
  "hooks/list",
  "model/list",
  "modelProvider/capabilities/read",
  "permissionProfile/list",
  "skills/list",
  "thread/goal/get",
  "thread/items/list",
  "thread/list",
  "thread/loaded/list",
  "thread/read",
  "thread/turns/list"
]);

/** Experimental methods known to the supervisor. Unknown methods remain callable. */
export const EXPERIMENTAL_CODEX_METHODS = new Set([
  "collaborationMode/list",
  "environment/info",
  "process/kill",
  "process/resizePty",
  "process/spawn",
  "process/writeStdin",
  "thread/backgroundTerminals/clean",
  "thread/backgroundTerminals/list",
  "thread/backgroundTerminals/terminate",
  "thread/items/list",
  "thread/turns/list"
]);

export const REQUIRED_STABLE_CLIENT_METHODS = Object.freeze([
  "initialize",
  "initialized",
  "account/read",
  "thread/start",
  "thread/resume",
  "thread/read",
  "turn/start",
  "turn/steer",
  "turn/interrupt"
] as const);

/** Server-to-client messages required by the supervision and approval loop. */
export const REQUIRED_STABLE_SERVER_METHODS = Object.freeze([
  "turn/started",
  "turn/completed",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval"
] as const);

export const RETRYABLE_CODEX_ERROR_CODES = new Set([-32001]);

export function isReadOnlyCodexMethod(method: string): boolean {
  return READ_ONLY_CODEX_METHODS.has(method);
}

export function assertExperimentalMethodAllowed(method: string, experimentalApi: boolean): void {
  if (!experimentalApi && EXPERIMENTAL_CODEX_METHODS.has(method)) {
    throw new Error(`${method} requires explicit experimentalApi capability`);
  }
}
