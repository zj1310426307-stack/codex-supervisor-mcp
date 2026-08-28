import { createHash } from "node:crypto";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { SupervisorError } from "../core/errors.js";
import type { OciRuntimeConfig, VerificationRecipe } from "../core/verification-config.js";
import type { ReconciliationProof, VerifierRunV1 } from "../types.js";

const execFileAsync = promisify(execFile);
const RUN_LABEL = "io.openai.codex-supervisor.run";
const TASK_LABEL = "io.openai.codex-supervisor.task";
const WORKER_LABEL = "io.openai.codex-supervisor.worker";
const RECIPE_LABEL = "io.openai.codex-supervisor.recipe";
const IMAGE_LABEL = "io.openai.codex-supervisor.image-digest";
const ENGINE_LABEL = "io.openai.codex-supervisor.engine";
const NAMESPACE_LABEL = "io.openai.codex-supervisor.engine-namespace";

export interface OwnedExecution {
  child: ChildProcessWithoutNullStreams;
  backend: "oci";
  engine: "docker" | "podman";
  assurance: "high";
  containerId: string;
  containerIdHash: string;
  engineInstanceHash: string;
  runtime: OciRuntimeConfig;
  labels: Record<string, string>;
  settlement?: Promise<TerminationEvidence>;
}

export interface TerminationEvidence {
  backend: "oci";
  engine: "docker" | "podman";
  assurance: "high";
  containerIdHash: string;
  containerImageDigest: string;
  containerLabelsHash: string;
  containerEngineNamespaceHash: string;
  observedAt: string;
  forceRequestedAt?: string;
  containerExitCode?: number;
  ownershipVerified: boolean;
  requiredIntervention: boolean;
  provenComplete: boolean;
  detail: string;
}

export interface OciExecutionContext {
  runtime: OciRuntimeConfig;
  runtimeBinding: OciRuntimeBinding;
  workspace: string;
  taskId: string;
  runId: string;
  workerId: string;
  containerEnvironment: Record<string, string>;
}

interface ContainerInspection {
  id: string;
  image: string;
  running: boolean;
  pid: number;
  exitCode?: number;
  labels: Record<string, string>;
}

function engineProgram(runtime: OciRuntimeConfig): string {
  return runtime.engineExecutable ?? runtime.engine;
}

function engineArgs(runtime: OciRuntimeConfig, args: string[]): string[] {
  return [...runtime.engineArguments, ...args];
}

function engineEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  // Never forward dynamic-loader or language-runtime injection variables into
  // a privileged host-side engine CLI. Only platform/runtime discovery values
  // needed to locate the trusted local Docker/Podman binary are retained.
  for (const name of [
    "PATH", "PATHEXT", "SystemRoot", "ComSpec", "TMP", "TEMP",
    "HOME", "USERPROFILE", "LANG", "LC_ALL", "XDG_RUNTIME_DIR"
  ]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

async function engineOutput(runtime: OciRuntimeConfig, args: string[], timeout = 15_000): Promise<string> {
  const result = await execFileAsync(engineProgram(runtime), engineArgs(runtime, args), {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout,
    windowsHide: true,
    env: engineEnvironment()
  });
  return result.stdout.trim();
}

function runtimeUnavailable(message: string, cause?: unknown): SupervisorError {
  return new SupervisorError("RUNTIME_UNAVAILABLE", message, 503, undefined, cause ? { cause } : undefined);
}

export interface OciRuntimeBinding {
  engine: "docker" | "podman";
  image: string;
  engineInstanceHash: string;
  probedAt: string;
}

function parseEngineInstance(runtime: OciRuntimeConfig, raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("OCI info is not an object");
  if (runtime.engine === "docker") {
    const id = parsed.ID ?? parsed.Id ?? parsed.id;
    const root = parsed.DockerRootDir ?? parsed.dockerRootDir;
    if (typeof id !== "string" || !id || typeof root !== "string" || !root) {
      throw new Error("Docker daemon identity is incomplete");
    }
    return { id, root, name: typeof parsed.Name === "string" ? parsed.Name : "" };
  }
  const store = parsed.store && typeof parsed.store === "object"
    ? parsed.store as Record<string, unknown>
    : {};
  const host = parsed.host && typeof parsed.host === "object"
    ? parsed.host as Record<string, unknown>
    : {};
  const graphRoot = store.graphRoot;
  const runRoot = store.runRoot;
  if (typeof graphRoot !== "string" || !graphRoot || typeof runRoot !== "string" || !runRoot) {
    throw new Error("Podman store identity is incomplete");
  }
  return {
    graphRoot,
    runRoot,
    volumePath: typeof store.volumePath === "string" ? store.volumePath : "",
    hostId: typeof host.id === "string" ? host.id : "",
    hostname: typeof host.hostname === "string" ? host.hostname : "",
    rootless: host.security && typeof host.security === "object"
      ? (host.security as Record<string, unknown>).rootless === true
      : false
  };
}

async function probeOciRuntime(
  runtime: OciRuntimeConfig,
  requireImage: boolean
): Promise<OciRuntimeBinding> {
  const version = await engineOutput(runtime, ["version"], 10_000);
  const infoArgs = runtime.engine === "docker"
    ? ["info", "--format", "{{json .}}"]
    : ["info", "--format", "json"];
  const info = await engineOutput(runtime, infoArgs, 10_000);
  if (!version || !info) throw new Error("OCI runtime probe returned empty evidence");
  const instance = parseEngineInstance(runtime, info);
  if (requireImage) {
    const image = await engineOutput(runtime, ["image", "inspect", runtime.image], 15_000);
    if (!image) throw new Error("OCI image probe returned empty evidence");
  }
  const engineInstanceHash = createHash("sha256")
    .update(JSON.stringify({
      engine: runtime.engine,
      executable: runtime.engineExecutable ?? runtime.engine,
      arguments: runtime.engineArguments,
      instance
    }), "utf8")
    .digest("hex");
  return {
    engine: runtime.engine,
    image: runtime.image,
    engineInstanceHash,
    probedAt: new Date().toISOString()
  };
}

/** Prove that the selected OCI engine, daemon and exact digest image are available. */
export async function assertOciRuntimeAvailable(runtime: OciRuntimeConfig): Promise<OciRuntimeBinding> {
  try {
    return await probeOciRuntime(runtime, true);
  } catch (error) {
    throw runtimeUnavailable(
      `${runtime.engine} is unavailable or the configured digest-pinned verifier image is not present locally`,
      error
    );
  }
}

function safeContainerEnvironment(
  inherited: Record<string, string>,
  literal: Record<string, string> | undefined
): Record<string, string> {
  const environment = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(inherited)) environment[name] = value;
  for (const [name, value] of Object.entries(literal ?? {})) environment[name] = value;
  return environment;
}

function normalizeContainerId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/^sha256:/, "").toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : undefined;
}

export function ociOwnershipLabels(input: {
  taskId: string;
  runId: string;
  workerId: string;
  recipeId: string;
  imageDigest: string;
  engine: "docker" | "podman";
  engineNamespaceHash: string;
}): Record<string, string> {
  return {
    [TASK_LABEL]: input.taskId,
    [RUN_LABEL]: input.runId,
    [WORKER_LABEL]: input.workerId,
    [RECIPE_LABEL]: input.recipeId,
    [IMAGE_LABEL]: input.imageDigest,
    [ENGINE_LABEL]: input.engine,
    [NAMESPACE_LABEL]: input.engineNamespaceHash
  };
}

function ociRunOwnershipLabels(input: {
  taskId: string;
  runId: string;
  workerId: string;
  imageDigest: string;
  engine: "docker" | "podman";
  engineNamespaceHash: string;
}): Record<string, string> {
  return {
    [TASK_LABEL]: input.taskId,
    [RUN_LABEL]: input.runId,
    [WORKER_LABEL]: input.workerId,
    [IMAGE_LABEL]: input.imageDigest,
    [ENGINE_LABEL]: input.engine,
    [NAMESPACE_LABEL]: input.engineNamespaceHash
  };
}

export function ociLabelsHash(labels: Record<string, string>): string {
  return createHash("sha256")
    .update(JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))), "utf8")
    .digest("hex");
}

