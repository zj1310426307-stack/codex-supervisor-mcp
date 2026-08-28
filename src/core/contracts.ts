import { createHash } from "node:crypto";
import path from "node:path";
import type { AcceptanceCriterion, DevelopmentContractV1 } from "../types.js";
import { SupervisorError } from "./errors.js";
import { redact } from "./redaction.js";

export interface LegacyStartTaskInput {
  workspace: string;
  objective: string;
  plan: string[];
  acceptanceCriteria: Array<string | AcceptanceCriterion>;
  constraints?: string[];
  clientRequestId: string;
  verificationProfile?: string;
  toolSurfaceVersion?: string;
}

export interface StructuredStartTaskInput {
  workspace: string;
  contract: unknown;
  toolSurfaceVersion?: string;
}

export type StartTaskInput = LegacyStartTaskInput | StructuredStartTaskInput;

export interface NormalizedStartTaskInput {
  workspace: string;
  contract: DevelopmentContractV1;
  contractHash: string;
  clientRequestId: string;
}

const CONTRACT_KEYS = new Set([
  "contractVersion",
  "clientRequestId",
  "title",
  "objective",
  "plan",
  "scope",
  "constraints",
  "acceptanceCriteria",
  "requiredVerificationRecipes",
  "allowedChangePaths",
  "forbiddenChangePaths",
  "maxCorrectionPasses",
  "metadata"
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SupervisorError("INVALID_CONTRACT", `${label} must be an object`, 400);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, maxLength = 100_000): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new SupervisorError("INVALID_CONTRACT", `${label} must be a non-empty string`, 400);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new SupervisorError("INVALID_CONTRACT", `${label} must contain at most ${maxLength} characters`, 400);
  }
  return normalized;
}

function optionalString(value: unknown, label: string, maxLength = 100_000): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label, maxLength);
}

function stringArray(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = 200,
  maxItemLength = 10_000
): string[] {
  if (!Array.isArray(value)) {
    throw new SupervisorError("INVALID_CONTRACT", `${label} must be an array`, 400);
  }
  if (value.length > maximum) {
    throw new SupervisorError("INVALID_CONTRACT", `${label} must contain at most ${maximum} item(s)`, 400);
  }
  const result = value.map((entry, index) => requiredString(entry, `${label}[${index}]`, maxItemLength));
  if (result.length < minimum) {
    throw new SupervisorError("INVALID_CONTRACT", `${label} must contain at least ${minimum} item(s)`, 400);
  }
  return result;
}

function uniqueStringArray(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = 200,
  maxItemLength = 10_000
): string[] {
  const result = stringArray(value, label, minimum, maximum, maxItemLength);
  if (new Set(result).size !== result.length) {
    throw new SupervisorError("INVALID_CONTRACT", `${label} must not contain duplicates`, 400);
  }
  return result;
}

function repoRelativePaths(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  const result = uniqueStringArray(value, label, 0, 500, 1_024).map((entry, index) => {
    const portable = entry.replace(/\\/g, "/");
    const directoryWildcard = portable.endsWith("/**");
    const withoutWildcard = directoryWildcard ? portable.slice(0, -3) : portable;
    if (/[*?\[\]]/.test(withoutWildcard) || (!directoryWildcard && /[*?\[\]]/.test(portable))) {
      throw new SupervisorError(
        "INVALID_CONTRACT",
        `${label}[${index}] supports only plain paths or a trailing /** directory prefix`,
        400
      );
    }
    if (path.posix.isAbsolute(withoutWildcard) || path.win32.isAbsolute(entry)) {
      throw new SupervisorError("INVALID_CONTRACT", `${label}[${index}] must be repository-relative`, 400);
    }
    const normalized = path.posix.normalize(withoutWildcard || ".");
    if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
      throw new SupervisorError("INVALID_CONTRACT", `${label}[${index}] escapes the repository`, 400);
    }
    if (normalized === "" || normalized === ".") return ".";
    return normalized.replace(/^\.\//, "");
  });
  if (new Set(result).size !== result.length) {
    throw new SupervisorError("INVALID_CONTRACT", `${label} normalizes to duplicate paths`, 400);
  }
  return result;
}

