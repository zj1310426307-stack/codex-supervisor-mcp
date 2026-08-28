import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { redact, redactAndTruncate } from "../core/redaction.js";
import type { CriterionConfirmationInput, SupervisorFacade } from "./facade.js";
import {
  SUPERVISOR_TOOLS,
  TOOL_SURFACE_VERSION,
  inputJsonSchema,
  toolSurfaceMetadata,
  type ToolDefinition
} from "./tool-catalog.js";

const MAX_RESULT_CHARS = 100_000;

function structured(value: unknown): Record<string, unknown> {
  const safe = redact(value);
  if (safe && typeof safe === "object" && !Array.isArray(safe)) return safe as Record<string, unknown>;
  return { value: safe };
}

function boundedResultPayload(value: unknown): Record<string, unknown> {
  const payload = structured(value);
  const serialized = JSON.stringify(payload, null, 2);
  if (serialized.length <= MAX_RESULT_CHARS) return payload;
  return {
    truncated: true,
    originalChars: serialized.length,
    preview: redactAndTruncate(serialized, MAX_RESULT_CHARS).text
  };
}

export function mcpSuccessResult(value: unknown) {
  const boundedPayload = boundedResultPayload(value);
  const bounded = JSON.stringify(boundedPayload, null, 2);
  return {
    content: [{ type: "text" as const, text: bounded }],
    structuredContent: boundedPayload
  };
}

export function mcpErrorResult(error: unknown) {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
  const code = typeof record?.code === "string" ? record.code : "SUPERVISOR_OPERATION_FAILED";
  const message = error instanceof Error ? error.message : String(error);
  const payload = boundedResultPayload({ ok: false, error: { code, message } });
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload
  };
}

type ToolHandler = (input: Record<string, unknown>) => Promise<unknown> | unknown;

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { runtime: value };
}

