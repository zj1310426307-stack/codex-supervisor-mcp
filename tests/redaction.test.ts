import assert from "node:assert/strict";
import test from "node:test";
import { redact, redactAndTruncate, redactText } from "../src/core/redaction.js";
import { mcpErrorResult, mcpSuccessResult } from "../src/mcp/server.js";

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

test("shared redaction covers required credential families in nested objects and arrays", () => {
  // Assemble credential-shaped fixtures at runtime so repository secret scans do
  // not need exceptions for realistic-looking test material.
  const openAiPrefix = ["s", "k"].join("");
  const githubPrefix = ["g", "h"].join("");
  const secrets = [
    `${openAiPrefix}-1234567890abcdef`,
    `${openAiPrefix}-proj-1234567890abcdef`,
    `${openAiPrefix}-svcacct-1234567890abcdef`,
    `${githubPrefix}p_1234567890abcdef`,
    `${["git", "hub"].join("")}_pat_1234567890abcdef`,
    `${githubPrefix}o_1234567890abcdef`,
    `${githubPrefix}u_1234567890abcdef`,
    `${githubPrefix}s_1234567890abcdef`,
    `${githubPrefix}r_1234567890abcdef`
  ];
  const value = redact({
    clientSecret: "client-value",
    private_key: "private-value",
    cookie: "session=secret",
    array: secrets,
    nested: { note: `Authorization: Basic dXNlcjpwYXNz\nOPENAI_API_KEY=${secrets[1]}` }
  });
  const serialized = JSON.stringify(value);
  for (const secret of [...secrets, "client-value", "private-value", "dXNlcjpwYXNz"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  assert.match(serialized, /\[REDACTED\]/);
});

test("PEM, environment and command forms are redacted", () => {
  const input = [
    "-----BEGIN ENCRYPTED PRIVATE KEY-----",
    "private-material",
    "-----END ENCRYPTED PRIVATE KEY-----",
    "GITHUB_TOKEN=github_pat_1234567890abcdef",
    "tool --api-key secret-value --password=another-value"
  ].join("\n");
  const safe = redactText(input);
  assert.doesNotMatch(safe, /private-material|github_pat_|secret-value|another-value/);
});

test("MCP success and error results use the shared redactor", () => {
  const success = mcpSuccessResult({ nested: [{ apiKey: "success-secret" }] });
  const error = mcpErrorResult(new Error("Bearer error-secret"));
  assert.doesNotMatch(JSON.stringify(success), /success-secret/);
  assert.doesNotMatch(JSON.stringify(error), /error-secret/);
  assert.equal(error.isError, true);
});

test("long output is redacted before truncation and does not split surrogate pairs", () => {
  const secret = `${["s", "k"].join("")}-proj-1234567890abcdef`;
  const safe = redactAndTruncate(`${secret}\n${"x".repeat(100)}😀tail`, 40);
  assert.equal(safe.truncated, true);
  assert.doesNotMatch(safe.text, /sk-proj|1234567890abcdef/);
  assert.doesNotMatch(safe.text, /[\uD800-\uDBFF]$/u);
});