function criteria(value: unknown): AcceptanceCriterion[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) {
    throw new SupervisorError(
      "INVALID_CONTRACT",
      "acceptanceCriteria must contain from 1 to 200 criteria",
      400
    );
  }
  const result = value.map((entry, index) => {
    if (typeof entry === "string") {
      return {
        id: `AC-${index + 1}`,
        description: requiredString(entry, `acceptanceCriteria[${index}]`, 10_000)
      };
    }
    const item = record(entry, `acceptanceCriteria[${index}]`);
    const unknown = Object.keys(item).filter((key) => !["id", "description", "evidence"].includes(key));
    if (unknown.length) {
      throw new SupervisorError(
        "INVALID_CONTRACT",
        `Unknown acceptance criterion field(s): ${unknown.join(", ")}`,
        400
      );
    }
    return {
      id: requiredString(item.id, `acceptanceCriteria[${index}].id`, 100),
      description: requiredString(item.description, `acceptanceCriteria[${index}].description`, 10_000),
      ...(item.evidence === undefined
        ? {}
        : { evidence: requiredString(item.evidence, `acceptanceCriteria[${index}].evidence`, 10_000) })
    };
  });
  const ids = new Set<string>();
  for (const item of result) {
    if (ids.has(item.id)) {
      throw new SupervisorError("INVALID_CONTRACT", `Duplicate acceptance criterion id: ${item.id}`, 400);
    }
    ids.add(item.id);
  }
  return result;
}

function metadata(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const input = record(value, "metadata");
  if (Object.keys(input).length > 200) {
    throw new SupervisorError("INVALID_CONTRACT", "metadata must contain at most 200 entries", 400);
  }
  const output: Record<string, string> = {};
  for (const key of Object.keys(input).sort()) {
    const normalizedKey = requiredString(key, "metadata key", 200);
    if (["__proto__", "prototype", "constructor"].includes(normalizedKey)) {
      throw new SupervisorError("INVALID_CONTRACT", `metadata key is reserved: ${normalizedKey}`, 400);
    }
    output[normalizedKey] = requiredString(input[key], `metadata.${key}`, 10_000);
  }
  return output;
}

/** Validate and normalize an explicitly structured contract. Unknown fields fail closed. */
export function normalizeDevelopmentContract(value: unknown): DevelopmentContractV1 {
  const input = record(value, "contract");
  const unknownKeys = Object.keys(input).filter((key) => !CONTRACT_KEYS.has(key));
  if (unknownKeys.length) {
    throw new SupervisorError("INVALID_CONTRACT", `Unknown contract field(s): ${unknownKeys.join(", ")}`, 400);
  }
  if (input.contractVersion !== "1.0") {
    throw new SupervisorError("INVALID_CONTRACT", 'contractVersion must be "1.0"', 400);
  }
  const scope = record(input.scope, "scope");
  const scopeUnknown = Object.keys(scope).filter((key) => key !== "in" && key !== "out");
  if (scopeUnknown.length) {
    throw new SupervisorError("INVALID_CONTRACT", `Unknown scope field(s): ${scopeUnknown.join(", ")}`, 400);
  }
  const maxCorrectionPasses = input.maxCorrectionPasses === undefined ? 3 : input.maxCorrectionPasses;
  if (!Number.isInteger(maxCorrectionPasses) || (maxCorrectionPasses as number) < 0 || (maxCorrectionPasses as number) > 5) {
    throw new SupervisorError("INVALID_CONTRACT", "maxCorrectionPasses must be an integer from 0 to 5", 400);
  }
  const contract: DevelopmentContractV1 = {
    contractVersion: "1.0",
    clientRequestId: requiredString(input.clientRequestId, "clientRequestId", 200),
    ...(optionalString(input.title, "title", 500) ? { title: optionalString(input.title, "title", 500) } : {}),
    objective: requiredString(input.objective, "objective", 100_000),
    plan: stringArray(input.plan, "plan", 0, 200, 10_000),
    scope: {
      in: stringArray(scope.in, "scope.in", 1, 200, 10_000),
      out: stringArray(scope.out ?? [], "scope.out", 0, 200, 10_000)
    },
    constraints: stringArray(input.constraints ?? [], "constraints", 0, 200, 10_000),
    acceptanceCriteria: criteria(input.acceptanceCriteria),
    requiredVerificationRecipes: uniqueStringArray(
      input.requiredVerificationRecipes ?? [],
      "requiredVerificationRecipes",
      0,
      100,
      200
    ),
    ...(repoRelativePaths(input.allowedChangePaths, "allowedChangePaths") === undefined
      ? {}
      : { allowedChangePaths: repoRelativePaths(input.allowedChangePaths, "allowedChangePaths") }),
    ...(repoRelativePaths(input.forbiddenChangePaths, "forbiddenChangePaths") === undefined
      ? {}
      : { forbiddenChangePaths: repoRelativePaths(input.forbiddenChangePaths, "forbiddenChangePaths") }),
    maxCorrectionPasses: maxCorrectionPasses as number,
    ...(metadata(input.metadata) ? { metadata: metadata(input.metadata) } : {})
  };
  if (canonicalJson(redact(contract)) !== canonicalJson(contract)) {
    throw new SupervisorError(
      "INVALID_CONTRACT",
      "Development Contract contains credential-shaped material; secrets are not permitted in contracts",
      400
    );
  }
  return contract;
}

