# codex-supervisor-mcp

A generic MCP control plane for one clear division of labor:

> **ChatGPT Web thinks and supervises. Codex executes and writes code.**

This repository is intentionally unrelated to any specific application repository.

## What it does

ChatGPT connects to this server as a remote MCP. The MCP starts and controls a local `codex app-server` process, then exposes a small supervisory API:

| MCP tool | Purpose |
|---|---|
| `codex_health` | Verify Codex is reachable/authenticated |
| `codex_task_start` | Give Codex a structured implementation brief |
| `codex_task_list` / `codex_task_status` | Track work |
| `codex_task_events` / `codex_task_wait` | Observe actual execution progress |
| `codex_task_steer` | Correct an active Codex turn |
| `codex_task_interrupt` | Stop a bad run |
| `codex_task_continue` | Ask Codex for another implementation/fix pass |
| `codex_pending_approvals` | Inspect commands/file changes waiting for approval |
| `codex_approval_decide` | Accept/decline an allowed pending action |
| `codex_workspace_status` | Independently inspect git status |
| `codex_workspace_diff` | Independently review code changes |

There is **no arbitrary shell MCP tool**.

## Prerequisites

- Node.js 20+
- Git
- Codex CLI installed and logged in (`codex login`)
- One or more local project directories to allowlist

`codex app-server` is used internally because it exposes thread lifecycle, turn steering/interruption, events and approval requests. It speaks JSON-RPC over stdio.

## Setup

```bash
cp .env.example .env
# edit CODEX_WORKSPACE_ROOTS and other values
npm install
npm run build
```

Node does not automatically load `.env`; either export the variables in your service manager/shell or use your preferred env loader. Example on macOS/Linux:

```bash
export CODEX_WORKSPACE_ROOTS="$HOME/dev"
export MCP_BEARER_TOKEN="$(openssl rand -hex 32)"
npm run dev
```

On Windows PowerShell:

```powershell
$env:CODEX_WORKSPACE_ROOTS = "C:\\dev;D:\\work"
$env:MCP_BEARER_TOKEN = "replace-with-a-long-random-secret"
npm run dev
```

Default endpoint:

```text
http://127.0.0.1:8787/mcp
```

## Connecting ChatGPT Web

ChatGPT is hosted, so it cannot call a laptop-only `127.0.0.1` endpoint directly. The preferred topology is **Secure MCP Tunnel**: keep this MCP on loopback and let OpenAI's tunnel client establish the outbound connection. A hardened HTTPS reverse proxy is the fallback.

Plan capability matters. As of August 2026, ChatGPT Pro can connect custom MCP apps only with read/fetch permissions; Full MCP write/modify actions are available in beta on Business, Enterprise and Edu. Therefore:

- `MCP_CONTROL_ENABLED=false`: expose inspection/status/diff tools only. This is the safe restricted mode.
- `MCP_CONTROL_ENABLED=true`: expose start/steer/interrupt/continue/approval actions for a Full MCP-capable ChatGPT workspace.

Do not mislabel control actions as read-only to bypass host permissions, and never bind an unauthenticated development MCP to the public Internet. See `docs/CHATGPT-WEB.md`.

## Intended ChatGPT supervision loop

```text
1. Understand the feature/problem.
2. Inspect enough context to define scope.
3. Call codex_task_start with:
   - objective
   - implementation plan
   - acceptance criteria
   - constraints
4. Poll codex_task_wait/status/events.
5. If approval is requested, inspect it and decide.
6. If Codex drifts, codex_task_steer or interrupt.
7. When Codex finishes, inspect workspace_status and workspace_diff.
8. If defects remain, codex_task_continue with targeted corrections.
9. Stop only when acceptance criteria have evidence.
```

## Security defaults

- Workspace path must be below `CODEX_WORKSPACE_ROOTS`.
- Codex starts with workspace-write sandboxing.
- Command/file-change approval requests are surfaced to the supervisor instead of being auto-approved. Additional permission-profile requests are denied in v0.1.
- Known destructive actions are hard-blocked by local policy.
- MCP has no generic shell executor.
- Remote binds require a bearer token.
- Task/thread/event audit data is persisted to `SUPERVISOR_STATE_FILE`.

## Current v0.1 limitation

Pending app-server approval requests are live-process state. The task/thread ledger survives a supervisor restart, but an approval that was waiting at the exact moment of restart cannot be resumed as the same RPC request; the task is marked `stale`. Continue the persisted thread with a new supervised turn.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/ROADMAP.md](docs/ROADMAP.md).
