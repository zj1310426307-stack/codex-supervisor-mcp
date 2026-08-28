# Phase 02 design

Phase 02 established the core invariant that a completed Codex turn is not an accepted task.

- A versioned Development Contract defines scope, constraints, acceptance criteria, verification requirements, and correction limits.
- A centralized state machine owns all meaningful task transitions.
- Each task owns a branch and isolated Git worktree created from a clean allowlisted source.
- Deterministic snapshots cover staged, unstaged, tracked, and untracked content.
- Verification selects only trusted local recipes and binds passing results to one snapshot.
- The supervisor records accept/request-changes/block/cancel decisions and an acceptance-evidence matrix.
- Cleanup is conservative and never force-removes a dirty worktree or deletes the source repository/branch.
- Ledger migration preserves legacy facts without synthesizing verification.

Phase 03 extends this design with protocol compatibility, Turn/Verifier Leases, reconciliation, secure HTTP, a local operator fallback, and the 23-tool surface.
