import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import { CodexAppServerClient, type RpcRequest } from "../codex/app-server-client.js";
import type { PendingApproval, SupervisorEvent, TaskRecord, TaskStatus } from "../types.js";
import { classifyApproval } from "./policy.js";
import { TaskStore } from "./store.js";
import { WorkspaceGuard } from "./workspace.js";
import { workspaceDiff, workspaceStatus } from "./git-inspector.js";

interface StartTaskInput {
  workspace: string;
  objective: string;
  plan?: string[];
  acceptanceCriteria?: string[];
  constraints?: string[];
}

interface ContinueTaskInput {
  taskId: string;
  instruction: string;
}

function iso(): string {
  return new Date().toISOString();
}

function brief(input: StartTaskInput): string {
  const list = (title: string, values?: string[]) =>
    values?.length ? `\n${title}:\n${values.map((v, i) => `${i + 1}. ${v}`).join("\n")}` : "";
  return [
    "You are the implementation agent. ChatGPT is the supervisor and has already defined the task.",
    "Implement the requested work in the current repository. Do not silently broaden scope.",
    "Inspect the repository before editing. Preserve existing contracts unless the brief explicitly changes them.",
    "Run the relevant tests/checks before declaring completion. If blocked, explain the blocker precisely instead of inventing a workaround.",
    `\nObjective:\n${input.objective}`,
    list("Implementation plan", input.plan),
    list("Acceptance criteria", input.acceptanceCriteria),
    list("Constraints", input.constraints),
    "\nAt the end, report: changed files, tests/checks run, results, unresolved risks, and anything the supervisor should review."
  ].join("\n");
}

export class Orchestrator {
  private readonly client: CodexAppServerClient;
  private readonly store: TaskStore;
  private readonly guard: WorkspaceGuard;
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(private readonly config: Config) {
    this.client = new CodexAppServerClient(config.codexBin, config.codexHome, config.requestTimeoutMs);
    this.store = new TaskStore(config.stateFile);
    this.guard = new WorkspaceGuard(config.workspaceRoots);

    this.client.on("notification", (message) => void this.onNotification(message));
    this.client.on("serverRequest", (request: RpcRequest) => void this.onServerRequest(request));
    this.client.on("exit", () => void this.markActiveTasksStale("codex app-server exited"));
    this.client.on("processError", (error: Error) => void this.markActiveTasksStale(`codex app-server process error: ${error.message}`));
    this.client.on("stderr", (line: string) => console.error(`[codex] ${line}`));
  }

  async init(): Promise<void> {
    await this.store.load();
  }

  async health(): Promise<Record<string, unknown>> {
    try {
      await this.client.ensureStarted();
      const account = await this.client.request("account/read", {});
      return { ok: true, codex: "reachable", account };
    } catch (error) {
      return { ok: false, codex: "unreachable", error: (error as Error).message };
    }
  }

  controlEnabled(): boolean {
    return this.config.controlEnabled;
  }

  listTasks(): TaskRecord[] {
    return this.store.list();
  }

  listTaskSummaries(): Array<Record<string, unknown>> {
    return this.store.list().map((task) => this.taskSummary(task));
  }

  getTaskSummary(taskId: string): Record<string, unknown> {
    return this.taskSummary(this.getTask(taskId));
  }

  getTask(taskId: string): TaskRecord {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    return task;
  }

  async startTask(input: StartTaskInput): Promise<TaskRecord> {
    const workspace = await this.guard.resolveAllowed(input.workspace);
    const task: TaskRecord = {
      id: randomUUID(),
      objective: input.objective,
      workspace,
      status: "starting",
      createdAt: iso(),
      updatedAt: iso(),
      eventSeq: 0,
      events: [],
      pendingApprovalIds: []
    };
    await this.store.put(task);

    try {
      const started = await this.client.request("thread/start", {
        cwd: workspace,
        approvalPolicy: "unlessTrusted",
        sandbox: "workspaceWrite",
        approvalsReviewer: "user",
        serviceName: "codex_supervisor_mcp"
      });
      task.threadId = started.thread.id;
      const turn = await this.client.request("turn/start", {
        threadId: task.threadId,
        clientUserMessageId: `supervisor-${task.id}`,
        input: [{ type: "text", text: brief(input) }]
      });
      task.turnId = turn.turn.id;
      task.status = "running";
      task.updatedAt = iso();
      await this.store.put(task);
      this.signal(task.id);
      return task;
    } catch (error) {
      task.status = "failed";
      task.error = (error as Error).message;
      task.updatedAt = iso();
      await this.store.put(task);
      this.signal(task.id);
      throw error;
    }
  }

