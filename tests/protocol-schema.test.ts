import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectProtocolMethods,
  encodeCodexWireMessage,
  parseCodexWireMessage,
  protocolSchemaHash,
  readProtocolSchemaBundle,
  validateRequiredProtocolShapes
} from "../src/codex/protocol-schema.js";

test("wire parser enforces Codex JSONL shape without jsonrpc", () => {
  assert.deepEqual(parseCodexWireMessage('{"method":"initialized","params":{}}'), {
    method: "initialized",
    params: {}
  });
  assert.equal(encodeCodexWireMessage({ method: "initialized", params: {} }), '{"method":"initialized","params":{}}\n');
  assert.throws(
    () => parseCodexWireMessage('{"jsonrpc":"2.0","method":"initialized","params":{}}'),
    /must omit/
  );
  assert.throws(() => parseCodexWireMessage('{"id":1,"result":{},"error":{}}'), /exactly one/);
  assert.throws(() => parseCodexWireMessage('{"method":"x","id":1,"result":{}}'), /cannot contain/);
});

test("schema hash is canonical and method collection follows method properties", () => {
  const first = { z: [{ properties: { method: { const: "thread/read" } } }], a: 1 };
  const second = { a: 1, z: [{ properties: { method: { const: "thread/read" } } }] };
  assert.equal(protocolSchemaHash(first), protocolSchemaHash(second));
  assert.deepEqual([...collectProtocolMethods(first)], ["thread/read"]);
});

test("generated schema bundle hash is stable across file creation order", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-schema-test-"));
  try {
    await fs.writeFile(path.join(directory, "z.json"), JSON.stringify({ properties: { method: { enum: ["turn/start"] } } }));
    await fs.writeFile(path.join(directory, "a.json"), JSON.stringify({ properties: { method: { const: "initialize" } } }));
    const bundle = await readProtocolSchemaBundle(directory);
    assert.deepEqual(Object.keys(bundle.files), ["a.json", "z.json"]);
    assert.deepEqual(bundle.methods, ["initialize", "turn/start"]);
    assert.match(bundle.hash, /^[a-f0-9]{64}$/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("stable shape gate validates nested turn and approval fields", () => {
  const turn = {
    required: ["id", "status"],
    properties: { id: { type: "string" }, status: { enum: ["completed", "failed"] } }
  };
  const approval = {
    required: ["itemId", "threadId", "turnId"],
    properties: {
      itemId: { type: "string" },
      threadId: { type: "string" },
      turnId: { type: "string" }
    }
  };
  const decision = {
    required: ["decision"],
    properties: { decision: { enum: ["accept", "decline", "cancel"] } }
  };
  const files = {
    "InitializeParams.json": {
      required: ["clientInfo"],
      properties: {
        clientInfo: {
          required: ["name", "version"],
          properties: { name: { type: "string" }, version: { type: "string" } }
        }
      }
    },
    "ThreadStartParams.json": {
      properties: {
        approvalPolicy: { enum: ["untrusted", "on-request", "never"] },
        sandbox: { enum: ["read-only", "workspace-write", "danger-full-access"] },
        approvalsReviewer: { enum: ["user", "auto_review"] }
      }
    },
    "TurnStartedNotification.json": { required: ["turn"], properties: { turn } },
    "TurnCompletedNotification.json": { required: ["turn"], properties: { turn } },
    "CommandExecutionRequestApprovalParams.json": approval,
    "CommandExecutionRequestApprovalResponse.json": decision,
    "FileChangeRequestApprovalParams.json": approval,
    "FileChangeRequestApprovalResponse.json": decision
  };
  const valid = validateRequiredProtocolShapes(files);
  assert.equal(valid.compatible, true);
  assert.equal(valid.validatedShapes.length, 8);

  const malformed: Record<string, any> = structuredClone(files);
  malformed["TurnCompletedNotification.json"].properties.turn = {
    required: ["id"],
    properties: { id: { type: "string" } }
  };
  const invalid = validateRequiredProtocolShapes(malformed);
  assert.equal(invalid.compatible, false);
  assert.match(invalid.shapeErrors.join("\n"), /TurnCompletedNotification\.turn\.status/);
});

test("schema bundle reader rejects excessive file count and file size before parsing", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-schema-limits-"));
  try {
    await fs.writeFile(path.join(directory, "a.json"), "{}");
    await fs.writeFile(path.join(directory, "b.json"), "{}");
    await assert.rejects(
      readProtocolSchemaBundle(directory, { maxFiles: 1 }),
      /exceeds 1 JSON files/
    );

    await fs.rm(path.join(directory, "b.json"));
    await fs.writeFile(path.join(directory, "a.json"), JSON.stringify({ payload: "x".repeat(128) }));
    await assert.rejects(
      readProtocolSchemaBundle(directory, { maxFileBytes: 32 }),
      /file exceeds 32 bytes/
    );

    await fs.writeFile(path.join(directory, "a.json"), "{}");
    await fs.writeFile(path.join(directory, "b.json"), "{}");
    await assert.rejects(
      readProtocolSchemaBundle(directory, { maxFileBytes: 2, maxTotalBytes: 3 }),
      /exceeds 3 total bytes/
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("schema bundle reader refuses symbolic links instead of following them", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-schema-link-"));
  const target = path.join(directory, "target");
  const linked = path.join(directory, "linked.json");
  try {
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "schema.json"), "{}");
    try {
      await fs.symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
        t.skip(`symbolic-link creation unavailable: ${code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(readProtocolSchemaBundle(directory), /contains a symbolic link/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
