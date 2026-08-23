import assert from "node:assert/strict";
import test from "node:test";
import { classifyApproval } from "../src/core/policy.js";

test("normal project test command is not blocked", () => {
  const result = classifyApproval({ command: "npm test", cwd: "/repo" }, "/repo");
  assert.equal(result.risk, "normal");
});

test("force push is blocked", () => {
  const result = classifyApproval({ command: "git push --force origin main", cwd: "/repo" }, "/repo");
  assert.equal(result.risk, "blocked");
});

test("sudo is blocked", () => {
  const result = classifyApproval({ command: "sudo apt install something", cwd: "/repo" }, "/repo");
  assert.equal(result.risk, "blocked");
});

test("write outside workspace is blocked", () => {
  const result = classifyApproval({ type: "fileChange", path: "/etc/hosts" }, "/repo");
  assert.equal(result.risk, "blocked");
});
