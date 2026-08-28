# ORCH-PHASE-04 Validation

## 1. Baseline

Version v0.4.0 on branch `orch/phase-04-live-ready`, based on commit
`33e984504dbc23f475cbf21ef2143dbbf7dfd9f6`. The baseline audit is preserved in
`docs/ORCH-PHASE-04-BASELINE-AUDIT.md`.

## 2. Files changed

Phase 04 updates configuration/security defaults, shared redaction, Codex
runtime probing and JSONL lifecycle, orchestration/approval concurrency,
digest-pinned OCI verification, WSL2/MCP/live scripts, tests, CI, tool manifests,
operating documents, and machine-readable validation evidence. `git status` is
the authoritative file list; no existing business repository was used by E2E.

## 3. Security fixes

- `.env.example` leaves the bearer token empty and defaults to Restricted mode.
- Obvious token placeholders are rejected.
- One redaction core covers MCP results/errors, events, CLI, verifier and live artifacts before truncation.
- MCP exposes no arbitrary shell/file-write/publication/deployment primitive.
- Approval responses are exact single-use decisions. Offered session/execpolicy/network-policy choices are never selected.
- Unknown fields, network access, extra permissions, dangerous commands and workspace escapes remain fail-closed.

## 4. WSL2 runtime

Read-only preflight at `2026-08-28T10:00:38.807Z`: **PASS**, blockers `[]`.
Ubuntu WSL2, Node v24.20.0, npm 11.19.0, Git 2.53.0, Codex 0.150.1,
ChatGPT authentication, Docker 29.7.2, workspace and state/worktree permissions
all passed.

## 5. Codex runtime probe

**PASS** at `2026-08-28T10:01:12.945Z`. The real CLI generated 295 Schema files
in an isolated temporary directory. Canonical Schema hash:
`f9d365c1780056b70454dcab8bd6ff21e81d342ec72760198ce521de9a0f7cf8`.
All required stable client/server methods and eight required nested shapes were
present; no experimental API was requested.

## 6. Real App Server handshake

**PASS** — run `codex-handshake-2026-08-28T08-06-47-204Z`. Real stdio JSONL
process, response-before-`initialized`, read-only `account/read`, stdin open
through the read, one initialized connection, process exit and stdout drain were
proven. See `artifacts/validation/phase04-live-codex-handshake-summary.json`.

## 7. Real development E2E

**PASS** — run `codex-e2e-2026-08-28T09-57-01-728Z`, explicit optional model
`gpt-5.4-mini`. A real Codex turn modified only `result.txt` in an isolated
no-remote disposable worktree. There were zero commits after baseline, zero
forbidden changes, four policy-normal single-use approvals, exact content,
snapshot-matched acceptance evidence, and complete cleanup proof. See
`artifacts/validation/phase04-live-codex-e2e-summary.json`.

## 8. Independent verifier

**PASS** with the locally inspected digest
`local/codex-supervisor-verifier@sha256:c625cad3763f15662e1964037d0a2ce602089cbafd69d140b288d7229b187eb1`.
The OCI recipe ran network-disabled, read-only and non-root with bounded
resources. Image/label ownership, exit, absence of remaining processes, removal,
and unchanged before/after snapshot were proven. No host fallback occurred.

## 9. MCP Restricted scan

**PASS** through the actual Streamable HTTP server and official MCP SDK client:
exactly 13 read-only, non-destructive, closed-world tools. Evidence:
`artifacts/validation/mcp-restricted-scan.json`.

## 10. MCP Full scan

**PASS** through the same real stack: exactly 23 catalog-matched tools with
conservative annotations. Evidence: `artifacts/validation/mcp-full-scan.json`.

## 11. ChatGPT Web status

Restricted: **NOT_RUN**. Full-control: **NOT_RUN**. No Secure MCP Tunnel or real
ChatGPT developer-mode connector was exercised, so local evidence cannot promote
either track to PASS.

## 12. Remaining blockers

- Secure outbound MCP Tunnel and ChatGPT Web Restricted/Full acceptance remain for Phase 05.
- The current VPN exit returns HTTP 451 for the default model's Code Mode Host endpoint; the proven E2E used explicit `CODEX_MODEL=gpt-5.4-mini` and left the default unset.
- Human publication actions remain deliberately outside the tool surface.

## 13. Risk assessment

Local execution risk is bounded by clean allowlisted source repositories,
isolated worktrees, exact turn/verifier leases, single-use approvals,
snapshot-bound acceptance and exact cleanup. This evidence does not establish
remote tunnel, ChatGPT workspace policy, connector authentication, or UI
confirmation behavior.

## 14. Final readiness

**PASS - LOCAL READY / CHATGPT WEB NOT_RUN**.

`npm run check` passed on WSL2 with 158/158 tests, zero failures/skips/todos,
followed by build, real MCP scans and every validator. `npm audit
--audit-level=high` reported 0 vulnerabilities across 49 dependencies. This is
not `PRODUCTION READY`. Phase 05 should establish the Secure MCP Tunnel,
Restricted-to-Full ChatGPT acceptance, and the first real-repository Shadow Mode
trial while Human retains commit/push/merge/release/deployment authority.
