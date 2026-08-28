# ChatGPT Web connection

The server has two explicit surfaces:

- Restricted: `MCP_CONTROL_ENABLED=false`, exposing 13 genuinely read-only tools.
- Full-control: `MCP_CONTROL_ENABLED=true`, exposing all 23 tools with accurate annotations.

Custom MCP availability and allowed actions can vary by ChatGPT plan, workspace policy, administrator settings, and rollout. Do not infer entitlement from the server configuration. Use `docs/CHATGPT-PLAN-CAPABILITY-MATRIX.md` and record the observed result.

ChatGPT is hosted and cannot directly reach a laptop-only loopback address. Keep the service on loopback and use an approved outbound MCP tunnel when available. If a reverse proxy is used, terminate TLS at a trusted boundary, require authentication, configure exact Host/Origin allowlists, and keep the Supervisor unavailable from the general Internet.

The canonical tool list is generated from the actual registration source. Rescan after changing the control mode or version. Never change annotations to evade a client permission boundary.

See `docs/CHATGPT-WEB-MANUAL-TEST.md` for the evidence procedure and `docs/SECURE-MCP-TUNNEL.md` for topology.