  async continueTask(input: ContinueTaskInput): Promise<TaskRecord> {
    const task = this.getTask(input.taskId);
    if (!task.threadId) throw new Error("Task has no Codex thread id");
    if (["running", "waiting_approval"].includes(task.status)) throw new Error("Task already has an active turn; use codex_task_steer instead");

    const resumed = await this.client.request("thread/resume", {
      threadId: task.threadId,
      cwd: task.workspace,
      approvalPolicy: "unlessTrusted",
      sandbox: "workspaceWrite",
      approvalsReviewer: "user"
    });
    task.threadId = resumed.thread.id;
    const turn = await this.client.request("turn/start", {
      threadId: task.threadId,
      clientUserMessageId: `supervisor-followup-${randomUUID()}`,
      input: [{ type: "text", text: input.instruction }]
    });
    task.turnId = turn.turn.id;
    task.status = "running";
    task.error = undefined;
    task.updatedAt = iso();
    await this.store.put(task);
    this.signal(task.id);
    return task;
  }

  async steerTask(taskId: string, instruction: string): Promise<TaskRecord> {
    const task = this.getTask(taskId);
    if (!task.threadId || !task.turnId) throw new Error("Task has no active Codex turn");
    await this.client.request("turn/steer", {
      threadId: task.threadId,
      expectedTurnId: task.turnId,
      clientUserMessageId: `supervisor-steer-${randomUUID()}`,
      input: [{ type: "text", text: instruction }]
    });
    return task;
  }

  async interruptTask(taskId: string): Promise<TaskRecord> {
    const task = this.getTask(taskId);
    if (!task.threadId || !task.turnId) throw new Error("Task has no active Codex turn");
    await this.client.request("turn/interrupt", { threadId: task.threadId, turnId: task.turnId });
    return task;
  }

  getEvents(taskId: string, afterSeq = 0): SupervisorEvent[] {
    return this.getTask(taskId).events.filter((e) => e.seq > afterSeq);
  }

  listApprovals(taskId?: string): PendingApproval[] {
    const all = [...this.approvals.values()];
    if (!taskId) return all;
    return all.filter((a) => this.findTaskByThread(a.threadId)?.id === taskId);
  }

  async decideApproval(approvalId: string, decision: "accept" | "acceptForSession" | "decline" | "cancel"): Promise<PendingApproval> {
    const approval = this.approvals.get(approvalId);
    if (!approval) throw new Error(`Unknown or already-resolved approval: ${approvalId}`);
    if (approval.risk === "blocked" && (decision === "accept" || decision === "acceptForSession")) {
      throw new Error(`Approval is blocked by supervisor policy: ${approval.riskReasons.join("; ")}`);
    }

    this.client.respond(approval.requestId, { decision });
    this.approvals.delete(approvalId);
    const task = this.findTaskByThread(approval.threadId);
    if (task) {
      task.pendingApprovalIds = task.pendingApprovalIds.filter((id) => id !== approvalId);
      if (task.pendingApprovalIds.length === 0 && task.status === "waiting_approval") task.status = "running";
      task.updatedAt = iso();
      await this.store.put(task);
      this.signal(task.id);
    }
    return approval;
  }

  async getWorkspaceStatus(taskId: string): Promise<string> {
    return workspaceStatus(this.getTask(taskId).workspace);
  }

  async getWorkspaceDiff(taskId: string): Promise<{ truncated: boolean; text: string }> {
    return workspaceDiff(this.getTask(taskId).workspace, this.config.maxDiffChars);
  }

  async waitForChange(taskId: string, afterSeq: number, timeoutMs: number): Promise<TaskRecord> {
    const task = this.getTask(taskId);
    if (task.eventSeq > afterSeq || ["completed", "failed", "interrupted", "waiting_approval", "stale"].includes(task.status)) return task;
    await new Promise<void>((resolve) => {
      const bucket = this.waiters.get(taskId) ?? new Set<() => void>();
      const done = () => {
        clearTimeout(timer);
        bucket.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.min(Math.max(timeoutMs, 1), 25000));
      bucket.add(done);
      this.waiters.set(taskId, bucket);
    });
    return this.getTask(taskId);
  }

