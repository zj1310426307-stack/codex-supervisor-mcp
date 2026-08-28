import { createHash } from "node:crypto";
import * as z from "zod/v4";

export const TOOL_SURFACE_VERSION = "0.3.0" as const;

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const;

export const CONTROL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
} as const;

export const DESTRUCTIVE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false
} as const;

export type ToolAnnotations =
  | typeof READ_ONLY_ANNOTATIONS
  | typeof CONTROL_ANNOTATIONS
  | typeof DESTRUCTIVE_ANNOTATIONS;

const taskId = z.string().min(1).max(200).describe("Supervisor task identifier");
const toolSurfaceVersion = z.literal(TOOL_SURFACE_VERSION).optional();
const boundedText = z.string().min(1).max(100_000);
const metadataKey = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !["__proto__", "prototype", "constructor"].includes(value), "reserved metadata key");
const relativePath = z
  .string()
  .min(1)
  .max(1_024)
  .regex(/^(?!(?:[A-Za-z]:[\\/]|[\\/]{1,2}))(?!.*(?:^|[\\/])\.\.(?:[\\/]|$)).+$/, "must be repository-relative")
  .refine(
    (value) => !value.split(/[\\/]+/).includes(".."),
    "must not contain parent-directory traversal"
  )
  .refine(
    (value) => {
      const portable = value.replace(/\\/g, "/");
      const withoutTrailingDirectoryGlob = portable.endsWith("/**") ? portable.slice(0, -3) : portable;
      return !/[*?\[\]]/.test(withoutTrailingDirectoryGlob) && (!portable.includes("*") || portable.endsWith("/**"));
    },
    "supports only plain paths or a trailing /** directory prefix"
  );

export const acceptanceCriterionSchema = z
  .object({
    id: z.string().min(1).max(100),
    description: z.string().min(1).max(10_000),
    evidence: z.string().min(1).max(10_000).optional()
  })
  .strict();

export const developmentContractSchema = z
  .object({
    contractVersion: z.literal("1.0"),
    clientRequestId: z.string().min(1).max(200),
    title: z.string().min(1).max(500).optional(),
    objective: boundedText,
    plan: z.array(z.string().min(1).max(10_000)).max(200),
    scope: z
      .object({
        in: z.array(z.string().min(1).max(10_000)).min(1).max(200),
        out: z.array(z.string().min(1).max(10_000)).max(200).default([])
      })
      .strict(),
    constraints: z.array(z.string().min(1).max(10_000)).max(200).default([]),
    acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1).max(200),
    requiredVerificationRecipes: z.array(z.string().min(1).max(200)).max(100).default([]),
    allowedChangePaths: z.array(relativePath).max(500).optional(),
    forbiddenChangePaths: z.array(relativePath).max(500).optional(),
    maxCorrectionPasses: z.number().int().min(0).max(5).default(3),
    metadata: z
      .record(metadataKey, z.string().min(1).max(10_000))
      .refine((value) => Object.keys(value).length <= 200, "metadata must contain at most 200 entries")
      .optional()
  })
  .strict();

const structuredTaskStartSchema = z
  .object({
    workspace: z.string().min(1).max(4_096),
    contract: developmentContractSchema,
    toolSurfaceVersion
  })
  .strict();

const legacyTaskStartSchema = z
  .object({
    workspace: z.string().min(1).max(4_096),
    objective: boundedText,
    plan: z.array(z.string().min(1).max(10_000)).min(1).max(200),
    acceptanceCriteria: z.array(z.string().min(1).max(10_000)).min(1).max(200),
    constraints: z.array(z.string().min(1).max(10_000)).max(200).optional(),
    clientRequestId: z.string().min(1).max(200),
    verificationProfile: z.string().min(1).max(200).optional(),
    toolSurfaceVersion
  })
  .strict();

/**
 * The strict union is the runtime source for the structured-vs-legacy XOR.
 * Manifest generation renders its root alternatives as JSON Schema `oneOf`.
 */
export const taskStartSchema = z.union([structuredTaskStartSchema, legacyTaskStartSchema]);

export const verifierReconcileSchema = z
  .object({
    runId: z.string().uuid(),
    taskId: taskId.optional(),
    toolSurfaceVersion
  })
  .strict();

export const criterionConfirmationSchema = z
  .object({
    criterionId: z.string().min(1).max(100),
    evidence: z.string().min(1).max(10_000)
  })
  .strict();

const taskDecisionCommon = {
  taskId,
  rationale: boundedText,
  acceptedRisks: z.array(z.string().min(1).max(10_000)).max(100).optional(),
  toolSurfaceVersion
} as const;

const acceptTaskDecisionSchema = z
  .object({
    ...taskDecisionCommon,
    decision: z.literal("accept"),
    expectedSnapshotId: z
      .string()
      .regex(/^[a-f0-9]{64}$/, "must be a lowercase SHA-256 snapshot identifier"),
    criterionConfirmations: z.array(criterionConfirmationSchema).min(1).max(200)
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.criterionConfirmations.map((confirmation) => confirmation.criterionId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["criterionConfirmations"],
        message: "criterionConfirmations must not contain duplicate criterionId values"
      });
    }
  });

