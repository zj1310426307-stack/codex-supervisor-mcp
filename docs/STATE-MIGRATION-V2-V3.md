# State migration: v2 to v3

Version 3 adds durable Turn Leases, Verifier Runs and Leases, scoped quarantines, reconciliation proofs, App Server/runtime snapshots, tool-surface metadata, and live-test evidence.

The migration never invents process ownership. A v2 active verifier without v3 ownership proof is marked legacy/unreconciled and quarantined. Existing passing verification remains historical but cannot automatically validate a new snapshot. Existing tasks and event order are preserved.

Older container records that use `backend="docker"` do not distinguish Docker from Podman and have no engine/store namespace binding. Startup therefore marks them stale and clears acceptance candidates. Only new `backend="oci"` records with an explicit engine and complete termination evidence can satisfy acceptance.

The writer synchronizes a newly created temporary file before atomic replacement, then synchronizes the final file and, where supported, its parent directory. Version 3 also requires one canonical idempotency entry per task and rejects mismatched, missing, duplicate, or orphan mappings. An unsupported future ledger version fails closed and leaves the file unchanged.
