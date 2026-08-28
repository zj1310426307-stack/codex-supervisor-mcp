import type {
  OciRuntimeConfig,
  VerificationRecipe,
} from "../core/verification-config.js";
import { isForbiddenVerificationEnvironmentName } from "../core/verification-config.js";
import type { OciRuntimeBinding } from "./execution-backend.js";

export interface WorkerStartMessage {
  type: "start";
  runId: string;
  taskId: string;
  workerId: string;
  sequence: 1;
  at: string;
  workspace: string;
  runtime: OciRuntimeConfig;
  runtimeBinding: OciRuntimeBinding;
  recipes: VerificationRecipe[];
  containerEnvironment: Record<string, string>;
  maxOutputChars: number;
}

export type WorkerEventType =
  | "heartbeat"
  | "recipe_started"
  | "stdout_chunk"
  | "stderr_chunk"
  | "recipe_completed"
  | "verification_completed"
  | "termination_started"
  | "termination_completed"
  | "fatal_error";

export interface WorkerEvent {
  type: WorkerEventType;
  runId: string;
  workerId: string;
  sequence: number;
  at: string;
  recipeId?: string;
  chunk?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  durationMs?: number;
  passed?: boolean;
  error?: string;
  terminationEvidence?: Record<string, unknown>;
  execution?: {
    backend: "oci";
    engine: "docker" | "podman";
    assurance: "high";
    containerId: string;
    containerIdHash: string;
    containerLabelsHash: string;
    containerEngineNamespaceHash: string;
  };
  truncated?: boolean;
}

/** Guard the only inbound worker command. */
export function isWorkerStartMessage(value: unknown): value is WorkerStartMessage {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<WorkerStartMessage>;
  const runtime = input.runtime as Partial<OciRuntimeConfig> | undefined;
  const binding = input.runtimeBinding as Partial<OciRuntimeBinding> | undefined;
  const containerEnvironment = input.containerEnvironment;
  const environmentEntries = containerEnvironment && typeof containerEnvironment === "object" && !Array.isArray(containerEnvironment)
    ? Object.entries(containerEnvironment)
    : [];
  return (
    input.type === "start" &&
    typeof input.runId === "string" &&
    typeof input.taskId === "string" && input.taskId.length > 0 &&
    typeof input.workerId === "string" &&
    input.sequence === 1 &&
    typeof input.workspace === "string" &&
    Boolean(runtime) &&
    Boolean(binding) &&
    binding!.engine === runtime!.engine &&
    binding!.image === runtime!.image &&
    typeof binding!.engineInstanceHash === "string" &&
    /^[a-f0-9]{64}$/.test(binding!.engineInstanceHash) &&
    typeof binding!.probedAt === "string" &&
    (runtime!.engine === "docker" || runtime!.engine === "podman") &&
    typeof runtime!.image === "string" &&
    /@sha256:[a-f0-9]{64}$/.test(runtime!.image) &&
    typeof runtime!.user === "string" &&
    /^[1-9][0-9]*:[1-9][0-9]*$/.test(runtime!.user) &&
    Number.isSafeInteger(runtime!.pidsLimit) &&
    Number.isSafeInteger(runtime!.memoryBytes) &&
    typeof runtime!.cpus === "number" &&
    runtime!.cpus! > 0 &&
    Number.isSafeInteger(runtime!.tmpfsSizeBytes) &&
    Array.isArray(runtime!.engineArguments) &&
    Array.isArray(input.recipes) &&
    Boolean(containerEnvironment) &&
    environmentEntries.length <= 64 &&
    environmentEntries.every(([name, value]) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
      !isForbiddenVerificationEnvironmentName(name) &&
      typeof value === "string" &&
      value.length <= 8_192
    ) &&
    Number.isSafeInteger(input.maxOutputChars) &&
    Number(input.maxOutputChars) > 0
  );
}
