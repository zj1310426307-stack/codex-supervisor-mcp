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

## Phase 05 official tunnel-client baseline

OpenAI's current Secure MCP Tunnel uses an outbound-only `tunnel-client`. It
requires a tunnel ID, a runtime API key, and a reachable local stdio or HTTP MCP
server. The client must reach `api.openai.com:443`; no inbound firewall rule is
required. See <https://developers.openai.com/api/docs/guides/secure-mcp-tunnels>.

Use `config/tunnel-client.restricted.example.yaml` as the reviewed baseline. It
keeps the local target and the client's admin UI on loopback, references the MCP
Authorization value through an environment variable, and contains no tunnel ID
or key. In the operator shell, supply:

```text
CONTROL_PLANE_TUNNEL_ID=tunnel_<32-lowercase-hex>
CONTROL_PLANE_API_KEY=<runtime-api-key>
MCP_BEARER_TOKEN=<independent-random-local-secret>
MCP_TUNNEL_AUTHORIZATION=Bearer <same-local-secret>
MCP_SERVER_URL=http://127.0.0.1:8787/mcp
MCP_EXTRA_HEADERS=Authorization: env:MCP_TUNNEL_AUTHORIZATION
MCP_DISCOVERY_EXTRA_HEADERS=Authorization: env:MCP_TUNNEL_AUTHORIZATION
MCP_CONTROL_ENABLED=false
```

Do not copy literal values from this illustration. Quote values according to
the operator shell and keep them out of command history where possible. Run
`npm run preflight:tunnel`, then run `tunnel-client doctor --profile-file
<operator-profile> --explain`. Only after doctor and the running client's health
and readiness pass should ChatGPT developer-mode discovery begin.
