import assert from "node:assert/strict";
import test from "node:test";
import type { SupervisorFacade } from "../src/mcp/facade.js";
import {
  OperatorRiskRejectedError,
  OperatorUsageError,
  redactOperatorText,
  runOperatorCommand,
  type OperatorIo
} from "../src/cli/operator.js";

function fixture() {
  const calls: Array<{ name: string; input: unknown }> = [];
  const no = async () => ({});
  const facade = {
    controlEnabled: () => true,
    health: no,
    listTaskSummaries: () => [],
    getTaskSummary: () => ({}),
    getEvents: () => [],
    waitForChange: no,
    listApprovals: () => [],
    getWorkspaceStatus: no,
    getWorkspaceDiff: no,
    getTaskContract: no,
    getTaskEvidence: no,
    listVerificationProfiles: no,
    getRuntimeCapabilities: no,
    getVerifierStatus: no,
    startTask: async (input: Record<string, unknown>) => {
      calls.push({ name: "startTask", input });
      return { taskId: "TASK-1" };
    },
    continueTask: no,
    steerTask: no,
    interruptTask: no,
    decideApproval: async (approvalId: string, decision: string, taskId?: string) => {
      calls.push({ name: "decideApproval", input: { approvalId, decision, taskId } });
      return {};
    },
    recoverTask: no,
    verifyTask: no,
    decideTask: async (input: unknown) => {
      calls.push({ name: "decideTask", input });
      return { status: "ready_for_human_review" };
    },
    cleanupTask: no,
    reconcileVerifier: async (input: unknown) => {
      calls.push({ name: "reconcileVerifier", input });
      return { disposition: "UNKNOWN" };
    }
  } as unknown as SupervisorFacade;
  const files = new Map<string, string>([
    ["contract.json", JSON.stringify({ contractVersion: "1.0", objective: "test" })],
    ["instruction.txt", "Make the bounded change"],
    ["rationale.txt", "Evidence supports this decision"],
    [
      "criterion-confirmations.json",
      JSON.stringify([{ criterionId: "AC-1", evidence: "Passing verifier run plus manual review" }])
    ]
  ]);
  const output: string[] = [];
  const io = (confirmed: boolean): OperatorIo => ({
    readText: async (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing fixture: ${path}`);
      return value;
    },
    confirm: async () => confirmed,
    write: (text) => output.push(text),
    writeError: (text) => output.push(text)
  });
  return { facade, calls, io, output };
}

test("operator start routes a contract through the shared facade after confirmation", async () => {
  const { facade, calls, io, output } = fixture();
  await runOperatorCommand(
    ["task", "start", "--contract", "contract.json", "--workspace", "C:/repo", "--json"],
    facade,
    io(true)
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "startTask");
  assert.deepEqual(calls[0].input, {
    workspace: "C:/repo",
    contract: { contractVersion: "1.0", objective: "test" },
    toolSurfaceVersion: "0.4.0"
  });
  assert.match(output[0], /"taskId": "TASK-1"/);
});

test("operator rejects an unconfirmed high-risk operation before facade invocation", async () => {
  const { facade, calls, io } = fixture();
  await assert.rejects(
    () =>
      runOperatorCommand(
        ["task", "start", "--contract", "contract.json", "--workspace", "C:/repo"],
        facade,
        io(false)
      ),
    OperatorRiskRejectedError
  );
  assert.deepEqual(calls, []);
});

test("operator requires confirmation for every terminal task and approval decision", async () => {
  const { facade, calls, io } = fixture();
  await assert.rejects(
    () =>
      runOperatorCommand(
        [
          "task",
          "decide",
          "--task",
          "TASK-1",
          "--decision",
          "block",
          "--rationale",
          "rationale.txt"
        ],
        facade,
        io(false)
      ),
    OperatorRiskRejectedError
  );
  await assert.rejects(
    () =>
      runOperatorCommand(
        [
          "approval",
          "decide",
          "--task",
          "TASK-1",
          "--approval",
          "f48b9411-01f4-4b29-92e6-28c8b6f16ef2",
          "--decision",
          "decline"
        ],
        facade,
        io(false)
      ),
    OperatorRiskRejectedError
  );
  assert.deepEqual(calls, []);
});

test("operator accept forwards an exact snapshot and per-criterion confirmations", async () => {
  const { facade, calls, io } = fixture();
  const snapshotId = "a".repeat(64);
  await runOperatorCommand(
    [
      "task",
      "decide",
      "--task",
      "TASK-1",
      "--decision",
      "accept",
      "--rationale",
      "rationale.txt",
      "--expected-snapshot",
      snapshotId,
      "--criterion-confirmations",
      "criterion-confirmations.json"
    ],
    facade,
    io(true)
  );
  assert.deepEqual(calls[0], {
    name: "decideTask",
    input: {
      taskId: "TASK-1",
      decision: "accept",
      rationale: "Evidence supports this decision",
      expectedSnapshotId: snapshotId,
      criterionConfirmations: [
        { criterionId: "AC-1", evidence: "Passing verifier run plus manual review" }
      ],
      toolSurfaceVersion: "0.4.0"
    }
  });
});

test("operator rejects incomplete or misplaced acceptance evidence", async () => {
  const { facade, calls, io } = fixture();
  await assert.rejects(
    () =>
      runOperatorCommand(
        [
          "task",
          "decide",
          "--task",
          "TASK-1",
          "--decision",
          "accept",
          "--rationale",
          "rationale.txt",
          "--expected-snapshot",
          "a".repeat(64)
        ],
        facade,
        io(true)
      ),
    OperatorUsageError
  );
  await assert.rejects(
    () =>
      runOperatorCommand(
        [
          "task",
          "decide",
          "--task",
          "TASK-1",
          "--decision",
          "block",
          "--rationale",
          "rationale.txt",
          "--expected-snapshot",
          "a".repeat(64),
          "--criterion-confirmations",
          "criterion-confirmations.json"
        ],
        facade,
        io(true)
      ),
    OperatorUsageError
  );
  assert.deepEqual(calls, []);
});

test("operator exposes no session-wide approval decision", async () => {
  const { facade, calls, io } = fixture();
  await assert.rejects(
    () =>
      runOperatorCommand(
        [
          "approval",
          "decide",
          "--task",
          "TASK-1",
          "--approval",
          "f48b9411-01f4-4b29-92e6-28c8b6f16ef2",
          "--decision",
          "acceptForSession"
        ],
        facade,
        io(true)
      ),
    OperatorUsageError
  );
  assert.deepEqual(calls, []);
});

test("operator reconcile requires an exact run selector", async () => {
  const { facade, io } = fixture();
  await assert.rejects(
    () => runOperatorCommand(["verifier", "reconcile", "--task", "TASK-1"], facade, io(true)),
    OperatorUsageError
  );
});

test("operator reconcile forwards only runId, optional taskId, and surface version", async () => {
  const { facade, calls, io } = fixture();
  const runId = "f48b9411-01f4-4b29-92e6-28c8b6f16ef2";
  await runOperatorCommand(
    ["verifier", "reconcile", "--run", runId, "--task", "TASK-1"],
    facade,
    io(true)
  );
  assert.deepEqual(calls[0], {
    name: "reconcileVerifier",
    input: { runId, taskId: "TASK-1", toolSurfaceVersion: "0.4.0" }
  });
});

test("operator offers no arbitrary shell or publish command", async () => {
  const { facade, io } = fixture();
  await assert.rejects(
    () => runOperatorCommand(["git", "push", "--remote", "origin"], facade, io(true)),
    OperatorUsageError
  );
  await assert.rejects(
    () => runOperatorCommand(["run", "shell", "--command", "whoami"], facade, io(true)),
    OperatorUsageError
  );
});

test("operator output defensively redacts credentials", () => {
  const safe = redactOperatorText(
    JSON.stringify({ accessToken: "sensitive-value", note: "Bearer abc.def.ghi" })
  );
  assert.doesNotMatch(safe, /sensitive-value|abc\.def\.ghi/);
  assert.match(safe, /\[REDACTED\]/);
});
