import {
  EXPERIMENTAL_CODEX_METHODS,
  REQUIRED_STABLE_CLIENT_METHODS,
  REQUIRED_STABLE_SERVER_METHODS
} from "./protocol-values.js";
import { REQUIRED_PROTOCOL_SHAPES, type ProtocolShapeValidationReport } from "./protocol-schema.js";

export interface ProtocolCapabilityReport {
  compatible: boolean;
  experimentalApi: boolean;
  requiredClientMethods: string[];
  requiredServerMethods: string[];
  requiredMethods: string[];
  availableMethods: string[];
  missingMethods: string[];
  missingClientMethods: string[];
  missingServerMethods: string[];
  excludedExperimentalMethods: string[];
  requiredShapes: string[];
  validatedShapes: string[];
  shapeErrors: string[];
}

export interface ProtocolRuntimeBinding {
  version: string;
  schemaHash: string;
  capabilities: ProtocolCapabilityReport;
}

export interface ConnectionProtocolBinding extends ProtocolRuntimeBinding {
  connectionGeneration: number;
}

export function evaluateProtocolCapabilities(
  availableMethods: Iterable<string>,
  options: {
    /** Backwards-compatible override for client methods; server requirements become empty. */
    requiredMethods?: readonly string[];
    requiredClientMethods?: readonly string[];
    requiredServerMethods?: readonly string[];
    experimentalApi?: boolean;
    shapeValidation?: ProtocolShapeValidationReport;
  } = {}
): ProtocolCapabilityReport {
  const experimentalApi = options.experimentalApi === true;
  const available = new Set(availableMethods);
  const requiredClientMethods = [...(options.requiredClientMethods ?? options.requiredMethods ?? REQUIRED_STABLE_CLIENT_METHODS)];
  const requiredServerMethods = [...(options.requiredServerMethods ?? (options.requiredMethods ? [] : REQUIRED_STABLE_SERVER_METHODS))];
  const requiredMethods = [...new Set([...requiredClientMethods, ...requiredServerMethods])];
  const missingClientMethods = requiredClientMethods.filter((method) => !available.has(method));
  const missingServerMethods = requiredServerMethods.filter((method) => !available.has(method));
  const missingMethods = [...new Set([...missingClientMethods, ...missingServerMethods])];
  const excludedExperimentalMethods = experimentalApi
    ? []
    : [...available].filter((method) => EXPERIMENTAL_CODEX_METHODS.has(method)).sort();
  const shapeValidation = options.shapeValidation;

  return {
    compatible: missingMethods.length === 0 && (shapeValidation?.compatible ?? true),
    experimentalApi,
    requiredClientMethods,
    requiredServerMethods,
    requiredMethods,
    availableMethods: [...available].sort(),
    missingMethods,
    missingClientMethods,
    missingServerMethods,
    excludedExperimentalMethods,
    requiredShapes: [...(shapeValidation?.requiredShapes ?? [])],
    validatedShapes: [...(shapeValidation?.validatedShapes ?? [])],
    shapeErrors: [...(shapeValidation?.shapeErrors ?? [])]
  };
}

export function assertProtocolCapabilities(report: ProtocolCapabilityReport): void {
  if (report.compatible) return;
  const failures: string[] = [];
  if (report.missingMethods.length > 0) failures.push(`missing methods: ${report.missingMethods.join(", ")}`);
  if (report.shapeErrors.length > 0) failures.push(`invalid shapes: ${report.shapeErrors.join("; ")}`);
  throw new Error(`Incompatible Codex app-server schema; ${failures.join("; ")}`);
}

export function createProtocolRuntimeBinding(
  version: string,
  schemaHash: string,
  capabilities: ProtocolCapabilityReport
): ProtocolRuntimeBinding {
  const binding = { version, schemaHash, capabilities };
  assertProtocolRuntimeBinding(binding);
  return binding;
}

export function assertProtocolRuntimeBinding(binding: ProtocolRuntimeBinding): void {
  if (!binding.version.trim()) throw new Error("Codex protocol binding version must not be empty");
  if (!/^[a-f0-9]{64}$/i.test(binding.schemaHash)) {
    throw new Error("Codex protocol binding schemaHash must be a SHA-256 hex digest");
  }
  assertProtocolCapabilities(binding.capabilities);
  const validated = new Set(binding.capabilities.validatedShapes);
  const missingShapes = REQUIRED_PROTOCOL_SHAPES.filter((shape) => !validated.has(shape));
  if (missingShapes.length > 0) {
    throw new Error(`Codex protocol binding is missing validated schema shapes: ${missingShapes.join(", ")}`);
  }
}
