# ORCH-PHASE-05 ChatGPT acceptance

Allowed result values are `NOT_RUN`, `BLOCKED_BY_CONFIGURATION`,
`BLOCKED_BY_PLAN`, `BLOCKED_BY_WORKSPACE_POLICY`, `BLOCKED_BY_ENVIRONMENT`,
`PASS`, and `FAIL`. Local tests and local MCP scans cannot produce a ChatGPT or
Secure MCP Tunnel `PASS`.

Official connection references:

- <https://developers.openai.com/api/docs/guides/secure-mcp-tunnels>
- <https://developers.openai.com/plugins/deploy/connect-chatgpt>

## Current result

| Track | Status | Reason |
|---|---|---|
| Secure MCP Tunnel | NOT_RUN | No tunnel identity/runtime key or live tunnel-client evidence was supplied |
| ChatGPT Restricted (13 tools) | NOT_RUN | Requires a real developer-mode app connected through the tunnel |
| ChatGPT Full-control (23 tools) | NOT_RUN | Restricted acceptance and a separate explicit authorization are prerequisites |

## Operator sequence

1. In the target Platform organization, create or select a tunnel and associate
   the target ChatGPT workspace. Confirm Tunnels Read + Use for the runtime and
   connector operator. Do not use an admin key for the daemon.
2. Export secrets only in the WSL2 runtime environment. Keep the Supervisor on
   `127.0.0.1`, set `MCP_CONTROL_ENABLED=false`, and start it.
3. Copy `config/tunnel-client.restricted.example.yaml` to an operator-owned
   location outside the repository if customization is needed.
4. Set `MCP_SERVER_URL=http://127.0.0.1:8787/mcp`,
   `MCP_EXTRA_HEADERS='Authorization: env:MCP_TUNNEL_AUTHORIZATION'`, and the
   same value for `MCP_DISCOVERY_EXTRA_HEADERS` before running
   `npm run preflight:tunnel`.
5. Run `tunnel-client doctor --profile-file <operator-profile> --explain`. Save
   only a redacted result. Then run the client in the foreground or use its
   managed runtime commands and prove process-running, healthy, and ready.
6. In ChatGPT, enable Developer mode if workspace policy permits it. Create a
   developer-mode app, choose Tunnel, select or enter the approved tunnel, and
   review the discovered tools and annotations.
7. Execute the Restricted cases below. Stop/revoke the connection afterward.

## Required Restricted evidence

| Field | Required evidence |
|---|---|
| Operator and time | Approved identifier, ISO time, timezone |
| Workspace/organization | Non-secret identifiers and policy decision |
| Tunnel | Non-secret tunnel identifier; association and permission proof |
| Client | Exact version; doctor result; process-running/healthy/ready proof |
| Supervisor | v0.4.0, loopback bind, Restricted mode, readiness PASS |
| Tool discovery | Exactly 13 tools and schema hash `ff8bdcd4a57a6657c34a51fce89f8763adf9e658ab0833efce183163d3fdc23c` |
| Metadata review | All tools read-only, non-destructive, closed-world |
| Direct prompt | Selected tool, bounded arguments, redacted result |
| Follow-up prompt | Identifier reuse and bounded result |
| Negative prompt | Unsupported mutation selects no unsafe tool |
| Error case | Invalid identifier/authentication fails closed |
| Logs/screenshots | Redacted evidence references only |
| Shutdown | Tunnel client stopped or connector revoked with time |
| Residual risk | Open issue, owner, and disposition |

Never record bearer values, runtime/admin keys, authorization headers, cookies,
private URLs, account IDs, or raw unredacted exports. A Full-control test must be
a new run with a new explicit operator decision; Restricted never upgrades
itself.
