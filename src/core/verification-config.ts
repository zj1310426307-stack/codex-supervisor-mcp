import fs from "node:fs/promises";
import path from "node:path";
import { SupervisorError } from "./errors.js";

export interface VerificationRecipe {
  id: string;
  program: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  required: boolean;
  environment?: Record<string, string>;
}

export interface VerificationProfile {
  recipes: VerificationRecipe[];
}

export interface OciRuntimeConfig {
  engine: "docker" | "podman";
  image: string;
  user: `${number}:${number}`;
  pidsLimit: number;
  memoryBytes: number;
  cpus: number;
  tmpfsSizeBytes: number;
  engineExecutable?: string;
  engineArguments: string[];
}

export interface VerificationConfig {
  version: 2;
  runtime: OciRuntimeConfig;
  profiles: Record<string, VerificationProfile>;
  environmentAllowlist: string[];
}

export interface VerificationProfileSummary {
  id: string;
  recipes: Array<{ id: string; required: boolean; timeoutMs: number }>;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SENSITIVE_ENV = /(?:TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|AUTH|API_?KEY|PRIVATE_?KEY|CODEX|OPENAI|GITHUB|MCP_BEARER)/i;
const HOST_EXECUTION_ENV = /^(?:NODE_OPTIONS|NODE_PATH|LD_.+|DYLD_.+|BASH_ENV|ENV|IFS|CDPATH|SHELLOPTS|BASHOPTS|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|PYTHONINSPECT|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS|CLASSPATH|DOTNET_STARTUP_HOOKS|DOTNET_ADDITIONAL_DEPS|GIT_CONFIG(?:_.*)?|GIT_EXEC_PATH|GIT_TEMPLATE_DIR|GIT_SSH|GIT_SSH_COMMAND|GIT_ASKPASS|GIT_EXTERNAL_DIFF|GIT_PAGER|SSH_ASKPASS|PAGER|PROMPT_COMMAND|PS4|LESSOPEN|LESSCLOSE)$/i;
const RESERVED_PROPERTY = /^(?:__proto__|constructor|prototype)$/i;
const DIGEST_IMAGE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?:\:[A-Za-z0-9][A-Za-z0-9._-]{0,127})?@sha256:[a-f0-9]{64}$/;
const MAX_CONFIG_FILE_BYTES = 1024 * 1024;
const MAX_PROFILES = 32;
const MAX_RECIPES_PER_PROFILE = 32;
const MAX_TOTAL_RECIPES = 128;
const MAX_ARGUMENTS = 128;
const MAX_ARGUMENT_CHARS = 8_192;
const MAX_ENVIRONMENT_ENTRIES = 64;
const MAX_ENVIRONMENT_VALUE_CHARS = 8_192;
const MAX_ALLOWLIST_ENTRIES = 64;
const MAX_PROGRAM_CHARS = 1_024;
const MAX_CWD_CHARS = 1_024;

export function isForbiddenVerificationEnvironmentName(name: string): boolean {
  return RESERVED_PROPERTY.test(name) || SENSITIVE_ENV.test(name) || HOST_EXECUTION_ENV.test(name);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SupervisorError("VERIFICATION_CONFIG_INVALID", `${label} must be an object`, 500);
  }
  return value as Record<string, unknown>;
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new SupervisorError("VERIFICATION_CONFIG_INVALID", `${label} is not a safe identifier`, 500);
  }
  return value;
}

function relativeCwd(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_CWD_CHARS) {
    throw new SupervisorError("VERIFICATION_CONFIG_INVALID", `${label} must be a non-empty relative path`, 500);
  }
  const portable = value.replace(/\\/g, "/");
  const normalized = path.posix.normalize(portable);
  if (
    path.posix.isAbsolute(portable) ||
    path.win32.isAbsolute(value) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new SupervisorError("VERIFICATION_CONFIG_INVALID", `${label} escapes the task worktree`, 500);
  }
  return normalized;
}

