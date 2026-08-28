# Recovery

Recovery is evidence-driven and scoped.

- A stale Codex turn is not assumed dead. Read the ledger, process/runtime evidence, task worktree, and App Server thread state before recovery.
- A pending approval RPC cannot be recreated after the owning App Server connection is gone. Preserve the audit event, mark it unresolved/stale, and require an explicit follow-up decision.
- On restart, prior-runtime pending approval IDs are explicitly invalidated and cleared; they are never reconstructed as actionable approvals.
- A reservation-only `planned` task may resume only when the same `clientRequestId` is retried and the ledger contains no worktree/thread/turn/lease or other side-effect evidence. A prior-runtime `preparing` task is marked stale because a Git or App Server mutation may already have happened.
- For a stale `preparing` task, inspect the exact task-ID worktree/branch and any recorded thread identity manually. Do not retry task creation, adopt an unrecorded worktree, or delete a possible orphan until its Git common-directory, cleanliness, and remote-thread state are independently established.
- A lost verifier is quarantined at the narrowest safe scope. Reconcile only its exact durable run ID.
- Restart scans all prior-runtime active/terminating verifier leases, including leases attached to terminal runs. Complete terminal OCI evidence can close a contradictory lease; if the task was still `verifying`, that interrupted candidate is invalidated. Incomplete or orphan ownership stays lost/quarantined.
- A pre-container verifier run has no container ID. It is recoverable only through same-engine run-label absence with a dead worker and expired lease; any matching container keeps the task quarantined and is not terminated.
- `UNKNOWN` proof never clears quarantine. Only `PROVEN_TERMINATED` may release the affected scope; `PROVEN_STILL_RUNNING` keeps it blocked.
- Cleanup validates the exact recorded path and branch, shared Git common directory, source/worktree separation, terminal task state, clean worktree, and absence of active writers/verifiers.

Do not repair a ledger with `git reset`, `git clean`, state deletion, process-name-wide termination, or manual lease removal. If proof is unavailable, leave the task blocked and copy its diff/evidence for human review.
