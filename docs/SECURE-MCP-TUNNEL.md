# Secure MCP tunnel

Preferred topology:

`ChatGPT -> approved outbound MCP tunnel -> loopback Supervisor -> local Codex App Server -> isolated task worktree`

The tunnel should originate from the operator machine, authenticate both ends, preserve the MCP transport, and expose only the configured MCP path. The Supervisor should remain bound to loopback.

For Phase 04, run the Supervisor on WSL2 loopback with
`MCP_CONTROL_ENABLED=false`. The approved outbound tunnel is the only bridge to
ChatGPT. Do not bind the Supervisor to a WSL virtual-network address merely to
make it reachable, and do not expose health, readiness, state, or any additional
local port through the tunnel. The configured bearer token must be a real random
secret, supplied outside source control; placeholder values are rejected.

The operator must record the non-secret tunnel identifier, Restricted/Full mode,
tool count, tool Schema hash, connection time, shutdown/revocation time, and the
redacted ChatGPT acceptance evidence. A Restricted session never upgrades itself
to Full-control. Stop or revoke the tunnel after the test unless an approved
operating procedure explicitly keeps it active.

If the approved tunnel is unavailable, mark the ChatGPT Web track `BLOCKED_BY_ENVIRONMENT` or `BLOCKED_BY_PLAN`. Do not replace it with an unauthenticated public port. A reverse-proxy pilot requires HTTPS, exact host/origin policy, bearer authentication, request limits, access-log redaction, and a documented shutdown/revocation procedure.
