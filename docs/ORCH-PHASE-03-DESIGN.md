# Phase 03 design

The v0.3.0 design adds four coupled safety loops:

1. Contract and isolation: normalize intent, reject ambiguous input, require a clean allowlisted source, durably reserve an idempotent task identity, then create its task branch/worktree.
2. Codex ownership: stable protocol gate, one App Server connection, exact thread/turn IDs, Turn Lease, watchdog, and terminal evidence.
3. Independent verification: trusted profiles, snapshot binding, Verifier Lease, process ownership, mutation detection, and scoped reconciliation.
4. Supervisory decision: accept/request changes/block/cancel with bounded correction passes and a durable evidence chain.

The MCP catalog is the single source for registration, JSON Schema, annotations, Restricted/Full filtering, counts, and SHA-256 hashes. HTTP and `supervisorctl` call the same façade rather than duplicating policy.
