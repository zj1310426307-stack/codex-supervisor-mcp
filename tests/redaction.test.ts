import assert from "node:assert/strict";
import test from "node:test";
import { redact, redactText } from "../src/core/redaction.js";

test("structured and textual secrets are redacted", () => {
  const value = redact({
    authorization: "Bearer top-secret",
    nested: { api_key: "123", safe: "kept" },
    command: "tool --token=abc"
  });
  assert.equal(value.authorization, "[REDACTED]");
  assert.equal(value.nested.api_key, "[REDACTED]");
  assert.equal(value.nested.safe, "kept");
  assert.doesNotMatch(value.command, /abc/);
  assert.doesNotMatch(redactText("Authorization: Bearer abc.def"), /abc\.def/);
});

test("redaction handles cycles without serializing credentials", () => {
  const value: Record<string, unknown> = { password: "secret" };
  value.self = value;
  const safe = redact(value);
  assert.equal(safe.password, "[REDACTED]");
  assert.equal(safe.self, "[CIRCULAR]");
});