function handlers(facade: SupervisorFacade): Record<string, ToolHandler> {
  return {
    codex_health: async () => ({
      ...asObject(await facade.health()),
      ...toolSurfaceMetadata(facade.controlEnabled())
    }),
    codex_task_list: () => ({ tasks: facade.listTaskSummaries() }),
    codex_task_status: ({ taskId }) => facade.getTaskSummary(String(taskId)),
    codex_task_events: ({ taskId, afterSeq }) => ({
      events: facade.getEvents(String(taskId), Number(afterSeq))
    }),
    codex_task_wait: async ({ taskId, afterSeq, timeoutMs }) => {
      await facade.waitForChange(String(taskId), Number(afterSeq), Number(timeoutMs));
      return {
        task: facade.getTaskSummary(String(taskId)),
        events: facade.getEvents(String(taskId), Number(afterSeq))
      };
    },
    codex_pending_approvals: ({ taskId }) => ({
      approvals: facade.listApprovals(typeof taskId === "string" ? taskId : undefined)
    }),
    codex_workspace_status: async ({ taskId }) => ({
      status: await facade.getWorkspaceStatus(String(taskId))
    }),
    codex_workspace_diff: ({ taskId }) => facade.getWorkspaceDiff(String(taskId)),
    codex_task_contract: ({ taskId }) => facade.getTaskContract(String(taskId)),
    codex_task_evidence: ({ taskId }) => facade.getTaskEvidence(String(taskId)),
    codex_verification_profiles: () => facade.listVerificationProfiles(),
    codex_runtime_capabilities: () => facade.getRuntimeCapabilities(),
    codex_verifier_status: ({ taskId, runId }) =>
      facade.getVerifierStatus({
        taskId: typeof taskId === "string" ? taskId : undefined,
        runId: typeof runId === "string" ? runId : undefined
      }),
    codex_task_start: (input) => facade.startTask(input),
    codex_task_continue: ({ taskId, instruction, toolSurfaceVersion }) =>
      facade.continueTask({
        taskId: String(taskId),
        instruction: String(instruction),
        toolSurfaceVersion: typeof toolSurfaceVersion === "string" ? toolSurfaceVersion : undefined
      }),
    codex_task_steer: ({ taskId, instruction }) =>
      facade.steerTask(String(taskId), String(instruction)),
    codex_task_interrupt: ({ taskId }) => facade.interruptTask(String(taskId)),
    codex_approval_decide: ({ taskId, approvalId, decision }) =>
      facade.decideApproval(
        String(approvalId),
        decision as "accept" | "decline" | "cancel",
        typeof taskId === "string" ? taskId : undefined
      ),
    codex_task_recover: ({ taskId, toolSurfaceVersion }) =>
      facade.recoverTask({
        taskId: String(taskId),
        toolSurfaceVersion: typeof toolSurfaceVersion === "string" ? toolSurfaceVersion : undefined
      }),
    codex_task_verify: ({ taskId, profileId, toolSurfaceVersion }) =>
      facade.verifyTask({
        taskId: String(taskId),
        profileId: String(profileId),
        toolSurfaceVersion: typeof toolSurfaceVersion === "string" ? toolSurfaceVersion : undefined
      }),
    codex_task_decide: (input) => {
      const common = {
        taskId: String(input.taskId),
        rationale: String(input.rationale),
        acceptedRisks: Array.isArray(input.acceptedRisks) ? input.acceptedRisks.map(String) : undefined,
        toolSurfaceVersion: typeof input.toolSurfaceVersion === "string" ? input.toolSurfaceVersion : undefined
      };
      if (input.decision === "accept") {
        const criterionConfirmations = (input.criterionConfirmations as Array<Record<string, unknown>>).map(
          (confirmation): CriterionConfirmationInput => ({
            criterionId: String(confirmation.criterionId),
            evidence: String(confirmation.evidence)
          })
        );
        return facade.decideTask({
          ...common,
          decision: "accept",
          expectedSnapshotId: String(input.expectedSnapshotId),
          criterionConfirmations
        });
      }
      return facade.decideTask({
        ...common,
        decision: input.decision as "request_changes" | "block" | "cancel",
        instruction: typeof input.instruction === "string" ? input.instruction : undefined
      });
    },
    codex_task_cleanup: ({ taskId, toolSurfaceVersion }) =>
      facade.cleanupTask({
        taskId: String(taskId),
        toolSurfaceVersion: typeof toolSurfaceVersion === "string" ? toolSurfaceVersion : undefined
      }),
    codex_verifier_reconcile: ({ runId, taskId, toolSurfaceVersion }) =>
      facade.reconcileVerifier({
        runId: String(runId),
        taskId: typeof taskId === "string" ? taskId : undefined,
        toolSurfaceVersion: typeof toolSurfaceVersion === "string" ? toolSurfaceVersion : undefined
      })
  };
}

export function registeredToolDefinitions(controlEnabled: boolean): readonly ToolDefinition[] {
  return SUPERVISOR_TOOLS.filter((tool) => controlEnabled || tool.restricted);
}

export function createSupervisorMcp(facade: SupervisorFacade): McpServer {
  const server = new McpServer(
    { name: "codex-supervisor-mcp", version: TOOL_SURFACE_VERSION },
    {
      instructions:
        "ChatGPT is the Supervisor and Codex is the implementation agent. Define and review a Development Contract, use isolated tasks, require snapshot-bound verification before acceptance, and leave commit, push, merge, release, and deployment to a human."
    }
  );

  const byName = handlers(facade);
  for (const tool of registeredToolDefinitions(facade.controlEnabled())) {
    const handler = byName[tool.name];
    if (!handler) throw new Error(`Missing MCP handler for ${tool.name}`);

    // Registration and manifest export share this exact Zod source. Parsing
    // again preserves strict/default/refinement semantics even for clients
    // that omit their own preflight validation.
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        annotations: tool.annotations,
        // Freeze the exact schema advertised by tools/list. The Standard
        // Schema wrapper also performs JSON-Schema preflight validation; the
        // Zod parse below remains the authoritative runtime validation layer.
        inputSchema: fromJsonSchema(inputJsonSchema(tool))
      },
      async (rawInput) => {
        try {
          const input = tool.inputSchema.parse(rawInput ?? {}) as Record<string, unknown>;
          return mcpSuccessResult(await handler(input));
        } catch (error) {
          return mcpErrorResult(error);
        }
      }
    );
  }

  return server;
}
