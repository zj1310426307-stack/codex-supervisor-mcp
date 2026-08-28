# Operations

Start with loopback binding, a dedicated state/worktree directory, explicit allowed source roots, and a local verification configuration. Run one Supervisor instance per state ledger; the instance lock rejects concurrent owners.

Before serving control tools:

1. From WSL2, run `npm run preflight:wsl2` and resolve every reported blocker manually.
2. Run `npm run diagnose:codex` and review the read-only report.
3. Run `npm run check`, including the real local MCP SDK scans.
4. Build and inspect the local verifier image; copy only its real exact digest into a private local config.
5. Confirm source repositories are backup-safe and publication remains a human action.
6. Confirm verification recipes are deterministic, bounded, and read-only-worktree compatible.
7. Start Restricted mode first and inspect health, count, Schema hash, and annotations.

The root Dockerfile is an experimental MCP-server-only packaging path. It does
not contain Codex, Git integration, credentials, a source workspace, or durable
state/worktree mounts. The recommended complete runtime is native WSL2. Never
copy Codex or MCP credentials into either the service or verifier image.

For shutdown, stop accepting HTTP work, interrupt or reconcile owned live processes, flush the ledger, close the App Server process, and release the instance lock. A forced process exit may leave leases stale; follow `docs/RECOVERY.md` rather than deleting state.

Back up the v3 ledger and configuration, not task worktrees as a substitute for Git history. Restore only when the service is stopped. Never hand-edit active leases or quarantine records.
