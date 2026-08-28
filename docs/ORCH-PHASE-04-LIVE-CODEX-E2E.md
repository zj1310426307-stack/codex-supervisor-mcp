# Phase 04 live Codex E2E

Current local status: **PASS - LOCAL READY / CHATGPT WEB NOT_RUN**.

The validated runtime is Ubuntu WSL2 with Node v24.20.0, npm 11.19.0, Git
2.53.0, Codex CLI 0.150.1 signed in through ChatGPT, and Docker Engine 29.7.2.
The source checkout and all task worktrees are native Linux paths under
`/home/user3104/code` and `/tmp`, not WindowsApps shims.

## Real handshake

`npm run smoke:codex` remains opt-in. A valid run must prove all of these:

- a real CLI version and version-specific Schema binding;
- stdio JSONL process creation;
- one `initialize` request;
- receipt of its response before the `initialized` notification;
- stdin kept open while `account/read` executes;
- a redacted runtime-capability result;
- graceful shutdown with stdin closure only at shutdown;
- process exit and trailing stdout drain.

Evidence was written to
`artifacts/live/codex-handshake-2026-08-28T08-06-47-204Z/handshake-summary.json`.
The redacted, tracked summary is
`artifacts/validation/phase04-live-codex-handshake-summary.json`. Result:
**PASS**. The initialize response was awaited before one `initialized`
notification, `account/read` completed while stdin remained open, and shutdown
proved process exit plus stdout drain.

## Real development lifecycle

`npm run e2e:codex` requires the handshake flags, the additional E2E flag, and
`CODEX_SUPERVISOR_VERIFIER_IMAGE` containing a reviewed local
`image@sha256:<64-hex>` reference. It creates a temporary Git repository with no
remote and a single baseline commit. The contract allows only `result.txt` and
forbids README, Git history, and remote operations.

The harness records contract, events, status, diff, worktree audit, OCI
verification, snapshot-bound evidence, decision, shutdown, and two-stage cleanup
proof. It rejects commits, remotes, forbidden file changes, inexact result
content, stale snapshot evidence, unproven shutdown, or unsafe cleanup. State and
task worktrees are removed first while the source repository is rechecked as
intact; only then is the disposable root removed.

Execution result: **PASS**. Run
`codex-e2e-2026-08-28T09-57-01-728Z` used a real Codex turn and the explicitly
configured optional model `gpt-5.4-mini`. Four exact local approvals were
classified `normal` and answered only with single-use `accept`; offered
execpolicy amendments were never selected or applied. The worktree contained
only untracked `result.txt` with exact content `supervised\n`, no remote, no
post-baseline commit, and no forbidden README change.

The independent verifier used
`local/codex-supervisor-verifier@sha256:c625cad3763f15662e1964037d0a2ce602089cbafd69d140b288d7229b187eb1`,
reported high-assurance OCI execution, passed the required recipe, bound before
and after evidence to snapshot
`21e79730dff3a136232364c8be9e6fcf1a15448a3d80df76a1491884d784e3d4`,
and proved container termination. Cleanup proved the Supervisor state/worktrees
removed and the disposable source repository intact before removing the
temporary root. The tracked redacted summary is
`artifacts/validation/phase04-live-codex-e2e-summary.json`.

The VPN path still returns HTTP 451 for the default model's Code Mode Host
endpoint. This is why the successful run records the explicit model override;
the project default remains unset and no unsupported fallback was added.

## Operator sequence in WSL2

```bash
npm run preflight:wsl2
npm run diagnose:codex
npm run smoke:mcp
CODEX_SUPERVISOR_LIVE_TEST=1 \
CODEX_SUPERVISOR_LIVE_ACK=I_UNDERSTAND_THIS_STARTS_A_LOCAL_CODEX_PROCESS \
npm run smoke:codex
```

Run the development E2E only after reviewing and inspecting the local verifier
digest. A PASS must come from the generated live evidence, not from editing this
document.
