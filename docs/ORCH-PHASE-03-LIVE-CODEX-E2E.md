# Phase 03 live Codex E2E

Current runtime prerequisite status: **BLOCKED_BY_ENVIRONMENT**.

The read-only diagnosis found a Codex executable inside the installed WindowsApps desktop package, but both `codex --version` and `codex app-server --help` fail with Access Denied/`EPERM`. The same version probe was retried outside the sandbox after explicit approval and still failed. The global npm root contains no `@openai/codex` installation. The Supervisor did not install or repair a CLI and did not change PATH, the registry, aliases, or application registrations.

Because the runtime prerequisite is unavailable, neither opt-in live harness was started. Their execution status is **NOT_RUN**, not PASS or FAIL. Once an operator independently provides a compatible, signed-in Codex CLI, run the read-only diagnosis first and then opt in explicitly.

The handshake track requires both `CODEX_SUPERVISOR_LIVE_TEST=1` and the exact acknowledgement documented in the README. It initializes App Server, reads account/runtime capability information, and shuts down without starting a development turn.

The development track additionally requires `CODEX_SUPERVISOR_LIVE_E2E=1`. The harness creates a new temporary Git repository, configures a local identity, creates no remote, starts a bounded contract, observes terminal turn evidence, independently inspects changes, runs a trusted test profile, records a decision, and cleans up. It must not run against the Supervisor source repository or any existing business repository.

The development track also requires `CODEX_SUPERVISOR_VERIFIER_IMAGE` to name a reviewed, locally present OCI image pinned by an exact SHA-256 digest. Docker is used by default; set `CODEX_SUPERVISOR_OCI_ENGINE=podman` for Podman. Missing engines/images are reported as `BLOCKED_BY_ENVIRONMENT`; the harness never falls back to host execution.

Artifacts are written under `artifacts/live/<run-id>/` with environment, contract, events, task state, worktree status/diff, verification, decision, and summary. Secrets and absolute credential paths are redacted.

The current read-only environment report is `artifacts/validation/codex-cli-diagnosis.json`. Fake App Server tests do not satisfy this live track.
