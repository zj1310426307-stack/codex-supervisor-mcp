# ORCH-PHASE-05 design

## Objective

Phase 05 connects the already-proven WSL2 Supervisor to ChatGPT without opening
an inbound port. The first accepted route is Restricted only:

`ChatGPT developer-mode app -> OpenAI-hosted Secure MCP Tunnel -> tunnel-client in WSL2 -> http://127.0.0.1:8787/mcp -> Supervisor`

The project remains at v0.4.0 while external acceptance is incomplete. A phase
branch or local test does not itself change the published server/tool identity.

## Official constraints

The implementation follows the current OpenAI Secure MCP Tunnel contract:

- the client initiates outbound HTTPS to `api.openai.com:443`;
- the Supervisor remains private and loopback-only;
- `CONTROL_PLANE_API_KEY` is a runtime key, not an admin key;
- `CONTROL_PLANE_TUNNEL_ID` and the target ChatGPT workspace/Platform
  organization must be associated correctly;
- ChatGPT developer-mode permission and Platform tunnel permissions are
  independent;
- `tunnel-client doctor --profile <name> --explain` must pass before a real
  connector test;
- the daemon must remain healthy and ready during discovery and every MCP call.

References:

- <https://developers.openai.com/api/docs/guides/secure-mcp-tunnels>
- <https://developers.openai.com/plugins/deploy/connect-chatgpt>
- <https://github.com/openai/tunnel-client/blob/master/docs/configuration.md>

## Credential separation

Three values have distinct roles and must never be committed:

| Value | Purpose | Storage rule |
|---|---|---|
| `CONTROL_PLANE_TUNNEL_ID` | Non-secret tunnel identity | Runtime environment or approved operator record |
| `CONTROL_PLANE_API_KEY` | Authenticates `tunnel-client` to the OpenAI control plane | Runtime secret; never an admin key |
| `MCP_BEARER_TOKEN` | Authenticates local calls into the Supervisor | Runtime secret, at least 32 bytes |

`MCP_TUNNEL_AUTHORIZATION` is the HTTP header value `Bearer <MCP_BEARER_TOKEN>`.
The tunnel profile references it through `env:MCP_TUNNEL_AUTHORIZATION` for both
runtime and discovery/probe traffic. The report never emits any of these values.

## Deterministic gates

`npm run preflight:tunnel` is read-only and fails closed unless all of the
following are true:

1. the Supervisor bind and tunnel MCP URL are exact loopback targets;
2. `MCP_CONTROL_ENABLED=false`;
3. the local bearer is strong, non-placeholder, and correctly mapped through
   environment-backed tunnel headers;
4. the runtime key and local MCP bearer are distinct;
5. the tunnel identifier matches the documented shape;
6. `tunnel-client --version` and `tunnel-client help quickstart` work;
7. the local Supervisor reports ready.

The preflight does not install software, create a tunnel, open a browser, start a
daemon, change a workspace policy, or claim remote acceptance.

## External gates

The following remain human/operator-controlled and are never inferred from local
tests:

1. tunnel creation/association and Tunnels Read + Use permission;
2. runtime key creation outside source control;
3. `tunnel-client doctor` success and healthy/ready daemon evidence;
4. ChatGPT developer mode and Restricted tool discovery;
5. prompt, follow-up, negative, error, annotation, and shutdown evidence;
6. any later Full-control trial, which requires a new explicit authorization.

Commit, push, merge, release, and deployment remain human-only in both modes.
