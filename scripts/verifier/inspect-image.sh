#!/usr/bin/env bash
set -euo pipefail

engine="${CODEX_SUPERVISOR_OCI_ENGINE:-docker}"
image="${1:-}"
if [[ ! "$image" =~ ^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(/[a-z0-9]+([._-][a-z0-9]+)*)*(:[A-Za-z0-9][A-Za-z0-9._-]{0,127})?@sha256:[a-f0-9]{64}$ ]]; then
  printf '{"status":"BLOCKED_BY_ENVIRONMENT","reason":"Pass one exact image@sha256:<64hex> reference"}\n'
  exit 2
fi
if ! command -v "$engine" >/dev/null 2>&1; then
  printf '{"status":"BLOCKED_BY_ENVIRONMENT","reason":"OCI engine command is unavailable","engine":"%s"}\n' "$engine"
  exit 2
fi

inspection="$($engine image inspect --format '{{json .}}' "$image")"
configured_user="$($engine image inspect --format '{{.Config.User}}' "$image")"
case "$configured_user" in
  0|0:0|root|root:root|"")
    printf '{"status":"BLOCKED_BY_ENVIRONMENT","reason":"Verifier image must declare a numeric non-root user"}\n'
    exit 2
    ;;
esac
if [[ ! "$configured_user" =~ ^[1-9][0-9]*:[1-9][0-9]*$ ]]; then
  printf '{"status":"BLOCKED_BY_ENVIRONMENT","reason":"Verifier image user is not numeric uid:gid","user":"%s"}\n' "$configured_user"
  exit 2
fi

printf '{"status":"PASS","engine":"%s","image":"%s","user":"%s","locallyPresent":true,"inspection":%s}\n' \
  "$engine" "$image" "$configured_user" "$inspection"
