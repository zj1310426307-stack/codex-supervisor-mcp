import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { CODEX_SUPERVISOR_THREAD_OPTIONS } from "./protocol-values.js";

export interface CodexRpcRequest {
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface CodexRpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

export interface CodexRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface CodexRpcResponse {
  id: string | number;
  result?: unknown;
  error?: CodexRpcErrorObject;
}

export type CodexWireMessage = CodexRpcRequest | CodexRpcNotification | CodexRpcResponse;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

export function parseCodexWireMessage(line: string): CodexWireMessage {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`Invalid JSON from codex app-server: ${line.slice(0, 500)}`);
  }
  if (!isRecord(value)) throw new Error("Codex app-server message must be a JSON object");
  if ("jsonrpc" in value) {
    throw new Error('Codex app-server wire messages must omit the "jsonrpc" member');
  }

  if (typeof value.method === "string") {
    if ("result" in value || "error" in value) throw new Error("Codex request cannot contain result or error");
    if ("id" in value && !validId(value.id)) throw new Error("Codex request id must be a string or finite number");
    if ("params" in value && value.params !== undefined && !isRecord(value.params)) {
      throw new Error("Codex request params must be an object");
    }
    return value as unknown as CodexRpcRequest | CodexRpcNotification;
  }

  if (!validId(value.id)) throw new Error("Codex response id must be a string or finite number");
  const hasResult = Object.prototype.hasOwnProperty.call(value, "result");
  const hasError = Object.prototype.hasOwnProperty.call(value, "error");
  if (hasResult === hasError) throw new Error("Codex response must contain exactly one of result or error");
  if (hasError) {
    if (!isRecord(value.error) || typeof value.error.code !== "number" || typeof value.error.message !== "string") {
      throw new Error("Codex response error is malformed");
    }
  }
  return value as unknown as CodexRpcResponse;
}

export function encodeCodexWireMessage(message: CodexWireMessage): string {
  if ("jsonrpc" in message) throw new Error('Codex app-server wire messages must omit the "jsonrpc" member');
  const encoded = JSON.stringify(message);
  if (!encoded) throw new Error("Codex app-server message is not JSON serializable");
  parseCodexWireMessage(encoded);
  return `${encoded}\n`;
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) result[key] = canonicalizeValue(value[key]);
  return result;
}

export function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(canonicalizeValue(value));
  if (encoded === undefined) throw new Error("Protocol schema value is not JSON serializable");
  return encoded;
}

export function protocolSchemaHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function collectMethodSchema(value: unknown, methods: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectMethodSchema(item, methods);
    return;
  }
  if (!isRecord(value)) return;

  const methodSchema = isRecord(value.properties) && isRecord(value.properties.method)
    ? value.properties.method
    : undefined;
  if (methodSchema) {
    if (typeof methodSchema.const === "string") methods.add(methodSchema.const);
    if (Array.isArray(methodSchema.enum)) {
      for (const item of methodSchema.enum) if (typeof item === "string") methods.add(item);
    }
  }
  for (const child of Object.values(value)) collectMethodSchema(child, methods);
}

export function collectProtocolMethods(schemaBundle: unknown): Set<string> {
  const methods = new Set<string>();
  collectMethodSchema(schemaBundle, methods);
  return methods;
}

export interface ProtocolSchemaBundle {
  files: Record<string, unknown>;
  hash: string;
  methods: string[];
  shapes: ProtocolShapeValidationReport;
}

