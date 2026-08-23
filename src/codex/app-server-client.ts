import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";

export interface RpcRequest {
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
}

export class CodexAppServerClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRpc>();
  private starting?: Promise<void>;
  private ready = false;

  constructor(
    private readonly codexBin: string,
    private readonly codexHome: string | undefined,
    private readonly requestTimeoutMs: number
  ) {
    super();
  }

  async ensureStarted(): Promise<void> {
    if (this.child && !this.child.killed && this.ready) return;
    if (this.starting) return this.starting;
    this.starting = this.startInternal();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async startInternal(): Promise<void> {
    const env = { ...process.env };
    if (this.codexHome) env.CODEX_HOME = this.codexHome;
    const child = spawn(this.codexBin, ["app-server", "--stdio"], {
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    this.ready = false;

    child.once("error", (error) => {
      this.ready = false;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      this.child = undefined;
      this.emit("processError", error);
    });

    child.on("exit", (code, signal) => {
      const error = new Error(`codex app-server exited (code=${code}, signal=${signal})`);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      this.child = undefined;
      this.ready = false;
      this.emit("exit", { code, signal });
    });

    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => this.onLine(line));
    const stderr = createInterface({ input: child.stderr });
    stderr.on("line", (line) => this.emit("stderr", line));

    await this.requestRaw("initialize", {
      clientInfo: {
        name: "codex_supervisor_mcp",
        title: "Codex Supervisor MCP",
        version: "0.1.0"
      }
    });
    this.notify("initialized", {});
    this.ready = true;
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    await this.ensureStarted();
    return this.requestRaw(method, params);
  }

  private requestRaw(method: string, params: Record<string, unknown>): Promise<any> {
    if (!this.child) throw new Error("codex app-server is not running");
    const id = this.nextId++;
    const message = { method, id, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex RPC timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify(message) + "\n", (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (!this.child) throw new Error("codex app-server is not running");
    this.child.stdin.write(JSON.stringify({ method, params }) + "\n");
  }

  respond(requestId: string | number, result: unknown): void {
    if (!this.child) throw new Error("codex app-server is not running");
    this.child.stdin.write(JSON.stringify({ id: requestId, result }) + "\n");
  }

  respondError(requestId: string | number, code: number, message: string): void {
    if (!this.child) throw new Error("codex app-server is not running");
    this.child.stdin.write(JSON.stringify({ id: requestId, error: { code, message } }) + "\n");
  }

  private onLine(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("protocolError", new Error(`Invalid JSON from codex app-server: ${line.slice(0, 500)}`));
      return;
    }

    if (message && message.id !== undefined && ("result" in message || "error" in message) && typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
        else pending.resolve(message.result);
        return;
      }
    }

    if (message && message.method && message.id !== undefined) {
      this.emit("serverRequest", message as RpcRequest);
      return;
    }

    if (message && message.method) {
      this.emit("notification", message);
      return;
    }

    this.emit("unhandled", message);
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    const child = this.child;
    this.child = undefined;
    this.ready = false;
    child.kill("SIGTERM");
  }
}
