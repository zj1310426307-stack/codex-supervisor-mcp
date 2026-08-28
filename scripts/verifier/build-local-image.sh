#!/usr/bin/env bash
set -euo pipefail

engine="${CODEX_SUPERVISOR_OCI_ENGINE:-docker}"
tag="${CODEX_SUPERVISOR_VERIFIER_TAG:-local/codex-supervisor-verifier:phase04}"
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
project_root="$(CDPATH= cd -- "$script_dir/../.." && pwd)"

if ! command -v "$engine" >/dev/null 2>&1; then
  printf '{"status":"BLOCKED_BY_ENVIRONMENT","reason":"OCI engine command is unavailable","engine":"%s"}\n' "$engine"
  exit 2
fi

"$engine" build --pull=false --file "$script_dir/Dockerfile" --tag "$tag" "$project_root"
image_id="$($engine image inspect --format '{{.Id}}' "$tag")"
case "$image_id" in
  sha256:[0-9a-f][0-9a-f]*) ;;
  *)
    printf '{"status":"BLOCKED_BY_ENVIRONMENT","reason":"Engine did not return a sha256 image identity"}\n'
    exit 2
    ;;
esac

digest_ref="${tag%:*}@${image_id}"
if ! "$engine" image inspect "$digest_ref" >/dev/null 2>&1; then
  printf '{"status":"BLOCKED_BY_ENVIRONMENT","reason":"The local engine cannot resolve the built image through an image@sha256 reference","tag":"%s","imageId":"%s"}\n' "$tag" "$image_id"
  exit 2
fi

printf '{"status":"PASS","engine":"%s","tag":"%s","digestRef":"%s","next":"scripts/verifier/inspect-image.sh %s"}\n' \
  "$engine" "$tag" "$digest_ref" "$digest_ref"
