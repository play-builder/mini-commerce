#!/usr/bin/env bash
set -Eeuo pipefail

ref="${1:-}"
repository="${2:-}"
if [[ -z "$ref" || -z "$repository" ]]; then
  printf 'usage: dispatch-and-watch.sh REF OWNER/REPOSITORY\n' >&2
  exit 2
fi

dispatch_output="$(gh workflow run ci.yml --ref "$ref" --repo "$repository")"
export DISPATCH_OUTPUT="$dispatch_output"
run_url="$(node --input-type=module -e '
  import { parseDispatchRunUrl } from "./scripts/workflow-run-selection.mjs";
  console.log(parseDispatchRunUrl(process.env.DISPATCH_OUTPUT).runUrl);
')"
unset DISPATCH_OUTPUT
run_id="${run_url##*/}"

printf 'RUN_ID:  %s\n' "$run_id"
printf 'RUN_URL: %s\n' "$run_url"
gh run watch "$run_id" --repo "$repository" --exit-status