export interface ProtocolSchemaReadLimits {
  maxFiles?: number;
  maxEntries?: number;
  maxDepth?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

interface ResolvedProtocolSchemaReadLimits {
  maxFiles: number;
  maxEntries: number;
  maxDepth: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

interface DiscoveredSchemaFile {
  name: string;
  fullPath: string;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}

const DEFAULT_SCHEMA_READ_LIMITS = Object.freeze({
  maxFiles: 2_048,
  maxEntries: 4_096,
  maxDepth: 16,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024
});

function resolveSchemaReadLimits(options: ProtocolSchemaReadLimits): ResolvedProtocolSchemaReadLimits {
  const resolved = { ...DEFAULT_SCHEMA_READ_LIMITS, ...options };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  }
  if (resolved.maxFileBytes > resolved.maxTotalBytes) {
    throw new Error("maxFileBytes must not exceed maxTotalBytes");
  }
  return resolved;
}

async function discoverSchemaFiles(
  directory: string,
  limits: ResolvedProtocolSchemaReadLimits
): Promise<DiscoveredSchemaFile[]> {
  const root = await fs.lstat(directory);
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new Error("Codex schema output root must be a real directory, not a link");
  }
  const queue: Array<{ fullPath: string; relativePath: string; depth: number }> = [
    { fullPath: directory, relativePath: "", depth: 0 }
  ];
  const files: DiscoveredSchemaFile[] = [];
  let entriesSeen = 0;
  let totalBytes = 0;

  while (queue.length > 0) {
    const current = queue.shift()!;
    const directoryHandle = await fs.opendir(current.fullPath);
    try {
      while (true) {
        const entry = await directoryHandle.read();
        if (!entry) break;
        entriesSeen += 1;
        if (entriesSeen > limits.maxEntries) throw new Error(`Codex schema output exceeds ${limits.maxEntries} entries`);
        const fullPath = path.join(current.fullPath, entry.name);
        const relativePath = current.relativePath
          ? `${current.relativePath}/${entry.name}`
          : entry.name;
        const stats = await fs.lstat(fullPath);
        if (stats.isSymbolicLink() || entry.isSymbolicLink()) {
          throw new Error(`Codex schema output contains a symbolic link: ${relativePath}`);
        }
        if (stats.isDirectory() && entry.isDirectory()) {
          if (current.depth + 1 > limits.maxDepth) {
            throw new Error(`Codex schema output exceeds directory depth ${limits.maxDepth}`);
          }
          queue.push({ fullPath, relativePath, depth: current.depth + 1 });
          continue;
        }
        if (!stats.isFile() || !entry.isFile()) {
          throw new Error(`Codex schema output contains a non-regular entry: ${relativePath}`);
        }
        if (!entry.name.toLowerCase().endsWith(".json")) continue;
        if (files.length + 1 > limits.maxFiles) throw new Error(`Codex schema output exceeds ${limits.maxFiles} JSON files`);
        if (stats.size > limits.maxFileBytes) {
          throw new Error(`Codex schema file exceeds ${limits.maxFileBytes} bytes: ${relativePath}`);
        }
        totalBytes += stats.size;
        if (totalBytes > limits.maxTotalBytes) {
          throw new Error(`Codex schema output exceeds ${limits.maxTotalBytes} total bytes`);
        }
        files.push({
          name: relativePath.replaceAll("\\", "/"),
          fullPath,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          dev: stats.dev,
          ino: stats.ino
        });
      }
    } finally {
      await directoryHandle.close().catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ERR_DIR_CLOSED") throw error;
      });
    }
  }
  return files.sort((left, right) => left.name === right.name ? 0 : (left.name < right.name ? -1 : 1));
}

function sameFileIdentity(
  expected: Pick<DiscoveredSchemaFile, "size" | "mtimeMs" | "dev" | "ino">,
  actual: { size: number; mtimeMs: number; dev: number; ino: number }
): boolean {
  return expected.size === actual.size &&
    expected.mtimeMs === actual.mtimeMs &&
    expected.dev === actual.dev &&
    expected.ino === actual.ino;
}