/** Parse trusted operator configuration; MCP callers never supply programs or arguments. */
export function parseVerificationConfig(value: unknown, maxTimeoutMs = 900_000): VerificationConfig {
  const root = object(value, "verification config");
  const rootUnknown = Object.keys(root).filter(
    (key) => !["version", "runtime", "profiles", "environmentAllowlist"].includes(key)
  );
  if (rootUnknown.length) {
    throw new SupervisorError("VERIFICATION_CONFIG_INVALID", `Unknown config field(s): ${rootUnknown.join(", ")}`, 500);
  }
  if (root.version !== 2) {
    throw new SupervisorError(
      "VERIFICATION_CONFIG_INVALID",
      "verification config version must be 2; host-process verification is disabled and has no compatibility fallback",
      500
    );
  }
  const runtimeInput = object(root.runtime, "runtime");
  const runtimeUnknown = Object.keys(runtimeInput).filter(
    (key) => ![
      "engine",
      "image",
      "user",
      "pidsLimit",
      "memoryBytes",
      "cpus",
      "tmpfsSizeBytes",
      "engineExecutable",
      "engineArguments"
    ].includes(key)
  );
  if (runtimeUnknown.length) {
    throw new SupervisorError(
      "VERIFICATION_CONFIG_INVALID",
      `Unknown runtime field(s): ${runtimeUnknown.join(", ")}`,
      500
    );
  }
  if (runtimeInput.engine !== "docker" && runtimeInput.engine !== "podman") {
    throw new SupervisorError("VERIFICATION_CONFIG_INVALID", "runtime.engine must be docker or podman", 500);
  }
  if (typeof runtimeInput.image !== "string" || runtimeInput.image.length > 512 || !DIGEST_IMAGE.test(runtimeInput.image)) {
    throw new SupervisorError(
      "VERIFICATION_CONFIG_INVALID",
      "runtime.image must be an OCI image pinned by an exact sha256 digest",
      500
    );
  }
  if (typeof runtimeInput.user !== "string" || !/^[1-9][0-9]*:[1-9][0-9]*$/.test(runtimeInput.user)) {
    throw new SupervisorError(
      "VERIFICATION_CONFIG_INVALID",
      "runtime.user must be a numeric, explicitly non-root uid:gid",
      500
    );
  }
  const boundedInteger = (field: string, minimum: number, maximum: number): number => {
    const candidate = runtimeInput[field];
    if (!Number.isSafeInteger(candidate) || Number(candidate) < minimum || Number(candidate) > maximum) {
      throw new SupervisorError(
        "VERIFICATION_CONFIG_INVALID",
        `runtime.${field} must be an integer from ${minimum} to ${maximum}`,
        500
      );
    }
    return Number(candidate);
  };
  if (typeof runtimeInput.cpus !== "number" || !Number.isFinite(runtimeInput.cpus) || runtimeInput.cpus <= 0 || runtimeInput.cpus > 64) {
    throw new SupervisorError("VERIFICATION_CONFIG_INVALID", "runtime.cpus must be greater than 0 and at most 64", 500);
  }
  let engineExecutable: string | undefined;
  if (runtimeInput.engineExecutable !== undefined) {
    if (
      typeof runtimeInput.engineExecutable !== "string" ||
      runtimeInput.engineExecutable.length > 4_096 ||
      !path.isAbsolute(runtimeInput.engineExecutable) ||
      /[\r\n\0]/.test(runtimeInput.engineExecutable)
    ) {
      throw new SupervisorError(
        "VERIFICATION_CONFIG_INVALID",
        "runtime.engineExecutable must be an absolute trusted executable path",
        500
      );
    }
    engineExecutable = path.resolve(runtimeInput.engineExecutable);
  }
  const engineArguments = runtimeInput.engineArguments === undefined
    ? []
    : (() => {
        if (
          !Array.isArray(runtimeInput.engineArguments) ||
          runtimeInput.engineArguments.length > 8 ||
          !runtimeInput.engineArguments.every(
            (entry) => typeof entry === "string" && entry.length <= MAX_ARGUMENT_CHARS && !/[\r\n\0]/.test(entry)
          )
        ) {
          throw new SupervisorError(
            "VERIFICATION_CONFIG_INVALID",
            "runtime.engineArguments must be a bounded string array without control characters",
            500
          );
        }
        return [...runtimeInput.engineArguments] as string[];
      })();
  const runtime: OciRuntimeConfig = {
    engine: runtimeInput.engine,
    image: runtimeInput.image,
    user: runtimeInput.user as `${number}:${number}`,
    pidsLimit: boundedInteger("pidsLimit", 2, 4096),
    memoryBytes: boundedInteger("memoryBytes", 64 * 1024 * 1024, 64 * 1024 * 1024 * 1024),
    cpus: runtimeInput.cpus,
    tmpfsSizeBytes: boundedInteger("tmpfsSizeBytes", 1024 * 1024, 4 * 1024 * 1024 * 1024),
    ...(engineExecutable ? { engineExecutable } : {}),
    engineArguments
  };
  const profilesInput = object(root.profiles, "profiles");
  if (Object.keys(profilesInput).length === 0 || Object.keys(profilesInput).length > MAX_PROFILES) {
    throw new SupervisorError("VERIFICATION_CONFIG_INVALID", "profiles must not be empty", 500);
  }
  const environmentAllowlist = root.environmentAllowlist === undefined
    ? []
    : (() => {
        if (!Array.isArray(root.environmentAllowlist) || root.environmentAllowlist.length > MAX_ALLOWLIST_ENTRIES) {
          throw new SupervisorError("VERIFICATION_CONFIG_INVALID", "environmentAllowlist must be an array", 500);
        }
        return root.environmentAllowlist.map((entry, index) => {
          if (
            typeof entry !== "string" ||
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry) ||
            isForbiddenVerificationEnvironmentName(entry)
          ) {
            throw new SupervisorError(
              "VERIFICATION_CONFIG_INVALID",
              `environmentAllowlist[${index}] is unsafe or credential-shaped`,
              500
            );
          }
          return entry;
        });
      })();
  const profiles: Record<string, VerificationProfile> = {};
  let totalRecipes = 0;
  for (const [profileId, rawProfile] of Object.entries(profilesInput)) {
    safeId(profileId, "profile id");
    const profile = object(rawProfile, `profiles.${profileId}`);
    const profileUnknown = Object.keys(profile).filter((key) => key !== "recipes");
    if (profileUnknown.length) {
      throw new SupervisorError(
        "VERIFICATION_CONFIG_INVALID",
        `Unknown field(s) in profile ${profileId}: ${profileUnknown.join(", ")}`,
        500
      );
    }
    if (
      !Array.isArray(profile.recipes) ||
      profile.recipes.length === 0 ||
      profile.recipes.length > MAX_RECIPES_PER_PROFILE
    ) {
      throw new SupervisorError("VERIFICATION_CONFIG_INVALID", `profiles.${profileId}.recipes must not be empty`, 500);
    }
    totalRecipes += profile.recipes.length;
    if (totalRecipes > MAX_TOTAL_RECIPES) {
      throw new SupervisorError("VERIFICATION_CONFIG_INVALID", "verification config has too many total recipes", 500);
    }
    const recipeIds = new Set<string>();
    const recipes = profile.recipes.map((rawRecipe, index): VerificationRecipe => {
      const recipe = object(rawRecipe, `profiles.${profileId}.recipes[${index}]`);
      const recipeUnknown = Object.keys(recipe).filter(
        (key) => !["id", "program", "args", "cwd", "timeoutMs", "required", "environment"].includes(key)
      );
      if (recipeUnknown.length) {
        throw new SupervisorError(
          "VERIFICATION_CONFIG_INVALID",
          `Unknown field(s) in recipe ${profileId}[${index}]: ${recipeUnknown.join(", ")}`,
          500
        );
      }
      const id = safeId(recipe.id, `profiles.${profileId}.recipes[${index}].id`);
      if (recipeIds.has(id)) {
        throw new SupervisorError("VERIFICATION_CONFIG_INVALID", `Duplicate recipe id in ${profileId}: ${id}`, 500);
      }
      recipeIds.add(id);
      if (
        typeof recipe.program !== "string" ||
        !recipe.program.trim() ||
        recipe.program.length > MAX_PROGRAM_CHARS ||
        /[\r\n\0]/.test(recipe.program)
      ) {
        throw new SupervisorError("VERIFICATION_CONFIG_INVALID", `Recipe ${id} has an invalid program`, 500);
      }
      if (
        !Array.isArray(recipe.args) ||
        recipe.args.length > MAX_ARGUMENTS ||
        !recipe.args.every(
          (arg) => typeof arg === "string" && arg.length <= MAX_ARGUMENT_CHARS && !arg.includes("\0")
        )
      ) {
        throw new SupervisorError("VERIFICATION_CONFIG_INVALID", `Recipe ${id} args must be string array`, 500);
      }
      if (!Number.isSafeInteger(recipe.timeoutMs) || Number(recipe.timeoutMs) < 1 || Number(recipe.timeoutMs) > maxTimeoutMs) {
        throw new SupervisorError(
          "VERIFICATION_CONFIG_INVALID",
          `Recipe ${id} timeoutMs must be between 1 and ${maxTimeoutMs}`,
          500
        );
      }
      if (typeof recipe.required !== "boolean") {
        throw new SupervisorError("VERIFICATION_CONFIG_INVALID", `Recipe ${id} required must be boolean`, 500);
      }
      let environment: Record<string, string> | undefined;
      if (recipe.environment !== undefined) {
        const rawEnvironment = object(recipe.environment, `Recipe ${id} environment`);
        const entries = Object.entries(rawEnvironment);
        if (entries.length > MAX_ENVIRONMENT_ENTRIES) {
          throw new SupervisorError("VERIFICATION_CONFIG_INVALID", `Recipe ${id} has too many environment entries`, 500);
        }
        environment = Object.create(null) as Record<string, string>;
        for (const [name, envValue] of entries) {
          if (
            isForbiddenVerificationEnvironmentName(name) ||
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
            typeof envValue !== "string" ||
            envValue.length > MAX_ENVIRONMENT_VALUE_CHARS
          ) {
            throw new SupervisorError("VERIFICATION_CONFIG_INVALID", `Recipe ${id} contains unsafe environment key`, 500);
          }
          environment[name] = envValue;
        }
      }
      return {
        id,
        program: recipe.program.trim(),
        args: [...recipe.args] as string[],
        cwd: relativeCwd(recipe.cwd ?? ".", `Recipe ${id} cwd`),
        timeoutMs: Number(recipe.timeoutMs),
        required: recipe.required,
        ...(environment ? { environment } : {})
      };
    });
    if (!recipes.some((recipe) => recipe.required)) {
      throw new SupervisorError(
        "VERIFICATION_CONFIG_INVALID",
        `Profile ${profileId} must contain at least one required recipe`,
        500
      );
    }
    profiles[profileId] = { recipes };
  }
  return { version: 2, runtime, profiles, environmentAllowlist: [...new Set(environmentAllowlist)] };
}

