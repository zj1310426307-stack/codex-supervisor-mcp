import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Config } from "../src/config.js";
import { evaluateProtocolCapabilities } from "../src/codex/protocol-capabilities.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import { TaskStore } from "../src/core/store.js";
import type { VerificationConfig } from "../src/core/verification-config.js";
import type { TaskRecord } from "../src/types.js";
import {
  assertOciRuntimeAvailable,
  ociLabelsHash,
  ociOwnershipLabels
} from "../src/verification/execution-backend.js";

const runFile = promisify(execFile);
const fakeOciEngine = fileURLToPath(new URL("./fixtures/fake-oci-engine.mjs", import.meta.url));
const fakeOciStateRoot = path.join(os.tmpdir(), `codex-supervisor-fake-oci-orchestrator-${process.pid}`);

class FakeCodexClient extends EventEmitter {
  readonly errors: Array<{ id: string | number; code: number; message: string }> = [];
  readonly responses: Array<{ id: string | number; result: unknown }> = [];
  readonly requests: Array<{ method: string; params: unknown }> = [];
  ready = false;
  constructor(
    private readonly earlyTurnStarted = false,
    private readonly nextTurnId = "turn-1",
    private readonly earlyTurnCompleted = false,
    private readonly failTurnStart = false
  ) { super(); }
  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    this.ready = true;
    if (method === "account/read") return { account: { type: "apiKey" } };
    if (method === "thread/start" || method === "thread/resume") return { thread: { id: "thread-1" } };
    if (method === "turn/start") {
      if (this.earlyTurnStarted) {
        this.emit("notification", {
          method: "turn/started",
          params: { turn: { id: this.nextTurnId } }
        });
      }
      if (this.earlyTurnCompleted) {
        this.emit("notification", {
          method: "turn/completed",
          params: { turn: { id: this.nextTurnId, status: "completed", items: [] } }
        });
      }
      if (this.failTurnStart) throw new Error("synthetic turn/start failure");
      return { turn: { id: this.nextTurnId } };
    }
    if (method === "thread/read") return { thread: { id: "thread-1", turns: [{ id: "turn-1", status: "completed" }] } };
    if (method === "turn/steer" || method === "turn/interrupt") return {};
    throw new Error(`Unexpected fake Codex method: ${method}`);
  }
  isReady(): boolean { return this.ready; }
  connectionCount(): number { return this.ready ? 1 : 0; }
  async respond(id: string | number, result: unknown): Promise<void> {
    this.responses.push({ id, result });
  }
  async respondError(id: string | number, code: number, message: string): Promise<void> {
    this.errors.push({ id, code, message });
  }
  async stop() { return { alreadyStopped: false, forced: false, exitCode: 0, signal: null }; }
}

class TailExitCodexClient extends FakeCodexClient {
  override async stop() {
    this.emit("exit");
    await Promise.resolve();
    return { alreadyStopped: false, forced: false, exitCode: 0, signal: null };
  }
}

class LatePriorCompletionClient extends FakeCodexClient {
  private turnStarts = 0;

  override async request(method: string, params?: unknown): Promise<unknown> {
    if (method === "turn/start") {
      this.turnStarts += 1;
      if (this.turnStarts === 2) {
        this.emit("notification", {
          method: "turn/completed",
          params: { turn: { id: "turn-1", status: "completed", items: [] } }
        });
        return { turn: { id: "turn-2" } };
      }
    }
    return super.request(method, params);
  }
}

class PostThreadStateTelemetryStore extends TaskStore {
  emitted = false;

  constructor(file: string, private readonly client: FakeCodexClient) {
    super(file);
  }

