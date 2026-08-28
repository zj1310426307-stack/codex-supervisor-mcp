import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import {
  encodeCodexWireMessage,
  parseCodexWireMessage,
  type CodexRpcRequest,
  type CodexRpcResponse
} from "./protocol-schema.js";
import {
  assertProtocolRuntimeBinding,
  type ConnectionProtocolBinding,
  type ProtocolRuntimeBinding
} from "./protocol-capabilities.js";
import {
  assertExperimentalMethodAllowed,
  CODEX_APP_SERVER_CLIENT_INFO,
  isReadOnlyCodexMethod,
  RETRYABLE_CODEX_ERROR_CODES
} from "./protocol-values.js";

export type RpcRequest = CodexRpcRequest;

interface PendingRpc {
  method: string;
  generation: number;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
}

interface ChildExitOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface ChildLifecycle {
  generation: number;
  exit: Promise<ChildExitOutcome>;
  resolveExit: (outcome: ChildExitOutcome) => void;
  stdoutClosed: Promise<void>;
  drained?: Promise<ChildExitOutcome>;
  termination?: Promise<{ outcome: ChildExitOutcome; forced: boolean }>;
  poison?: Promise<void>;
  poisoned: boolean;
}

export interface CodexAppServerClientOptions {
  experimentalApi?: boolean;
  maxReadRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  retryJitter?: number;
  shutdownTimeoutMs?: number;
  killTimeoutMs?: number;
  maxStdoutLineBytes?: number;
  maxStderrLineBytes?: number;
  clientInfo?: { name: string; title: string; version: string };
  /** Overrides process arguments for deterministic protocol tests. */
  appServerArgs?: string[];
  /** A pre-probed version/schema/capability binding, re-asserted for every connection. */
  protocolBinding?: ProtocolRuntimeBinding;
  /** Re-probes and returns the protocol binding for each new connection generation. */
  validateProtocolBinding?: (generation: number) => Promise<ProtocolRuntimeBinding> | ProtocolRuntimeBinding;
  random?: () => number;
}

export interface StopResult {
  alreadyStopped: boolean;
  forced: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export class CodexRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown
  ) {
    super(message);
    this.name = "CodexRpcError";
  }
}

export class CodexConnectionPoisonedError extends Error {
  constructor(message: string, readonly generation: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexConnectionPoisonedError";
  }
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < 0) throw new Error(`${name} must be a non-negative integer`);
  return selected;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected <= 0) throw new Error(`${name} must be a positive integer`);
  return selected;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function childHasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

interface BoundedLineReaderOptions {
  maxLineBytes: number;
  stopAfterOverflow: boolean;
  onLine: (line: string) => void;
  onOverflow: (boundedPrefix: string) => void;
  onError: (error: Error) => void;
}

/**
 * Consumes a byte stream without ever retaining more than maxLineBytes for one
 * line. Keeping the stream flowing after overflow is important: termination
 * proof still depends on the child pipes reaching close.
 */
function consumeBoundedLines(input: Readable, options: BoundedLineReaderOptions): Promise<void> {
  let fragments: Buffer[] = [];
  let bufferedBytes = 0;
  let discardingLine = false;
  let terminalOverflow = false;
  let ended = false;

  const resetLine = () => {
    fragments = [];
    bufferedBytes = 0;
    discardingLine = false;
  };
  const emitBufferedLine = () => {
    const joined = fragments.length === 1 ? fragments[0]! : Buffer.concat(fragments, bufferedBytes);
    const line = joined.length > 0 && joined[joined.length - 1] === 13 ? joined.subarray(0, -1) : joined;
    options.onLine(line.toString("utf8"));
  };
  const append = (segment: Buffer) => {
    if (discardingLine || terminalOverflow) return;
    const remaining = options.maxLineBytes - bufferedBytes;
    if (segment.length <= remaining) {
      if (segment.length > 0) fragments.push(segment);
      bufferedBytes += segment.length;
      return;
    }
    if (remaining > 0) fragments.push(segment.subarray(0, remaining));
    bufferedBytes += Math.max(remaining, 0);
    const prefix = fragments.length === 1 ? fragments[0]! : Buffer.concat(fragments, bufferedBytes);
    options.onOverflow(prefix.toString("utf8"));
    fragments = [];
    bufferedBytes = 0;
    discardingLine = true;
    terminalOverflow = options.stopAfterOverflow;
  };
  const flushFinalLine = () => {
    if (ended) return;
    ended = true;
    if (!terminalOverflow && !discardingLine && bufferedBytes > 0) emitBufferedLine();
  };

  input.on("data", (value: Buffer | string) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      if (newline < 0) {
        append(chunk.subarray(start));
        break;
      }
      append(chunk.subarray(start, newline));
      if (!terminalOverflow && !discardingLine) emitBufferedLine();
      if (!terminalOverflow) resetLine();
      start = newline + 1;
    }
  });
  input.once("end", flushFinalLine);
  input.once("error", (error) => options.onError(error instanceof Error ? error : new Error(String(error))));
  return new Promise<void>((resolve) => {
    input.once("close", () => {
      flushFinalLine();
      resolve();
    });
  });
}