async function inspectContainer(
  runtime: OciRuntimeConfig,
  containerId: string,
  expectedLabels: Record<string, string>,
  expectedImage: string
): Promise<ContainerInspection> {
  const raw = await engineOutput(runtime, ["inspect", containerId]);
  const parsed = JSON.parse(raw) as unknown;
  const candidate = Array.isArray(parsed) ? parsed[0] : undefined;
  if (!candidate || typeof candidate !== "object") throw new Error("OCI inspect returned an unknown shape");
  const object = candidate as Record<string, unknown>;
  const id = normalizeContainerId(object.Id ?? object.ID);
  if (!id || id !== containerId) throw new Error("OCI inspect identity did not match the owned container");
  const state = object.State && typeof object.State === "object"
    ? object.State as Record<string, unknown>
    : {};
  const config = object.Config && typeof object.Config === "object"
    ? object.Config as Record<string, unknown>
    : {};
  const image = config.Image;
  if (typeof image !== "string" || image !== expectedImage) {
    throw new Error("OCI inspect image did not match the digest-pinned verifier image");
  }
  const rawLabels = config.Labels ?? object.Labels;
  const labels = rawLabels && typeof rawLabels === "object" && !Array.isArray(rawLabels)
    ? Object.fromEntries(
        Object.entries(rawLabels as Record<string, unknown>)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      )
    : {};
  if (Object.entries(expectedLabels).some(([key, value]) => labels[key] !== value)) {
    throw new Error("OCI inspect labels did not match the owned verifier run");
  }
  const running = state.Running === true || state.Status === "running";
  const pid = Number.isSafeInteger(state.Pid) ? Number(state.Pid) : 0;
  const exitCode = Number.isSafeInteger(state.ExitCode) ? Number(state.ExitCode) : undefined;
  return { id, image, running, pid, ...(exitCode === undefined ? {} : { exitCode }), labels };
}

async function listExactContainerIds(
  runtime: OciRuntimeConfig,
  labels?: Record<string, string>
): Promise<Set<string>> {
  const filters = Object.entries(labels ?? {}).flatMap(([name, value]) => ["--filter", `label=${name}=${value}`]);
  const raw = await engineOutput(runtime, [
    "container", "ls", "--all", "--no-trunc", "--quiet", ...filters
  ]);
  const ids = new Set<string>();
  for (const line of raw.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
    const id = normalizeContainerId(line);
    if (!id) throw new Error("OCI engine returned a truncated or invalid container identity");
    ids.add(id);
  }
  return ids;
}

function unknownOciObservation(
  run: VerifierRunV1,
  at: Date,
  detail: string,
  extra: Record<string, unknown> = {}
): Pick<ReconciliationProof, "result" | "observedAt" | "evidence"> {
  return {
    result: "UNKNOWN",
    observedAt: at.toISOString(),
    evidence: {
      backend: run.backend,
      engine: run.engine ?? "absent",
      containerIdHash: run.containerIdHash ?? "absent",
      containerImageDigest: run.containerImageDigest ?? "absent",
      ownershipBindingValid: false,
      detail,
      ...extra
    }
  };
}

/**
 * Re-establish exact OCI ownership from durable ledger evidence. A running
 * container is observed but never killed by reconciliation. A stopped,
 * label-verified container may be removed by exact ID before termination is
 * proven. Absence is positive only when the full prior ownership binding was
 * durably recorded.
 */
