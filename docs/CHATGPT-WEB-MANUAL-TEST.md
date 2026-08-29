# ChatGPT Web manual test

Record the date, ChatGPT plan/workspace, administrator policy, connector URL type, server version, tool-surface version/hash, and screenshots or exported scan metadata. Never record access tokens.

## Restricted track

1. Start with `MCP_CONTROL_ENABLED=false`.
2. Scan/refresh the MCP definition.
3. Confirm exactly 13 tools and that every tool is read-only.
4. Call health, list/status/events/wait, worktree status/diff, contract/evidence, verification profiles, runtime capabilities, and verifier status.
5. Confirm no start, steer, interrupt, approval, decision, verification, cleanup, or reconciliation tool appears.

## Full-control track

1. Use only a clean temporary Git repository with no remote, isolated Supervisor state/worktree paths, and enable Full-control explicitly.
2. Set `FULL_CONTROL_ACCEPTANCE_AUTHORIZED=true` and `FULL_CONTROL_NEW_CHATGPT_APP_REQUIRED=true`, then run `npm run preflight:tunnel:full` while the local Supervisor is ready.
3. Create a new ChatGPT developer-mode app while the Full-control service and tunnel are running. Never reuse, reset, or upgrade the Restricted app: its stored 13-tool definition is separate evidence.
4. Confirm the new app exposes exactly 23 tools and accurate annotations before opening the acceptance chat.
5. Exercise structured task start, observation, steer/interrupt, exact approval handling, trusted verification, decision, and cleanup.
6. Confirm the client asks for appropriate confirmation on destructive tools.
7. Confirm no commit, push, merge, release, or deploy occurs.

Record each track as `PASS`, `FAIL`, `BLOCKED_BY_PLAN`, `BLOCKED_BY_WORKSPACE_POLICY`, `BLOCKED_BY_ENVIRONMENT`, or `NOT_RUN`. An unavailable UI is not a pass.