/** Load the verification config only from the trusted operator-selected path. */
export async function loadVerificationConfig(file: string, maxTimeoutMs = 900_000): Promise<VerificationConfig> {
  if (!path.isAbsolute(file)) {
    throw new SupervisorError("VERIFICATION_CONFIG_INVALID", "Verification config path must be absolute", 500);
  }
  let parsed: unknown;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(file, "r");
    const buffer = Buffer.allocUnsafe(MAX_CONFIG_FILE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_CONFIG_FILE_BYTES) {
      throw new SupervisorError(
        "VERIFICATION_CONFIG_INVALID",
        `Verification config exceeds ${MAX_CONFIG_FILE_BYTES} bytes`,
        500
      );
    }
    parsed = JSON.parse(buffer.subarray(0, offset).toString("utf8"));
  } catch (error) {
    if (error instanceof SupervisorError) throw error;
    throw new SupervisorError("VERIFICATION_CONFIG_INVALID", "Unable to read verification config", 500, undefined, {
      cause: error
    });
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return parseVerificationConfig(parsed, maxTimeoutMs);
}

/** Return selection metadata without exposing executable programs, args or environment values. */
export function listVerificationProfiles(config: VerificationConfig): VerificationProfileSummary[] {
  return Object.entries(config.profiles)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, profile]) => ({
      id,
      recipes: profile.recipes.map((recipe) => ({
        id: recipe.id,
        required: recipe.required,
        timeoutMs: recipe.timeoutMs
      }))
    }));
}

