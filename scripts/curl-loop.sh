#!/usr/bin/env bash

set -Eeuo pipefail

trap 'printf "ERROR: curl loop failed(line=%s)\n" "$LINENO" >&2' ERR

target_url=${1:-http://127.0.0.1:3000/}
request_count=${2:-60}
interval_seconds=${3:-1}

if ! [[ "$request_count" =~ ^[1-9][0-9]*$ ]]; then
  printf 'COUNT must be a positive integer: %s\n' "$request_count" >&2
  exit 2
fi

printf 'target=%s count=%s interval=%ss\n' "$target_url" "$request_count" "$interval_seconds"

for ((request_number = 1; request_number <= request_count; request_number += 1)); do
  started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  response=$(curl --silent --show-error --max-time 5 --write-out $'\n%{http_code}' "$target_url" || true)
  status_code=${response##*$'\n'}
  response_body=${response%$'\n'*}

  printf '%s request=%d status=%s body=%s\n' \
    "$started_at" "$request_number" "${status_code:-curl-error}" "${response_body:-<empty>}"

  if ((request_number < request_count)); then
    sleep "$interval_seconds"
  fi
done
