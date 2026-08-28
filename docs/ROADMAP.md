# Roadmap

## Current: v0.3.0

- Stable App Server schema compatibility gate
- Structured contracts and strict legacy input compatibility
- Isolated task worktrees, Turn Leases, watchdog, and fail-closed protocol ownership
- Independent verifier worker, Verifier Leases, snapshot binding, scoped quarantine, and reconciliation
- v1/v2 to v3 ledger migration
- Restricted 13-tool and Full-control 23-tool MCP surfaces
- Secure loopback-first HTTP and `supervisorctl` fallback
- Opt-in real handshake/development harnesses with honest evidence boundaries

## Candidate v0.4 work

- First-class OAuth resource-server integration where required by the deployment environment
- Multiple authenticated human supervisors with explicit ownership transfer
- Stronger Windows process identity attestation beyond best-effort process-tree proof
- Signed tool manifests and ledger backup/restore tooling
- Supported outbound tunnel packaging when an official workspace capability is available

## Out of scope without a new phase

- Automatic commit, push, merge, release, or deployment
- Arbitrary shell/file-write MCP tools
- Silent CLI installation or host PATH/registry/alias repair
- Parallel writers in one task worktree
