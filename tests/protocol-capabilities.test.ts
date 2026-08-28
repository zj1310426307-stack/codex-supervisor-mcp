import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  assertProtocolCapabilities,
  assertProtocolRuntimeBinding,
  evaluateProtocolCapabilities
} from "../src/codex/protocol-capabilities.js";
import { officialNpmNativeCandidates, resolveCodexCommand } from "../src/codex/command-resolution.js";
import { REQUIRED_STABLE_CLIENT_METHODS, REQUIRED_STABLE_SERVER_METHODS } from "../src/codex/protocol-values.js";
import { probeCodexRuntime } from "../src/codex/runtime-probe.js";

function requiredShapeSchemas(): Record<string, unknown> {
  const turn = {
    type: "object",
    required: ["id", "status"],
    properties: { id: { type: "string" }, status: { enum: ["inProgress", "completed", "failed"] } }
  };
  const approval = {
    type: "object",
    required: ["itemId", "threadId", "turnId"],
    properties: {
      itemId: { type: "string" },
      threadId: { type: "string" },
      turnId: { type: "string" }
    }
  };
  const decision = {
    type: "object",
    required: ["decision"],
    properties: { decision: { enum: ["accept", "acceptForSession", "decline", "cancel"] } }
  };
  return {
    "InitializeParams.json": {
      title: "InitializeParams",
      type: "object",
      required: ["clientInfo"],
      properties: {
        clientInfo: {
          type: "object",
          required: ["name", "version"],
          properties: { name: { type: "string" }, version: { type: "string" } }
        }
      }
    },
    "TurnStartedNotification.json": {
      title: "TurnStartedNotification",
      type: "object",
      required: ["turn"],
      properties: { turn }
    },
    "TurnCompletedNotification.json": {
      title: "TurnCompletedNotification",
      type: "object",
      required: ["turn"],
      properties: { turn }
    },
    "CommandExecutionRequestApprovalParams.json": {
      title: "CommandExecutionRequestApprovalParams",
      ...approval
    },
    "CommandExecutionRequestApprovalResponse.json": {
      title: "CommandExecutionRequestApprovalResponse",
      ...decision
    },
    "FileChangeRequestApprovalParams.json": {
      title: "FileChangeRequestApprovalParams",
      ...approval
    },
    "FileChangeRequestApprovalResponse.json": {
      title: "FileChangeRequestApprovalResponse",
      ...decision
    }
  };
}

async function writeProbeSchemas(output: string, methods: readonly string[]): Promise<void> {
  await fs.writeFile(path.join(output, "protocol.json"), JSON.stringify({
    oneOf: methods.map((method) => ({ properties: { method: { const: method } } }))
  }));
  await Promise.all(Object.entries(requiredShapeSchemas()).map(([name, schema]) => (
    fs.writeFile(path.join(output, name), JSON.stringify(schema))
  )));
}

test("stable capability gate reports exact missing methods", () => {
  const available = [
    ...REQUIRED_STABLE_CLIENT_METHODS.filter((method) => method !== "turn/steer"),
    ...REQUIRED_STABLE_SERVER_METHODS
  ];
  const report = evaluateProtocolCapabilities(available);
  assert.equal(report.compatible, false);
  assert.deepEqual(report.missingMethods, ["turn/steer"]);
  assert.deepEqual(report.missingServerMethods, []);
  assert.throws(() => assertProtocolCapabilities(report), /turn\/steer/);
});

test("experimental methods are visible but disabled unless explicitly enabled", () => {
  const methods = [...REQUIRED_STABLE_CLIENT_METHODS, ...REQUIRED_STABLE_SERVER_METHODS, "thread/turns/list"];
  const stable = evaluateProtocolCapabilities(methods);
  assert.deepEqual(stable.excludedExperimentalMethods, ["thread/turns/list"]);
  const experimental = evaluateProtocolCapabilities(methods, { experimentalApi: true });
  assert.deepEqual(experimental.excludedExperimentalMethods, []);
  assert.equal(experimental.compatible, true);
});

test("a runtime binding cannot claim compatibility without validated stable shapes", () => {
  const methodsOnly = evaluateProtocolCapabilities([
    ...REQUIRED_STABLE_CLIENT_METHODS,
    ...REQUIRED_STABLE_SERVER_METHODS
  ]);
  assert.equal(methodsOnly.compatible, true);
  assert.throws(() => assertProtocolRuntimeBinding({
    version: "codex-cli test",
    schemaHash: "a".repeat(64),
    capabilities: methodsOnly
  }), /missing validated schema shapes/);
});

test("CODEX_BIN wins over npm native, then npm native wins over PATH", () => {
  const explicit = resolveCodexCommand({
    configured: "C:\\tools\\codex.exe",
    platform: "win32",
    arch: "x64",
    npmRoots: ["C:\\npm\\node_modules"],
    exists: (candidate) => candidate === "C:\\tools\\codex.exe"
  });
  assert.equal(explicit.source, "explicit");

  const roots = ["C:\\npm\\node_modules"];
  const [native] = officialNpmNativeCandidates(roots, "win32", "x64");
  const npm = resolveCodexCommand({ platform: "win32", arch: "x64", npmRoots: roots, exists: (candidate) => candidate === native });
  assert.equal(npm.source, "npm-native");
  assert.equal(npm.command, native);

  const fallback = resolveCodexCommand({ platform: "win32", arch: "x64", npmRoots: roots, exists: () => false });
  assert.deepEqual({ command: fallback.command, source: fallback.source }, { command: "codex.exe", source: "path" });
});

test("runtime probe generates a version-specific schema and enforces both protocol directions", async () => {
  const methods = [...REQUIRED_STABLE_CLIENT_METHODS, ...REQUIRED_STABLE_SERVER_METHODS];
  const runner = async (_command: string, args: string[], _timeoutMs: number) => {
    if (args[0] === "--version") return "codex-cli test";
    const output = args[args.indexOf("--out") + 1];
    await writeProbeSchemas(output, methods);
    return "";
  };
  const result = await probeCodexRuntime({ codexBin: "fake-codex", runner });
  assert.equal(result.version, "codex-cli test");
  assert.equal(result.capabilities.compatible, true);
  assert.equal(result.capabilities.validatedShapes.length, 7);
  assert.equal(result.binding?.version, "codex-cli test");
  assert.match(result.schemaHash, /^[a-f0-9]{64}$/);

  await assert.rejects(probeCodexRuntime({
    codexBin: "fake-codex",
    runner: async (command, args, timeout) => {
      if (args[0] === "--version") return runner(command, args, timeout);
      const output = args[args.indexOf("--out") + 1];
      await writeProbeSchemas(output, REQUIRED_STABLE_CLIENT_METHODS);
      return "";
    }
  }), /commandExecution\/requestApproval/);

  await assert.rejects(probeCodexRuntime({
    codexBin: "fake-codex",
    runner: async (command, args, timeout) => {
      if (args[0] === "--version") return runner(command, args, timeout);
      const output = args[args.indexOf("--out") + 1];
      await writeProbeSchemas(output, methods);
      await fs.writeFile(path.join(output, "TurnCompletedNotification.json"), JSON.stringify({
        required: ["turn"],
        properties: {
          turn: { required: ["id"], properties: { id: { type: "string" } } }
        }
      }));
      return "";
    }
  }), /TurnCompletedNotification\.turn\.status/);
});
