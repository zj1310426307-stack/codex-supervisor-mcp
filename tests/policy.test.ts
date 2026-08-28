import assert from "node:assert/strict";
import test from "node:test";
import { classifyApproval } from "../src/core/policy.js";

const commandMethod = "item/commandExecution/requestApproval";
const fileMethod = "item/fileChange/requestApproval";

function commandParams(command: string, overrides: Record<string, unknown> = {}) {
  return {
    itemId: "item-1",
    threadId: "thread-1",
    turnId: "turn-1",
    command,
    cwd: ".",
    ...overrides
  };
}

test("normal project test command is not blocked", () => {
  const result = classifyApproval(commandMethod, commandParams("npm test"), "/repo");
  assert.equal(result.risk, "normal");
});

test("git history and publication commands cannot hide behind global options", () => {
  assert.equal(classifyApproval(commandMethod, commandParams("git -C . commit -m x"), "/repo").risk, "blocked");
  assert.equal(classifyApproval(commandMethod, commandParams("git -c user.name=x push origin main"), "/repo").risk, "blocked");
});

test("sudo is blocked", () => {
  const result = classifyApproval(commandMethod, commandParams("sudo apt install something"), "/repo");
  assert.equal(result.risk, "blocked");
});

test("relative traversal in cwd or command is blocked", () => {
  assert.equal(classifyApproval(commandMethod, commandParams("npm test", { cwd: "../outside" }), "/repo").risk, "blocked");
  assert.equal(classifyApproval(commandMethod, commandParams("node ../outside/script.js"), "/repo").risk, "blocked");
  assert.equal(classifyApproval(commandMethod, commandParams("cd .. && npm test"), "/repo").risk, "blocked");
  assert.equal(classifyApproval(commandMethod, commandParams("Set-Location '..'; npm test"), "/repo").risk, "blocked");
});

test("absolute command path operands must stay inside the workspace", () => {
  assert.equal(classifyApproval(commandMethod, commandParams("cat /etc/passwd"), "/repo").risk, "blocked");
  assert.equal(classifyApproval(commandMethod, commandParams("type C:\\outside\\secret.txt"), "C:\\repo").risk, "blocked");
  assert.equal(classifyApproval(commandMethod, commandParams("cat /repo/README.md"), "/repo").risk, "normal");
});

test("network, permission, and policy escalation fields are fail-closed", () => {
  assert.equal(
    classifyApproval(commandMethod, commandParams("npm test", { networkApprovalContext: {} }), "/repo").risk,
    "blocked"
  );
  assert.equal(
    classifyApproval(commandMethod, commandParams("npm test", { additionalPermissions: [] }), "/repo").risk,
    "blocked"
  );
  assert.equal(
    classifyApproval(commandMethod, commandParams("npm test", { proposedExecpolicyAmendment: {} }), "/repo").risk,
    "blocked"
  );
});

test("unknown fields and incomplete request identity are fail-closed", () => {
  assert.equal(classifyApproval(commandMethod, commandParams("npm test", { mystery: true }), "/repo").risk, "blocked");
  const incomplete = commandParams("npm test");
  delete (incomplete as Partial<typeof incomplete>).turnId;
  assert.equal(classifyApproval(commandMethod, incomplete, "/repo").risk, "blocked");
});

test("file grantRoot must remain inside the supervised workspace", () => {
  const common = { itemId: "item-1", threadId: "thread-1", turnId: "turn-1" };
  assert.equal(classifyApproval(fileMethod, { ...common, grantRoot: "src" }, "/repo").risk, "normal");
  assert.equal(classifyApproval(fileMethod, { ...common, grantRoot: "../outside" }, "/repo").risk, "blocked");
});

test("unknown approval methods are blocked", () => {
  const result = classifyApproval("item/unknown/requestApproval", commandParams("npm test"), "/repo");
  assert.equal(result.risk, "blocked");
});