export async function observeOwnedOciContainer(
  run: VerifierRunV1,
  runtime: OciRuntimeConfig | undefined,
  workerState: "alive" | "dead" | "unknown",
  leaseExpired: boolean,
  at = new Date()
): Promise<Pick<ReconciliationProof, "result" | "observedAt" | "evidence">> {
  if (!runtime) return unknownOciObservation(run, at, "Trusted OCI runtime configuration is unavailable");
  if (run.backend !== "oci" || run.assurance !== "high") {
    return unknownOciObservation(run, at, "Run is not a current high-assurance OCI ownership record");
  }
  const containerId = normalizeContainerId(run.containerId);
  const expectedIdHash = containerId
    ? createHash("sha256").update(containerId, "utf8").digest("hex")
    : undefined;
  const recipeId = run.containerRecipeId;
  let currentBinding: OciRuntimeBinding;
  try {
    currentBinding = await probeOciRuntime(runtime, false);
  } catch {
    return unknownOciObservation(run, at, "Trusted OCI engine instance could not be identified");
  }
  const namespaceHash = currentBinding.engineInstanceHash;
  if (
    !run.engine ||
    run.engine !== runtime.engine ||
    !run.containerImageDigest ||
    run.containerEngineNamespaceHash !== namespaceHash
  ) {
    return unknownOciObservation(run, at, "Durable OCI run binding is missing or conflicts with the trusted runtime");
  }
  const runLabels = ociRunOwnershipLabels({
    taskId: run.taskId,
    runId: run.runId,
    workerId: run.workerId,
    imageDigest: run.containerImageDigest,
    engine: run.engine,
    engineNamespaceHash: namespaceHash
  });
  if (!containerId) {
    if (
      run.containerIdHash ||
      run.containerRecipeId ||
      run.containerLabelsHash ||
      run.containerOwnershipRecordedAt
    ) {
      return unknownOciObservation(run, at, "Partial exact-container ownership fields cannot prove a pre-container run");
    }
    if (workerState !== "dead" || !leaseExpired) {
      return unknownOciObservation(run, at, "Pre-container verifier worker death and lease expiry are not both proven", {
        workerProcessState: workerState,
        leaseExpired
      });
    }
    try {
      const ownedRunIds = await listExactContainerIds(runtime, runLabels);
      if (ownedRunIds.size > 0) {
        return {
          result: "UNKNOWN",
          observedAt: at.toISOString(),
          evidence: {
            backend: "oci",
            engine: run.engine,
            containerImageDigest: run.containerImageDigest,
            containerEngineNamespaceHash: namespaceHash,
            exactContainerOwnershipRecorded: false,
            runWideOwnedContainerCount: ownedRunIds.size,
            workerProcessState: workerState,
            leaseExpired,
            ownershipBindingValid: true,
            detail: "Run-wide OCI containers exist but no exact container identity was durably recorded; none were terminated"
          }
        };
      }
      return {
        result: "PROVEN_TERMINATED",
        observedAt: at.toISOString(),
        evidence: {
          backend: "oci",
          engine: run.engine,
          containerImageDigest: run.containerImageDigest,
          containerEngineNamespaceHash: namespaceHash,
          exactContainerOwnershipRecorded: false,
          runWideOwnedContainerCount: 0,
          workerProcessState: workerState,
          leaseExpired,
          ownershipBindingValid: true,
          detail: "Pre-container run has a dead worker, expired lease, and no container with its durable run-wide labels"
        }
      };
    } catch {
      return unknownOciObservation(run, at, "Trusted OCI engine could not prove run-wide absence for the pre-container run");
    }
  }
  if (
    run.containerIdHash !== expectedIdHash ||
    !recipeId ||
    !run.recipeIds.includes(recipeId) ||
    !run.containerOwnershipRecordedAt ||
    !Number.isFinite(Date.parse(run.containerOwnershipRecordedAt))
  ) {
    return unknownOciObservation(run, at, "Durable exact OCI ownership fields are missing or conflict with the trusted runtime");
  }
  const labels = ociOwnershipLabels({
    taskId: run.taskId,
    runId: run.runId,
    workerId: run.workerId,
    recipeId,
    imageDigest: run.containerImageDigest,
    engine: run.engine,
    engineNamespaceHash: namespaceHash
  });
  const labelsHash = ociLabelsHash(labels);
  if (run.containerLabelsHash !== labelsHash) {
    return unknownOciObservation(run, at, "Durable OCI label binding hash is missing or mismatched");
  }
  const baseEvidence: Record<string, unknown> = {
    backend: "oci",
    engine: run.engine,
    containerIdHash: run.containerIdHash,
    containerImageDigest: run.containerImageDigest,
    containerLabelsHash: labelsHash,
    containerEngineNamespaceHash: namespaceHash,
    containerRecipeId: recipeId,
    ownershipRecordedAt: run.containerOwnershipRecordedAt,
    ownershipBindingValid: true
  };
  try {
    let ids = await listExactContainerIds(runtime);
    let ownedRunIds = await listExactContainerIds(runtime, runLabels);
    if (!ids.has(containerId)) {
      if (ownedRunIds.size > 0 || workerState !== "dead" || !leaseExpired) {
        return {
          result: "UNKNOWN",
          observedAt: at.toISOString(),
          evidence: {
            ...baseEvidence,
            exactContainerPresent: false,
            unexpectedOwnedContainerCount: ownedRunIds.size,
            workerProcessState: workerState,
            leaseExpired,
            detail: "Exact container is absent but worker quiescence or run-wide container absence is not proven"
          }
        };
      }
      return {
        result: "PROVEN_TERMINATED",
        observedAt: at.toISOString(),
        evidence: {
          ...baseEvidence,
          exactContainerPresent: false,
          runWideOwnedContainerCount: 0,
          workerProcessState: workerState,
          leaseExpired,
          absenceConfirmedByFullIdListing: true,
          detail: "Exact durably owned OCI container is absent from the trusted engine"
        }
      };
    }
    let inspection: ContainerInspection;
    try {
      inspection = await inspectContainer(runtime, containerId, labels, run.containerImageDigest);
    } catch {
      // Close the list/inspect removal race without treating a generic inspect
      // failure as absence.
      ids = await listExactContainerIds(runtime);
      if (!ids.has(containerId)) {
        ownedRunIds = await listExactContainerIds(runtime, runLabels);
        if (ownedRunIds.size > 0 || workerState !== "dead" || !leaseExpired) {
          return {
            result: "UNKNOWN",
            observedAt: at.toISOString(),
            evidence: {
              ...baseEvidence,
              exactContainerPresent: false,
              unexpectedOwnedContainerCount: ownedRunIds.size,
              workerProcessState: workerState,
              leaseExpired,
              detail: "Container disappeared during inspection but run-wide quiescence is not proven"
            }
          };
        }
        return {
          result: "PROVEN_TERMINATED",
          observedAt: at.toISOString(),
          evidence: {
            ...baseEvidence,
            exactContainerPresent: false,
            runWideOwnedContainerCount: 0,
            workerProcessState: workerState,
            leaseExpired,
            absenceConfirmedByFullIdListing: true,
            detail: "Exact OCI container disappeared between full-ID listing and inspection"
          }
        };
      }
      return {
        result: "UNKNOWN",
        observedAt: at.toISOString(),
        evidence: {
          ...baseEvidence,
          exactContainerPresent: true,
          ownershipVerified: false,
          detail: "Exact OCI container exists but its labels or state could not be verified"
        }
      };
    }
    if (inspection.running || inspection.pid > 0) {
      return {
        result: "PROVEN_STILL_RUNNING",
        observedAt: at.toISOString(),
        evidence: {
          ...baseEvidence,
          exactContainerPresent: true,
          ownershipVerified: true,
          containerRunning: inspection.running,
          containerPidPresent: inspection.pid > 0,
          detail: "Exact label-verified OCI container is still running; reconciliation did not terminate it"
        }
      };
    }
    if (
      workerState !== "dead" ||
      !leaseExpired ||
      ownedRunIds.size !== 1 ||
      !ownedRunIds.has(containerId)
    ) {
      return {
        result: "UNKNOWN",
        observedAt: at.toISOString(),
        evidence: {
          ...baseEvidence,
          exactContainerPresent: true,
          ownershipVerified: true,
          containerRunning: false,
          runWideOwnedContainerCount: ownedRunIds.size,
          workerProcessState: workerState,
          leaseExpired,
          detail: "Stopped container is exact but worker quiescence and exclusive run ownership are not proven"
        }
      };
    }
    await engineOutput(runtime, ["rm", containerId], 15_000);
    ids = await listExactContainerIds(runtime);
    ownedRunIds = await listExactContainerIds(runtime, runLabels);
    if (ids.has(containerId) || ownedRunIds.size > 0) {
      return {
        result: "UNKNOWN",
        observedAt: at.toISOString(),
        evidence: {
          ...baseEvidence,
          exactContainerPresent: true,
          ownershipVerified: true,
          containerRunning: false,
          removalConfirmed: false,
          runWideOwnedContainerCount: ownedRunIds.size,
          detail: "Stopped exact OCI container remained after bounded exact removal"
        }
      };
    }
    return {
      result: "PROVEN_TERMINATED",
      observedAt: at.toISOString(),
      evidence: {
        ...baseEvidence,
        exactContainerPresent: false,
        ownershipVerified: true,
        containerRunning: false,
        containerExitCode: inspection.exitCode,
        removalConfirmed: true,
        detail: "Stopped exact label-verified OCI container was removed and full-ID absence was confirmed"
      }
    };
  } catch {
    return {
      result: "UNKNOWN",
      observedAt: at.toISOString(),
      evidence: {
        ...baseEvidence,
        detail: "Trusted OCI engine query or exact stopped-container removal failed"
      }
    };
  }
}

