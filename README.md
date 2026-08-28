# codex-supervisor-mcp

`codex-supervisor-mcp` v0.3.0 is an independent MCP control plane for one division of responsibility:

> ChatGPT supervises; Codex implements inside an isolated worktree; a human owns commit, push, merge, release, and deployment.

It is intentionally unrelated to any application repository or business-domain profile. It exposes no arbitrary shell, file-write, Git publication, or deployment tool.

## Current surface

The Full-control surface contains **23** tools. The Restricted surface contains the **13** genuinely read-only tools generated from the same registration source.

| Class | Tools |
|---|---|
| Restricted/read | `codex_health`, `codex_task_list`, `codex_task_status`, `codex_task_events`, `codex_task_wait`, `codex_pending_approvals`, `codex_workspace_status`, `codex_workspace_diff`, `codex_task_contract`, `codex_task_evidence`, `codex_verification_profiles`, `codex_runtime_capabilities`, `codex_verifier_status` |
| Control | `codex_task_recover` |
| Destructive control | `codex_task_start`, `codex_task_continue`, `codex_task_steer`, `codex_task_interrupt`, `codex_approval_decide`, `codex_task_verify`, `codex_task_decide`, `codex_task_cleanup`, `codex_verifier_reconcile` |

The machine-readable source and hashes are exported to `artifacts/tool-manifest.json`. Every local tool has `openWorldHint=false`; control tools are never mislabeled as read-only.

## Safety model

- Every task starts from a strict Development Contract and an allowlisted, clean source Git repository.
- Work happens on a per-task branch and worktree. The source checkout is not used as Codex's write directory.
- `turn/completed` means only that the Codex turn ended. It moves the task toward independent verification; it does not mean acceptance.
- A Turn Lease and watchdog prevent two writers from owning the same task silently.
- Verification accepts only trusted profile IDs from version-2 local configuration. Read-only-compatible recipes run only in a digest-pinned, network-disabled, read-only, non-root OCI container; inspected image/label identity and complete container termination are required, and Docker/Podman failure never falls back to the host.
- A Verifier Lease, durable run ledger, process-ownership proof, and scoped quarantine guard uncertain verifier termination.
- Workspace snapshots include tracked, staged, unstaged, ordinary untracked, Git-ignored, and symbolic-link state under explicit resource limits. Passing evidence is tied to an exact snapshot.
- Contract path rules are enforced forbidden-first against both sides of renames/copies and all changes since the task base commit.
- Verification creates evidence candidates only. Acceptance re-captures the live worktree and requires an exact snapshot ID plus one explicit evidence confirmation for every contract criterion.
- Approval requests are classified from their official structured fields. Session-wide acceptance, network grants, policy amendments, extra permissions, publication/history commands, and out-of-worktree paths are not authorized.
- Cleanup is allowed only for an eligible terminal task and removes only its validated task worktree.
- Secrets and unbounded event/log payloads are redacted before persistence or remote return.

## Prerequisites and setup

- Node.js 20 or newer
- Git
- A compatible Codex CLI installed and signed in by the operator
- One or more local Git repositories below `CODEX_WORKSPACE_ROOTS`

The service does not install or repair Codex CLI, modify `PATH`, aliases, the registry, or operating-system application registrations.

```bash
npm install
copy .env.example .env
npm run check
```

Node does not automatically load `.env`; export the variables using the process manager or shell that starts the service. The default endpoint is `http://127.0.0.1:8787/mcp`.

Official Codex documentation describes App Server as the client-integration protocol and specifies JSONL over stdio by default. A client initializes once, waits for the response, then sends `initialized`: [Codex App Server](https://learn.chatgpt.com/docs/app-server). CLI installation and sign-in are operator prerequisites: [Codex CLI](https://learn.chatgpt.com/docs/codex/cli).

## Typical lifecycle

1. Call `codex_task_start` with either a structured contract or the strict legacy compatibility form. Both forms require a caller-generated `clientRequestId`; reuse the same value only when retrying the same start request.
2. Observe status, bounded events, approvals, and the isolated worktree.
3. Steer, interrupt, or resolve an exact approval when required.
4. After a turn ends, run a trusted verification profile.
5. Use `codex_task_decide` to accept, request corrections, block, or cancel. Acceptance must include the expected verified snapshot ID and exact per-criterion confirmations.
6. A human reviews the evidence and owns all publication actions.
7. Clean up the task worktree only after terminal resolution.

`supervisorctl` provides the same policy-enforced lifecycle locally when a ChatGPT workspace cannot expose Full-control MCP tools.

An identical `task_start` retry can resume only a pristine durable `planned` reservation, before any worktree, Codex thread, turn, lease, or other side-effect evidence exists. A restart that finds `preparing` or later ambiguous start evidence marks the task stale instead of replaying an external mutation. After any HTTP 504, do not automatically retry a control call: the server deliberately becomes not-ready because the result may already have committed. Restart only after inspecting the ledger and worktree; `clientRequestId` makes the original task identity discoverable but does not make arbitrary mutations replay-safe.

## Verification tracks

```bash
npm run typecheck
npm test
npm run build
npm run validate:generic
npm run validate:phase03
npm run validate:tool-surface
npm run validate:version-consistency
npm run validate:security
```

Real Codex runs are opt-in and never part of an ordinary build:

```text
CODEX_SUPERVISOR_LIVE_TEST=1
CODEX_SUPERVISOR_LIVE_ACK=I_UNDERSTAND_THIS_STARTS_A_LOCAL_CODEX_PROCESS
```

Development E2E additionally requires `CODEX_SUPERVISOR_LIVE_E2E=1` and uses a newly created temporary Git repository with no remote. See `docs/ORCH-PHASE-03-LIVE-CODEX-E2E.md`.

## Documentation

- Architecture and trust boundaries: `docs/ARCHITECTURE.md`
- State and supervision protocol: `docs/SUPERVISION-PROTOCOL.md`
- Verification and recovery: `docs/VERIFICATION.md`, `docs/RECOVERY.md`
- Secure operation and remote connectivity: `docs/SECURE-OPERATIONS.md`, `docs/SECURE-MCP-TUNNEL.md`
- ChatGPT Web manual checks: `docs/CHATGPT-WEB-MANUAL-TEST.md`
- Current validation record: `docs/ORCH-PHASE-03-VALIDATION.md`
