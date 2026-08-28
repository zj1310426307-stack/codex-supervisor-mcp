import assert from "node:assert/strict";
import test from "node:test";
import {
  SUPERVISOR_TOOLS,
  TOOL_SURFACE_VERSION,
  createCombinedToolManifest,
  createToolManifest,
  inputJsonSchema,
  taskDecisionSchema,
  taskStartSchema,
  verifierReconcileSchema
} from "../src/mcp/tool-catalog.js";
import type { SupervisorFacade } from "../src/mcp/facade.js";
import { createSupervisorMcp, registeredToolDefinitions } from "../src/mcp/server.js";

const EXPECTED_FULL = [
  "codex_health",
  "codex_task_list",
  "codex_task_status",
  "codex_task_events",
  "codex_task_wait",
  "codex_pending_approvals",
  "codex_workspace_status",
  "codex_workspace_diff",
  "codex_task_contract",
  "codex_task_evidence",
  "codex_verification_profiles",
  "codex_runtime_capabilities",
  "codex_verifier_status",
  "codex_task_start",
  "codex_task_continue",
  "codex_task_steer",
  "codex_task_interrupt",
  "codex_approval_decide",
  "codex_task_recover",
  "codex_task_verify",
  "codex_task_decide",
  "codex_task_cleanup",
  "codex_verifier_reconcile"
];

const EXPECTED_RESTRICTED = EXPECTED_FULL.slice(0, 13);

const structuredInput = {
  workspace: "C:/repo",
  contract: {
    contractVersion: "1.0",
    clientRequestId: "request-1",
    title: "Add a safe feature",
    objective: "Implement the feature",
    plan: ["Inspect", "Implement", "Verify"],
    scope: { in: ["src"], out: ["deployment"] },
    constraints: ["Do not publish"],
    acceptanceCriteria: [{ id: "AC-1", description: "Tests pass", evidence: "test output" }],
    requiredVerificationRecipes: ["unit"],
    allowedChangePaths: ["src/**"],
    forbiddenChangePaths: [".env"],
    maxCorrectionPasses: 3
  }
};

const legacyInput = {
  workspace: "C:/repo",
  clientRequestId: "legacy-request-1",
  objective: "Implement the feature",
  plan: ["Inspect", "Implement"],
  acceptanceCriteria: ["Tests pass"],
  constraints: ["Do not publish"]
};

test("full and restricted surfaces are frozen at 23 and 13 tools", () => {
  assert.equal(TOOL_SURFACE_VERSION, "0.4.0");
  assert.deepEqual(registeredToolDefinitions(true).map((tool) => tool.name), EXPECTED_FULL);
  assert.deepEqual(registeredToolDefinitions(false).map((tool) => tool.name), EXPECTED_RESTRICTED);
  assert.equal(new Set(SUPERVISOR_TOOLS.map((tool) => tool.name)).size, 23);
});

test("restricted tools are genuinely read-only and every tool is closed-world", () => {
  for (const tool of SUPERVISOR_TOOLS) {
    assert.equal(tool.annotations.openWorldHint, false, tool.name);
    assert.equal(tool.annotations.readOnlyHint, tool.restricted, tool.name);
  }
});

test("destructive annotations conservatively cover branching high-risk tools", () => {
  const destructive = SUPERVISOR_TOOLS.filter((tool) => tool.annotations.destructiveHint).map(
    (tool) => tool.name
  );
  assert.deepEqual(destructive, [
    "codex_task_start",
    "codex_task_continue",
    "codex_task_steer",
    "codex_task_interrupt",
    "codex_approval_decide",
    "codex_task_verify",
    "codex_task_decide",
    "codex_task_cleanup",
    "codex_verifier_reconcile"
  ]);
});

test("task_decide makes acceptance snapshot-bound and keeps non-accept branches disjoint", () => {
  const common = {
    taskId: "TASK-001",
    rationale: "Evidence reviewed"
  };
  const acceptance = {
    ...common,
    decision: "accept" as const,
    expectedSnapshotId: "a".repeat(64),
    criterionConfirmations: [{ criterionId: "AC-1", evidence: "Verifier run and manual review" }]
  };
  assert.equal(taskDecisionSchema.safeParse(acceptance).success, true);
  assert.equal(taskDecisionSchema.safeParse({ ...acceptance, expectedSnapshotId: undefined }).success, false);
  assert.equal(taskDecisionSchema.safeParse({ ...acceptance, criterionConfirmations: undefined }).success, false);
  assert.equal(
    taskDecisionSchema.safeParse({
      ...acceptance,
      criterionConfirmations: [
        { criterionId: "AC-1", evidence: "first" },
        { criterionId: "AC-1", evidence: "duplicate" }
      ]
    }).success,
    false
  );
  assert.equal(
    taskDecisionSchema.safeParse({ ...common, decision: "request_changes", instruction: "Correct it" }).success,
    true
  );
  assert.equal(taskDecisionSchema.safeParse({ ...common, decision: "request_changes" }).success, false);
  assert.equal(taskDecisionSchema.safeParse({ ...common, decision: "block" }).success, true);
  assert.equal(
    taskDecisionSchema.safeParse({
      ...common,
      decision: "block",
      expectedSnapshotId: "a".repeat(64),
      criterionConfirmations: acceptance.criterionConfirmations
    }).success,
    false
  );
});

