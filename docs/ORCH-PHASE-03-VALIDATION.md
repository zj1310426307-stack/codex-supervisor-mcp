# Phase 03 validation record

This record belongs only to the rebuilt v0.3.0 tree created from seed commit `6b90549046059727a8430f64d299ac98fcb8e100`. It does not inherit claims or artifacts from the deleted earlier worktree.

Recorded on 2026-08-28 (Asia/Shanghai).

| Track | Result | Evidence |
|---|---|---|
| Static typecheck | PASS | `npm run check`, `npm run typecheck`; exit 0 |
| Unit/integration tests | PASS | 144 passed, 0 failed, 2 Windows platform skips; exit 0 |
| Production build | PASS | `tsc -p tsconfig.build.json`; exit 0 |
| Generic and Phase 03 validation | PASS | both validators; exit 0 |
| Tool surface | PASS | Restricted 13 / Full 23; manifest check exit 0 |
| Version consistency | PASS | package/server/surface v0.3.0; exit 0 |
| Security validation | PASS | credential-pattern and forbidden-capability scan; exit 0 |
| Dependency audit | PASS | `npm audit --audit-level=high`; 0 vulnerabilities, exit 0 |
| Package dry run | PASS | 113 entries; exit 0 |
| Read-only Codex diagnosis | COMPLETED_WITH_BLOCKER | `artifacts/validation/codex-cli-diagnosis.json` |
| Real App Server handshake | BLOCKED_BY_ENVIRONMENT | Codex executable resolves to WindowsApps but returns Access Denied; live harness itself remains NOT_RUN |
| Real development E2E | BLOCKED_BY_ENVIRONMENT | Same runtime prerequisite; gated harness remains NOT_RUN |
| ChatGPT Web Restricted | NOT_RUN | Requires an actual ChatGPT Web connector scan |
| ChatGPT Web Full-control | NOT_RUN | Requires an actual ChatGPT Web connector scan |
| Tunnel/reverse-proxy pilot | NOT_RUN | No approved remote endpoint was provisioned |
| Docker image build | NOT_RUN | Docker is not installed on this host |

Tool hashes:

- Restricted: `ff8bdcd4a57a6657c34a51fce89f8763adf9e658ab0833efce183163d3fdc23c`
- Full: `df0eec76487d28ddfbf9619c6b1d3427e46979c46f756f1f4da74a44b762957e`

The deterministic fake App Server tests cover handshake ordering, official turn-event shapes, approval ownership, reconnect/exit draining, and failure handling. They are local protocol evidence only and are not represented as a real Codex handshake. The Windows executable probe was also repeated outside the sandbox after explicit approval and still returned Access Denied. No CLI was installed and no PATH, registry, or alias was changed.

Machine-readable evidence is in `artifacts/validation/phase03-local-validation-summary.json`.