const nonAcceptTaskDecisionSchema = z
  .object({
    ...taskDecisionCommon,
    decision: z.enum(["request_changes", "block", "cancel"]),
    instruction: boundedText.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decision === "request_changes" && !value.instruction) {
      context.addIssue({
        code: "custom",
        path: ["instruction"],
        message: "instruction is required for request_changes"
      });
    }
  });

/** Acceptance is an explicit snapshot-bound branch; other decisions cannot carry acceptance evidence. */
export const taskDecisionSchema = z.union([acceptTaskDecisionSchema, nonAcceptTaskDecisionSchema]);

export interface ToolDefinition {
  name: string;
  description: string;
  annotations: ToolAnnotations;
  inputSchema: z.ZodType;
  restricted: boolean;
}

const empty = () => z.object({}).strict();

/**
 * This is the single registration and manifest source.  Do not maintain a
 * second hand-written name list in the server or export script.
 */
export const SUPERVISOR_TOOLS: readonly ToolDefinition[] = [
  {
    name: "codex_health",
    description: "Read Supervisor, Codex App Server, and frozen tool-surface health without starting a turn.",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: empty(),
    restricted: true
  },
  {
    name: "codex_task_list",
    description: "List bounded summaries of tasks known to the Supervisor.",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: empty(),
    restricted: true
  },
  {
    name: "codex_task_status",
    description: "Read the current Supervisor state for one Codex implementation task.",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: z.object({ taskId }).strict(),
    restricted: true
  },
  {
    name: "codex_task_events",
    description: "Read bounded task-ledger events after a sequence number.",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: z
      .object({ taskId, afterSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0) })
      .strict(),
    restricted: true
  },
  {
    name: "codex_task_wait",
    description: "Long-poll for a bounded task state or event change without mutating it.",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: z
      .object({
        taskId,
        afterSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
        timeoutMs: z.number().int().min(1).max(25_000).default(20_000)
      })
      .strict(),
    restricted: true
  },
  {
    name: "codex_pending_approvals",
    description: "Read redacted pending approval summaries; this never resolves an approval.",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: z.object({ taskId: taskId.optional() }).strict(),
    restricted: true
  },
  {
    name: "codex_workspace_status",
    description: "Read bounded Git status evidence from the task's isolated worktree.",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: z.object({ taskId }).strict(),
    restricted: true
  },
  {
    name: "codex_workspace_diff",
    description: "Read a bounded Git diff from the task's isolated worktree.",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: z.object({ taskId }).strict(),
    restricted: true
  },
  {
    name: "codex_task_contract",
    description: "Read the immutable normalized Development Contract for a supervised task.",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: z.object({ taskId }).strict(),
    restricted: true
  },
  {
    name: "codex_task_evidence",
    description: "Read redacted contract, snapshot, verification, and decision evidence for human review.",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: z.object({ taskId }).strict(),
    restricted: true
  },
  {
    name: "codex_verification_profiles",
    description: "List trusted Supervisor-side verification profile metadata; no command input is accepted.",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: empty(),
    restricted: true
  },
  {
    name: "codex_runtime_capabilities",
    description: "Read stable Codex runtime and protocol capabilities without starting work or verification.",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: empty(),
    restricted: true
  },
  {
    name: "codex_verifier_status",
    description: "Read redacted owned verifier lease and scoped quarantine status.",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: z.object({ taskId: taskId.optional(), runId: z.string().uuid().optional() }).strict(),
    restricted: true
  },
  {
    name: "codex_task_start",
    description: "Create an isolated task from a structured contract or the strict legacy compatibility form; Codex implements it.",
    annotations: DESTRUCTIVE_ANNOTATIONS,
    inputSchema: taskStartSchema,
    restricted: false
  },
  {
    name: "codex_task_continue",
    description: "Start a supervised follow-up Codex turn on the persisted task thread.",
    annotations: DESTRUCTIVE_ANNOTATIONS,
    inputSchema: z.object({ taskId, instruction: boundedText, toolSurfaceVersion }).strict(),
    restricted: false
  },
  {
    name: "codex_task_steer",
    description: "Steer the currently owned Codex turn using its exact expected turn identifier.",
    annotations: DESTRUCTIVE_ANNOTATIONS,
    inputSchema: z.object({ taskId, instruction: boundedText, toolSurfaceVersion }).strict(),
    restricted: false
  },
  {
    name: "codex_task_interrupt",
    description: "Interrupt the active owned Codex turn and wait for terminal protocol evidence.",
    annotations: DESTRUCTIVE_ANNOTATIONS,
    inputSchema: z.object({ taskId, toolSurfaceVersion }).strict(),
    restricted: false
  },
  {
    name: "codex_approval_decide",
    description: "Resolve an exact pending approval under Supervisor policy; accepting may authorize workspace changes.",
    annotations: DESTRUCTIVE_ANNOTATIONS,
    inputSchema: z
      .object({
        taskId: taskId.optional(),
        approvalId: z.string().uuid(),
        decision: z.enum(["accept", "decline", "cancel"]),
        toolSurfaceVersion
      })
      .strict(),
    restricted: false
  },
  {
    name: "codex_task_recover",
    description: "Reconcile a stale task with its isolated worktree and Codex thread without starting a new turn.",
    annotations: CONTROL_ANNOTATIONS,
    inputSchema: z.object({ taskId, toolSurfaceVersion }).strict(),
    restricted: false
  },
  {
    name: "codex_task_verify",
    description: "Run one trusted Supervisor verification profile in the independent verifier worker.",
    annotations: DESTRUCTIVE_ANNOTATIONS,
    inputSchema: z
      .object({ taskId, profileId: z.string().min(1).max(200), toolSurfaceVersion })
      .strict(),
    restricted: false
  },
  {
    name: "codex_task_decide",
    description: "Record accept, request-changes, block, or cancel; cancel can interrupt active work.",
    annotations: DESTRUCTIVE_ANNOTATIONS,
    inputSchema: taskDecisionSchema,
    restricted: false
  },
  {
    name: "codex_task_cleanup",
    description: "Remove only a clean terminal task worktree; never removes the source repository or branch.",
    annotations: DESTRUCTIVE_ANNOTATIONS,
    inputSchema: z.object({ taskId, toolSurfaceVersion }).strict(),
    restricted: false
  },
  {
    name: "codex_verifier_reconcile",
    description: "Reconcile one exact owned verifier run; only proven termination can clear its scoped quarantine.",
    annotations: DESTRUCTIVE_ANNOTATIONS,
    inputSchema: verifierReconcileSchema,
    restricted: false
  }
] as const;

