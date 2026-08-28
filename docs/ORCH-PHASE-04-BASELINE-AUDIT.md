# Phase 04 baseline audit

Audit date: 2026-08-28 (Asia/Shanghai).

This audit was performed before Phase 04 implementation changes. It records the
actual `main` baseline and does not promote Phase 03 deterministic evidence into
live Codex, verifier, tunnel, or ChatGPT evidence.

## Repository baseline

- Repository: `https://github.com/zj1310426307-stack/codex-supervisor-mcp`
- Baseline branch: `main`
- Baseline commit: `33e984504dbc23f475cbf21ef2143dbbf7dfd9f6`
- Baseline version: `0.3.0`
- Phase 04 work branch: `orch/phase-04-live-ready`
- Working tree before branch creation: clean and aligned with `origin/main`
- Node requirement: `>=20`
- MCP packages: `@modelcontextprotocol/node@2.0.0` and
  `@modelcontextprotocol/server@2.0.0`
- Tool surface: Restricted 13 tools; Full-control 23 tools
- Restricted schema hash:
  `ff8bdcd4a57a6657c34a51fce89f8763adf9e658ab0833efce183163d3fdc23c`
- Full schema hash:
  `df0eec76487d28ddfbf9619c6b1d3427e46979c46f756f1f4da74a44b762957e`

The tool catalog is already the shared source for registration, JSON Schema,
annotations, mode filtering, counts, and hashes. The surface contains no
arbitrary shell, arbitrary file-write, Git publication, release, or deployment
tool.

## Existing implementation

The baseline contains a persistent JSONL stdio App Server client, Codex command
resolution, version-specific schema generation, a schema hash, required stable
client/server method checks, required payload-shape checks, and explicit gating
for experimental methods. Stable protocol compatibility is required before a
runtime binding is accepted.

The orchestration path already includes Development Contracts, idempotent task
reservation, isolated Git worktrees, exact thread/turn ownership, Turn Leases,
watchdog handling, bounded persistent events, workspace snapshots, independent
OCI-only verification, Verifier Leases, exact container ownership/termination
proof, snapshot-bound acceptance, and conservative cleanup.

The baseline has two opt-in live harnesses:

- `npm run smoke:codex` probes a real Codex runtime, initializes App Server,
  performs `account/read`, and proves bounded shutdown without starting a turn.
- `npm run e2e:codex` creates a disposable no-remote Git repository and exercises
  the Supervisor lifecycle with a digest-pinned OCI verifier.

Neither harness had valid Phase 03 live evidence on this machine.

## Deterministic validation baseline

The most recent complete local check recorded 146 tests: 144 passed, 0 failed,
and 2 explicit Windows-only platform skips. Typecheck, production build, generic
validation, Phase 03 validation, tool-surface validation, version consistency,
and security validation passed. The dependency audit reported zero known
vulnerabilities at `high` or above.

The latest CI run for the baseline commit completed successfully on both the
Ubuntu and Windows matrix:

- Run: `33136935263`
- Result: `success`
- URL: `https://github.com/zj1310426307-stack/codex-supervisor-mcp/actions/runs/33136935263`

## Security gaps found

Phase 04 must remediate these baseline gaps before any live-ready claim:

1. `.env.example` contains a token-shaped placeholder and enables control mode.
2. Configuration rejects short bearer tokens but does not reject obvious long
   placeholder values.
3. `src/core/redaction.ts` exists, but MCP responses retain a separate, narrower
   redaction implementation. Operator output also uses an independent pattern.
4. The shared redactor does not yet cover all required OpenAI/GitHub token
   families and key/value spellings with dedicated end-to-end tests.
5. No Phase 04 WSL2 preflight, real MCP SDK scan, local verifier image workflow,
   or Phase 04 acceptance record exists.
6. The example verifier digest is demonstrative only and must never be reported
   as a real locally reviewed verifier image.

## Runtime and external-track baseline

| Track | Baseline result | Evidence |
|---|---|---|
| Windows / Node / npm / Git | OBSERVED | Windows 10.0.26200; Node v24.17.0; npm 11.13.0; Git 2.55.0.windows.2 |
| WSL component | PARTIAL | WSL 2.7.11.0 is installed; distro/status enumeration returned `E_ACCESSDENIED` in the current host |
| Codex resolution | BLOCKED_BY_ENVIRONMENT | Resolves only to the WindowsApps desktop package |
| `codex --version` | BLOCKED_BY_ENVIRONMENT | Process launch returned Access Denied |
| `codex app-server --help` | BLOCKED_BY_ENVIRONMENT | Process launch returned Access Denied |
| Global npm `@openai/codex` | NOT_INSTALLED | Global npm tree is empty for this package |
| Docker / daemon | BLOCKED_BY_ENVIRONMENT | `docker` is not installed or not on the current command path |
| Real App Server handshake | NOT_RUN | Runtime prerequisite unavailable |
| Real Codex development E2E | NOT_RUN | Codex and verifier prerequisites unavailable |
| Real verifier digest | NOT_CONFIGURED | Only an example placeholder is present |
| ChatGPT Web Restricted | NOT_RUN | No operator connector scan was supplied |
| ChatGPT Web Full-control | NOT_RUN | No operator connector scan was supplied |
| Secure outbound tunnel | NOT_RUN | No approved endpoint was provisioned |

The Supervisor did not install or sign in a CLI, edit PATH/profile/registry or
aliases, change WindowsApps permissions, install WSL distributions, install or
configure Docker, expose a public endpoint, or fall back to host verification.

## Phase 04 disposition

Implementation may continue for deterministic code, tests, scanners, preflight,
documentation, and evidence formats. On this host, the initial live disposition
is `PARTIAL - BLOCKED_BY_ENVIRONMENT`. It may be upgraded only by new evidence
from the real WSL2 Codex runtime, a reviewed local verifier image pinned by its
actual digest, and the required live runs. ChatGPT Web remains independently
`NOT_RUN` until an operator completes the real connector acceptance procedure.

## Post-audit evidence update

This section does not rewrite the historical baseline above. After the operator
installed Ubuntu WSL2, Codex CLI 0.150.1, and enabled Docker Desktop WSL
integration, the read-only WSL preflight passed with no blockers. The real
handshake, digest-pinned OCI verifier, disposable-repository development E2E,
cleanup proof, and Restricted/Full MCP scans subsequently passed. The final
Phase 04 disposition is recorded in `docs/ORCH-PHASE-04-VALIDATION.md` as
`PASS - LOCAL READY / CHATGPT WEB NOT_RUN`.
