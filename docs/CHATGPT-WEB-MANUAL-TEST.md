# ChatGPT Web manual test

Record the date, ChatGPT plan/workspace, administrator policy, connector URL type, server version, tool-surface version/hash, and screenshots or exported scan metadata. Never record access tokens.

## Restricted track

1. Start with `MCP_CONTROL_ENABLED=false`.
2. Scan/refresh the MCP definition.
3. Confirm exactly 13 tools and that every tool is read-only.
4. Call health, list/status/events/wait, worktree status/diff, contract/evidence, verification profiles, runtime capabilities, and verifier status.
5. Confirm no start, steer, interrupt, approval, decision, verification, cleanup, or reconciliation tool appears.

## Full-control track

1. Use only a temporary Git repository with no remote and enable Full-control explicitly.
2. Confirm exactly 23 tools and accurate annotations.
3. Exercise structured task start, observation, steer/interrupt, exact approval handling, trusted verification, decision, and cleanup.
4. Confirm the client asks for appropriate confirmation on destructive tools.
5. Confirm no commit, push, merge, release, or deploy occurs.

Record each track as `PASS`, `FAIL`, `BLOCKED_BY_PLAN`, `BLOCKED_BY_WORKSPACE_POLICY`, `BLOCKED_BY_ENVIRONMENT`, or `NOT_RUN`. An unavailable UI is not a pass.