  private async onServerRequest(request: RpcRequest): Promise<void> {
    const params = request.params ?? {};
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
    const task = this.findTaskByThread(threadId);

    if (!task) {
      this.client.respondError(request.id, -32602, `No supervised task for Codex thread: ${threadId ?? "unknown"}`);
      return;
    }

    if (request.method === "item/permissions/requestApproval") {
      // v0.1 never grants additional permission profiles. Codex can continue
      // inside the original workspace-write sandbox or report the blocker.
      this.client.respond(request.id, { scope: "turn", permissions: {} });
      await this.appendEvent(task, request.method, { ...params, supervisorDecision: "denyAdditionalPermissions" });
      await this.store.put(task);
      this.signal(task.id);
      return;
    }

    const supportedApproval =
      request.method === "item/commandExecution/requestApproval" ||
      request.method === "item/fileChange/requestApproval";
    if (!supportedApproval) {
      // Unknown blocking interaction: fail closed using an RPC error instead of
      // guessing a result schema for a request we do not understand.
      this.client.respondError(request.id, -32601, `Unsupported Codex server request: ${request.method}`);
      return;
    }

    const risk = classifyApproval(params, task.workspace);
    const approval: PendingApproval = {
      approvalId: randomUUID(),
      requestId: request.id,
      method: request.method,
      threadId,
      turnId,
      params,
      risk: risk.risk,
      riskReasons: risk.reasons,
      createdAt: iso()
    };
    this.approvals.set(approval.approvalId, approval);
    task.pendingApprovalIds.push(approval.approvalId);
    task.status = "waiting_approval";
    task.updatedAt = iso();
    await this.appendEvent(task, `serverRequest:${request.method}`, { ...params, approvalId: approval.approvalId, risk });
    await this.store.put(task);
    this.signal(task.id);
  }

  private async onNotification(message: any): Promise<void> {
    const params = message.params ?? {};
    const threadId = typeof params.threadId === "string" ? params.threadId : params.thread?.id;
    const task = this.findTaskByThread(threadId);
    if (!task) return;

    if (message.method === "turn/started") {
      if (params.turn?.id) task.turnId = params.turn.id;
      task.status = "running";
    } else if (message.method === "turn/completed") {
      const status = params.turn?.status;
      task.status = this.mapTurnStatus(status);
      const finalMessage = params.turn?.items?.find?.((item: any) => item.type === "agentMessage")?.text;
      if (typeof finalMessage === "string") task.lastAgentMessage = finalMessage;
      this.clearApprovalsForThread(task.threadId);
      task.pendingApprovalIds = [];
    } else if (message.method === "serverRequest/resolved") {
      const requestId = params.requestId;
      for (const [approvalId, approval] of this.approvals) {
        if (String(approval.requestId) === String(requestId)) {
          this.approvals.delete(approvalId);
          task.pendingApprovalIds = task.pendingApprovalIds.filter((id) => id !== approvalId);
        }
      }
      if (task.pendingApprovalIds.length === 0 && task.status === "waiting_approval") task.status = "running";
    } else if (message.method === "item/completed" && params.item?.type === "agentMessage") {
      if (typeof params.item.text === "string") task.lastAgentMessage = params.item.text;
    } else if (message.method === "error") {
      task.error = params.error?.message ?? JSON.stringify(params.error ?? params);
    }

    task.updatedAt = iso();
    await this.appendEvent(task, message.method, params);
    await this.store.put(task);
    this.signal(task.id);
  }

  private mapTurnStatus(value: unknown): TaskStatus {
    if (value === "completed") return "completed";
    if (value === "interrupted") return "interrupted";
    if (value === "failed") return "failed";
    return "completed";
  }

  private findTaskByThread(threadId?: string): TaskRecord | undefined {
    if (!threadId) return undefined;
    return this.store.list().find((task) => task.threadId === threadId);
  }

  private async appendEvent(task: TaskRecord, method: string, payload: unknown): Promise<void> {
    task.eventSeq += 1;
    task.events.push({ seq: task.eventSeq, at: iso(), method, payload: this.boundPayload(payload) });
    if (task.events.length > this.config.maxEventsPerTask) {
      task.events.splice(0, task.events.length - this.config.maxEventsPerTask);
    }
  }

  private signal(taskId: string): void {
    const bucket = this.waiters.get(taskId);
    if (!bucket) return;
    for (const wake of [...bucket]) wake();
  }

  private taskSummary(task: TaskRecord): Record<string, unknown> {
    const { events: _events, ...summary } = task;
    return { ...summary, latestSeq: task.eventSeq };
  }

  private boundPayload(payload: unknown): unknown {
    try {
      const raw = JSON.stringify(payload);
      if (raw.length <= this.config.maxEventPayloadChars) return payload;
      return {
        truncated: true,
        originalChars: raw.length,
        preview: raw.slice(0, this.config.maxEventPayloadChars)
      };
    } catch {
      return { truncated: true, preview: String(payload).slice(0, this.config.maxEventPayloadChars) };
    }
  }

  private clearApprovalsForThread(threadId?: string): void {
    if (!threadId) return;
    for (const [approvalId, approval] of this.approvals) {
      if (approval.threadId === threadId) this.approvals.delete(approvalId);
    }
  }

  async stop(): Promise<void> {
    await this.client.stop();
  }

  private async markActiveTasksStale(reason: string): Promise<void> {
    for (const task of this.store.list()) {
      if (["starting", "running", "waiting_approval"].includes(task.status)) {
        task.status = "stale";
        task.error = reason;
        task.pendingApprovalIds = [];
        task.updatedAt = iso();
        await this.store.put(task);
        this.signal(task.id);
      }
    }
    this.approvals.clear();
  }
}
