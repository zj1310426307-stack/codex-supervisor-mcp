# Operations

Start with loopback binding, a dedicated state/worktree directory, explicit allowed source roots, and a local verification configuration. Run one Supervisor instance per state ledger; the instance lock rejects concurrent owners.

Before serving control tools:

1. Run `npm run diagnose:codex` and review the read-only report.
2. Run the local check suite.
3. Confirm source repositories are backups-safe and publication remains a human action.
4. Confirm the selected verification recipes are deterministic, bounded, and do not modify the repository.
5. Start Restricted mode first and inspect health/tool hashes.

For shutdown, stop accepting HTTP work, interrupt or reconcile owned live processes, flush the ledger, close the App Server process, and release the instance lock. A forced process exit may leave leases stale; follow `docs/RECOVERY.md` rather than deleting state.

Back up the v3 ledger and configuration, not task worktrees as a substitute for Git history. Restore only when the service is stopped. Never hand-edit active leases or quarantine records.
