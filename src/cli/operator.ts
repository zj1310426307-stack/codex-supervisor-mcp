import fs from "node:fs/promises";
import { redactText } from "../core/redaction.js";
import type { SupervisorFacade, TaskDecisionInput } from "../mcp/facade.js";
import { TOOL_SURFACE_VERSION, taskDecisionSchema } from "../mcp/tool-catalog.js";

export interface OperatorIo {
  readText(path: string): Promise<string>;
  confirm(operation: string): Promise<boolean>;
  write(text: string): void;
  writeError(text: string): void;
}

interface ParsedArguments {
  words: string[];
  flags: Map<string, string[]>;
  json: boolean;
}

export class OperatorUsageError extends Error {
  readonly code = "OPERATOR_USAGE_ERROR";
}

export class OperatorRiskRejectedError extends Error {
  readonly code = "NON_INTERACTIVE_RISK_REJECTED";
}

const USAGE = `codex-supervisor operator commands:
  task start --contract <file> --workspace <path> [--json]
  task continue --task <id> --instruction <file> [--json]
  task steer --task <id> --instruction <file> [--json]
  task interrupt --task <id> [--json]
  task recover --task <id> [--json]
  task verify --task <id> --profile <id> [--json]
  task decide --task <id> --decision <accept|request_changes|block|cancel> --rationale <file> [--instruction <file>] [--accepted-risk <text>]... [--expected-snapshot <sha256>] [--criterion-confirmations <JSON file>] [--json]
  task cleanup --task <id> [--json]
  approval decide --task <id> --approval <id> --decision <accept|decline|cancel> [--json]
  verifier reconcile --run <uuid> [--task <id>] [--json]

High-risk commands require an interactive confirmation. Non-interactive input is rejected by default.`;

function parseArguments(argv: string[]): ParsedArguments {
  const words: string[] = [];
  const flags = new Map<string, string[]>();
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      words.push(token);
      continue;
    }
    const name = token.slice(2);
    if (name === "json") {
      json = true;
      continue;
    }
    if (!name || index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      throw new OperatorUsageError(`Flag --${name || "<empty>"} requires a value`);
    }
    const values = flags.get(name) ?? [];
    values.push(argv[index + 1]);
    flags.set(name, values);
    index += 1;
  }
  return { words, flags, json };
}

function flag(parsed: ParsedArguments, name: string, required = true): string | undefined {
  const values = parsed.flags.get(name);
  if (!values?.length) {
    if (required) throw new OperatorUsageError(`Missing required --${name}`);
    return undefined;
  }
  if (values.length !== 1) throw new OperatorUsageError(`--${name} may only be supplied once`);
  return values[0];
}

function assertKnownFlags(parsed: ParsedArguments, allowed: string[]): void {
  const accepted = new Set(allowed);
  for (const name of parsed.flags.keys()) {
    if (!accepted.has(name)) throw new OperatorUsageError(`Unknown flag --${name}`);
  }
}

async function readInstruction(io: OperatorIo, parsed: ParsedArguments, name: string): Promise<string> {
  const file = flag(parsed, name);
  const value = (await io.readText(file!)).trim();
  if (!value) throw new OperatorUsageError(`--${name} file must not be empty`);
  return value;
}