/** Serialize JSON with recursively sorted object keys while preserving array order. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

/** Hash the normalized contract so retries and evidence bind to identical semantics. */
export function canonicalContractHash(contract: DevelopmentContractV1): string {
  const normalized = normalizeDevelopmentContract(contract);
  return createHash("sha256").update(canonicalJson(normalized), "utf8").digest("hex");
}

/** Convert structured or legacy task input to one validated contract representation. */
export function normalizeStartTaskInput(value: unknown): NormalizedStartTaskInput {
  const input = record(value, "task input");
  const workspace = requiredString(input.workspace, "workspace", 4_096);
  const hasContract = Object.prototype.hasOwnProperty.call(input, "contract");
  const legacyFields = [
    "objective",
    "plan",
    "acceptanceCriteria",
    "constraints",
    "clientRequestId",
    "verificationProfile"
  ].filter((key) => Object.prototype.hasOwnProperty.call(input, key));
  if (hasContract && legacyFields.length) {
    throw new SupervisorError(
      "INVALID_INPUT",
      `Structured contract input cannot be mixed with legacy field(s): ${legacyFields.join(", ")}`,
      400
    );
  }
  const allowedTopLevel = hasContract
    ? new Set(["workspace", "contract", "toolSurfaceVersion"])
    : new Set([
        "workspace",
        "objective",
        "plan",
        "acceptanceCriteria",
        "constraints",
        "clientRequestId",
        "verificationProfile",
        "toolSurfaceVersion"
      ]);
  const unknownTopLevel = Object.keys(input).filter((key) => !allowedTopLevel.has(key));
  if (unknownTopLevel.length) {
    throw new SupervisorError("INVALID_INPUT", `Unknown task input field(s): ${unknownTopLevel.join(", ")}`, 400);
  }

  let contract: DevelopmentContractV1;
  if (hasContract) {
    contract = normalizeDevelopmentContract(input.contract);
  } else {
    // The compatibility path remains strict: incomplete legacy input never starts Codex.
    const objective = requiredString(input.objective, "objective");
    const plan = stringArray(input.plan, "plan", 1, 200, 10_000);
    const acceptanceCriteria = criteria(input.acceptanceCriteria);
    const clientRequestId = requiredString(input.clientRequestId, "clientRequestId", 200);
    const profile = optionalString(input.verificationProfile, "verificationProfile", 200);
    contract = normalizeDevelopmentContract({
      contractVersion: "1.0",
      clientRequestId,
      objective,
      plan,
      scope: { in: [objective], out: [] },
      constraints: stringArray(input.constraints ?? [], "constraints", 0, 200, 10_000),
      acceptanceCriteria,
      requiredVerificationRecipes: [],
      maxCorrectionPasses: 3,
      ...(profile ? { metadata: { defaultVerificationProfile: profile } } : {})
    });
  }

  return {
    workspace,
    contract,
    contractHash: canonicalContractHash(contract),
    clientRequestId: contract.clientRequestId
  };
}
