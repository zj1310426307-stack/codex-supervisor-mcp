# Supervision protocol

## Task states

The main path is:

`planned -> preparing -> running -> awaiting_verification -> verifying -> awaiting_verification -> ready_for_human_review`

Correction uses `awaiting_verification -> needs_correction -> running`. Explicit decisions can also block or cancel a task. `stale`, `lost`, and quarantine are safety states, not automatic retry instructions.

## Turn semantics

A task and a Codex turn are distinct. `turn/completed` closes the active Turn Lease and captures evidence; it never directly accepts the task. Only an explicit `codex_task_decide(accept)` after required verification can reach human-review readiness. The accept branch requires `expectedSnapshotId` and `criterionConfirmations`; their IDs must uniquely and exactly cover the Development Contract. The Supervisor re-captures the worktree before the transition, so stale evidence cannot be accepted.

Steer and interrupt require the exact owned thread/turn. A follow-up starts only from `codex_task_continue` or a `request_changes` decision. Correction passes are bounded by the Development Contract.

## App Server sequence

The Supervisor starts `codex app-server` using JSONL stdio, sends one `initialize` request with client identity and supported capabilities, waits for its response, then sends `initialized`. The stdin stream remains open for the lifetime of the connection. Requests before initialization and repeated initialization are protocol errors.

Stable capabilities are checked before control operations. Experimental APIs require an explicit configuration flag and are never silently substituted for a missing stable capability.

`turn/started` and `turn/completed` are associated by the exact turn identity in the official `{turn}` payload; they do not need a synthetic top-level thread ID. A notification that races ahead of `turn/start` response handling is idempotently reconciled and cannot acquire a second writer lease or resurrect a completed writer.

## Event semantics

Every task event has a monotonically increasing sequence. Retention is bounded; responses include the oldest available and latest sequence so clients can detect trimming. Payloads are redacted and size-bounded before persistence.