function mountSpec(workspace: string): string {
  if (/[,\r\n\0]/.test(workspace)) {
    throw new SupervisorError(
      "VERIFICATION_CONFIG_INVALID",
      "OCI verification worktree paths cannot contain commas or control characters",
      500
    );
  }
  return `type=bind,source=${workspace},target=/workspace,readonly`;
}

/** Create an exact, labeled OCI container and attach through the trusted engine CLI. */
export async function startOwnedExecution(
  recipe: VerificationRecipe,
  context: OciExecutionContext
): Promise<OwnedExecution> {
  if (
    context.runtimeBinding.engine !== context.runtime.engine ||
    context.runtimeBinding.image !== context.runtime.image ||
    !/^[a-f0-9]{64}$/.test(context.runtimeBinding.engineInstanceHash)
  ) {
    throw runtimeUnavailable("OCI runtime binding does not match the selected trusted runtime");
  }
  const workspace = fs.realpathSync.native(path.resolve(context.workspace));
  const hostCwd = resolveRecipeCwd(workspace, recipe.cwd);
  const relativeCwd = path.relative(workspace, hostCwd).replace(/\\/g, "/");
  const containerCwd = relativeCwd ? `/workspace/${relativeCwd}` : "/workspace";
  const labels = ociOwnershipLabels({
    taskId: context.taskId,
    runId: context.runId,
    workerId: context.workerId,
    recipeId: recipe.id,
    imageDigest: context.runtime.image,
    engine: context.runtime.engine,
    engineNamespaceHash: context.runtimeBinding.engineInstanceHash
  });
  const environment = safeContainerEnvironment(context.containerEnvironment, recipe.environment);
  const createArgs = [
    "create",
    "--pull=never",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges=true",
    "--pids-limit", String(context.runtime.pidsLimit),
    "--memory", String(context.runtime.memoryBytes),
    "--cpus", String(context.runtime.cpus),
    "--user", context.runtime.user,
    "--init",
    "--ipc=none",
    "--mount", mountSpec(workspace),
    "--tmpfs", `/tmp:rw,nosuid,nodev,noexec,size=${context.runtime.tmpfsSizeBytes}`,
    "--workdir", containerCwd,
    ...Object.entries(labels).flatMap(([name, value]) => ["--label", `${name}=${value}`]),
    ...Object.entries(environment).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
    context.runtime.image,
    recipe.program,
    ...recipe.args
  ];
  let containerId: string | undefined;
  try {
    const created = await engineOutput(context.runtime, createArgs, 60_000);
    const candidate = normalizeContainerId(created.split(/\s+/).at(-1));
    if (!candidate) throw new Error("OCI create did not return a full container id");
    containerId = candidate;
    const inspection = await inspectContainer(context.runtime, containerId, labels, context.runtime.image);
    if (inspection.running || inspection.pid > 0) throw new Error("New verifier container was unexpectedly running");
  } catch (error) {
    if (containerId) {
      // `create` never starts the container. If post-create identity proof
      // fails, remove only the exact full ID returned by that invocation.
      await engineOutput(context.runtime, ["rm", "--force", containerId], 15_000).catch(() => undefined);
    }
    throw runtimeUnavailable("Unable to create and prove ownership of the verifier OCI container", error);
  }
  if (!containerId) throw runtimeUnavailable("OCI create did not return durable container ownership");

  const child = spawn(
    engineProgram(context.runtime),
    engineArgs(context.runtime, ["start", "--attach", containerId]),
    {
      env: engineEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    }
  );
  if (!child.pid) {
    await engineOutput(context.runtime, ["rm", "--force", containerId]).catch(() => undefined);
    throw runtimeUnavailable("OCI engine did not start an attach process for the owned verifier container");
  }
  child.stdin.end();
  return {
    child,
    backend: "oci",
    engine: context.runtime.engine,
    assurance: "high",
    containerId,
    containerIdHash: createHash("sha256").update(containerId, "utf8").digest("hex"),
    engineInstanceHash: context.runtimeBinding.engineInstanceHash,
    runtime: context.runtime,
    labels
  };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function settleOwnedExecution(execution: OwnedExecution, force: boolean): Promise<TerminationEvidence> {
  if (execution.settlement) return execution.settlement;
  execution.settlement = (async () => {
    const evidence: TerminationEvidence = {
      backend: "oci",
      engine: execution.engine,
      assurance: "high",
      containerIdHash: execution.containerIdHash,
      containerImageDigest: execution.runtime.image,
      containerLabelsHash: ociLabelsHash(execution.labels),
      containerEngineNamespaceHash: execution.engineInstanceHash,
      observedAt: new Date().toISOString(),
      ownershipVerified: false,
      requiredIntervention: force,
      provenComplete: false,
      detail: "OCI container termination is not yet proven"
    };
    let inspection: ContainerInspection;
    try {
      inspection = await inspectContainer(
        execution.runtime,
        execution.containerId,
        execution.labels,
        execution.runtime.image
      );
      evidence.ownershipVerified = true;
    } catch {
      evidence.detail = "Unable to inspect the exact owned OCI container";
      return evidence;
    }
    if (force || inspection.running || inspection.pid > 0) {
      evidence.requiredIntervention = true;
      evidence.forceRequestedAt = new Date().toISOString();
      await engineOutput(execution.runtime, ["kill", "--signal", "KILL", execution.containerId], 15_000)
        .catch(() => undefined);
    }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        inspection = await inspectContainer(
          execution.runtime,
          execution.containerId,
          execution.labels,
          execution.runtime.image
        );
      } catch {
        evidence.detail = "Ownership became unverifiable while waiting for OCI termination";
        return evidence;
      }
      if (!inspection.running && inspection.pid === 0) break;
      await delay(100);
    }
    evidence.containerExitCode = inspection.exitCode;
    if (inspection.running || inspection.pid > 0) {
      evidence.detail = "Owned OCI container remained active after bounded termination";
      return evidence;
    }
    try {
      await engineOutput(execution.runtime, ["rm", execution.containerId], 15_000);
    } catch {
      evidence.detail = "Owned OCI container stopped but exact container removal was not proven";
      return evidence;
    }
    evidence.provenComplete = true;
    evidence.detail = evidence.requiredIntervention
      ? "Owned OCI container required forced termination and was then removed"
      : "Owned OCI container exited, had no remaining processes, and was removed";
    return evidence;
  })();
  return execution.settlement;
}

/** Prove a normal recipe exit did not leave a live container or descendant. */
export async function finalizeOwnedExecution(execution: OwnedExecution): Promise<TerminationEvidence> {
  return settleOwnedExecution(execution, false);
}

/** Terminate only the exact container created and label-verified by this worker. */
export async function terminateOwnedExecution(execution: OwnedExecution): Promise<TerminationEvidence> {
  return settleOwnedExecution(execution, true);
}

/** Resolve recipe cwd only to construct a validated read-only container workdir. */
export function resolveRecipeCwd(workspace: string, relative: string): string {
  const root = fs.realpathSync.native(path.resolve(workspace));
  const cwd = fs.realpathSync.native(path.resolve(root, relative));
  const relation = path.relative(root, cwd);
  if (relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error("Recipe cwd escapes task worktree through a path link");
  }
  return cwd;
}
