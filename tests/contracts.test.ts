import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalContractHash,
  normalizeDevelopmentContract,
  normalizeStartTaskInput
} from "../src/core/contracts.js";
import { SupervisorError } from "../src/core/errors.js";

const contract = {
  contractVersion: "1.0",
  clientRequestId: "request-1",
  objective: "Implement a bounded feature",
  plan: ["Inspect", "Implement", "Verify"],
  scope: { in: ["Core behavior"], out: ["Deployment"] },
  constraints: ["No arbitrary shell tool"],
  acceptanceCriteria: [{ id: "AC-1", description: "Tests pass" }],
  requiredVerificationRecipes: ["test"],
  allowedChangePaths: ["src", "tests"],
  maxCorrectionPasses: 3,
  metadata: { owner: "supervisor" }
} as const;

test("structured development contracts normalize and hash canonically", () => {
  const normalized = normalizeStartTaskInput({ workspace: "/repo", contract });
  assert.equal(normalized.contract.objective, contract.objective);
  assert.equal(normalized.clientRequestId, "request-1");
  const reordered = {
    ...contract,
    scope: { out: ["Deployment"], in: ["Core behavior"] },
    metadata: { owner: "supervisor" }
  };
  assert.equal(canonicalContractHash(normalized.contract), canonicalContractHash(normalizeDevelopmentContract(reordered)));
  assert.match(normalized.contractHash, /^[a-f0-9]{64}$/);
});

test("legacy start input is converted to a contract", () => {
  const normalized = normalizeStartTaskInput({
    workspace: "/repo",
    objective: "Legacy objective",
    clientRequestId: "legacy-request-1",
    plan: ["Implement"],
    acceptanceCriteria: ["It works"],
    constraints: []
  });
  assert.equal(normalized.contract.contractVersion, "1.0");
  assert.deepEqual(normalized.contract.acceptanceCriteria, [{ id: "AC-1", description: "It works" }]);
  assert.equal(normalized.clientRequestId, "legacy-request-1");
  assert.throws(
    () => normalizeStartTaskInput({
      workspace: "/repo",
      objective: "Missing retry identity",
      plan: ["Implement"],
      acceptanceCriteria: ["It works"]
    }),
    /clientRequestId must be a non-empty string/
  );
});

test("contract validation fails closed for mixed, empty, duplicate and escaping input", () => {
  assert.throws(() => normalizeStartTaskInput({}), SupervisorError);
  assert.throws(() => normalizeStartTaskInput({ workspace: "/repo", contract, objective: "mixed" }), /cannot be mixed/i);
  assert.throws(
    () => normalizeDevelopmentContract({ ...contract, allowedChangePaths: ["../outside"] }),
    /escapes the repository/i
  );
  assert.throws(
    () => normalizeDevelopmentContract({
      ...contract,
      acceptanceCriteria: [
        { id: "same", description: "one" },
        { id: "same", description: "two" }
      ]
    }),
    /Duplicate acceptance criterion/i
  );
});

test("contracts reject unknown criterion fields, duplicate recipes and credential material", () => {
  const base = {
    contractVersion: "1.0",
    clientRequestId: "request-base",
    objective: "implement",
    plan: [],
    scope: { in: ["src"], out: [] },
    constraints: [],
    acceptanceCriteria: [{ id: "AC-1", description: "pass" }],
    requiredVerificationRecipes: ["test"],
    maxCorrectionPasses: 3
  };
  assert.throws(
    () => normalizeStartTaskInput({ workspace: "/repo", contract: { ...base, requiredVerificationRecipes: ["test", "test"] } }),
    /must not contain duplicates/
  );
  assert.throws(
    () => normalizeStartTaskInput({ workspace: "/repo", contract: { ...base, acceptanceCriteria: [{ ...base.acceptanceCriteria[0], extra: true }] } }),
    /Unknown acceptance criterion/
  );
  assert.throws(
    () => normalizeStartTaskInput({ workspace: "/repo", contract: { ...base, objective: "use Bearer abc.def" } }),
    /credential-shaped material/
  );
  const wildcard = normalizeStartTaskInput({
    workspace: "/repo",
    contract: { ...base, allowedChangePaths: ["src/**"] }
  });
  assert.deepEqual(wildcard.contract.allowedChangePaths, ["src"]);
  assert.throws(
    () => normalizeStartTaskInput({ workspace: "/repo", contract: { ...base, allowedChangePaths: ["src/*.ts"] } }),
    /only plain paths or a trailing \/\*\*/
  );
  assert.throws(
    () => normalizeStartTaskInput({ workspace: "/repo", contract: { ...base, clientRequestId: "x".repeat(201) } }),
    /at most 200 characters/
  );
  assert.throws(
    () => normalizeStartTaskInput({
      workspace: "/repo",
      contract: { ...base, plan: Array.from({ length: 201 }, () => "step") }
    }),
    /at most 200 item/
  );
  assert.throws(
    () => normalizeStartTaskInput({
      workspace: "/repo",
      contract: { ...base, metadata: JSON.parse('{"__proto__":"blocked"}') }
    }),
    /metadata key is reserved/
  );
});
