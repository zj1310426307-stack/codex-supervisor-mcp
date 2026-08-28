# Secure operations

Default to `127.0.0.1`. A non-loopback bind requires a bearer token and should also have exact allowed Host and Origin values. HTTP applies request-body, rate, header, request, and readiness time bounds. Health responses contain capability state and hashes, never tokens, raw environment variables, home paths, or account secrets.

An MCP handler timeout is result-ambiguous: a mutation may have committed after the client received 504. The HTTP process therefore rejects later MCP calls and readiness until a deliberate restart. Never automatically retry a control request after 504; inspect the durable task/idempotency ledger, worktree, and lease state first.

Run the service as an unprivileged user. Keep the state, worktree, and configuration directories accessible only to that user. Do not place bearer tokens or Codex credentials in source control, command arguments, event payloads, or validation artifacts.

The Docker image packages the Supervisor service only. It does not bundle a logged-in Codex identity. Mounting credentials into a container is an operator security decision and is not the default deployment path.

Review `npm run validate:security` and dependency audit results before deployment. A pattern scan reduces accidental disclosure but is not a substitute for secret rotation or a dedicated enterprise scanner.

The remote approval surface intentionally omits `acceptForSession`. Command and file approvals require exact item/thread/turn identity and structured field validation; network contexts, extra permissions, execution-policy amendments, publication/history operations, and paths outside the isolated worktree are hard-blocked.