  override async put(task: TaskRecord): Promise<void> {
    await super.put(task);
    if (
      !this.emitted &&
      task.status === "preparing" &&
      task.threadId === "thread-1" &&
      !task.pendingTurnStart
    ) {
      this.emitted = true;
      this.client.emit("notification", {
        method: "thread/started",
        params: { thread: { id: "thread-1" } }
      });
      this.client.emit("notification", {
        method: "mcpServer/startupStatus/updated",
        params: { threadId: "thread-1", name: "probe", status: "ready" }
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

class FailingApprovalResponseClient extends FakeCodexClient {
  override async respond(): Promise<void> {
    throw new Error("synthetic approval response transport failure");
  }
}

class CascadingApprovalClient extends FakeCodexClient {
  nextServerRequest?: { id: string; method: string; params: Record<string, unknown> };

  override async respond(id: string | number, result: unknown): Promise<void> {
    await super.respond(id, result);
    const next = this.nextServerRequest;
    this.nextServerRequest = undefined;
    if (next) {
      this.emit("serverRequest", next);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

class CrashAfterReservationStore extends TaskStore {
  private crashPending = true;

  override async putWithIdempotency(
    task: TaskRecord,
    clientRequestId?: string
  ): Promise<{ task: TaskRecord; created: boolean }> {
    const result = await super.putWithIdempotency(task, clientRequestId);
    if (this.crashPending) {
      this.crashPending = false;
      throw new Error("synthetic crash after durable planned reservation");
    }
    return result;
  }
}

function config(root: string): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    mcpPath: "/mcp",
    allowedHosts: ["127.0.0.1"],
    allowedOrigins: [],
    codexBin: "codex-test",
    codexBinSource: "explicit",
    codexModel: "gpt-5.4-mini",
    codexExperimentalApi: false,
    codexReadRetries: 0,
    codexRetryBaseDelayMs: 1,
    codexRetryMaxDelayMs: 1,
    codexShutdownTimeoutMs: 100,
    workspaceRoots: [root],
    stateFile: path.join(root, "state", "state.json"),
    worktreeRoot: path.join(root, "state", "worktrees"),
    verificationConfigFile: path.join(root, "verification.json"),
    turnLeaseTtlMs: 5_000,
    turnWarnIdleMs: 10_000,
    turnSuspectIdleMs: 20_000,
    turnHardDeadlineMs: 30_000,
    verifierLeaseTtlMs: 5_000,
    maxVerificationOutputChars: 20_000,
    maxEventsPerTask: 100,
    maxEventPayloadChars: 20_000,
    maxDiffChars: 30_000,
    requestTimeoutMs: 2_000,
    maxBodyBytes: 100_000,
    rateLimitMaxRequests: 100,
    rateLimitWindowMs: 60_000,
    headersTimeoutMs: 1_000,
    httpRequestTimeoutMs: 2_000,
    readinessTimeoutMs: 100,
    controlEnabled: true
  };
}

const verificationConfig: VerificationConfig = {
  version: 2,
  runtime: {
    engine: "docker",
    engineExecutable: process.execPath,
    engineArguments: [fakeOciEngine, "--state-root", fakeOciStateRoot],
    image: `example.invalid/verifier@sha256:${"a".repeat(64)}`,
    user: "65532:65532",
    pidsLimit: 64,
    memoryBytes: 256 * 1024 * 1024,
    cpus: 1,
    tmpfsSizeBytes: 16 * 1024 * 1024
  },
  environmentAllowlist: [],
  profiles: {
    test: {
      recipes: [{
        id: "check",
        program: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: ".",
        timeoutMs: 5_000,
        required: true
      }]
    }
  }
};

async function fixture(
  selectedVerificationConfig: VerificationConfig = verificationConfig,
  earlyTurnStarted = false,
  earlyTurnCompleted = false,
  failTurnStart = false,
  clientOverride?: FakeCodexClient,
  storeFactory?: (stateFile: string) => TaskStore
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-orchestrator-"));
  const repository = path.join(root, "repository");
  await fs.mkdir(repository, { recursive: true });
  await runFile("git", ["init", "-b", "main", repository], { windowsHide: true });
  await runFile("git", ["-C", repository, "config", "user.name", "Supervisor Test"], { windowsHide: true });
  await runFile("git", ["-C", repository, "config", "user.email", "supervisor@example.invalid"], { windowsHide: true });
  await fs.writeFile(path.join(repository, "README.md"), "fixture\n", "utf8");
  await runFile("git", ["-C", repository, "add", "README.md"], { windowsHide: true });
  await runFile("git", ["-C", repository, "commit", "-m", "fixture"], { windowsHide: true });
  const fakeClient = clientOverride ?? new FakeCodexClient(earlyTurnStarted, "turn-1", earlyTurnCompleted, failTurnStart);
  const stateFile = path.join(root, "state", "state.json");
  const store = storeFactory?.(stateFile) ?? new TaskStore(stateFile);
  const fakeLock = {
    instanceId: "instance-test",
    acquire: async () => ({ instanceId: "instance-test" }),
    release: async () => undefined
  };
  const capabilities = evaluateProtocolCapabilities([
    "initialize",
    "initialized",
    "account/read",
    "thread/start",
    "thread/resume",
    "thread/read",
    "turn/start",
    "turn/steer",
    "turn/interrupt",
    "turn/started",
    "turn/completed",
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval"
  ]);
  const orchestrator = new Orchestrator(config(root), {
    client: fakeClient as never,
    store,
    instanceLock: fakeLock as never,
    verificationConfig: selectedVerificationConfig,
    runtimeProbe: async () => ({
      checkedAt: new Date().toISOString(),
      version: "codex-test 1.0.0",
      schemaHash: "a".repeat(64),
      schemaFileCount: 1,
      schemaGeneration: { command: "codex app-server generate-json-schema", isolatedTemporaryDirectory: true },
      experimentalApiRequested: false,
      capabilities
    })
  });
  await orchestrator.init();
  return { root, repository, orchestrator, fakeClient };
}

async function waitForStatus(orchestrator: Orchestrator, taskId: string, status: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (orchestrator.getTask(taskId).status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Task did not reach ${status}; current=${orchestrator.getTask(taskId).status}`);
}

test("supervisor sends current stable App Server thread option values", async () => {
  const { root, repository, orchestrator, fakeClient } = await fixture();
  try {
    await orchestrator.startTask({
      workspace: repository,
      clientRequestId: "current-thread-options-request",
      objective: "Exercise the stable Codex thread options.",
      plan: ["Start one supervised turn"],
      acceptanceCriteria: ["The thread uses current App Server enum values"]
    });
    const request = fakeClient.requests.find((entry) => entry.method === "thread/start");
    assert.ok(request);
    const params = request.params as Record<string, unknown>;
    assert.equal(params.approvalPolicy, "untrusted");
    assert.equal(params.sandbox, "workspace-write");
    assert.equal(params.approvalsReviewer, "user");
    assert.equal(params.model, "gpt-5.4-mini");
  } finally {
    await orchestrator.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("post-response thread telemetry cannot deadlock exact turn/start binding", async () => {
  const client = new FakeCodexClient();
  let telemetryStore: PostThreadStateTelemetryStore | undefined;
  const { root, repository, orchestrator } = await fixture(
    verificationConfig,
    false,
    false,
    false,
    client,
    (stateFile) => {
      telemetryStore = new PostThreadStateTelemetryStore(stateFile, client);
      return telemetryStore;
    }
  );
  let deadline: NodeJS.Timeout | undefined;
  try {
    const task = await Promise.race([
      orchestrator.startTask({
        workspace: repository,
        clientRequestId: "post-thread-start-telemetry",
        objective: "Bind a turn after immediate thread telemetry.",
        plan: ["Start one supervised turn"],
        acceptanceCriteria: ["The start operation does not deadlock"]
      }),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("startTask deadlocked behind post-response telemetry")), 2_000);
      })
    ]);
    if (deadline) clearTimeout(deadline);
    assert.equal(task.status, "running");
    assert.equal(task.turnStatus, "in_progress");
    assert.equal(telemetryStore?.emitted, true);
  } finally {
    if (deadline) clearTimeout(deadline);
    await orchestrator.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

/** Construct a new Supervisor runtime over an existing durable test ledger. */
function restartedOrchestrator(root: string, selectedVerificationConfig = verificationConfig): Orchestrator {
  return new Orchestrator(config(root), {
    client: new FakeCodexClient(false, "turn-restarted") as never,
    store: new TaskStore(path.join(root, "state", "state.json")),
    instanceLock: {
      instanceId: "instance-restarted",
      acquire: async () => ({ instanceId: "instance-restarted" }),
      release: async () => undefined
    } as never,
    verificationConfig: selectedVerificationConfig,
    runtimeProbe: async () => ({
      checkedAt: new Date().toISOString(),
      version: "codex-test 1.0.0",
      schemaHash: "a".repeat(64),
      schemaFileCount: 1,
      schemaGeneration: { command: "codex app-server generate-json-schema", isolatedTemporaryDirectory: true },
      experimentalApiRequested: false,
      capabilities: evaluateProtocolCapabilities([
        "initialize", "initialized", "account/read", "thread/start", "thread/resume", "thread/read",
        "turn/start", "turn/steer", "turn/interrupt", "turn/started", "turn/completed",
        "item/commandExecution/requestApproval", "item/fileChange/requestApproval"
      ])
    })
  });
}

test("an identical retry resumes one pristine planned reservation after restart", async () => {
  const { root, repository, orchestrator } = await fixture(
    verificationConfig,
    false,
    false,
    false,
    undefined,
    (stateFile) => new CrashAfterReservationStore(stateFile)
  );
  let restarted: Orchestrator | undefined;
  const input = {
    workspace: repository,
    clientRequestId: "planned-resume-request",
    objective: "Resume the exact task identity after a reservation-only crash.",
    plan: ["Start once"],
    acceptanceCriteria: ["Exactly one task and worktree are created"]
  };
  try {
    await assert.rejects(orchestrator.startTask(input), /synthetic crash after durable planned reservation/);
    const reservation = orchestrator.listTasks()[0]!;
    assert.equal(reservation.status, "planned");
    assert.equal(orchestrator.listTasks().length, 1);
    assert.equal(reservation.worktree, undefined);
    assert.equal(reservation.threadId, undefined);
    await orchestrator.stop();

    restarted = restartedOrchestrator(root);
    await restarted.init();
    assert.equal(restarted.getTask(reservation.id).status, "planned");
    const resumed = await restarted.startTask(input);
    assert.equal(resumed.id, reservation.id);
    assert.equal(resumed.status, "running");
    assert.equal(restarted.listTasks().length, 1);
    assert.ok(resumed.worktree);
    assert.ok(resumed.threadId);
  } finally {
    await restarted?.stop().catch(() => undefined);
    await orchestrator.stop().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("concurrent retries cannot replay one planned reservation twice", async () => {
  const { root, repository, orchestrator } = await fixture(
    verificationConfig,
    false,
    false,
    false,
    undefined,
    (stateFile) => new CrashAfterReservationStore(stateFile)
  );
  const input = {
    workspace: repository,
    clientRequestId: "planned-concurrent-request",
    objective: "Serialize replay of one durable planned reservation.",
    plan: ["Start once"],
    acceptanceCriteria: ["Only one retry obtains task ownership"]
  };
  try {
    await assert.rejects(orchestrator.startTask(input), /synthetic crash after durable planned reservation/);
    const results = await Promise.allSettled([
      orchestrator.startTask(input),
      orchestrator.startTask(input)
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal((rejected[0] as PromiseRejectedResult).reason.code, "ACTIVE_WRITER_CONFLICT");
    assert.equal(orchestrator.listTasks().length, 1);
    assert.equal(orchestrator.listTasks()[0]?.status, "running");
  } finally {
    await orchestrator.stop().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a planned reservation with side-effect evidence is never replayed", async () => {
  const { root, repository, orchestrator } = await fixture(
    verificationConfig,
    false,
    false,
    false,
    undefined,
    (stateFile) => new CrashAfterReservationStore(stateFile)
  );
  const input = {
    workspace: repository,
    clientRequestId: "planned-ambiguous-request",
    objective: "Reject an ambiguous planned reservation.",
    plan: ["Do not duplicate external work"],
    acceptanceCriteria: ["Ambiguous side effects remain fail-closed"]
  };
  try {
    await assert.rejects(orchestrator.startTask(input), /synthetic crash after durable planned reservation/);
    const reservation = orchestrator.listTasks()[0]!;
    reservation.threadId = "ambiguous-unbound-thread";
    await (orchestrator as unknown as { store: TaskStore }).store.put(reservation);
    await assert.rejects(
      orchestrator.startTask(input),
      (error: unknown) => (error as { code?: string }).code === "IDEMPOTENCY_CONFLICT"
    );
    const current = orchestrator.getTask(reservation.id);
    assert.equal(current.status, "planned");
    assert.equal(current.worktree, undefined);
    assert.equal(orchestrator.listTasks().length, 1);
  } finally {
    await orchestrator.stop().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("restart marks an incomplete preparing phase stale instead of replaying side effects", async () => {
  const { root, repository, orchestrator } = await fixture(
    verificationConfig,
    false,
    false,
    false,
    undefined,
    (stateFile) => new CrashAfterReservationStore(stateFile)
  );
  let restarted: Orchestrator | undefined;
  const input = {
    workspace: repository,
    clientRequestId: "preparing-restart-request",
    objective: "Fail closed after task-start preparation becomes ambiguous.",
    plan: ["Do not replay an external mutation"],
    acceptanceCriteria: ["Restart preserves ambiguity evidence"]
  };
  try {
    await assert.rejects(orchestrator.startTask(input), /synthetic crash after durable planned reservation/);
    const taskId = orchestrator.listTasks()[0]!.id;
    await orchestrator.stop();
    const crashLedger = new TaskStore(path.join(root, "state", "state.json"));
    await crashLedger.load();
    const preparing = crashLedger.get(taskId)!;
    preparing.status = "preparing";
    await crashLedger.put(preparing);

    restarted = restartedOrchestrator(root);
    await restarted.init();
    const recovered = restarted.getTask(preparing.id);
    assert.equal(recovered.status, "stale");
    assert.equal(recovered.residualRisks?.includes("prior_runtime_task_start_side_effect_ambiguous"), true);
    assert.equal(recovered.events.some((event) => event.method === "supervisor/priorTaskStartAmbiguous"), true);
  } finally {
    await restarted?.stop().catch(() => undefined);
    await orchestrator.stop().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("orchestrator separates turn completion, verification evidence, and explicit acceptance", async () => {
  const { root, repository, orchestrator, fakeClient } = await fixture();
  try {
    const task = await orchestrator.startTask({
      workspace: repository,
      contract: {
        contractVersion: "1.0",
        clientRequestId: "lifecycle-request",
        objective: "Validate the supervision lifecycle without changing files.",
        plan: ["Report completion"],
        scope: { in: ["Supervisor lifecycle"], out: ["Repository publication"] },
        constraints: ["Do not commit or push"],
        acceptanceCriteria: [{ id: "AC-1", description: "Trusted verification passes" }],
        requiredVerificationRecipes: ["check"],
        maxCorrectionPasses: 1
      }
    });
    assert.equal(task.status, "running");
    assert.notEqual(task.worktree, repository);
    fakeClient.emit("notification", {
      method: "turn/completed",
      params: { turn: { id: "turn-1", status: "completed", items: [] } }
    });
    await waitForStatus(orchestrator, task.id, "awaiting_verification");
    assert.equal(orchestrator.getTask(task.id).decisions?.length, 0);

    const run = await orchestrator.verifyTask({ taskId: task.id, profileId: "test" });
    assert.equal(run.state, "passed");
    assert.equal(orchestrator.getTask(task.id).acceptanceEvidence?.[0]?.satisfied, false);
    const expectedSnapshotId = orchestrator.getTask(task.id).snapshots?.at(-1)?.snapshotId;
    assert.ok(expectedSnapshotId);
    await assert.rejects(
      orchestrator.decideTask({
        taskId: task.id,
        decision: "accept",
        rationale: "Missing criterion evidence must fail closed.",
        expectedSnapshotId,
        criterionConfirmations: []
      }),
      /exactly cover every Development Contract criterion/
    );
    assert.equal(orchestrator.getTask(task.id).acceptanceEvidence?.[0]?.satisfied, false);
    const accepted = await orchestrator.decideTask({
      taskId: task.id,
      decision: "accept",
      rationale: "Current snapshot and trusted check satisfy AC-1.",
      expectedSnapshotId,
      criterionConfirmations: [{ criterionId: "AC-1", evidence: "Reviewed trusted check output" }]
    });
    assert.equal(accepted.status, "ready_for_human_review");
    assert.deepEqual(accepted.decisions?.at(-1)?.verificationRunIds, [run.runId]);
    assert.equal(accepted.decisions?.at(-1)?.snapshotId, expectedSnapshotId);
  } finally {
    await orchestrator.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("mismatched terminal notification loses ownership instead of completing a task", async () => {
  const { root, repository, orchestrator, fakeClient } = await fixture();
  try {
    const task = await orchestrator.startTask({
      workspace: repository,
      clientRequestId: "ownership-request",
      objective: "Exercise fail-closed ownership.",
      plan: ["Observe protocol"],
      acceptanceCriteria: ["Foreign turns cannot complete this task"]
    });
    fakeClient.emit("notification", {
      method: "turn/completed",
      params: { turn: { id: "turn-foreign", threadId: "thread-1", status: "completed" } }
    });
    await waitForStatus(orchestrator, task.id, "stale");
    assert.equal(orchestrator.getTask(task.id).snapshots?.length, 1);
    assert.match(orchestrator.getTask(task.id).error ?? "", /ownership mismatch/);
  } finally {
    await orchestrator.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("unknown task-scoped notification is audited without renewing or revoking ownership", async () => {
  const { root, repository, orchestrator, fakeClient } = await fixture();
  try {
    const task = await orchestrator.startTask({
      workspace: repository,
      clientRequestId: "unknown-notification-request",
      objective: "Exercise unknown-notification handling.",
      plan: ["Observe protocol"],
      acceptanceCriteria: ["Unknown protocol methods cannot renew ownership"]
    });
    fakeClient.emit("notification", {
      method: "future/unknownMutation",
      params: { turn: { id: "turn-1" } }
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(orchestrator.getTask(task.id).status, "running");
    assert.equal(
      orchestrator.getTask(task.id).events.some((event) => event.method === "unrecognized:future/unknownMutation"),
      true
    );
  } finally {
    await orchestrator.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("turn started notification before response is idempotent and owns one writer", async () => {
  const { root, repository, orchestrator } = await fixture(verificationConfig, true);
  try {
    const task = await orchestrator.startTask({
      workspace: repository,
      clientRequestId: "early-start-request",
      objective: "Handle response-notification ordering.",
      plan: ["Start once"],
      acceptanceCriteria: ["Exactly one writer lease exists"]
    });
    assert.equal(task.status, "running");
    assert.equal(task.activeTurnId, "turn-1");
    assert.ok(task.turnLease);
    assert.equal(orchestrator.getTask(task.id).status, "running");
  } finally {
    await orchestrator.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("turn completion before the start response is retained and never resurrects a writer", async () => {
  const { root, repository, orchestrator } = await fixture(verificationConfig, true, true);
  try {
    const task = await orchestrator.startTask({
      workspace: repository,
      clientRequestId: "early-completion-request",
      objective: "Handle a complete notification sequence before the response.",
      plan: ["Complete once"],
      acceptanceCriteria: ["The terminal writer is not restarted"]
    });
    assert.equal(task.status, "awaiting_verification");
    assert.equal(task.activeTurnId, "turn-1");
    assert.equal(task.turnStatus, "completed");
    assert.equal(task.turnLease?.state, "terminal");
    assert.equal(task.turnHistory?.filter((turn) => turn.turnId === "turn-1").length, 1);
  } finally {
    await orchestrator.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("late prior-turn telemetry cannot deadlock or rebind a pending continuation", async () => {
  const client = new LatePriorCompletionClient();
  const { root, repository, orchestrator, fakeClient } = await fixture(
    verificationConfig,
    false,
    false,
    false,
    client
  );
  try {
    const task = await orchestrator.startTask({
      workspace: repository,
      clientRequestId: "late-prior-turn-request",
      objective: "Bind each continuation to exactly one new turn.",
      plan: ["Complete and continue"],
      acceptanceCriteria: ["A late prior-turn event cannot own the new writer"]
    });
    fakeClient.emit("notification", {
      method: "turn/completed",
      params: { turn: { id: "turn-1", status: "completed", items: [] } }
    });
    await waitForStatus(orchestrator, task.id, "awaiting_verification");

    let timeout: NodeJS.Timeout | undefined;
    const continued = await Promise.race([
      orchestrator.continueTask({ taskId: task.id, instruction: "Start the exact follow-up turn." }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("continuation deadlocked on prior-turn telemetry")), 3_000);
      })
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
    assert.equal(continued.activeTurnId, "turn-2");
    assert.equal(continued.turnLease?.turnId, "turn-2");
    assert.equal(continued.turnLease?.state, "active");
    assert.ok(
      continued.events.some((event) => event.method === "supervisor/deferredPriorTurnTelemetry")
    );
  } finally {
    await orchestrator.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("failed turn/start leaves a durable lost writer identity that blocks cleanup", async () => {
  const { root, repository, orchestrator } = await fixture(verificationConfig, true, false, true);
  try {
    await assert.rejects(
      orchestrator.startTask({
        workspace: repository,
        clientRequestId: "failed-start-request",
        objective: "Fail closed when remote start outcome is unknown.",
        plan: ["Start"],
        acceptanceCriteria: ["Potential writer remains unresolved"]
      }),
      /synthetic turn\/start failure/
    );
    const task = orchestrator.listTasks()[0]!;
    assert.equal(task.status, "stale");
    assert.equal(task.turnLease?.state, "lost");
    assert.ok(task.activeTurnId?.startsWith("unresolved-") || task.activeTurnId === "turn-1");
    await assert.rejects(
      orchestrator.cleanupTask({ taskId: task.id }),
      /not eligible for worktree cleanup/
    );
  } finally {
    await orchestrator.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("per-task operation guard rejects concurrent verification and defers telemetry without stale overwrite", async () => {
  const slowConfig: VerificationConfig = {
    ...verificationConfig,
    profiles: {
      test: {
        recipes: [{
          ...verificationConfig.profiles.test.recipes[0]!,
          args: ["-e", "setTimeout(() => process.exit(0), 600)"]
        }]
      }
    }
  };
  const { root, repository, orchestrator, fakeClient } = await fixture(slowConfig);
  try {
    const task = await orchestrator.startTask({
      workspace: repository,
      clientRequestId: "operation-guard-request",
      objective: "Serialize supervisor operations.",
      plan: ["Verify once"],
      acceptanceCriteria: ["Only one verifier mutates the ledger"]
    });
    fakeClient.emit("notification", {
      method: "turn/completed",
      params: { turn: { id: "turn-1", status: "completed", items: [] } }
    });
    await waitForStatus(orchestrator, task.id, "awaiting_verification");
    const first = orchestrator.verifyTask({ taskId: task.id, profileId: "test" });
    await waitForStatus(orchestrator, task.id, "verifying");
    await assert.rejects(
      orchestrator.verifyTask({ taskId: task.id, profileId: "test" }),
      (error: unknown) => (error as { code?: string }).code === "ACTIVE_WRITER_CONFLICT"
    );
    await assert.rejects(
      orchestrator.decideTask({ taskId: task.id, decision: "block", rationale: "must serialize" }),
      (error: unknown) => (error as { code?: string }).code === "ACTIVE_WRITER_CONFLICT"
    );
    fakeClient.emit("notification", {
      method: "future/telemetry",
      params: { turn: { id: "turn-1" } }
    });
    await first;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const current = orchestrator.getTask(task.id);
    assert.equal(current.status, "awaiting_verification");
    assert.equal(current.events.some((event) => event.method === "unrecognized:future/telemetry"), true);
  } finally {
    await orchestrator.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("terminal snapshot failure loses writer authority instead of persisting terminal-plus-running", async () => {
  const { root, repository, orchestrator, fakeClient } = await fixture();
  try {
    const task = await orchestrator.startTask({
      workspace: repository,
      clientRequestId: "snapshot-failure-request",
      objective: "Fail closed when terminal snapshot capture fails.",
      plan: ["Capture terminal state"],
      acceptanceCriteria: ["Terminal state has a durable snapshot"]
    });
    await fs.rm(task.worktree!, { recursive: true, force: true });
    fakeClient.emit("notification", {
      method: "turn/completed",
      params: { turn: { id: "turn-1", status: "completed", items: [] } }
    });
    await waitForStatus(orchestrator, task.id, "stale");
    const current = orchestrator.getTask(task.id);
    assert.equal(current.turnLease?.state, "lost");
    assert.notEqual(current.status, "running");
  } finally {
    await orchestrator.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("approval authority is invalidated when the exact active lease is lost", async () => {
  const { root, repository, orchestrator, fakeClient } = await fixture();
  try {
    const task = await orchestrator.startTask({
      workspace: repository,
      clientRequestId: "approval-authority-request",
      objective: "Bind approvals to one live lease.",
      plan: ["Request exact approval"],
      acceptanceCriteria: ["Lost authority cannot approve"]
    });
    fakeClient.emit("serverRequest", {
      id: "approval-request-1",
      method: "item/commandExecution/requestApproval",
      params: {
        itemId: "item-1",
        threadId: "thread-1",
        turnId: "turn-1",
        command: "npm test",
        cwd: task.worktree
      }
    });
    await waitForStatus(orchestrator, task.id, "waiting_approval");
    const approval = orchestrator.listApprovals(task.id)[0]!;
    fakeClient.emit("processError", new Error("synthetic App Server loss"));
    await waitForStatus(orchestrator, task.id, "stale");
    assert.equal(orchestrator.listApprovals(task.id).length, 0);
    assert.equal(fakeClient.errors.some((entry) => entry.id === "approval-request-1"), true);
    await assert.rejects(orchestrator.decideApproval(approval.approvalId, "accept"), /Unknown or resolved approval/);
  } finally {
    await orchestrator.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("single-use approval never applies an offered execpolicy amendment", async () => {
  const { root, repository, orchestrator, fakeClient } = await fixture();
  try {
    const task = await orchestrator.startTask({
      workspace: repository,
      clientRequestId: "single-use-approval-request",
      objective: "Use only a single command approval.",
      plan: ["Inspect repository status"],
      acceptanceCriteria: ["No persistent approval rule is applied"]
    });
    fakeClient.emit("serverRequest", {
      id: "approval-request-single-use",
      method: "item/commandExecution/requestApproval",
      params: {
        approvalId: null,
        itemId: "item-single-use",
        threadId: "thread-1",
        turnId: "turn-1",
        startedAtMs: 1_777_000_000_000,
        environmentId: "local",
        kind: "command",
        command: "git status --short",
        cwd: task.worktree,
        commandActions: [{ type: "unknown", command: "git status --short" }],
        proposedExecpolicyAmendment: ["git", "status", "--short"],
        availableDecisions: [
          "accept",
          { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "status", "--short"] } },
          "cancel"
        ]
      }
    });
    await waitForStatus(orchestrator, task.id, "waiting_approval");
    const approval = orchestrator.listApprovals(task.id)[0]!;
    assert.equal(approval.risk, "normal");
    await orchestrator.decideApproval(approval.approvalId, "accept", task.id);
    assert.deepEqual(fakeClient.responses, [{
      id: "approval-request-single-use",
      result: { decision: "accept" }
    }]);
  } finally {
    await orchestrator.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a chained approval waits for the prior single-use decision to be durably recorded", async () => {
  const cascadingClient = new CascadingApprovalClient();
  const { root, repository, orchestrator, fakeClient } = await fixture(
    verificationConfig,
    false,
    false,
    false,
    cascadingClient
  );
  try {
    const task = await orchestrator.startTask({
      workspace: repository,
      clientRequestId: "chained-approval-request",
      objective: "Serialize two exact approval requests.",
      plan: ["Inspect twice"],
      acceptanceCriteria: ["The second request retains exact turn authority"]
    });
    cascadingClient.nextServerRequest = {
      id: "approval-request-second",
      method: "item/commandExecution/requestApproval",
      params: {
        itemId: "item-second",
        threadId: "thread-1",
        turnId: "turn-1",
        command: "git diff --stat",
        cwd: task.worktree
      }
    };
    fakeClient.emit("serverRequest", {
      id: "approval-request-first",
      method: "item/commandExecution/requestApproval",
      params: {
        itemId: "item-first",
        threadId: "thread-1",
        turnId: "turn-1",
        command: "git status --short",
        cwd: task.worktree
      }
    });
    await waitForStatus(orchestrator, task.id, "waiting_approval");
    const first = orchestrator.listApprovals(task.id)[0]!;
    await orchestrator.decideApproval(first.approvalId, "accept", task.id);
    await waitForStatus(orchestrator, task.id, "waiting_approval");
    const second = orchestrator.listApprovals(task.id)[0]!;
    assert.equal(second.params.itemId, "item-second");
    assert.deepEqual(fakeClient.errors, []);
    assert.equal(orchestrator.getTask(task.id).turnLease?.state, "active");
    await orchestrator.decideApproval(second.approvalId, "decline", task.id);
  } finally {
    await orchestrator.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("approval response transport failure revokes authority without recording a decision", async () => {
  const failingClient = new FailingApprovalResponseClient();
  const { root, repository, orchestrator, fakeClient } = await fixture(
    verificationConfig,
    false,
    false,
    false,
    failingClient
  );
  try {
    const task = await orchestrator.startTask({
      workspace: repository,
      clientRequestId: "approval-transport-failure-request",
      objective: "Fail closed if an approval response cannot be delivered.",
      plan: ["Request exact approval"],
      acceptanceCriteria: ["No unproven approval decision is retained"]
    });
    fakeClient.emit("serverRequest", {
      id: "approval-request-transport-failure",
      method: "item/commandExecution/requestApproval",
      params: {
        itemId: "item-transport-failure",
        threadId: "thread-1",
        turnId: "turn-1",
        command: "npm test",
        cwd: task.worktree
      }
    });
    await waitForStatus(orchestrator, task.id, "waiting_approval");
    const approval = orchestrator.listApprovals(task.id)[0]!;
    await assert.rejects(
      orchestrator.decideApproval(approval.approvalId, "accept", task.id),
      (error: unknown) => (error as { code?: string }).code === "LEASE_CONFLICT"
    );
    const current = orchestrator.getTask(task.id);
    assert.equal(current.status, "stale");
    assert.equal(current.turnLease?.state, "lost");
    assert.deepEqual(current.pendingApprovalIds, []);
    assert.equal(orchestrator.listApprovals(task.id).length, 0);
    assert.equal(current.events.some((event) => event.method === "supervisor/approvalInvalidated"), true);
    assert.equal(current.events.some((event) => event.method === "supervisor/approvalDecided"), false);
  } finally {
    await orchestrator.stop().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("PROVEN_STILL_RUNNING can be re-observed and only later termination clears quarantine", async () => {
  const { root, repository, orchestrator, fakeClient } = await fixture();
  try {
    const task = await orchestrator.startTask({
      workspace: repository,
      clientRequestId: "still-running-verifier-request",
      objective: "Keep a live verifier quarantined.",
      plan: ["Reconcile exact process identity"],
      acceptanceCriteria: ["Live verifier cannot release cleanup"]
    });
    fakeClient.emit("notification", {
      method: "turn/completed",
      params: { turn: { id: "turn-1", status: "completed", items: [] } }
    });
    await waitForStatus(orchestrator, task.id, "awaiting_verification");
    const current = orchestrator.getTask(task.id);
    const at = new Date().toISOString();
    const binding = await assertOciRuntimeAvailable(verificationConfig.runtime);
    const containerId = createHash("sha256").update(`live-${task.id}`).digest("hex");
    const labels = ociOwnershipLabels({
      taskId: task.id,
      runId: "live-run",
      workerId: "worker",
      recipeId: "check",
      imageDigest: verificationConfig.runtime.image,
      engine: "docker",
      engineNamespaceHash: binding.engineInstanceHash
    });
    await fs.mkdir(fakeOciStateRoot, { recursive: true });
    await fs.writeFile(path.join(fakeOciStateRoot, `${containerId}.json`), JSON.stringify({
      id: containerId,
      image: verificationConfig.runtime.image,
      running: true,
      pid: 4242,
      exitCode: 0,
      labels
    }));
    current.status = "blocked";
    current.statusHistory = [{
      transitionId: "blocked-by-run",
      from: "verifying",
      to: "blocked",
      reason: "lost verifier",
      source: "task-verify",
      at,
      verificationRunId: "live-run"
    }];
    current.verificationRuns = [{
      runId: "live-run",
      taskId: task.id,
      profileId: "test",
      recipeIds: ["check"],
      workerId: "worker",
      ownerInstanceId: "instance-test",
      leaseId: "live-lease",
      backend: "oci",
      engine: "docker",
      assurance: "high",
      pid: 999_999_999,
      containerId,
      containerIdHash: createHash("sha256").update(containerId).digest("hex"),
      containerImageDigest: verificationConfig.runtime.image,
      containerRecipeId: "check",
      containerLabelsHash: ociLabelsHash(labels),
      containerEngineNamespaceHash: binding.engineInstanceHash,
      containerOwnershipRecordedAt: at,
      startedAt: at,
      heartbeatAt: at,
      leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      beforeSnapshotId: current.snapshots!.at(-1)!.snapshotId,
      state: "lost"
    }];
    current.verifierLeases = [{
      leaseId: "live-lease",
      runId: "live-run",
      taskId: task.id,
      workerId: "worker",
      ownerInstanceId: "instance-test",
      acquiredAt: at,
      heartbeatAt: at,
      expiresAt: at,
      state: "lost"
    }];
    current.quarantines = [];
    const internalStore = (orchestrator as unknown as { store: TaskStore }).store;
    await internalStore.put(current);
    const proof = await orchestrator.reconcileVerifier({ taskId: task.id, runId: "live-run" });
    assert.equal(proof.result, "PROVEN_STILL_RUNNING");
    const reconciled = orchestrator.getTask(task.id);
    assert.equal(reconciled.verificationRuns?.find((run) => run.runId === "live-run")?.state, "running");
    assert.equal(reconciled.verifierLeases?.find((lease) => lease.runId === "live-run")?.state, "lost");
    assert.equal(reconciled.quarantines?.some((entry) => entry.runId === "live-run" && !entry.clearedAt), true);
    await assert.rejects(orchestrator.cleanupTask({ taskId: task.id }), /not eligible for worktree cleanup/);
    await fs.writeFile(path.join(fakeOciStateRoot, `${containerId}.json`), JSON.stringify({
      id: containerId,
      image: verificationConfig.runtime.image,
      running: false,
      pid: 0,
      exitCode: 0,
      labels
    }));
    const terminated = await orchestrator.reconcileVerifier({ taskId: task.id, runId: "live-run" });
    assert.equal(terminated.result, "PROVEN_TERMINATED");
    const released = orchestrator.getTask(task.id);
    assert.equal(released.status, "awaiting_verification");
    assert.equal(released.verificationRuns?.[0]?.state, "failed");
    assert.equal(released.verifierLeases?.[0]?.state, "terminal");
    assert.equal(released.quarantines?.some((entry) => !entry.clearedAt), false);
  } finally {
    await orchestrator.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("stop drains tail exit handling before the ledger flush completes", async () => {
  const client = new TailExitCodexClient();
  const { root, repository, orchestrator } = await fixture(
    verificationConfig,
    false,
    false,
    false,
    client
  );
  try {
    const task = await orchestrator.startTask({
      workspace: repository,
      clientRequestId: "stop-drain-request",
      objective: "Drain App Server tail events before releasing state.",
      plan: ["Stop"],
      acceptanceCriteria: ["Exit state is durable before stop returns"]
    });
    await orchestrator.stop();
    const current = orchestrator.getTask(task.id);
    assert.equal(current.status, "stale");
    assert.equal(current.turnLease?.state, "lost");
    const persisted = JSON.parse(await fs.readFile(path.join(root, "state", "state.json"), "utf8"));
    const persistedTask = persisted.tasks.find((entry: { id: string }) => entry.id === task.id);
    assert.equal(persistedTask.status, "stale");
    assert.equal(persistedTask.turnLease.state, "lost");
  } finally {
    await orchestrator.stop().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("contract path violations prevent verification", async () => {
  const { root, repository, orchestrator, fakeClient } = await fixture();
  try {
    const task = await orchestrator.startTask({
      workspace: repository,
      contract: {
        contractVersion: "1.0",
        clientRequestId: "contract-path-request",
        objective: "Respect path scope.",
        plan: ["Modify only src"],
        scope: { in: ["src"], out: [] },
        constraints: [],
        acceptanceCriteria: [{ id: "AC-1", description: "Only allowed files change" }],
        requiredVerificationRecipes: ["check"],
        allowedChangePaths: ["src/**"],
        forbiddenChangePaths: ["src/secret"],
        maxCorrectionPasses: 1
      }
    });
    await fs.mkdir(path.join(task.worktree!, "src", "secret"), { recursive: true });
    await fs.writeFile(path.join(task.worktree!, "src", "secret", "key.ts"), "forbidden\n");
    fakeClient.emit("notification", {
      method: "turn/completed",
      params: { turn: { id: "turn-1", status: "completed", items: [] } }
    });
    await waitForStatus(orchestrator, task.id, "awaiting_verification");
    await assert.rejects(
      orchestrator.verifyTask({ taskId: task.id, profileId: "test" }),
      /violate Development Contract path constraints/
    );
  } finally {
    await orchestrator.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("acceptance recaptures the live worktree and rejects post-verification changes", async () => {
  const { root, repository, orchestrator, fakeClient } = await fixture();
  try {
    const task = await orchestrator.startTask({
      workspace: repository,
      clientRequestId: "acceptance-toctou-request",
      objective: "Reject stale acceptance evidence.",
      plan: ["Verify then inspect live state"],
      acceptanceCriteria: ["No changes occur after verification"]
    });
    fakeClient.emit("notification", {
      method: "turn/completed",
      params: { turn: { id: "turn-1", status: "completed", items: [] } }
    });
    await waitForStatus(orchestrator, task.id, "awaiting_verification");
    await orchestrator.verifyTask({ taskId: task.id, profileId: "test" });
    const expectedSnapshotId = orchestrator.getTask(task.id).snapshots?.at(-1)?.snapshotId;
    assert.ok(expectedSnapshotId);
    await fs.writeFile(path.join(task.worktree!, "late.txt"), "late mutation\n");
    await assert.rejects(
      orchestrator.decideTask({
        taskId: task.id,
        decision: "accept",
        rationale: "must be current",
        expectedSnapshotId,
        criterionConfirmations: [{ criterionId: "AC-1", evidence: "Reviewed before late mutation" }]
      }),
      /changed after verification/
    );
    assert.equal(orchestrator.getTask(task.id).status, "needs_correction");
  } finally {
    await orchestrator.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("optional recipe failure cannot satisfy a contract recipe", async () => {
  const configWithOptionalFailure: VerificationConfig = {
    ...verificationConfig,
    profiles: {
      test: {
        recipes: [
          ...verificationConfig.profiles.test.recipes,
          {
            id: "optional-check",
            program: process.execPath,
            args: ["-e", "process.exit(1)"],
            cwd: ".",
            timeoutMs: 5_000,
            required: false
          }
        ]
      }
    }
  };
  const { root, repository, orchestrator, fakeClient } = await fixture(configWithOptionalFailure);
  try {
    const task = await orchestrator.startTask({
      workspace: repository,
      contract: {
        contractVersion: "1.0",
        clientRequestId: "optional-recipe-request",
        objective: "Prove optional failures cannot satisfy explicit contract evidence.",
        plan: ["Verify"],
        scope: { in: ["verification"], out: [] },
        constraints: [],
        acceptanceCriteria: [{ id: "AC-1", description: "Optional check passes" }],
        requiredVerificationRecipes: ["optional-check"],
        maxCorrectionPasses: 1
      }
    });
    fakeClient.emit("notification", {
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } }
    });
    await waitForStatus(orchestrator, task.id, "awaiting_verification");
    const run = await orchestrator.verifyTask({ taskId: task.id, profileId: "test" });
    assert.equal(run.state, "passed");
    assert.equal(orchestrator.getTask(task.id).acceptanceEvidence?.[0]?.satisfied, false);
    const expectedSnapshotId = orchestrator.getTask(task.id).snapshots?.at(-1)?.snapshotId;
    assert.ok(expectedSnapshotId);
    await assert.rejects(
      orchestrator.decideTask({
        taskId: task.id,
        decision: "accept",
        rationale: "must fail closed",
        expectedSnapshotId,
        criterionConfirmations: [{ criterionId: "AC-1", evidence: "Optional check failed" }]
      }),
      /no current snapshot-bound verification candidate/
    );
  } finally {
    await orchestrator.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("restart restores a lost writer lease and exact terminal recovery releases it", async () => {
  const { root, repository, orchestrator } = await fixture();
  let restarted: Orchestrator | undefined;
  try {
    const task = await orchestrator.startTask({
      workspace: repository,
      clientRequestId: "restart-recovery-request",
      objective: "Recover an exact prior-runtime turn lease.",
      plan: ["Recover"],
      acceptanceCriteria: ["Only exact terminal evidence releases the writer"]
    });
    const priorLeaseId = task.turnLease?.leaseId;
    assert.ok(priorLeaseId);
    await orchestrator.stop();

    const fakeClient = new FakeCodexClient(false, "turn-2");
    restarted = new Orchestrator(config(root), {
      client: fakeClient as never,
      store: new TaskStore(path.join(root, "state", "state.json")),
      instanceLock: {
        instanceId: "instance-restarted",
        acquire: async () => ({ instanceId: "instance-restarted" }),
        release: async () => undefined
      } as never,
      verificationConfig,
      runtimeProbe: async () => ({
        checkedAt: new Date().toISOString(),
        version: "codex-test 1.0.0",
        schemaHash: "a".repeat(64),
        schemaFileCount: 1,
        schemaGeneration: { command: "codex app-server generate-json-schema", isolatedTemporaryDirectory: true },
        experimentalApiRequested: false,
        capabilities: evaluateProtocolCapabilities([
          "initialize", "initialized", "account/read", "thread/start", "thread/resume", "thread/read",
          "turn/start", "turn/steer", "turn/interrupt", "turn/started", "turn/completed",
          "item/commandExecution/requestApproval", "item/fileChange/requestApproval"
        ])
      })
    });
    await restarted.init();
    assert.equal(restarted.getTask(task.id).turnLease?.state, "lost");
    const recovered = await restarted.recoverTask({ taskId: task.id });
    assert.equal(recovered.turnLease?.state, "terminal");
    const continued = await restarted.continueTask({ taskId: task.id, instruction: "continue after exact proof" });
    assert.equal(continued.status, "running");
    assert.notEqual(continued.turnLease?.leaseId, priorLeaseId);
    const resumeRequest = fakeClient.requests.find((entry) => entry.method === "thread/resume");
    assert.ok(resumeRequest);
    const resumeParams = resumeRequest.params as Record<string, unknown>;
    assert.equal(resumeParams.approvalPolicy, "untrusted");
    assert.equal(resumeParams.sandbox, "workspace-write");
    assert.equal(resumeParams.approvalsReviewer, "user");
  } finally {
    if (restarted) await restarted.stop().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("temporary OCI runtime unavailability leaves verification retryable and creates no run", async () => {
  const unavailable: VerificationConfig = structuredClone(verificationConfig);
  unavailable.runtime.engineExecutable = path.join(os.tmpdir(), `missing-oci-${randomUUID()}.exe`);
  const { root, repository, orchestrator, fakeClient } = await fixture(unavailable);
  try {
    const task = await orchestrator.startTask({
      workspace: repository,
      clientRequestId: "runtime-retry-request",
      objective: "Keep verification retryable while the OCI runtime is temporarily unavailable.",
      plan: ["Verify"],
      acceptanceCriteria: ["Runtime recovery permits a retry"]
    });
    fakeClient.emit("notification", {
      method: "turn/completed",
      params: { turn: { id: "turn-1", status: "completed", items: [] } }
    });
    await waitForStatus(orchestrator, task.id, "awaiting_verification");
    await assert.rejects(
      orchestrator.verifyTask({ taskId: task.id, profileId: "test" }),
      (error: unknown) => (error as { code?: string }).code === "RUNTIME_UNAVAILABLE"
    );
    const retryable = orchestrator.getTask(task.id);
    assert.equal(retryable.status, "awaiting_verification");
    assert.equal(retryable.verificationRuns?.length ?? 0, 0);
    assert.equal(retryable.verifierLeases?.length ?? 0, 0);
    assert.equal(retryable.quarantines?.filter((entry) => !entry.clearedAt).length ?? 0, 0);

    unavailable.runtime.engineExecutable = process.execPath;
    const run = await orchestrator.verifyTask({ taskId: task.id, profileId: "test" });
    assert.equal(run.state, "passed");
  } finally {
    await orchestrator.stop().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("restart recovers a pre-container verifier run and exact run-wide absence permits retry", async () => {
  const { root, repository, orchestrator, fakeClient } = await fixture();
  let restarted: Orchestrator | undefined;
  try {
    const task = await orchestrator.startTask({
      workspace: repository,
      clientRequestId: "pre-container-restart-request",
      objective: "Recover a verifier crash before any container ownership event.",
      plan: ["Verify"],
      acceptanceCriteria: ["Run-wide absence is proven"]
    });
    fakeClient.emit("notification", {
      method: "turn/completed",
      params: { turn: { id: "turn-1", status: "completed", items: [] } }
    });
    await waitForStatus(orchestrator, task.id, "awaiting_verification");
    const current = orchestrator.getTask(task.id);
    const binding = await assertOciRuntimeAvailable(verificationConfig.runtime);
    const runId = randomUUID();
    const workerId = randomUUID();
    const leaseId = randomUUID();
    const at = new Date(0).toISOString();
    current.status = "verifying";
    current.statusHistory = [{
      transitionId: randomUUID(),
      from: "awaiting_verification",
      to: "verifying",
      reason: "synthetic crash before worker ownership",
      source: "task-verify",
      at,
      verificationRunId: runId
    }];
    current.verificationRuns = [{
      runId,
      taskId: task.id,
      profileId: "test",
      recipeIds: ["check"],
      workerId,
      ownerInstanceId: "instance-test",
      leaseId,
      backend: "oci",
      engine: "docker",
      assurance: "high",
      containerImageDigest: verificationConfig.runtime.image,
      containerEngineNamespaceHash: binding.engineInstanceHash,
      startedAt: at,
      heartbeatAt: at,
      leaseExpiresAt: at,
      beforeSnapshotId: current.snapshots!.at(-1)!.snapshotId,
      state: "starting"
    }];
    current.verifierLeases = [{
      leaseId,
      runId,
      taskId: task.id,
      workerId,
      ownerInstanceId: "instance-test",
      acquiredAt: at,
      heartbeatAt: at,
      expiresAt: at,
      state: "active"
    }];
    await (orchestrator as unknown as { store: TaskStore }).store.put(current);
    await orchestrator.stop();

    restarted = restartedOrchestrator(root);
    await restarted.init();
    const blocked = restarted.getTask(task.id);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.verificationRuns?.[0]?.state, "lost");
    assert.equal(blocked.verifierLeases?.[0]?.state, "lost");
    assert.equal(blocked.quarantines?.some((entry) => entry.runId === runId && !entry.clearedAt), true);

    const proof = await restarted.reconcileVerifier({ taskId: task.id, runId });
    assert.equal(proof.result, "PROVEN_TERMINATED");
    const recovered = restarted.getTask(task.id);
    assert.equal(recovered.status, "awaiting_verification");
    assert.equal(recovered.verificationRuns?.[0]?.state, "failed");
    assert.equal(recovered.verifierLeases?.[0]?.state, "terminal");
    assert.equal(recovered.quarantines?.some((entry) => entry.runId === runId && !entry.clearedAt), false);
  } finally {
    await restarted?.stop().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("restart invalidates a contradictory active lease bound to a terminal verifier run", async () => {
  const { root, repository, orchestrator, fakeClient } = await fixture();
  let restarted: Orchestrator | undefined;
  try {
    const task = await orchestrator.startTask({
      workspace: repository,
      clientRequestId: "terminal-lease-restart-request",
      objective: "Normalize a prior-runtime lease after complete terminal OCI evidence.",
      plan: ["Verify"],
      acceptanceCriteria: ["No active prior-runtime verifier lease survives"]
    });
    fakeClient.emit("notification", {
      method: "turn/completed",
      params: { turn: { id: "turn-1", status: "completed", items: [] } }
    });
    await waitForStatus(orchestrator, task.id, "awaiting_verification");
    const passed = await orchestrator.verifyTask({ taskId: task.id, profileId: "test" });
    assert.equal(passed.state, "passed");
    const current = orchestrator.getTask(task.id);
    current.status = "verifying";
    current.statusHistory!.push({
      transitionId: randomUUID(),
      from: "awaiting_verification",
      to: "verifying",
      reason: "synthetic crash after terminal run persistence",
      source: "task-verify",
      at: new Date().toISOString(),
      verificationRunId: passed.runId
    });
    current.verifierLeases![0]!.state = "active";
    await (orchestrator as unknown as { store: TaskStore }).store.put(current);
    await orchestrator.stop();

    restarted = restartedOrchestrator(root);
    await restarted.init();
    const recovered = restarted.getTask(task.id);
    assert.equal(recovered.status, "awaiting_verification");
    assert.equal(recovered.verifierLeases?.[0]?.state, "terminal");
    assert.equal(recovered.verificationRuns?.[0]?.stale, true);
    assert.deepEqual(recovered.acceptanceEvidence, []);
    assert.equal(recovered.quarantines?.some((entry) => !entry.clearedAt) ?? false, false);
    assert.equal(recovered.residualRisks?.includes("prior_runtime_terminal_verifier_lease_normalized"), true);
  } finally {
    await restarted?.stop().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("restart distinguishes no verifier ownership from an orphan active verifier lease", async () => {
  const { root, repository, orchestrator, fakeClient } = await fixture();
  let restarted: Orchestrator | undefined;
  try {
    const noOwnership = await orchestrator.startTask({
      workspace: repository,
      clientRequestId: "no-verifier-ownership-request",
      objective: "Retry when no verifier ownership was ever durable.",
      plan: ["Verify"],
      acceptanceCriteria: ["Retry is available"]
    });
    fakeClient.emit("notification", {
      method: "turn/completed",
      params: { turn: { id: "turn-1", status: "completed", items: [] } }
    });
    await waitForStatus(orchestrator, noOwnership.id, "awaiting_verification");
    const current = orchestrator.getTask(noOwnership.id);
    current.status = "verifying";
    current.statusHistory!.push({
      transitionId: randomUUID(),
      from: "awaiting_verification",
      to: "verifying",
      reason: "synthetic crash before run persistence",
      source: "task-verify",
      at: new Date().toISOString()
    });
    await (orchestrator as unknown as { store: TaskStore }).store.put(current);
    await orchestrator.stop();

    restarted = restartedOrchestrator(root);
    await restarted.init();
    const retryable = restarted.getTask(noOwnership.id);
    assert.equal(retryable.status, "awaiting_verification");
    assert.equal(retryable.residualRisks?.includes("prior_runtime_verification_interrupted_before_ownership"), true);
    await restarted.stop();

    const orphanStore = new TaskStore(path.join(root, "state", "state.json"));
    await orphanStore.load();
    const orphan = orphanStore.get(noOwnership.id)!;
    const orphanRunId = randomUUID();
    orphan.status = "verifying";
    orphan.verifierLeases = [{
      leaseId: randomUUID(),
      runId: orphanRunId,
      taskId: orphan.id,
      workerId: randomUUID(),
      ownerInstanceId: "prior-instance",
      acquiredAt: new Date(0).toISOString(),
      heartbeatAt: new Date(0).toISOString(),
      expiresAt: new Date(0).toISOString(),
      state: "active"
    }];
    await orphanStore.put(orphan);
    restarted = restartedOrchestrator(root);
    await restarted.init();
    const blocked = restarted.getTask(noOwnership.id);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.verifierLeases?.[0]?.state, "lost");
    assert.equal(blocked.quarantines?.some((entry) => entry.runId === orphanRunId && !entry.clearedAt), true);
  } finally {
    await restarted?.stop().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});