export type JsonSchema = Record<string, unknown>;

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortValue(child)])
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function inputJsonSchema(tool: ToolDefinition): JsonSchema {
  const converted = z.toJSONSchema(tool.inputSchema, {
    target: "draft-7",
    io: "input",
    reused: "inline",
    unrepresentable: "any"
  }) as JsonSchema;

  // Zod's strict union is an XOR at runtime.  Freeze that same contract as an
  // explicit oneOf for MCP scanners and compatibility hashing.
  if (["codex_task_start", "codex_task_decide"].includes(tool.name) && Array.isArray(converted.anyOf)) {
    converted.oneOf = converted.anyOf;
    delete converted.anyOf;
  }
  return sortValue(converted) as JsonSchema;
}

export interface ToolManifest {
  serverName: "codex-supervisor-mcp";
  serverVersion: typeof TOOL_SURFACE_VERSION;
  toolSurfaceVersion: typeof TOOL_SURFACE_VERSION;
  mode: "restricted" | "full";
  toolCount: number;
  toolSchemaHash: string;
  tools: Array<{
    name: string;
    description: string;
    annotations: ToolAnnotations;
    inputSchema: JsonSchema;
  }>;
}

export function createToolManifest(mode: "restricted" | "full"): ToolManifest {
  const tools = SUPERVISOR_TOOLS.filter((tool) => mode === "full" || tool.restricted).map((tool) => ({
    name: tool.name,
    description: tool.description,
    annotations: tool.annotations,
    inputSchema: inputJsonSchema(tool)
  }));
  const toolSchemaHash = createHash("sha256").update(canonicalJson(tools)).digest("hex");
  return {
    serverName: "codex-supervisor-mcp",
    serverVersion: TOOL_SURFACE_VERSION,
    toolSurfaceVersion: TOOL_SURFACE_VERSION,
    mode,
    toolCount: tools.length,
    toolSchemaHash,
    tools
  };
}

export interface CombinedToolManifest {
  serverName: "codex-supervisor-mcp";
  serverVersion: typeof TOOL_SURFACE_VERSION;
  toolSurfaceVersion: typeof TOOL_SURFACE_VERSION;
  restricted: ToolManifest;
  full: ToolManifest;
}

export function createCombinedToolManifest(): CombinedToolManifest {
  return {
    serverName: "codex-supervisor-mcp",
    serverVersion: TOOL_SURFACE_VERSION,
    toolSurfaceVersion: TOOL_SURFACE_VERSION,
    restricted: createToolManifest("restricted"),
    full: createToolManifest("full")
  };
}

export function toolSurfaceMetadata(controlEnabled: boolean): {
  toolSurfaceVersion: string;
  toolSchemaHash: string;
  toolCount: number;
  mode: "restricted" | "full";
} {
  const manifest = createToolManifest(controlEnabled ? "full" : "restricted");
  return {
    toolSurfaceVersion: manifest.toolSurfaceVersion,
    toolSchemaHash: manifest.toolSchemaHash,
    toolCount: manifest.toolCount,
    mode: manifest.mode
  };
}
