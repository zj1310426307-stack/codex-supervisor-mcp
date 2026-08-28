# Phase 04 ChatGPT Web acceptance

This is an operator evidence record. Allowed status values are `NOT_RUN`,
`BLOCKED_BY_PLAN`, `BLOCKED_BY_WORKSPACE_POLICY`, `BLOCKED_BY_ENVIRONMENT`,
`PASS`, and `FAIL`. Local unit
tests, manifest generation, or `npm run smoke:mcp` never imply a ChatGPT Web
PASS.

## Current result

| Track | Status | Reason |
|---|---|---|
| Restricted (13 tools) | NOT_RUN | No real ChatGPT developer-mode connection was tested |
| Full-control (23 tools) | NOT_RUN | Restricted acceptance and a separate operator authorization are prerequisites |

## Acceptance record template

Complete one copy per mode without placing bearer tokens, cookies, authorization
headers, tunnel credentials, account identifiers, or private URLs in the file.

| Field | Required evidence |
|---|---|
| Status | One allowed status value |
| Operator | Human reviewer name or approved internal identifier |
| Date/time and timezone | Exact test time |
| ChatGPT account/workspace policy | Plan and whether Developer mode is permitted |
| Mode | `restricted` or `full` |
| Server version | Expected v0.4.0 |
| Endpoint type | Secure MCP Tunnel or approved public HTTPS; never a raw public port |
| Tunnel/endpoint identifier | Non-secret approved identifier only |
| Tool count | 13 Restricted or 23 Full |
| Tool Schema hash | Exact scan value displayed by the server/connector |
| Annotations review | read-only/destructive/idempotent/open-world observations |
| Health call | Result of `codex_health` with secrets reviewed absent |
| Direct prompt | Selected tool, bounded arguments, result, confirmation behavior |
| Indirect prompt | Same fields for indirect intent |
| Follow-up prompt | Identifier reuse and result |
| Negative prompt | Proof an unsupported action selected no unsafe tool |
| Error case | Missing/invalid identifier or authentication behavior |
| Full-control confirmation | Per-action confirmation and no session-wide acceptance |
| Screenshots/log references | Redacted evidence locations |
| Shutdown/revocation | Tunnel stopped or connector revoked after the test |
| Residual risks | Unresolved issues and owner |

Restricted mode must be connected first with `MCP_CONTROL_ENABLED=false`. A
successful Restricted scan does not automatically restart or upgrade the server
to Full-control. Full-control requires a new explicit operator decision and must
still leave commit, push, merge, release, and deployment outside the MCP surface.

Follow the current official connection flow: enable Developer mode if the
workspace policy permits it, add the MCP server through Secure MCP Tunnel or an
approved HTTPS endpoint, review discovered tools and metadata, then exercise
positive, follow-up, negative, error, and confirmation cases.
