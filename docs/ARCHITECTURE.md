# Architecture

## Boundaries

The system separates four authorities:

1. ChatGPT or `supervisorctl` defines intent and makes supervisory decisions.
2. The Supervisor validates contracts, owns durable state, creates isolated worktrees, applies policy, and brokers Codex protocol messages.
3. Codex App Server owns the implementation thread and turn inside the assigned worktree.
4. The independent verifier runs only locally configured recipes. A human owns repository publication and deployment.

No layer can turn an MCP string into an arbitrary command. Verification commands come only from trusted local configuration and execute exclusively in a digest-pinned, network-disabled, read-only, non-root OCI container. Docker/Podman unavailability is fail-closed; host-process fallback does not exist.

## Components

- `src/core/contracts.ts`: structured/legacy input normalization and canonical contract hashing.
- `src/core/state-machine.ts`: explicit task transitions; turn completion and task acceptance are separate.
- `src/core/store.ts`: synchronized temporary-file/rename v3 ledger persistence, strict idempotency-map integrity, and v1/v2 migration.
- `src/core/worktree-manager.ts`: source-workspace checks and per-task Git isolation.
- `src/core/snapshot.ts`: deterministic Git/worktree evidence including untracked files.
- `src/core/turn-lease.ts` and `turn-watchdog.ts`: single-writer ownership and uncertain-exit handling.
- `src/verification/`: trusted profiles, exact OCI container ownership/termination proof, bounded results, complete mutation detection, leases, and reconciliation.
- `src/codex/`: command resolution, stable protocol capabilities, schema compatibility, runtime probing, and JSONL App Server client.
- `src/mcp/`: the single 23-tool catalog, schemas, annotations, manifest hashing, and MCP dispatch.
- `src/http/`: loopback-first Streamable HTTP with authentication and resource bounds.
- `src/cli/supervisorctl.ts`: local fallback over the same façade and policy.

## Data flow

`task_start` requires a caller-generated `clientRequestId`, validates the contract and source checkout, first records a `planned` identity, then creates a branch/worktree, starts a Codex thread, and acquires a Turn Lease. The request identifier is durably bound to the normalized task semantics so a retry cannot create a second task or silently reuse the identifier for different work. Only a pristine reservation with no side-effect evidence may be resumed after a reservation-only crash; a prior-runtime `preparing` phase is stale because worktree or remote-thread creation may be ambiguous. Protocol events are redacted and appended with monotonic sequence numbers. When a turn becomes terminal, the lease closes and a new snapshot moves the task to `awaiting_verification`.

Verification records a before snapshot, proves the configured OCI engine/image before changing task state, acquires a Verifier Lease, and persists run-level engine ownership before starting the worker. Container identity is added only after exact ID/labels/image inspection. Recipes run against a read-only worktree, produce bounded output and an after snapshot, and are rejected if the workspace mutated. Passing recipes create unsatisfied, snapshot-bound evidence candidates only when every recipe has current OCI termination proof. Acceptance re-captures the live worktree, requires the expected snapshot ID and one explicit confirmation per contract criterion, then records only the current trusted passing run IDs.

## Fail-closed rules

- Unknown protocol requests are rejected.
- Missing stable protocol capabilities block task control but do not make read-only health unavailable.
- An uncertain turn or verifier termination becomes stale/lost and quarantines only the affected scope.
- Reconciliation clears quarantine only from positive ownership and termination proof.
- Startup invalidates all prior-runtime active verifier leases; pre-container runs require same-engine run-wide absence, while exact containers require full ID, labels, and image proof.
- Only pristine `planned` reservations are replayable; ambiguous `preparing` task-start state becomes stale.
- No restart silently recreates pending approval RPCs.
- Unknown notification methods are audited without renewing ownership; unknown server requests are rejected.