async function readStableSchemaFile(file: DiscoveredSchemaFile): Promise<string> {
  const handle = await fs.open(file.fullPath, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameFileIdentity(file, before)) {
      throw new Error(`Codex schema file changed before read: ${file.name}`);
    }
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const probe = Buffer.allocUnsafe(1);
    const { bytesRead: extraBytes } = await handle.read(probe, 0, 1, before.size);
    const after = await handle.stat();
    const pathAfter = await fs.lstat(file.fullPath);
    if (
      offset !== buffer.length ||
      extraBytes !== 0 ||
      !sameFileIdentity(file, after) ||
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      !sameFileIdentity(file, pathAfter)
    ) {
      throw new Error(`Codex schema file changed while being read: ${file.name}`);
    }
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

export interface ProtocolShapeValidationReport {
  compatible: boolean;
  requiredShapes: string[];
  validatedShapes: string[];
  shapeErrors: string[];
}

interface LocatedSchema {
  file: string;
  root: Record<string, unknown>;
  node: Record<string, unknown>;
}

export const REQUIRED_PROTOCOL_SHAPES = Object.freeze([
  "initialize.params.clientInfo",
  "thread/start.params.supervisorOptions",
  "turn/started.params.turn",
  "turn/completed.params.turn",
  "item/commandExecution/requestApproval.params",
  "item/commandExecution/requestApproval.result",
  "item/fileChange/requestApproval.params",
  "item/fileChange/requestApproval.result"
] as const);

function normalizeSchemaPath(value: string): string {
  const parts: string[] = [];
  for (const part of value.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function decodePointer(value: string): string {
  return decodeURIComponent(value).replaceAll("~1", "/").replaceAll("~0", "~");
}

function pointer(root: unknown, fragment: string): unknown {
  if (!fragment || fragment === "#") return root;
  if (!fragment.startsWith("#/")) return undefined;
  let current = root;
  for (const part of fragment.slice(2).split("/").map(decodePointer)) {
    if (!isRecord(current) || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

function resolveReference(files: Record<string, unknown>, current: LocatedSchema, reference: string): LocatedSchema | undefined {
  const hashAt = reference.indexOf("#");
  const filePart = hashAt >= 0 ? reference.slice(0, hashAt) : reference;
  const fragment = hashAt >= 0 ? reference.slice(hashAt) : "#";
  let file = current.file;
  let root: unknown = current.root;
  if (filePart) {
    const slash = current.file.lastIndexOf("/");
    const directory = slash >= 0 ? current.file.slice(0, slash + 1) : "";
    file = normalizeSchemaPath(`${directory}${filePart}`);
    root = files[file];
    if (root === undefined) {
      const decoded = normalizeSchemaPath(`${directory}${decodeURIComponent(filePart)}`);
      file = decoded;
      root = files[file];
    }
  }
  if (!isRecord(root)) return undefined;
  const node = pointer(root, fragment);
  return isRecord(node) ? { file, root, node } : undefined;
}

function locateNamedSchema(files: Record<string, unknown>, name: string): LocatedSchema | undefined {
  for (const [file, value] of Object.entries(files)) {
    if (!isRecord(value)) continue;
    const stem = file.slice(file.lastIndexOf("/") + 1).replace(/\.json$/i, "");
    if (stem === name || value.title === name) return { file, root: value, node: value };
  }

  const visit = (
    file: string,
    root: Record<string, unknown>,
    value: unknown,
    seen: Set<unknown>
  ): LocatedSchema | undefined => {
    if (!isRecord(value) || seen.has(value)) return undefined;
    seen.add(value);
    if (value.title === name) return { file, root, node: value };
    for (const containerName of ["definitions", "$defs"] as const) {
      const container = value[containerName];
      if (isRecord(container) && isRecord(container[name])) {
        return { file, root, node: container[name] };
      }
    }
    for (const child of Object.values(value)) {
      const found = visit(file, root, child, seen);
      if (found) return found;
    }
    return undefined;
  };
  for (const [file, value] of Object.entries(files)) {
    if (!isRecord(value)) continue;
    const found = visit(file, value, value, new Set());
    if (found) return found;
  }
  return undefined;
}

function dereference(
  files: Record<string, unknown>,
  location: LocatedSchema,
  seen = new Set<string>()
): LocatedSchema {
  const reference = location.node.$ref;
  if (typeof reference !== "string") return location;
  const key = `${location.file}:${reference}`;
  if (seen.has(key)) return location;
  seen.add(key);
  const resolved = resolveReference(files, location, reference);
  return resolved ? dereference(files, resolved, seen) : location;
}

interface ObjectShape {
  required: Set<string>;
  properties: Map<string, LocatedSchema>;
}

function objectShape(
  files: Record<string, unknown>,
  location: LocatedSchema,
  seen = new Set<Record<string, unknown>>()
): ObjectShape {
  const resolved = dereference(files, location);
  if (seen.has(resolved.node)) return { required: new Set(), properties: new Map() };
  seen.add(resolved.node);
  const required = new Set(
    Array.isArray(resolved.node.required)
      ? resolved.node.required.filter((item): item is string => typeof item === "string")
      : []
  );
  const properties = new Map<string, LocatedSchema>();
  if (isRecord(resolved.node.properties)) {
    for (const [name, value] of Object.entries(resolved.node.properties)) {
      if (isRecord(value)) properties.set(name, { ...resolved, node: value });
    }
  }
  if (Array.isArray(resolved.node.allOf)) {
    for (const branch of resolved.node.allOf) {
      if (!isRecord(branch)) continue;
      const nested = objectShape(files, { ...resolved, node: branch }, seen);
      for (const name of nested.required) required.add(name);
      for (const [name, value] of nested.properties) if (!properties.has(name)) properties.set(name, value);
    }
  }
  return { required, properties };
}

function isStringSchema(
  files: Record<string, unknown>,
  location: LocatedSchema,
  seen = new Set<Record<string, unknown>>()
): boolean {
  const resolved = dereference(files, location);
  if (seen.has(resolved.node)) return false;
  seen.add(resolved.node);
  if (resolved.node.type === "string") return true;
  if (Array.isArray(resolved.node.type) && resolved.node.type.includes("string")) return true;
  if (typeof resolved.node.const === "string") return true;
  if (Array.isArray(resolved.node.enum) && resolved.node.enum.length > 0 && resolved.node.enum.every((item) => typeof item === "string")) {
    return true;
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = resolved.node[keyword];
    if (Array.isArray(branches) && branches.some((branch) => isRecord(branch) && isStringSchema(
      files,
      { ...resolved, node: branch },
      new Set(seen)
    ))) return true;
  }
  return false;
}

function stringValues(
  files: Record<string, unknown>,
  location: LocatedSchema,
  seen = new Set<Record<string, unknown>>()
): Set<string> {
  const resolved = dereference(files, location);
  if (seen.has(resolved.node)) return new Set();
  seen.add(resolved.node);
  const values = new Set<string>();
  if (typeof resolved.node.const === "string") values.add(resolved.node.const);
  if (Array.isArray(resolved.node.enum)) {
    for (const item of resolved.node.enum) if (typeof item === "string") values.add(item);
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = resolved.node[keyword];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (!isRecord(branch)) continue;
      for (const value of stringValues(files, { ...resolved, node: branch }, new Set(seen))) values.add(value);
    }
  }
  return values;
}

function requireStringFields(
  files: Record<string, unknown>,
  schemaName: string,
  fields: readonly string[]
): string | undefined {
  const schema = locateNamedSchema(files, schemaName);
  if (!schema) return `${schemaName} schema is missing`;
  const shape = objectShape(files, schema);
  for (const field of fields) {
    if (!shape.required.has(field)) return `${schemaName}.${field} must be required`;
    const property = shape.properties.get(field);
    if (!property || !isStringSchema(files, property)) return `${schemaName}.${field} must be a string`;
  }
  return undefined;
}

function validateInitialize(files: Record<string, unknown>): string | undefined {
  const schema = locateNamedSchema(files, "InitializeParams");
  if (!schema) return "InitializeParams schema is missing";
  const shape = objectShape(files, schema);
  const clientInfo = shape.properties.get("clientInfo");
  if (!shape.required.has("clientInfo") || !clientInfo) return "InitializeParams.clientInfo must be required";
  const clientShape = objectShape(files, clientInfo);
  for (const field of ["name", "version"] as const) {
    const property = clientShape.properties.get(field);
    if (!clientShape.required.has(field) || !property || !isStringSchema(files, property)) {
      return `InitializeParams.clientInfo.${field} must be a required string`;
    }
  }
  return undefined;
}

function validateThreadStartOptions(files: Record<string, unknown>): string | undefined {
  const schema = locateNamedSchema(files, "ThreadStartParams");
  if (!schema) return "ThreadStartParams schema is missing";
  const shape = objectShape(files, schema);
  for (const [field, requiredValue] of Object.entries(CODEX_SUPERVISOR_THREAD_OPTIONS)) {
    const property = shape.properties.get(field);
    if (!property) return `ThreadStartParams.${field} is missing`;
    if (!stringValues(files, property).has(requiredValue)) {
      return `ThreadStartParams.${field} must allow ${requiredValue}`;
    }
  }
  return undefined;
}

function validateTurn(files: Record<string, unknown>, schemaName: string): string | undefined {
  const schema = locateNamedSchema(files, schemaName);
  if (!schema) return `${schemaName} schema is missing`;
  const notification = objectShape(files, schema);
  const turn = notification.properties.get("turn");
  if (!notification.required.has("turn") || !turn) return `${schemaName}.turn must be required`;
  const turnShape = objectShape(files, turn);
  for (const field of ["id", "status"] as const) {
    const property = turnShape.properties.get(field);
    if (!turnShape.required.has(field) || !property || !isStringSchema(files, property)) {
      return `${schemaName}.turn.${field} must be a required string`;
    }
  }
  return undefined;
}

function validateDecision(files: Record<string, unknown>, schemaName: string): string | undefined {
  const schema = locateNamedSchema(files, schemaName);
  if (!schema) return `${schemaName} schema is missing`;
  const shape = objectShape(files, schema);
  const decision = shape.properties.get("decision");
  if (!shape.required.has("decision") || !decision) return `${schemaName}.decision must be required`;
  const values = stringValues(files, decision);
  for (const required of ["accept", "decline", "cancel"] as const) {
    if (!values.has(required)) return `${schemaName}.decision must allow ${required}`;
  }
  return undefined;
}

/** Validates the stable fields the supervisor reads or writes, not just method names. */
export function validateRequiredProtocolShapes(files: Record<string, unknown>): ProtocolShapeValidationReport {
  const checks: Array<readonly [string, () => string | undefined]> = [
    ["initialize.params.clientInfo", () => validateInitialize(files)],
    ["thread/start.params.supervisorOptions", () => validateThreadStartOptions(files)],
    ["turn/started.params.turn", () => validateTurn(files, "TurnStartedNotification")],
    ["turn/completed.params.turn", () => validateTurn(files, "TurnCompletedNotification")],
    ["item/commandExecution/requestApproval.params", () => requireStringFields(
      files,
      "CommandExecutionRequestApprovalParams",
      ["itemId", "threadId", "turnId"]
    )],
    ["item/commandExecution/requestApproval.result", () => validateDecision(
      files,
      "CommandExecutionRequestApprovalResponse"
    )],
    ["item/fileChange/requestApproval.params", () => requireStringFields(
      files,
      "FileChangeRequestApprovalParams",
      ["itemId", "threadId", "turnId"]
    )],
    ["item/fileChange/requestApproval.result", () => validateDecision(
      files,
      "FileChangeRequestApprovalResponse"
    )]
  ];
  const validatedShapes: string[] = [];
  const shapeErrors: string[] = [];
  for (const [shape, validate] of checks) {
    const error = validate();
    if (error) shapeErrors.push(`${shape}: ${error}`);
    else validatedShapes.push(shape);
  }
  return {
    compatible: shapeErrors.length === 0,
    requiredShapes: [...REQUIRED_PROTOCOL_SHAPES],
    validatedShapes,
    shapeErrors
  };
}

export async function readProtocolSchemaBundle(
  directory: string,
  options: ProtocolSchemaReadLimits = {}
): Promise<ProtocolSchemaBundle> {
  const limits = resolveSchemaReadLimits(options);
  const discovered = await discoverSchemaFiles(directory, limits);
  if (discovered.length === 0) throw new Error("Codex generated no JSON schema files");

  const files: Record<string, unknown> = {};
  for (const file of discovered) {
    try {
      files[file.name] = JSON.parse(await readStableSchemaFile(file));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`Invalid JSON in Codex schema file ${file.name}`, { cause: error });
      throw error;
    }
  }
  const shapes = validateRequiredProtocolShapes(files);
  return {
    files,
    hash: protocolSchemaHash(files),
    methods: [...collectProtocolMethods(files)].sort(),
    shapes
  };
}
