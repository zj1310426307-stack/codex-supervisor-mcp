/** Stable error codes let MCP clients distinguish policy, state and conflict failures. */
export type SupervisorErrorCode =
  | "INVALID_INPUT"
  | "INVALID_CONTRACT"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_STATE_TRANSITION"
  | "ACTIVE_WRITER_CONFLICT"
  | "WORKSPACE_NOT_ALLOWED"
  | "WORKSPACE_NOT_CLEAN"
  | "WORKTREE_INVALID"
  | "PROTOCOL_INCOMPATIBLE"
  | "RUNTIME_UNAVAILABLE"
  | "VERIFICATION_CONFIG_INVALID"
  | "VERIFICATION_NOT_ALLOWED"
  | "LEASE_CONFLICT"
  | "LOCK_CONFLICT"
  | "QUARANTINED"
  | "NOT_FOUND"
  | "INTERNAL_ERROR";

/** Error carrying a machine-readable code and an HTTP-compatible status. */
export class SupervisorError extends Error {
  readonly name = "SupervisorError";

  constructor(
    readonly code: SupervisorErrorCode,
    message: string,
    readonly statusCode = 400,
    readonly details?: Record<string, unknown>,
    options?: ErrorOptions
  ) {
    super(message, options);
  }

  /** Return a redaction-friendly structured representation for transport and audit. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      statusCode: this.statusCode,
      message: this.message,
      ...(this.details ? { details: this.details } : {})
    };
  }
}

/** Normalize unknown failures without discarding an existing SupervisorError. */
export function asSupervisorError(error: unknown): SupervisorError {
  if (error instanceof SupervisorError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new SupervisorError("INTERNAL_ERROR", message, 500, undefined, {
    cause: error
  });
}