function rpcIdKey(id: string | number): string {
  return `${typeof id}:${String(id)}`;
}

export class CodexAppServerClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private restartBlockedChild?: ChildProcessWithoutNullStreams;
  private stdoutDrain?: { child: ChildProcessWithoutNullStreams; done: Promise<void> };
  private readonly childLifecycles = new WeakMap<ChildProcessWithoutNullStreams, ChildLifecycle>();
  private nextId = 1;
  private readonly pending = new Map<string, PendingRpc>();
  private starting?: Promise<void>;
  private stopping?: Promise<StopResult>;
  private ready = false;
  private closed = false;
  private initializedConnections = 0;
  private latestGeneration = 0;
  private activeBinding?: ConnectionProtocolBinding;
  private readonly experimentalApi: boolean;
  private readonly maxReadRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly retryJitter: number;
  private readonly shutdownTimeoutMs: number;
  private readonly killTimeoutMs: number;
  private readonly maxStdoutLineBytes: number;
  private readonly maxStderrLineBytes: number;
  private readonly clientInfo: { name: string; title: string; version: string };
  private readonly appServerArgs: string[];
  private readonly staticProtocolBinding?: ProtocolRuntimeBinding;
  private readonly validateProtocolBinding?: (generation: number) => Promise<ProtocolRuntimeBinding> | ProtocolRuntimeBinding;
  private readonly random: () => number;

  constructor(
    private readonly codexBin: string,
    private readonly codexHome: string | undefined,
    private readonly requestTimeoutMs: number,
    options: CodexAppServerClientOptions = {}
  ) {
    super();
    if (!codexBin.trim()) throw new Error("codexBin must not be empty");
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new Error("requestTimeoutMs must be a positive integer");
    }
    this.experimentalApi = options.experimentalApi === true;
    this.maxReadRetries = nonNegativeInteger(options.maxReadRetries, 2, "maxReadRetries");
    this.retryBaseDelayMs = positiveInteger(options.retryBaseDelayMs, 50, "retryBaseDelayMs");
    this.retryMaxDelayMs = positiveInteger(options.retryMaxDelayMs, 1_000, "retryMaxDelayMs");
    const jitter = options.retryJitter ?? 0.2;
    if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) throw new Error("retryJitter must be between 0 and 1");
    this.retryJitter = jitter;
    this.shutdownTimeoutMs = positiveInteger(options.shutdownTimeoutMs, 5_000, "shutdownTimeoutMs");
    this.killTimeoutMs = positiveInteger(options.killTimeoutMs, 2_000, "killTimeoutMs");
    this.maxStdoutLineBytes = positiveInteger(options.maxStdoutLineBytes, 1024 * 1024, "maxStdoutLineBytes");
    this.maxStderrLineBytes = positiveInteger(options.maxStderrLineBytes, 16 * 1024, "maxStderrLineBytes");
    this.clientInfo = options.clientInfo ?? CODEX_APP_SERVER_CLIENT_INFO;
    this.appServerArgs = options.appServerArgs ?? ["app-server"];
    if (this.appServerArgs.length === 0) throw new Error("appServerArgs must not be empty");
    this.staticProtocolBinding = options.protocolBinding;
    this.validateProtocolBinding = options.validateProtocolBinding;
    this.random = options.random ?? Math.random;
  }

  isReady(): boolean {
    return this.ready;
  }

  connectionCount(): number {
    return this.initializedConnections;
  }

  connectionGeneration(): number {
    return this.latestGeneration;
  }

  connectionProtocolBinding(): ConnectionProtocolBinding | undefined {
    return this.activeBinding ? { ...this.activeBinding } : undefined;
  }

  /** Resolves only after the quarantined/exited process has both exited and closed stdout. */
  drainBarrier(): Promise<void> {
    return this.stdoutDrain?.done ?? Promise.resolve();
  }

  async ensureStarted(): Promise<void> {
    if (this.closed) throw new Error("codex app-server client is closed");
    if (this.stopping) await this.stopping;
    if (this.closed) throw new Error("codex app-server client is closed");
    if (this.starting) return this.starting;
    if (this.stdoutDrain) {
      const barrier = this.stdoutDrain;
      await barrier.done;
      if (this.stdoutDrain === barrier) this.stdoutDrain = undefined;
    }
    if (this.closed) throw new Error("codex app-server client is closed");
    if (this.starting) return this.starting;
    if (this.restartBlockedChild && !childHasExited(this.restartBlockedChild)) {
      throw new Error("codex app-server restart is blocked until the previous process exit is proven");
    }
    if (this.restartBlockedChild && childHasExited(this.restartBlockedChild)) this.restartBlockedChild = undefined;
    if (this.child && !childHasExited(this.child)) {
      if (!this.child.killed && this.ready) return;
      throw new Error("codex app-server restart is blocked until the previous process exits");
    }
    const starting = this.startInternal();
    this.starting = starting;
    try {
      await starting;
    } finally {
      if (this.starting === starting) this.starting = undefined;
    }
  }

  private async startInternal(): Promise<void> {
    const generation = this.latestGeneration + 1;
    this.latestGeneration = generation;
    const binding = await this.bindingForGeneration(generation);
    const env = { ...process.env };
    if (this.codexHome) env.CODEX_HOME = this.codexHome;
    // stdio is the default app-server transport. Keeping stdin open is part of
    // the connection lifecycle; it is only closed while stopping the process.
    const child = spawn(this.codexBin, this.appServerArgs, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.child = child;
    this.ready = false;
    this.activeBinding = undefined;
    const lifecycle = this.attachProcess(child, generation);

    try {
      // Deliberately await the initialize response before acknowledging it.
      // No application request can pass ensureStarted until initialized is sent.
      await this.requestRaw("initialize", {
        clientInfo: this.clientInfo,
        ...(this.experimentalApi ? { capabilities: { experimentalApi: true } } : {})
      });
      await this.writeLine({ method: "initialized", params: {} }, child);
      if (this.child !== child || childHasExited(child) || lifecycle.poisoned) {
        throw new Error("codex app-server exited or was quarantined during initialization");
      }
      this.initializedConnections += 1;
      this.activeBinding = binding ? { ...binding, connectionGeneration: generation } : undefined;
      this.ready = true;
    } catch (error) {
      try {
        await this.terminateWithProof(child);
      } catch (terminationError) {
        this.restartBlockedChild = child;
        throw new AggregateError(
          [error, terminationError],
          "codex app-server initialization failed and process exit was not proven"
        );
      }
      throw error;
    }
  }

  private async bindingForGeneration(generation: number): Promise<ProtocolRuntimeBinding | undefined> {
    const binding = this.validateProtocolBinding
      ? await this.validateProtocolBinding(generation)
      : this.staticProtocolBinding;
    if (binding) {
      assertProtocolRuntimeBinding(binding);
      if (binding.capabilities.experimentalApi !== this.experimentalApi) {
        throw new Error("Codex protocol binding experimentalApi capability does not match the client handshake");
      }
    }
    return binding;
  }

  private attachProcess(child: ChildProcessWithoutNullStreams, generation: number): ChildLifecycle {
    let resolveStdoutClosed!: () => void;
    const stdoutClosed = new Promise<void>((resolve) => {
      resolveStdoutClosed = resolve;
    });
    let exitSettled = false;
    let settleExit!: (outcome: ChildExitOutcome) => void;
    const exit = new Promise<ChildExitOutcome>((resolve) => {
      settleExit = (outcome) => {
        if (exitSettled) return;
        exitSettled = true;
        resolve(outcome);
      };
    });
    const lifecycle: ChildLifecycle = {
      generation,
      exit,
      resolveExit: settleExit,
      stdoutClosed,
      poisoned: false
    };
    this.childLifecycles.set(child, lifecycle);

    void consumeBoundedLines(child.stdout, {
      maxLineBytes: this.maxStdoutLineBytes,
      stopAfterOverflow: true,
      onLine: (line) => this.onLine(line, child, generation),
      onOverflow: () => this.handleProtocolFailure(
        child,
        generation,
        new Error(`Codex app-server JSONL line exceeds ${this.maxStdoutLineBytes} bytes`)
      ),
      onError: (error) => this.handleTransportFailure(child, generation, error)
    }).then(resolveStdoutClosed);

    child.on("error", (error) => {
      const processWasNeverCreated = child.pid === undefined;
      if (processWasNeverCreated) {
        this.failConnection(child, error, true);
        lifecycle.resolveExit({ code: child.exitCode, signal: child.signalCode });
        if (this.restartBlockedChild === child) this.restartBlockedChild = undefined;
        this.installDrainBarrier(child, this.beginDrain(child, lifecycle).then(() => undefined));
      } else {
        const poisoned = this.poisonConnection(child, generation, error);
        void poisoned.catch((terminationError) => this.emit("processError", terminationError));
      }
      this.emit("processError", error);
    });
    child.once("exit", (code, signal) => {
      const outcome = { code, signal };
      lifecycle.resolveExit(outcome);
      const error = new Error(`codex app-server exited (code=${code}, signal=${signal})`);
      // Reject in-flight calls as soon as process death is known, but defer the
      // public exit event until readline has emitted every trailing JSONL line.
      this.failConnection(child, error, true);
      if (this.restartBlockedChild === child) this.restartBlockedChild = undefined;
      this.installDrainBarrier(child, this.beginDrain(child, lifecycle).then(() => undefined));
    });

    void consumeBoundedLines(child.stderr, {
      maxLineBytes: this.maxStderrLineBytes,
      stopAfterOverflow: false,
      onLine: (line) => this.emit("stderr", line),
      onOverflow: (prefix) => this.emit(
        "stderr",
        `${prefix}\u2026[truncated at ${this.maxStderrLineBytes} bytes]`
      ),
      onError: (error) => this.emit("processError", error)
    });
    // A pipe can report EPIPE while a process is being terminated. Individual
    // writes still receive their callback error; this prevents an unhandled
    // stream error from taking down the supervisor during cleanup.
    child.stdin.on("error", () => undefined);
    return lifecycle;
  }

  private beginDrain(
    child: ChildProcessWithoutNullStreams,
    lifecycle = this.childLifecycles.get(child)
  ): Promise<ChildExitOutcome> {
    if (!lifecycle) return Promise.reject(new Error("codex app-server lifecycle was not registered"));
    if (!lifecycle.drained) {
      lifecycle.drained = Promise.all([lifecycle.exit, lifecycle.stdoutClosed]).then(([outcome]) => {
        this.emit("exit", outcome);
        return outcome;
      });
    }
    return lifecycle.drained;
  }

  private installDrainBarrier(child: ChildProcessWithoutNullStreams, done: Promise<void>): void {
    // A later, real exit replaces a previously rejected termination proof for
    // the same child. An older child must never replace a newer generation's
    // barrier.
    if (!this.stdoutDrain || this.stdoutDrain.child === child) this.stdoutDrain = { child, done };
    // The barrier is awaited by ensureStarted/stop, but event-triggered poison
    // can otherwise reject before either caller reaches it.
    void done.catch(() => undefined);
  }

  private failConnection(child: ChildProcessWithoutNullStreams, error: Error, releaseChild: boolean): void {
    if (this.child !== child) return;
    this.ready = false;
    this.activeBinding = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (releaseChild) this.child = undefined;
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    assertExperimentalMethodAllowed(method, this.experimentalApi);
    const retries = isReadOnlyCodexMethod(method) ? this.maxReadRetries : 0;
    let attempt = 0;
    while (true) {
      await this.ensureStarted();
      try {
        return await this.requestRaw(method, params);
      } catch (error) {
        if (attempt >= retries || !this.retryable(error)) throw error;
        await delay(this.backoff(attempt));
        attempt += 1;
      }
    }
  }

  private retryable(error: unknown): boolean {
    if (error instanceof CodexRpcError) return RETRYABLE_CODEX_ERROR_CODES.has(error.code);
    if (error instanceof CodexConnectionPoisonedError) return true;
    return error instanceof Error && (
      (error as NodeJS.ErrnoException).code === "EPIPE" ||
      error.message.startsWith("Codex RPC timed out:") ||
      error.message.includes("app-server exited") ||
      error.message.includes("EPIPE")
    );
  }

  private backoff(attempt: number): number {
    const base = Math.min(this.retryMaxDelayMs, this.retryBaseDelayMs * (2 ** attempt));
    const multiplier = 1 + ((this.random() * 2) - 1) * this.retryJitter;
    return Math.max(1, Math.round(base * multiplier));
  }

  private requestRaw(method: string, params: Record<string, unknown>): Promise<any> {
    const child = this.child;
    if (!child || childHasExited(child)) throw new Error("codex app-server is not running");
    const lifecycle = this.childLifecycles.get(child);
    if (!lifecycle || lifecycle.poisoned) throw new Error("codex app-server connection is quarantined");
    const generation = lifecycle.generation;
    const id = this.nextId++;
    const key = rpcIdKey(id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        const timeoutError = new Error(`Codex RPC timed out: ${method}`);
        if (isReadOnlyCodexMethod(method)) {
          reject(timeoutError);
          return;
        }
        const poisoned = this.poisonConnection(child, generation, timeoutError);
        void poisoned.then(
          () => reject(new CodexConnectionPoisonedError(timeoutError.message, generation, { cause: timeoutError })),
          (terminationError) => reject(new AggregateError(
            [timeoutError, terminationError],
            `Codex mutation timed out and generation ${generation} could not be safely drained`
          ))
        );
      }, this.requestTimeoutMs);
      this.pending.set(key, { method, generation, resolve, reject, timer });
      void this.writeLine({ method, id, params }, child).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(key);
        const writeError = error instanceof Error ? error : new Error(String(error));
        const poisoned = this.poisonConnection(child, generation, writeError);
        const outcome = isReadOnlyCodexMethod(method)
          ? `Codex request write failed: ${method}`
          : `Codex mutation write outcome is ambiguous: ${method}`;
        void poisoned.then(
          () => reject(new CodexConnectionPoisonedError(outcome, generation, { cause: writeError })),
          (terminationError) => reject(new AggregateError(
            [writeError, terminationError],
            `${outcome}; generation ${generation} could not be safely drained`
          ))
        );
      });
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    const child = this.requireChild();
    void this.writeLine({ method, params }, child).catch((error) => {
      this.handleOneWayWriteFailure(child, `notification ${method}`, error);
    });
  }

  async respond(requestId: string | number, result: unknown): Promise<void> {
    const child = this.requireChild();
    await this.writeServerResponse(
      child,
      `server request response ${String(requestId)}`,
      { id: requestId, result }
    );
  }

  async respondError(
    requestId: string | number,
    code: number,
    message: string,
    data?: unknown
  ): Promise<void> {
    const child = this.requireChild();
    await this.writeServerResponse(
      child,
      `server request error response ${String(requestId)}`,
      { id: requestId, error: { code, message, ...(data === undefined ? {} : { data }) } }
    );
  }

  private async writeServerResponse(
    child: ChildProcessWithoutNullStreams,
    operation: string,
    message: Parameters<typeof encodeCodexWireMessage>[0]
  ): Promise<void> {
    try {
      await this.writeLine(message, child);
    } catch (error) {
      const writeError = error instanceof Error ? error : new Error(String(error));
      const lifecycle = this.childLifecycles.get(child);
      if (!lifecycle) throw writeError;
      const ambiguousError = new CodexConnectionPoisonedError(
        `Codex ${operation} write outcome is ambiguous`,
        lifecycle.generation,
        { cause: writeError }
      );
      try {
        await this.poisonConnection(child, lifecycle.generation, ambiguousError);
      } catch (terminationError) {
        throw new AggregateError(
          [ambiguousError, terminationError],
          `Codex ${operation} failed and the connection could not be safely drained`
        );
      }
      throw ambiguousError;
    }
  }

  private handleOneWayWriteFailure(
    child: ChildProcessWithoutNullStreams,
    operation: string,
    error: unknown
  ): void {
    const writeError = error instanceof Error ? error : new Error(String(error));
    const lifecycle = this.childLifecycles.get(child);
    if (!lifecycle) {
      this.emit("processError", writeError);
      return;
    }
    const ambiguousError = new CodexConnectionPoisonedError(
      `Codex ${operation} write outcome is ambiguous`,
      lifecycle.generation,
      { cause: writeError }
    );
    const poisoned = this.poisonConnection(child, lifecycle.generation, ambiguousError);
    void poisoned.then(
      () => this.emit("processError", ambiguousError),
      (terminationError) => this.emit("processError", new AggregateError(
        [ambiguousError, terminationError],
        `Codex ${operation} failed and the connection could not be safely drained`
      ))
    );
  }

  private requireChild(): ChildProcessWithoutNullStreams {
    if (!this.ready || !this.child || childHasExited(this.child)) throw new Error("codex app-server is not ready");
    if (this.childLifecycles.get(this.child)?.poisoned) throw new Error("codex app-server connection is quarantined");
    return this.child;
  }

  private writeLine(message: Parameters<typeof encodeCodexWireMessage>[0], child: ChildProcessWithoutNullStreams): Promise<void> {
    if (this.child !== child || childHasExited(child) || child.stdin.destroyed) {
      return Promise.reject(new Error("codex app-server stdin is not writable"));
    }
    if (this.childLifecycles.get(child)?.poisoned) {
      return Promise.reject(new Error("codex app-server connection is quarantined"));
    }
    return new Promise((resolve, reject) => {
      child.stdin.write(encodeCodexWireMessage(message), (error) => error ? reject(error) : resolve());
    });
  }

  private onLine(line: string, child: ChildProcessWithoutNullStreams, generation: number): void {
    const lifecycle = this.childLifecycles.get(child);
    if (!lifecycle || lifecycle.generation !== generation || lifecycle.poisoned) return;
    let message;
    try {
      message = parseCodexWireMessage(line);
    } catch (error) {
      const protocolError = error instanceof Error ? error : new Error(String(error));
      this.handleProtocolFailure(child, generation, protocolError);
      return;
    }

    if (!("method" in message)) {
      this.onResponse(message, generation);
      return;
    }
    if ("id" in message) {
      this.emit("serverRequest", message as CodexRpcRequest);
      return;
    }
    this.emit("notification", message);
  }

  private onResponse(message: CodexRpcResponse, generation: number): void {
    const key = rpcIdKey(message.id);
    const pending = this.pending.get(key);
    if (!pending || pending.generation !== generation) {
      this.emit("unhandled", message);
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(key);
    if (message.error) {
      pending.reject(new CodexRpcError(message.error.message, message.error.code, message.error.data));
    } else {
      pending.resolve(message.result);
    }
  }

  private handleProtocolFailure(
    child: ChildProcessWithoutNullStreams,
    generation: number,
    error: Error
  ): void {
    const poisoned = this.poisonConnection(child, generation, error);
    this.emit("protocolError", error);
    void poisoned.catch((terminationError) => this.emit("processError", terminationError));
  }

  private handleTransportFailure(
    child: ChildProcessWithoutNullStreams,
    generation: number,
    error: Error
  ): void {
    const poisoned = this.poisonConnection(child, generation, error);
    this.emit("processError", error);
    void poisoned.catch((terminationError) => this.emit("processError", terminationError));
  }

  async stop(): Promise<StopResult> {
    if (this.stopping) return this.stopping;
    this.closed = true;
    const stopping = this.stopInternal();
    this.stopping = stopping;
    try {
      return await stopping;
    } finally {
      if (this.stopping === stopping) this.stopping = undefined;
    }
  }

  private async stopInternal(): Promise<StopResult> {
    this.ready = false;
    this.activeBinding = undefined;
    const child = this.restartBlockedChild ?? this.child;
    if (!child) {
      if (this.stdoutDrain) {
        const barrier = this.stdoutDrain;
        await barrier.done;
        if (this.stdoutDrain === barrier) this.stdoutDrain = undefined;
      }
      return { alreadyStopped: true, forced: false, exitCode: null, signal: null };
    }
    const lifecycle = this.childLifecycles.get(child);
    if (!lifecycle) throw new Error("codex app-server lifecycle was not registered");
    if (childHasExited(child)) {
      this.installDrainBarrier(child, this.beginDrain(child, lifecycle).then(() => undefined));
      const outcome = await this.beginDrain(child, lifecycle);
      if (this.child === child) this.child = undefined;
      if (this.restartBlockedChild === child) this.restartBlockedChild = undefined;
      if (this.stdoutDrain?.child === child) this.stdoutDrain = undefined;
      return { alreadyStopped: false, forced: false, exitCode: outcome.code, signal: outcome.signal };
    }
    const { outcome, forced } = await this.terminateWithProof(child);
    this.installDrainBarrier(child, this.beginDrain(child, lifecycle).then(() => undefined));
    await this.beginDrain(child, lifecycle);
    if (this.stdoutDrain?.child === child) this.stdoutDrain = undefined;
    return {
      alreadyStopped: false,
      forced,
      exitCode: outcome.code,
      signal: outcome.signal
    };
  }

  private async terminateWithProof(
    child: ChildProcessWithoutNullStreams
  ): Promise<{ outcome: ChildExitOutcome; forced: boolean }> {
    const lifecycle = this.childLifecycles.get(child);
    if (!lifecycle) throw new Error("codex app-server lifecycle was not registered");
    if (lifecycle.termination) return lifecycle.termination;
    const termination = this.terminateOnce(child, lifecycle);
    lifecycle.termination = termination;
    return termination;
  }

  private async terminateOnce(
    child: ChildProcessWithoutNullStreams,
    lifecycle: ChildLifecycle
  ): Promise<{ outcome: ChildExitOutcome; forced: boolean }> {
    if (childHasExited(child) || child.pid === undefined) {
      const outcome = child.pid === undefined
        ? await lifecycle.exit
        : { code: child.exitCode, signal: child.signalCode };
      if (this.child === child) this.child = undefined;
      if (this.restartBlockedChild === child) this.restartBlockedChild = undefined;
      return { outcome, forced: false };
    }

    try {
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
    } catch {
      // Process signals below are the authoritative shutdown mechanism.
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // Still wait: the process may have exited between the state check and kill.
    }
    let outcome = await this.waitForExit(lifecycle.exit, this.shutdownTimeoutMs);
    let forced = false;
    if (!outcome) {
      forced = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Still wait for a concurrently delivered exit event.
      }
      outcome = await this.waitForExit(lifecycle.exit, this.killTimeoutMs);
    }
    if (!outcome) {
      this.restartBlockedChild = child;
      throw new Error("codex app-server did not exit after SIGKILL; restart remains blocked");
    }
    if (this.child === child) this.child = undefined;
    if (this.restartBlockedChild === child) this.restartBlockedChild = undefined;
    return { outcome, forced };
  }

  private poisonConnection(
    child: ChildProcessWithoutNullStreams,
    generation: number,
    reason: Error
  ): Promise<void> {
    const lifecycle = this.childLifecycles.get(child);
    if (!lifecycle || lifecycle.generation !== generation) return Promise.resolve();
    if (lifecycle.poison) return lifecycle.poison;

    lifecycle.poisoned = true;
    if (this.child === child) {
      this.ready = false;
      this.activeBinding = undefined;
      this.failConnection(
        child,
        new CodexConnectionPoisonedError(
          `Codex connection generation ${generation} was quarantined: ${reason.message}`,
          generation,
          { cause: reason }
        ),
        false
      );
    }
    const poison = (async () => {
      await this.terminateWithProof(child);
      await this.beginDrain(child, lifecycle);
    })();
    lifecycle.poison = poison;
    this.stdoutDrain = { child, done: poison };
    void poison.catch(() => undefined);
    return poison;
  }

  private async waitForExit<T>(exit: Promise<T>, timeoutMs: number): Promise<T | undefined> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        exit,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