async function readJsonFile(io: OperatorIo, file: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await io.readText(file));
  } catch (error) {
    throw new OperatorUsageError(`Invalid ${label} JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function requireConfirmation(io: OperatorIo, operation: string): Promise<void> {
  if (!(await io.confirm(operation))) {
    throw new OperatorRiskRejectedError(`High-risk operation was not interactively confirmed: ${operation}`);
  }
}

function serialize(value: unknown, json: boolean): string {
  const raw = json || typeof value !== "string" ? JSON.stringify(value, null, 2) : value;
  return `${redactOperatorText(raw)}\n`;
}

export function redactOperatorText(value: string): string {
  return redactText(value);
}

function exactWordCount(parsed: ParsedArguments): void {
  if (parsed.words.length !== 2) throw new OperatorUsageError(USAGE);
}

/**
 * Execute one operator command through the same facade used by MCP.  This
 * adapter intentionally offers no arbitrary shell, file-write, or Git publish
 * escape hatch.
 */
export async function runOperatorCommand(
  argv: string[],
  facade: SupervisorFacade,
  io: OperatorIo
): Promise<unknown> {
  const parsed = parseArguments(argv);
  if (parsed.words.length === 1 && ["help", "-h"].includes(parsed.words[0])) {
    io.write(`${USAGE}\n`);
    return { ok: true, usage: USAGE };
  }
  exactWordCount(parsed);
  const [group, action] = parsed.words;
  let output: unknown;

  if (group === "task" && action === "start") {
    assertKnownFlags(parsed, ["contract", "workspace"]);
    const workspace = flag(parsed, "workspace")!;
    const contractFile = flag(parsed, "contract")!;
    let contract: unknown;
    try {
      contract = JSON.parse(await io.readText(contractFile));
    } catch (error) {
      throw new OperatorUsageError(`Invalid contract JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
      throw new OperatorUsageError("Contract file must contain a JSON object");
    }
    await requireConfirmation(io, "task start");
    output = await facade.startTask({ workspace, contract, toolSurfaceVersion: TOOL_SURFACE_VERSION });
  } else if (group === "task" && action === "continue") {
    assertKnownFlags(parsed, ["task", "instruction"]);
    const taskId = flag(parsed, "task")!;
    const instruction = await readInstruction(io, parsed, "instruction");
    await requireConfirmation(io, "task continue");
    output = await facade.continueTask({ taskId, instruction, toolSurfaceVersion: TOOL_SURFACE_VERSION });
  } else if (group === "task" && action === "steer") {
    assertKnownFlags(parsed, ["task", "instruction"]);
    const taskId = flag(parsed, "task")!;
    const instruction = await readInstruction(io, parsed, "instruction");
    await requireConfirmation(io, "task steer");
    output = await facade.steerTask(taskId, instruction);
  } else if (group === "task" && action === "interrupt") {
    assertKnownFlags(parsed, ["task"]);
    const taskId = flag(parsed, "task")!;
    await requireConfirmation(io, "task interrupt");
    output = await facade.interruptTask(taskId);
  } else if (group === "task" && action === "recover") {
    assertKnownFlags(parsed, ["task"]);
    output = await facade.recoverTask({
      taskId: flag(parsed, "task")!,
      toolSurfaceVersion: TOOL_SURFACE_VERSION
    });
  } else if (group === "task" && action === "verify") {
    assertKnownFlags(parsed, ["task", "profile"]);
    const input = {
      taskId: flag(parsed, "task")!,
      profileId: flag(parsed, "profile")!,
      toolSurfaceVersion: TOOL_SURFACE_VERSION
    };
    await requireConfirmation(io, "task verify");
    output = await facade.verifyTask(input);
  } else if (group === "task" && action === "decide") {
    assertKnownFlags(parsed, [
      "task",
      "decision",
      "rationale",
      "instruction",
      "accepted-risk",
      "expected-snapshot",
      "criterion-confirmations"
    ]);
    const decision = flag(parsed, "decision")!;
    if (!["accept", "request_changes", "block", "cancel"].includes(decision)) {
      throw new OperatorUsageError(`Unsupported task decision: ${decision}`);
    }
    const instructionFile = flag(parsed, "instruction", false);
    const instruction = instructionFile ? (await io.readText(instructionFile)).trim() : undefined;
    const expectedSnapshotId = flag(parsed, "expected-snapshot", false);
    const confirmationsFile = flag(parsed, "criterion-confirmations", false);
    const acceptedRisks = parsed.flags.get("accepted-risk");
    const candidate = {
      taskId: flag(parsed, "task")!,
      decision: decision as "accept" | "request_changes" | "block" | "cancel",
      rationale: await readInstruction(io, parsed, "rationale"),
      ...(instruction === undefined ? {} : { instruction }),
      ...(acceptedRisks === undefined ? {} : { acceptedRisks }),
      ...(expectedSnapshotId === undefined ? {} : { expectedSnapshotId }),
      ...(confirmationsFile === undefined
        ? {}
        : { criterionConfirmations: await readJsonFile(io, confirmationsFile, "criterion confirmations") }),
      toolSurfaceVersion: TOOL_SURFACE_VERSION
    };
    const validated = taskDecisionSchema.safeParse(candidate);
    if (!validated.success) {
      const reasons = validated.error.issues
        .map((issue) => `${issue.path.join(".") || "decision"}: ${issue.message}`)
        .join("; ");
      throw new OperatorUsageError(`Invalid task decision: ${reasons}`);
    }
    const input = validated.data as TaskDecisionInput;
    await requireConfirmation(io, `task decide ${decision}`);
    output = await facade.decideTask(input);
  } else if (group === "task" && action === "cleanup") {
    assertKnownFlags(parsed, ["task"]);
    const input = { taskId: flag(parsed, "task")!, toolSurfaceVersion: TOOL_SURFACE_VERSION };
    await requireConfirmation(io, "task cleanup");
    output = await facade.cleanupTask(input);
  } else if (group === "approval" && action === "decide") {
    assertKnownFlags(parsed, ["task", "approval", "decision"]);
    const decision = flag(parsed, "decision")!;
    if (!["accept", "decline", "cancel"].includes(decision)) {
      throw new OperatorUsageError(`Unsupported approval decision: ${decision}`);
    }
    await requireConfirmation(io, `approval decide ${decision}`);
    output = await facade.decideApproval(
      flag(parsed, "approval")!,
      decision as "accept" | "decline" | "cancel",
      flag(parsed, "task")!
    );
  } else if (group === "verifier" && action === "reconcile") {
    assertKnownFlags(parsed, ["run", "task"]);
    const input = {
      runId: flag(parsed, "run")!,
      taskId: flag(parsed, "task", false),
      toolSurfaceVersion: TOOL_SURFACE_VERSION
    };
    await requireConfirmation(io, "verifier reconcile");
    output = await facade.reconcileVerifier(input);
  } else {
    throw new OperatorUsageError(USAGE);
  }

  io.write(serialize(output, parsed.json));
  return output;
}

export const operatorUsage = USAGE;

export function defaultReadText(path: string): Promise<string> {
  return fs.readFile(path, "utf8");
}