test("task_decide manifest schema exposes an explicit two-branch oneOf", () => {
  const tool = SUPERVISOR_TOOLS.find((candidate) => candidate.name === "codex_task_decide");
  assert.ok(tool);
  const schema = inputJsonSchema(tool);
  assert.ok(Array.isArray(schema.oneOf));
  assert.equal((schema.oneOf as unknown[]).length, 2);
  assert.equal(schema.anyOf, undefined);
  const serialized = JSON.stringify(schema);
  assert.match(serialized, /expectedSnapshotId/);
  assert.match(serialized, /criterionConfirmations/);
});

test("approval decisions are exact and never session-wide", () => {
  const tool = SUPERVISOR_TOOLS.find((candidate) => candidate.name === "codex_approval_decide");
  assert.ok(tool);
  const common = { approvalId: "f48b9411-01f4-4b29-92e6-28c8b6f16ef2" };
  for (const decision of ["accept", "decline", "cancel"]) {
    assert.equal(tool.inputSchema.safeParse({ ...common, decision }).success, true);
  }
  assert.equal(tool.inputSchema.safeParse({ ...common, decision: "acceptForSession" }).success, false);
});

test("task_start rejects empty, workspace-only, and mixed modes", () => {
  assert.equal(taskStartSchema.safeParse({}).success, false);
  assert.equal(taskStartSchema.safeParse({ workspace: "C:/repo" }).success, false);
  assert.equal(
    taskStartSchema.safeParse({ ...structuredInput, objective: "mixed legacy field" }).success,
    false
  );
  assert.equal(taskStartSchema.safeParse({ workspace: "C:/repo", contract: {} }).success, false);
  const { clientRequestId: _structuredRequestId, ...contractWithoutRequestId } = structuredInput.contract;
  assert.equal(
    taskStartSchema.safeParse({ ...structuredInput, contract: contractWithoutRequestId }).success,
    false
  );
  const { clientRequestId: _legacyRequestId, ...legacyWithoutRequestId } = legacyInput;
  assert.equal(taskStartSchema.safeParse(legacyWithoutRequestId).success, false);
});

test("task_start accepts complete structured and legacy inputs", () => {
  assert.equal(taskStartSchema.safeParse(structuredInput).success, true);
  assert.equal(taskStartSchema.safeParse(legacyInput).success, true);
});

test("generated task_start schema has an explicit non-empty oneOf contract", () => {
  const tool = SUPERVISOR_TOOLS.find((candidate) => candidate.name === "codex_task_start");
  assert.ok(tool);
  const schema = inputJsonSchema(tool);
  assert.ok(Array.isArray(schema.oneOf));
  assert.equal((schema.oneOf as unknown[]).length, 2);
  const serialized = JSON.stringify(schema);
  for (const field of [
    "contractVersion",
    "objective",
    "plan",
    "scope",
    "acceptanceCriteria",
    "requiredVerificationRecipes",
    "maxCorrectionPasses"
  ]) {
    assert.match(serialized, new RegExp(`\\"${field}\\"`));
  }
});

test("the MCP SDK advertises the same explicit oneOf instead of an empty or anyOf schema", () => {
  const server = createSupervisorMcp({ controlEnabled: () => true } as SupervisorFacade);
  const inspectable = server as unknown as {
    toolInputSchemaJson(name: string): Record<string, unknown> | undefined;
    _registeredTools: Record<string, unknown>;
  };
  const schema = inspectable.toolInputSchemaJson("codex_task_start");
  assert.ok(schema);
  assert.equal(Array.isArray(schema.oneOf), true);
  assert.equal(schema.anyOf, undefined);
  assert.equal((schema.oneOf as unknown[]).length, 2);
  assert.equal(Object.keys(inspectable._registeredTools).length, 23);

  const restrictedServer = createSupervisorMcp({ controlEnabled: () => false } as SupervisorFacade);
  assert.equal(
    Object.keys(
      (restrictedServer as unknown as { _registeredTools: Record<string, unknown> })._registeredTools
    ).length,
    13
  );
});

test("verifier reconcile requires one exact runId and rejects caller ownership claims", () => {
  const runId = "f48b9411-01f4-4b29-92e6-28c8b6f16ef2";
  assert.equal(verifierReconcileSchema.safeParse({}).success, false);
  assert.equal(verifierReconcileSchema.safeParse({ taskId: "TASK-001" }).success, false);
  assert.equal(verifierReconcileSchema.safeParse({ runId }).success, true);
  assert.equal(verifierReconcileSchema.safeParse({ runId, taskId: "TASK-001" }).success, true);
  assert.equal(verifierReconcileSchema.safeParse({ runId, pid: 1234 }).success, false);
  assert.equal(verifierReconcileSchema.safeParse({ runId, confirmedTerminated: true }).success, false);
});

test("manifest is deterministic and derived from the registration catalog", () => {
  const first = createCombinedToolManifest();
  const second = createCombinedToolManifest();
  assert.deepEqual(first, second);
  assert.equal(first.restricted.toolCount, 13);
  assert.equal(first.full.toolCount, 23);
  assert.deepEqual(first.full.tools.map((tool) => tool.name), EXPECTED_FULL);
  assert.equal(first.full.toolSchemaHash.length, 64);
  assert.notEqual(first.full.toolSchemaHash, first.restricted.toolSchemaHash);
  assert.deepEqual(createToolManifest("full"), first.full);
});

test("tool surface exposes no arbitrary execution, file write, or publish primitive", () => {
  const names = SUPERVISOR_TOOLS.map((tool) => tool.name).join("\n");
  for (const forbidden of ["run_shell", "write_file", "git_commit", "git_push", "merge", "deploy"])
    assert.doesNotMatch(names, new RegExp(forbidden, "i"));
});
