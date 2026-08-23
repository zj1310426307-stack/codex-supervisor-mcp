# Architecture

## Responsibility split

- **ChatGPT Web = supervisor**: understands the user's goal, inspects progress, defines scope/plan/acceptance criteria, decides whether to steer/stop/ask for another Codex pass, and reviews git diff.
- **codex-supervisor-mcp = control plane**: exposes only high-level Codex lifecycle, approval, status/event and read-only git inspection tools. It maintains task/thread correlation and policy enforcement.
- **Codex = executor**: reads the repository, edits files, runs development commands/tests inside the configured workspace sandbox, and reports implementation results.

## Data flow

```text
ChatGPT Web
    |
    | MCP over Streamable HTTP
    v
codex-supervisor-mcp
    |
    | JSON-RPC over stdio
    v
codex app-server
    |
    v
Codex agent + local workspace
```

The external API is MCP. The Codex-facing adapter deliberately uses `codex app-server`, not raw shell orchestration and not GitHub as an intermediary.

## Why app-server

The app-server exposes durable threads, turns, same-turn steering, interruption, streamed events and explicit approval requests. Those are the primitives a supervisor needs. The MCP layer converts them into a smaller, stable set of tools suitable for ChatGPT.

## State model

A supervisor task owns one Codex thread and at most one active turn:

```text
starting -> running -> completed
                  |-> waiting_approval -> running
                  |-> interrupted
                  |-> failed
                  |-> stale (app-server/server restart)
```

Completed/interrupted/failed/stale tasks can use `codex_task_continue` to resume the persisted Codex thread and create another supervised turn.

## Approval model

Codex runs with workspace-write sandboxing and `approvalsReviewer=user`. When app-server asks for approval, the MCP does not auto-accept. It records a pending approval and changes the task to `waiting_approval`.

Known destructive actions are hard-blocked locally (force push, sudo, destructive reset/clean, root deletion, remote-script piping, etc.). This is intentionally stricter than relying on prompts.

## No arbitrary supervisor shell

There is deliberately no `run_shell` MCP tool. If ChatGPT could run arbitrary shell commands itself, it would stop being a supervisor and become a second implementation agent. Read-only `git status` and `git diff` are exposed only for independent inspection.
