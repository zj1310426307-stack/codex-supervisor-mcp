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
| Secure MCP Tunnel | PASS | Operator supplied preflight, doctor, healthy/ready/connected UI, real forwarding, and shutdown evidence |
| ChatGPT Restricted (13 tools) | PASS | Real developer-mode discovery and bounded read-only calls passed through the tunnel |
| ChatGPT Full-control (23 tools) | BLOCKED_BY_ENVIRONMENT | Local health advertised 23 tools, but `codex_task_start` was unavailable in the current ChatGPT session; no task or write occurred |

The recorded result is based on operator-supplied external evidence. The
repository agent did not execute the ChatGPT-side calls and does not claim that
it did. The redacted structured record is
`artifacts/validation/phase05-chatgpt-restricted-live.json`. The separately
authorized Full-control attempt is recorded in
`artifacts/validation/phase05-chatgpt-fullcontrol-attempt.json`.

## Recorded Restricted evidence

Recorded at `2026-08-29T20:34:55.8456663+08:00` (`Asia/Shanghai`):

- WSL2 preflight and `tunnel-client doctor --explain`: `PASS`.
- Tunnel admin UI: health `live`, readiness `ready`, logs `connected`, and the
  main `http-streamable` channel enabled.
- ChatGPT developer-mode app discovery: exactly 13 Restricted tools with schema
  hash `ff8bdcd4a57a6657c34a51fce89f8763adf9e658ab0833efce183163d3fdc23c`.
- `codex_health`: Supervisor initialized, App Server ready, compatible runtime,
  and fresh read probe all passed on `codex-cli 0.150.1`.
- `codex_task_list`: bounded empty result (`0` tasks).
- Follow-up: returned `NO_TASK_FOR_FOLLOW_UP` without inventing a task ID.
- Unsupported mutation: task creation and README modification were refused;
  no write-capable tool was called.
- Invalid identifier: `codex_task_status` failed closed with `NOT_FOUND` /
  normalized `INVALID_ARGUMENT` and no side effects.
- Shutdown: `LOCAL_MCP_STOPPED` and `TUNNEL_STOPPED`.

No bearer value, API key, authorization header, cookie, account identifier, or
private URL is stored. The later Full-control attempt does not change or weaken
this Restricted PASS.

## Recorded Full-control attempt

Recorded at `2026-08-30T00:12:04.1755983+08:00` (`Asia/Shanghai`):

- The operator explicitly authorized a temporary Full-control acceptance run.
- The target was an isolated temporary Git repository with no remote.
- Supervisor health reported `mode=full`, `controlEnabled=true`, 23 advertised
  tools, and schema hash
  `b3b0284da37852d182a0e1d8b403634c176b41d468dfdac7290485913c4ecc00`.
- The current ChatGPT session did not expose `codex_task_start` and returned
  `FULL_CONTROL_TOOL_UNAVAILABLE`.
- No control tool was called, no task ID was created, and no repository write,
  commit, push, merge, release, or deployment occurred.
- Available runtime logs showed intermittent control-plane polling failures and
  Codex model-refresh child-exit timeouts. These observations do not establish
  a single root cause.
- The exact Supervisor and tunnel processes were stopped, and both local ports
  were confirmed closed. The temporary repository is retained for audit.

The result is `BLOCKED_BY_ENVIRONMENT`, not PASS. Production readiness remains
false.

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

For a separately authorized Full-control run, first start the isolated
Full-control Supervisor, run `npm run preflight:tunnel:full`, and then create a
new ChatGPT developer-mode app while the 23-tool service is live. Do not reuse
the Restricted app or interpret permission reset/reconnect as a schema refresh.
The new app must visibly expose `codex_task_start` before any control prompt is
attempted.

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
