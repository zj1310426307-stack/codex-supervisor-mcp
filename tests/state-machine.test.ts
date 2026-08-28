import assert from "node:assert/strict";
import test from "node:test";
import {
  contractPathViolations,
  hasActiveWriter,
  isCleanupEligible,
  transitionTask
} from "../src/core/state-machine.js";
import type { TaskRecord } from "../src/types.js";

function task(status: TaskRecord["status"]): TaskRecord {
  const at = new Date().toISOString();
  return {
    id: "task",
    objective: "test",
    workspace: "/repo",
    status,
    turnStatus: "none",
    createdAt: at,
    updatedAt: at,
    eventSeq: 0,
    events: [],
    pendingApprovalIds: [],
    snapshots: [],
    verificationRuns: []
  };
}

test("turn completion leads to verification, not task acceptance", () => {
  const value = task("running");
  value.turnStatus = "completed";
  transitionTask(value, "awaiting_verification", { reason: "turn completed", source: "codex" });
  assert.equal(value.status, "awaiting_verification");
  assert.equal(value.statusHistory?.length, 1);
});

test("state machine rejects unknown shortcuts and active-writer verification", () => {
  const value = task("running");
  assert.throws(
    () => transitionTask(value, "ready_for_human_review", { reason: "skip", source: "test" }),
    /Illegal task state transition/
  );
  value.activeTurnId = "turn";
  value.turnStatus = "in_progress";
  assert.equal(hasActiveWriter(value), true);
  assert.equal(isCleanupEligible(value), false);
});

test("cleanup blocks every unresolved writer, verifier, quarantine, and approval identity", () => {
  const value = task("cancelled");
  const at = new Date().toISOString();
  value.turnLease = {
    leaseId: "turn-lease",
    taskId: value.id,
    threadId: "thread",
    turnId: "turn",
    worktree: value.workspace,
    supervisorInstanceId: "instance",
    appServerInstanceId: "app",
    acquiredAt: at,
    heartbeatAt: at,
    expiresAt: at,
    lastProtocolEventAt: at,
    state: "lost"
  };
  assert.equal(isCleanupEligible(value), false);
  value.turnLease.state = "terminal";
  value.pendingApprovalIds = ["approval"];
  assert.equal(isCleanupEligible(value), false);
  value.pendingApprovalIds = [];
  value.verifierLeases = [{
    leaseId: "verifier-lease",
    runId: "run",
    taskId: value.id,
    workerId: "worker",
    ownerInstanceId: "instance",
    acquiredAt: at,
    heartbeatAt: at,
    expiresAt: at,
    state: "lost"
  }];
  assert.equal(isCleanupEligible(value), false);
  value.verifierLeases[0]!.state = "terminal";
  value.verificationRuns = [{
    runId: "run",
    taskId: value.id,
    profileId: "test",
    recipeIds: ["check"],
    workerId: "worker",
    ownerInstanceId: "instance",
    leaseId: "verifier-lease",
    backend: "process-group",
    assurance: "standard",
    startedAt: at,
    heartbeatAt: at,
    leaseExpiresAt: at,
    beforeSnapshotId: "snapshot",
    state: "quarantined"
  }];
  assert.equal(isCleanupEligible(value), false);
  value.verificationRuns[0]!.state = "failed";
  assert.equal(isCleanupEligible(value), true);
});

test("blocked verification resumes only through the reconciliation source", () => {
  const value = task("blocked");
  assert.throws(
    () => transitionTask(value, "awaiting_verification", { reason: "retry", source: "task-verify" }),
    /only after exact proven reconciliation/
  );
  value.statusHistory = [{
    transitionId: "blocked-transition",
    from: "verifying",
    to: "blocked",
    reason: "lost verifier",
    source: "task-verify",
    at: new Date().toISOString(),
    verificationRunId: "run"
  }];
  value.reconciliationProofs = [{
    proofId: "proof",
    runId: "run",
    result: "PROVEN_TERMINATED",
    observedAt: new Date().toISOString(),
    evidence: {}
  }];
  transitionTask(value, "awaiting_verification", {
    reason: "the quarantined verifier was proven terminated",
    source: "verifier-reconcile",
    verificationRunId: "run"
  });
  assert.equal(value.status, "awaiting_verification");
});

