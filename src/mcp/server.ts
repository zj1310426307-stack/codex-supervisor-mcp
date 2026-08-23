import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { Orchestrator } from "../core/orchestrator.js";

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const;

const CONTROL = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
} as const;

const INTERRUPT = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false
} as const;

export function createSupervisorMcp(orchestrator: Orchestrator): McpServer {
  const server = new McpServer(
    { name: "codex-supervisor-mcp", version: "0.1.0" },
    {
      instructions:
        "You are the supervisor. Think, define scope/plan/acceptance criteria, delegate implementation to Codex, observe progress, review diffs, and steer only when evidence shows drift. Codex owns code execution and edits."
    }
  );

  // Read-only supervision surface. These remain available when
  // MCP_CONTROL_ENABLED=false so restricted clients can inspect state safely.
  server.registerTool(
    "codex_health",
    {
      description: "Check whether the local Codex app-server is reachable and authenticated.",
      annotations: READ_ONLY
    },
    async () => result(await orchestrator.health())
  );

  server.registerTool(
    "codex_task_list",
    { description: "List known supervisor tasks, newest first.", annotations: READ_ONLY },
    async () => result({ tasks: orchestrator.listTaskSummaries() })
  );

  server.registerTool(
    "codex_task_status",
    {
      description: "Read the current status and latest summary for one Codex task.",
      annotations: READ_ONLY,
      inputSchema: z.object({ taskId: z.string().uuid() })
    },
    async ({ taskId }) => result(orchestrator.getTaskSummary(taskId))
  );

  server.registerTool(
    "codex_task_events",
    {
      description: "Read Codex events recorded for a task after a sequence number.",
      annotations: READ_ONLY,
      inputSchema: z.object({
        taskId: z.string().uuid(),
        afterSeq: z.number().int().min(0).default(0)
      })
    },
    async ({ taskId, afterSeq }) => result({ events: orchestrator.getEvents(taskId, afterSeq) })
  );

  server.registerTool(
    "codex_task_wait",
    {
      description: "Long-poll for a task state/event change for up to 25 seconds.",
      annotations: READ_ONLY,
      inputSchema: z.object({
        taskId: z.string().uuid(),
        afterSeq: z.number().int().min(0).default(0),
        timeoutMs: z.number().int().min(1).max(25000).default(20000)
      })
    },
    async ({ taskId, afterSeq, timeoutMs }) => {
      await orchestrator.waitForChange(taskId, afterSeq, timeoutMs);
      return result({
        task: orchestrator.getTaskSummary(taskId),
        events: orchestrator.getEvents(taskId, afterSeq)
      });
    }
  );

  server.registerTool(
    "codex_pending_approvals",
    {
      description: "List command/file-change approvals currently waiting on the supervisor.",
      annotations: READ_ONLY,
      inputSchema: z.object({ taskId: z.string().uuid().optional() })
    },
    async ({ taskId }) => result({ approvals: orchestrator.listApprovals(taskId) })
  );

  server.registerTool(
    "codex_workspace_status",
    {
      description: "Read-only git status for the workspace associated with a task.",
      annotations: READ_ONLY,
      inputSchema: z.object({ taskId: z.string().uuid() })
    },
    async ({ taskId }) => result({ status: await orchestrator.getWorkspaceStatus(taskId) })
  );

  server.registerTool(
    "codex_workspace_diff",
    {
      description: "Read-only git diff for the workspace associated with a task.",
      annotations: READ_ONLY,
      inputSchema: z.object({ taskId: z.string().uuid() })
    },
    async ({ taskId }) => result(await orchestrator.getWorkspaceDiff(taskId))
  );

  if (!orchestrator.controlEnabled()) return server;

  // Write/control surface. Full MCP clients can use these to make Codex work.
  server.registerTool(
    "codex_task_start",
    {
      description:
        "Delegate a new implementation task to Codex. Provide an objective and preferably a plan, acceptance criteria, and constraints.",
      annotations: CONTROL,
      inputSchema: z.object({
        workspace: z.string().min(1).describe("Absolute path to an allowed git workspace"),
        objective: z.string().min(1),
        plan: z.array(z.string()).optional(),
        acceptanceCriteria: z.array(z.string()).optional(),
        constraints: z.array(z.string()).optional()
      })
    },
    async (input) => result(await orchestrator.startTask(input))
  );

  server.registerTool(
    "codex_task_steer",
    {
      description: "Steer the active Codex turn when the implementation is drifting.",
      annotations: CONTROL,
      inputSchema: z.object({ taskId: z.string().uuid(), instruction: z.string().min(1) })
    },
    async ({ taskId, instruction }) => result(await orchestrator.steerTask(taskId, instruction))
  );

  server.registerTool(
    "codex_task_interrupt",
    {
      description: "Interrupt the active Codex turn before more work is performed.",
      annotations: INTERRUPT,
      inputSchema: z.object({ taskId: z.string().uuid() })
    },
    async ({ taskId }) => result(await orchestrator.interruptTask(taskId))
  );

  server.registerTool(
    "codex_task_continue",
    {
      description: "Start a supervised follow-up Codex turn on the same persisted thread.",
      annotations: CONTROL,
      inputSchema: z.object({ taskId: z.string().uuid(), instruction: z.string().min(1) })
    },
    async ({ taskId, instruction }) =>
      result(await orchestrator.continueTask({ taskId, instruction }))
  );

  server.registerTool(
    "codex_approval_decide",
    {
      description:
        "Resolve a pending command/file-change approval. Locally blocked destructive requests cannot be accepted.",
      annotations: CONTROL,
      inputSchema: z.object({
        approvalId: z.string().uuid(),
        decision: z.enum(["accept", "acceptForSession", "decline", "cancel"])
      })
    },
    async ({ approvalId, decision }) =>
      result(await orchestrator.decideApproval(approvalId, decision))
  );

  return server;
}
