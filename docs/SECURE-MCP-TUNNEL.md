# Secure MCP tunnel

Preferred topology:

`ChatGPT -> approved outbound MCP tunnel -> loopback Supervisor -> local Codex App Server -> isolated task worktree`

The tunnel should originate from the operator machine, authenticate both ends, preserve the MCP transport, and expose only the configured MCP path. The Supervisor should remain bound to loopback.

If the approved tunnel is unavailable, mark the ChatGPT Web track `BLOCKED_BY_ENVIRONMENT` or `BLOCKED_BY_PLAN`. Do not replace it with an unauthenticated public port. A reverse-proxy pilot requires HTTPS, exact host/origin policy, bearer authentication, request limits, access-log redaction, and a documented shutdown/revocation procedure.