test("ready for human review requires current passing snapshot evidence", () => {
  const value = task("needs_correction");
  value.contract = {
    contractVersion: "1.0",
    clientRequestId: "state-ready-request",
    objective: "test",
    plan: [],
    scope: { in: ["test"], out: [] },
    constraints: [],
    acceptanceCriteria: [{ id: "AC-1", description: "pass" }],
    requiredVerificationRecipes: ["test"],
    maxCorrectionPasses: 3
  };
  value.snapshots = [{
    snapshotId: "snapshot",
    headSha: "a",
    branch: "task",
    statusHash: "b",
    diffHash: "c",
    untrackedHash: "d",
    createdAt: new Date().toISOString(),
    changedFiles: []
  }];
  assert.throws(
    () => transitionTask(value, "ready_for_human_review", { reason: "accept", source: "supervisor" }),
    /does not have all required passing verification/
  );
  value.verificationRuns = [{
    runId: "run",
    taskId: value.id,
    profileId: "node",
    recipeIds: ["test"],
    workerId: "worker",
    ownerInstanceId: "instance",
    leaseId: "lease",
    backend: "process-group",
    assurance: "standard",
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    leaseExpiresAt: new Date().toISOString(),
    beforeSnapshotId: "snapshot",
    afterSnapshotId: "snapshot",
    state: "passed",
    results: [{
      recipeId: "test",
      required: true,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 1,
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      truncated: false,
      timedOut: false,
      passed: true
    }]
  }];
  value.acceptanceEvidence = [{
    criterionId: "AC-1",
    description: "pass",
    evidencePlan: "trusted verification",
    snapshotId: "snapshot",
    verificationRunIds: ["run"],
    satisfied: true,
    observedAt: new Date().toISOString()
  }];
  assert.throws(
    () => transitionTask(value, "ready_for_human_review", { reason: "accept", source: "supervisor" }),
    /does not have all required passing verification/
  );
  Object.assign(value.verificationRuns[0]!, {
    backend: "oci",
    engine: "docker",
    assurance: "high",
    containerImageDigest: `example.invalid/verifier@sha256:${"a".repeat(64)}`,
    containerEngineNamespaceHash: "b".repeat(64),
    containerOwnershipRecordedAt: new Date().toISOString(),
    terminationEvidence: {
      attempts: [{
        recipeId: "test",
        backend: "oci",
        engine: "docker",
        assurance: "high",
        containerIdHash: "c".repeat(64),
        containerLabelsHash: "d".repeat(64),
        containerImageDigest: `example.invalid/verifier@sha256:${"a".repeat(64)}`,
        containerEngineNamespaceHash: "b".repeat(64),
        ownershipVerified: true,
        requiredIntervention: false,
        provenComplete: true
      }]
    }
  });
  transitionTask(value, "ready_for_human_review", { reason: "accept", source: "supervisor" });
  assert.equal(value.status, "ready_for_human_review");
  assert.equal(isCleanupEligible(value), true);
  value.quarantines = [{
    quarantineId: "q",
    scope: "task",
    taskId: value.id,
    runId: "run",
    reason: "unknown verifier descendants",
    createdAt: new Date().toISOString()
  }];
  assert.equal(isCleanupEligible(value), false);
});

test("contract paths are forbidden-first and allowed empty denies any change", () => {
  const value = task("awaiting_verification");
  value.contract = {
    contractVersion: "1.0",
    clientRequestId: "state-path-request",
    objective: "test",
    plan: [],
    scope: { in: ["src"], out: [] },
    constraints: [],
    acceptanceCriteria: [{ id: "AC-1", description: "pass" }],
    requiredVerificationRecipes: [],
    allowedChangePaths: ["src"],
    forbiddenChangePaths: ["src/secret"],
    maxCorrectionPasses: 1
  };
  value.snapshots = [{
    snapshotId: "snapshot",
    headSha: "a",
    branch: "task",
    statusHash: "b",
    diffHash: "c",
    untrackedHash: "d",
    createdAt: new Date().toISOString(),
    changedFiles: ["src/ok.ts", "src/secret/key.ts", "docs/outside.md"]
  }];
  assert.deepEqual(contractPathViolations(value), {
    forbidden: ["src/secret/key.ts"],
    outsideAllowed: ["docs/outside.md"]
  });
  value.contract.allowedChangePaths = [];
  assert.deepEqual(contractPathViolations(value).outsideAllowed, value.snapshots[0]!.changedFiles);
});
