# Phase 03 baseline audit

The rebuild started from the independent `codex-supervisor-mcp-v0.1.0.bundle`.

- Seed commit: `6b90549046059727a8430f64d299ac98fcb8e100`
- Bundle SHA-256: `133005B3C6C16EDD5CD4628463DF22B5A2F735E43F6BD6F705F4924A34BC14A7`
- Seed tag: `v0.1.0`
- Initial tracked files: 28

The separate Dayu bundle has no common ancestor or identical blobs and is not a code or domain dependency. The old deleted v0.3 worktree and its reports were not recovered. Historical claims from that worktree are not evidence for this rebuild.

The seed implemented 13 tools and a basic persistent App Server session but lacked contracts, worktrees, snapshot-bound verification, leases/reconciliation, v3 migration, the 23-tool surface, and current live evidence. This rebuild therefore treats the seed as source material, not as a validated release.