/** Resolve an allowlisted selection and ensure no required recipe can be omitted. */
export function selectVerificationRecipes(
  config: VerificationConfig,
  profileId: string,
  recipeIds?: string[]
): VerificationRecipe[] {
  const profile = config.profiles[profileId];
  if (!profile) {
    throw new SupervisorError("VERIFICATION_NOT_ALLOWED", `Unknown verification profile: ${profileId}`, 404);
  }
  if (!recipeIds) return profile.recipes.map((recipe) => ({ ...recipe, args: [...recipe.args] }));
  if (recipeIds.length === 0) {
    throw new SupervisorError("VERIFICATION_NOT_ALLOWED", "Verification recipe selection must not be empty", 400);
  }
  const requested = new Set(recipeIds);
  if (requested.size !== recipeIds.length) {
    throw new SupervisorError("VERIFICATION_NOT_ALLOWED", "Duplicate verification recipe id", 400);
  }
  const selected = profile.recipes.filter((recipe) => requested.has(recipe.id));
  const unknown = recipeIds.filter((id) => !selected.some((recipe) => recipe.id === id));
  if (unknown.length) {
    throw new SupervisorError("VERIFICATION_NOT_ALLOWED", `Unknown recipe id(s): ${unknown.join(", ")}`, 400);
  }
  const omittedRequired = profile.recipes.filter((recipe) => recipe.required && !requested.has(recipe.id));
  if (omittedRequired.length) {
    throw new SupervisorError(
      "VERIFICATION_NOT_ALLOWED",
      `Required recipe(s) cannot be omitted: ${omittedRequired.map((recipe) => recipe.id).join(", ")}`,
      409
    );
  }
  return selected.map((recipe) => ({ ...recipe, args: [...recipe.args] }));
}
