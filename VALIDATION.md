# Validation

The current v0.4.0 validation record is maintained in `docs/ORCH-PHASE-04-VALIDATION.md`.

The Phase 04 suite includes typechecking, unit/integration tests, production
build, generic and Phase 04 validation, version/security checks, and real local
Streamable HTTP scans through the official MCP SDK. Restricted exposes exactly
13 read-only closed-world tools; Full-control exposes exactly 23 tools with
catalog-matched Schemas and annotations. On 2026-08-28, the WSL2 preflight,
Codex 0.150.1 runtime/Schema probe, real App Server handshake, real development
E2E, digest-pinned OCI verification, exact cleanup proof, and both MCP scans
passed. The complete WSL2 suite passed 158/158 tests and the dependency audit
reported zero vulnerabilities. ChatGPT Web remains a separate `NOT_RUN` track;
therefore the result is Local Ready, not Production Ready.

Phase 05 preparation adds deterministic tests, a read-only tunnel preflight, a
secret-free Restricted `tunnel-client` profile template, and an honest operator
acceptance contract. `scripts/validate-phase05.mjs` proves that ordinary CI does
not require external credentials and that Secure Tunnel/ChatGPT results remain
`NOT_RUN` until real operator evidence exists.
