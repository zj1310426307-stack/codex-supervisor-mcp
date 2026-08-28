# State migration: v1 to v2

The original ledger stored task/thread IDs, a single status, events, and process-local approval references. Migration preserves those values without claiming verification:

- source workspace is retained;
- legacy `completed` becomes `legacy_unverified`;
- a normalized compatibility contract is recorded when enough legacy fields exist;
- event sequence and trimming boundaries are preserved;
- worktree, snapshot, decision, and verification evidence remain absent rather than synthesized.

Migration is deterministic and written atomically. The original file should be backed up before first v2/v3 startup.
