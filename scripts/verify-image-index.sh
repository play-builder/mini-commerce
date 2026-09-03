#!/usr/bin/env bash
set -Eeuo pipefail

repository="${1:-}"
digest="${2:-}"

if [[ -z "$repository" || "$repository" =~ [[:space:]] ]]; then
  printf 'ERROR: invalid repository\n' >&2
  exit 1
fi
if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  printf 'ERROR: invalid digest; expected sha256:<64 lowercase hex>\n' >&2
  exit 1
fi

if [[ -n "${IMAGE_INDEX_INSPECT_FILE:-}" ]]; then
  raw_json="$(<"$IMAGE_INDEX_INSPECT_FILE")"
else
  raw_json="$(docker buildx imagetools inspect --raw "$repository@$digest")"
fi

media_type="$(jq -r '.mediaType // ""' <<<"$raw_json")"
if [[ "$media_type" != "application/vnd.oci.image.index.v1+json" && "$media_type" != "application/vnd.docker.distribution.manifest.list.v2+json" ]]; then
  printf 'ERROR: expected an OCI image index or Docker manifest list\n' >&2
  exit 1
fi

for platform in linux/amd64 linux/arm64; do
  os="${platform%/*}"
  architecture="${platform#*/}"
  count="$(jq --arg os "$os" --arg architecture "$architecture" \
    '[.manifests[] | select(.platform.os == $os and .platform.architecture == $architecture)] | length' \
    <<<"$raw_json")"
  if [[ "$count" != "1" ]]; then
    printf 'ERROR: missing required platform %s or descriptor is not unique\n' "$platform" >&2
    exit 1
  fi
done

printf 'PASS: multi-architecture image index %s@%s\n' "$repository" "$digest"
