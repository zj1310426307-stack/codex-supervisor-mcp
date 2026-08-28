import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadVerificationConfig,
  listVerificationProfiles,
  parseVerificationConfig,
  selectVerificationRecipes
} from "../src/core/verification-config.js";

const raw = {
  version: 2,
  runtime: {
    engine: "docker",
    image: `example.invalid/verifier@sha256:${"a".repeat(64)}`,
    user: "65532:65532",
    pidsLimit: 64,
    memoryBytes: 256 * 1024 * 1024,
    cpus: 1,
    tmpfsSizeBytes: 16 * 1024 * 1024,
    engineArguments: []
  },
  profiles: {
    node: {
      recipes: [
        { id: "test", program: "npm", args: ["test"], cwd: ".", timeoutMs: 1000, required: true },
        { id: "lint", program: "npm", args: ["run", "lint"], cwd: ".", timeoutMs: 1000, required: false }
      ]
    }
  }
};

test("verification profile summaries do not expose commands", () => {
  const config = parseVerificationConfig(raw);
  const summary = listVerificationProfiles(config);
  assert.deepEqual(summary[0]?.recipes.map((recipe) => recipe.id), ["test", "lint"]);
  assert.doesNotMatch(JSON.stringify(summary), /npm/);
});

test("host-process configs and mutable/root OCI runtimes fail closed", () => {
  assert.throws(
    () => parseVerificationConfig({ ...raw, version: 1 }),
    /host-process verification is disabled/
  );
  assert.throws(
    () => parseVerificationConfig({
      ...raw,
      runtime: { ...raw.runtime, image: "example.invalid/verifier:latest" }
    }),
    /exact sha256 digest/
  );
  assert.throws(
    () => parseVerificationConfig({
      ...raw,
      runtime: { ...raw.runtime, user: "0:0" }
    }),
    /non-root/
  );
});

test("recipe selection rejects unknown ids, omitted required recipes and escaping cwd", () => {
  const config = parseVerificationConfig(raw);
  assert.throws(() => selectVerificationRecipes(config, "node", ["lint"]), /cannot be omitted/);
  assert.throws(() => selectVerificationRecipes(config, "node", ["test", "unknown"]), /Unknown recipe/);
  assert.throws(
    () => parseVerificationConfig({
      ...raw,
      profiles: { node: { recipes: [{ ...raw.profiles.node.recipes[0], cwd: "../outside" }] } }
    }),
    /escapes/
  );
});

test("host loader, executor and prototype environment names are rejected on both paths", () => {
  for (const name of [
    "NODE_OPTIONS", "node_path", "LD_PRELOAD", "DyLd_InSeRt_LiBrArIeS",
    "BASH_ENV", "PYTHONPATH", "PERL5OPT", "RUBYOPT", "JAVA_TOOL_OPTIONS",
    "DOTNET_STARTUP_HOOKS", "GIT_CONFIG_PARAMETERS", "GIT_EXTERNAL_DIFF",
    "GIT_SSH", "PAGER", "__proto__", "constructor", "prototype"
  ]) {
    assert.throws(
      () => parseVerificationConfig({ ...raw, environmentAllowlist: [name] }),
      /unsafe or credential-shaped/
    );
    const environment = JSON.parse(`{${JSON.stringify(name)}:"value"}`) as Record<string, string>;
    assert.throws(
      () => parseVerificationConfig({
        ...raw,
        profiles: {
          node: {
            recipes: [{ ...raw.profiles.node.recipes[0], environment }]
          }
        }
      }),
      /unsafe environment key/
    );
  }
});

test("verification config collections and strings have fixed bounds", () => {
  assert.throws(
    () => parseVerificationConfig({
      ...raw,
      profiles: {
        node: {
          recipes: [{ ...raw.profiles.node.recipes[0], args: Array.from({ length: 129 }, () => "x") }]
        }
      }
    }),
    /args must be string array/
  );
  assert.throws(
    () => parseVerificationConfig({
      ...raw,
      profiles: {
        node: {
          recipes: [{ ...raw.profiles.node.recipes[0], environment: { SAFE_VALUE: "x".repeat(8_193) } }]
        }
      }
    }),
    /unsafe environment key/
  );
  assert.throws(
    () => parseVerificationConfig({ ...raw, environmentAllowlist: Array.from({ length: 65 }, (_, i) => `SAFE_${i}`) }),
    /environmentAllowlist must be an array/
  );
});

test("verification config file reads are bounded", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-verification-config-"));
  const file = path.join(directory, "oversized.json");
  await fs.writeFile(file, " ".repeat(1024 * 1024 + 1));
  await assert.rejects(loadVerificationConfig(file), /exceeds 1048576 bytes/);
});
