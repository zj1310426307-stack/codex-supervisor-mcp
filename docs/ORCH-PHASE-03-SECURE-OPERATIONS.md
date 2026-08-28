# Phase 03 secure-operations checklist

- Loopback is the default bind.
- Non-loopback without a bearer token is rejected at configuration load.
- Host, Origin, body size, rate, header, request, and readiness limits are enforced.
- Health, events, logs, CLI output, verifier output, and persisted state use redaction and bounds.
- No CLI install, PATH/registry/alias mutation, arbitrary MCP command, generic file write, Git publication, or deployment capability exists.
- Live tests are double-gated and development E2E uses a disposable repository with no remote.
- Cleanup validates exact task ownership and never targets the source repository.
- Session-wide approvals are unavailable; structured approval requests fail closed on unknown fields, network/permission escalation, repository history/publication, or out-of-worktree paths.
- Acceptance requires a live snapshot re-check and explicit evidence for every contract criterion.
