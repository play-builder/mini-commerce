#!/usr/bin/env bash

set -Eeuo pipefail

trap 'printf "ERROR: curl loop test failed(line=%s)\n" "$LINENO" >&2' ERR

test_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
app_dir=$(cd -- "${test_dir}/.." && pwd)
test_port=${TEST_PORT:-39001}
management_port=${TEST_MANAGEMENT_PORT:-39002}
test_log=$(mktemp "${TMPDIR:-/tmp}/sample-app-curl-loop.XXXXXX")

cleanup() {
  if [[ -n "${server_pid:-}" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -f "$test_log"
}
trap cleanup EXIT

PORT="$test_port" MANAGEMENT_PORT="$management_port" \
  node "${app_dir}/src/server.js" >"$test_log" 2>&1 &
server_pid=$!

for _ in {1..30}; do
  if curl --silent --fail "http://127.0.0.1:${management_port}/readyz" >/dev/null; then
    break
  fi
  sleep 0.1
done

result=$("${app_dir}/scripts/curl-loop.sh" "http://127.0.0.1:${management_port}/healthz" 3 0)

grep -q 'request=1 status=200' <<<"$result"
grep -q 'request=3 status=200' <<<"$result"

fractional_result=$("${app_dir}/scripts/curl-loop.sh" "http://127.0.0.1:${management_port}/healthz" 2 0.01)
grep -q 'interval=0.01s' <<<"$fractional_result"

if "${app_dir}/scripts/curl-loop.sh" "http://127.0.0.1:${management_port}/healthz" 2 invalid >/dev/null 2>&1; then
  printf 'invalid interval must fail\n' >&2
  exit 1
fi

printf 'curl-loop test passed\n'
