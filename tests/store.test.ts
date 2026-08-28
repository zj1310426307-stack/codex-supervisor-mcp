import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskStore } from "../src/core/store.js";
import { normalizeStartTaskInput } from "../src/core/contracts.js";
import type { TaskRecord } from "../src/types.js";

function task(id: string): TaskRecord {
  const now = new Date().toISOString();
  return {
    id,
    objective: `task-${id}`,
    workspace: "/tmp/repo",
    status: "completed",
    createdAt: now,
    updatedAt: now,
    eventSeq: 0,
    events: [],
    pendingApprovalIds: []
  };
}

function modernTask(id: string, workspace: string, clientRequestId = `request-${id}`): TaskRecord {
  const normalized = normalizeStartTaskInput({
    workspace,
    objective: `task-${id}`,
    plan: ["implement"],
    acceptanceCriteria: ["pass"],
    clientRequestId
  });
  return {
    ...task(id),
    objective: normalized.contract.objective,
    workspace,
    sourceWorkspace: workspace,
    contract: normalized.contract,
    contractHash: normalized.contractHash
  };
}

test("task store serializes concurrent writes without corrupting the ledger", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-store-"));
  const file = path.join(dir, "state.json");
  const store = new TaskStore(file);
  await Promise.all([store.put(task("a")), store.put(task("b")), store.put(task("c"))]);
  const parsed = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(parsed.version, 3);
  assert.deepEqual(new Set(parsed.tasks.map((value: TaskRecord) => value.id)), new Set(["a", "b", "c"]));
  assert.equal(Object.keys(parsed.idempotency).length, 3);
  assert.equal((await fs.readdir(dir)).some((name) => name.endsWith(".tmp")), false);

  const reloaded = new TaskStore(file);
  await reloaded.load();
  assert.deepEqual(new Set(reloaded.list().map((value) => value.id)), new Set(["a", "b", "c"]));
});

test("active tasks become stale after supervisor restart", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-store-"));
  const file = path.join(dir, "state.json");
  const running = task("running");
  running.status = "running";
  running.pendingApprovalIds = ["approval-1"];
  await fs.writeFile(file, JSON.stringify({ version: 1, tasks: [running] }));

  const second = new TaskStore(file);
  await second.load();
  assert.equal(second.get("running")?.status, "stale");
  assert.deepEqual(second.get("running")?.pendingApprovalIds, []);
  const migrated = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(migrated.version, 3);
  assert.equal(Object.keys(migrated.idempotency).length, 1);
  assert.equal((await fs.readdir(dir)).some((name) => name.includes(".v1.") && name.endsWith(".bak")), true);
});

test("v1 completed and v2 interrupted verifier records migrate fail closed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-store-"));
  const v1File = path.join(dir, "v1.json");
  await fs.writeFile(v1File, JSON.stringify({ version: 1, tasks: [{ ...task("old"), status: "completed" }] }));
  const v1 = new TaskStore(v1File);
  await v1.load();
  assert.equal(v1.get("old")?.status, "legacy_unverified");

  const v2File = path.join(dir, "v2.json");
  await fs.writeFile(v2File, JSON.stringify({ version: 2, tasks: [{ ...task("verify"), status: "verifying" }], idempotency: {} }));
  const v2 = new TaskStore(v2File);
  await v2.load();
  assert.equal(v2.get("verify")?.status, "blocked");
  assert.equal(v2.get("verify")?.legacyUnreconciledVerifier, true);
  assert.deepEqual(v2.get("verify")?.residualRisks, ["legacy_unreconciled_verifier"]);
  assert.equal(Object.keys(JSON.parse(await fs.readFile(v2File, "utf8")).idempotency).length, 1);
});

test("v1 and v2 ready records never retain v3 acceptance authority", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-store-"));
  for (const version of [1, 2] as const) {
    const file = path.join(dir, `v${version}-ready.json`);
    await fs.writeFile(file, JSON.stringify({
      version,
      tasks: [{
        ...task(`ready-${version}`),
        status: "ready_for_human_review",
        acceptanceEvidence: [{ satisfied: true }],
        verificationRuns: [{ state: "passed", stale: false }]
      }],
      idempotency: {}
    }));
    const migrated = new TaskStore(file);
    await migrated.load();
    const value = migrated.get(`ready-${version}`)!;
    assert.equal(value.status, "legacy_unverified");
    assert.deepEqual(value.acceptanceEvidence, []);
    assert.equal(value.verificationRuns?.[0]?.stale, true);
    assert.ok(value.residualRisks?.includes("legacy_ready_requires_reverification"));
  }
});

