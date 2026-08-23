export type TaskStatus =
  | "starting"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "interrupted"
  | "stale";

export interface SupervisorEvent {
  seq: number;
  at: string;
  method: string;
  payload: unknown;
}

export interface PendingApproval {
  approvalId: string;
  requestId: string | number;
  method: string;
  threadId?: string;
  turnId?: string;
  params: Record<string, unknown>;
  risk: "normal" | "blocked";
  riskReasons: string[];
  createdAt: string;
}

export interface TaskRecord {
  id: string;
  objective: string;
  workspace: string;
  threadId?: string;
  turnId?: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  lastAgentMessage?: string;
  error?: string;
  eventSeq: number;
  events: SupervisorEvent[];
  pendingApprovalIds: string[];
}
