# Roadmap

## v0.1 — local supervisor control plane

- Remote MCP endpoint over Streamable HTTP
- Codex app-server adapter
- Start/status/events/wait/steer/interrupt/continue
- Approval queue with destructive-action blocks
- Workspace allowlist
- Read-only git status/diff
- Persistent task ledger

## v0.2 — production connectivity and auth

- OAuth 2.1 resource server support for ChatGPT MCP connections
- Secure MCP Tunnel deployment profile when available to the workspace
- Multi-user task ownership and audit identity
- TLS/reverse-proxy deployment examples

## v0.3 — stronger independent verification

- Configured, allowlisted verification recipes (not arbitrary shell)
- Git worktree isolation per Codex task
- Base/head snapshots and deterministic diff evidence
- Test evidence ingestion and failure classification

## v0.4 — multi-Codex orchestration

- Parallel task slots
- Explicit task dependencies
- Supervisor fan-out/fan-in while preserving one writer per worktree
- Rate/budget controls
