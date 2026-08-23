# ChatGPT Web integration

## Target behavior

The product boundary is deliberate:

- **ChatGPT Web**: architect, planner, supervisor, reviewer, decision maker.
- **codex-supervisor-mcp**: control plane and audit boundary.
- **Codex app-server**: implementation runtime.
- **Codex agent**: reads code, edits files, runs tests, reports results.

```text
ChatGPT Web
   |  MCP (Streamable HTTP)
   v
codex-supervisor-mcp
   |  JSON-RPC / stdio
   v
codex app-server
   |
   v
Codex + local git workspace
```

GitHub is optional. It is not the scheduler and is not required for the core loop.

## ChatGPT plan availability (August 2026)

Full MCP write/modify actions in ChatGPT Web are currently available in beta for Business, Enterprise and Edu workspaces. Pro can build Apps SDK apps and connect custom MCPs with read/fetch permissions, but cannot currently invoke the control actions required to start or steer Codex.

This repository therefore has two exposure modes:

### Restricted/read-only

```bash
MCP_CONTROL_ENABLED=false
```

Exposes health, task history, event inspection, pending-approval inspection, git status and git diff. It does not expose the tools that can cause Codex to execute work.

### Full supervisor control

```bash
MCP_CONTROL_ENABLED=true
```

Adds task start, steer, interrupt, continue and approval-decision tools. Use only on a ChatGPT workspace with Full MCP action support.

## Connectivity

For a developer machine or private network, prefer Secure MCP Tunnel rather than making this service public. The tunnel client connects outbound to OpenAI and forwards MCP requests to the private server.

If a direct HTTPS deployment is used instead, terminate TLS at a trusted reverse proxy, authenticate requests, restrict host/origin where appropriate, keep the workspace allowlist narrow, and run the service under a low-privilege OS account.

## Supervisor loop

1. ChatGPT reasons about the user's goal and defines an implementation brief.
2. ChatGPT calls `codex_task_start`.
3. Codex inspects the repository and executes the work.
4. ChatGPT uses `codex_task_wait` and incremental events to monitor progress.
5. Command/file-change approvals are surfaced; destructive approvals are hard-blocked locally.
6. ChatGPT can steer or interrupt an active turn.
7. After completion, ChatGPT inspects `codex_workspace_status` and `codex_workspace_diff`.
8. If acceptance criteria are not met, ChatGPT sends a targeted `codex_task_continue`.
9. ChatGPT reports completion only when the observed evidence matches the acceptance criteria.

The MCP intentionally has no generic shell tool.