test("idempotent task creation returns identical retry and rejects semantic drift", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-store-"));
  const store = new TaskStore(path.join(dir, "state.json"));
  await assert.rejects(
    store.putWithIdempotency(task("missing-client-request-id")),
    /requires clientRequestId/
  );
  const normalized = normalizeStartTaskInput({
    workspace: dir,
    objective: "one",
    plan: ["implement"],
    acceptanceCriteria: ["pass"],
    clientRequestId: "request"
  });
  const first = task("first");
  first.workspace = dir;
  first.sourceWorkspace = dir;
  first.contract = normalized.contract;
  first.contractHash = normalized.contractHash;
  first.objective = normalized.contract.objective;
  const created = await store.putWithIdempotency(first);
  const duplicate = await store.putWithIdempotency({ ...first, id: "duplicate" });
  assert.equal(created.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.task.id, "first");

  await assert.rejects(
    store.putWithIdempotency({ ...first, id: "mismatched-explicit" }, "another-request"),
    /must match contract\.clientRequestId/
  );

  const changed = normalizeStartTaskInput({
    workspace: dir,
    objective: "different",
    plan: ["implement"],
    acceptanceCriteria: ["pass"],
    clientRequestId: "request"
  });
  await assert.rejects(
    store.putWithIdempotency({
      ...first,
      id: "changed",
      objective: changed.contract.objective,
      contract: changed.contract,
      contractHash: changed.contractHash
    }),
    (error: unknown) => (error as { code?: string; statusCode?: number }).code === "IDEMPOTENCY_CONFLICT" &&
      (error as { statusCode?: number }).statusCode === 409
  );
});

test("v3 load rejects tampered, missing, orphaned and duplicate idempotency mappings", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-store-"));
  const originalFile = path.join(dir, "original.json");
  const originalStore = new TaskStore(originalFile);
  await originalStore.putWithIdempotency(modernTask("bound", dir));
  const original = JSON.parse(await fs.readFile(originalFile, "utf8"));
  const [canonicalKey] = Object.keys(original.idempotency);

  const cases: Array<{ name: string; mutate: (ledger: any) => void; pattern: RegExp }> = [
    {
      name: "missing",
      mutate: (ledger) => { ledger.idempotency = {}; },
      pattern: /missing an idempotency mapping/
    },
    {
      name: "wrong-key",
      mutate: (ledger) => {
        ledger.idempotency["0".repeat(64)] = ledger.idempotency[canonicalKey];
        delete ledger.idempotency[canonicalKey];
      },
      pattern: /key is not canonical/
    },
    {
      name: "wrong-source",
      mutate: (ledger) => { ledger.idempotency[canonicalKey].sourceWorkspace = path.join(dir, "other"); },
      pattern: /does not match its task/
    },
    {
      name: "wrong-hash",
      mutate: (ledger) => { ledger.idempotency[canonicalKey].contractHash = "0".repeat(64); },
      pattern: /does not match its task/
    },
    {
      name: "wrong-created-at",
      mutate: (ledger) => { ledger.idempotency[canonicalKey].createdAt = "2000-01-01T00:00:00.000Z"; },
      pattern: /does not match its task/
    },
    {
      name: "orphan",
      mutate: (ledger) => { ledger.idempotency[canonicalKey].taskId = "missing-task"; },
      pattern: /references a missing task/
    },
    {
      name: "duplicate",
      mutate: (ledger) => { ledger.idempotency["f".repeat(64)] = { ...ledger.idempotency[canonicalKey] }; },
      pattern: /key is not canonical|more than once/
    }
  ];

  for (const item of cases) {
    const ledger = structuredClone(original);
    item.mutate(ledger);
    const file = path.join(dir, `${item.name}.json`);
    await fs.writeFile(file, JSON.stringify(ledger));
    await assert.rejects(new TaskStore(file).load(), item.pattern, item.name);
  }
});

test("put preserves immutable task identity", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-store-"));
  const store = new TaskStore(path.join(dir, "state.json"));
  const original = modernTask("immutable", dir, "request");
  await store.putWithIdempotency(original);

  await assert.rejects(
    store.put({ ...store.get(original.id)!, sourceWorkspace: path.join(dir, "other") }),
    /identity is immutable/
  );

  const changedSemantics = modernTask("immutable", dir, "request");
  const changedContract = normalizeStartTaskInput({
    workspace: dir,
    objective: "changed objective",
    plan: ["implement"],
    acceptanceCriteria: ["pass"],
    clientRequestId: "request"
  });
  changedSemantics.contract = changedContract.contract;
  changedSemantics.contractHash = changedContract.contractHash;
  changedSemantics.createdAt = original.createdAt;
  changedSemantics.updatedAt = original.updatedAt;
  await assert.rejects(store.put(changedSemantics), /identity is immutable/);

  const changedRequest = modernTask("immutable", dir, "different-request");
  changedRequest.createdAt = original.createdAt;
  changedRequest.updatedAt = original.updatedAt;
  await assert.rejects(store.put(changedRequest), /identity is immutable/);

  const unchanged = store.get(original.id)!;
  unchanged.status = "running";
  unchanged.updatedAt = new Date(Date.now() + 1_000).toISOString();
  await store.put(unchanged);
  const reloaded = new TaskStore(path.join(dir, "state.json"));
  await reloaded.load();
  assert.equal(reloaded.get(original.id)?.status, "running");
});

test("store clones reads, rolls back failed persistence and rejects a forged contract hash", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-store-"));
  const file = path.join(dir, "state.json");
  const store = new TaskStore(file);
  await store.put(task("clone"));
  const read = store.get("clone")!;
  read.objective = "mutated outside the store";
  assert.notEqual(store.get("clone")?.objective, read.objective);

  const failing = new TaskStore(dir);
  await assert.rejects(failing.put(task("rollback")));
  assert.equal(failing.get("rollback"), undefined);

  const parsed = JSON.parse(await fs.readFile(file, "utf8"));
  parsed.tasks[0].contractHash = "0".repeat(64);
  await fs.writeFile(file, JSON.stringify(parsed));
  await assert.rejects(new TaskStore(file).load(), /contract hash does not match/);
});
