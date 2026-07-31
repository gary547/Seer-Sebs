#!/usr/bin/env bash

set -euo pipefail
umask 077

input=""
output_directory=""
project_id=""
apply=false
allow_existing_target=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --input)
      input="${2:-}"
      shift 2
      ;;
    --output-directory)
      output_directory="${2:-}"
      shift 2
      ;;
    --project)
      project_id="${2:-}"
      shift 2
      ;;
    --apply)
      apply=true
      shift
      ;;
    --allow-existing-target)
      allow_existing_target=true
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ ! "$project_id" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]; then
  echo "--project must be an explicit valid Google Cloud project ID." >&2
  exit 1
fi
if [[ -z "$input" || ! -f "$input" ]]; then
  echo "--input must point to the restricted Firebase import JSON." >&2
  exit 1
fi
if [[ -z "$output_directory" ]]; then
  echo "--output-directory is required." >&2
  exit 1
fi

user_count="$(jq -er '
  .users as $users
  | if ($users | type) != "array" then error("users must be an array") else empty end,
    if (($users | map(.localId) | unique | length) != ($users | length))
      then error("duplicate UID") else empty end,
    if (($users | map(select(.email != null) | (.email | ascii_downcase)) | unique | length)
      != ($users | map(select(.email != null)) | length))
      then error("duplicate email") else empty end,
    ($users | length)
' "$input")"

if [[ "$apply" != true ]]; then
  jq -n \
    --arg project "$project_id" \
    --argjson users "$user_count" \
    '{apply:false, project:$project, validatedUsers:$users}'
  exit 0
fi

if ! command -v firebase >/dev/null 2>&1; then
  echo "The Firebase CLI is required for --apply." >&2
  exit 1
fi

mkdir -p "$output_directory"
pre_import="$output_directory/target-auth-pre-import.json"
post_import="$output_directory/target-auth-post-import.json"
report="$output_directory/identity-reconciliation.json"

firebase auth:export "$pre_import" --format=json --project "$project_id"
existing_count="$(jq -r '(.users // []) | length' "$pre_import")"
if [[ "$existing_count" -gt 0 && "$allow_existing_target" != true ]]; then
  echo "Target Identity Platform already contains users; import stopped." >&2
  exit 1
fi

firebase auth:import "$input" --hash-algo=BCRYPT --project "$project_id"
firebase auth:export "$post_import" --format=json --project "$project_id"
node gcp/scripts/reconcile-identity.mjs \
  --source "$input" \
  --target "$post_import" \
  --output "$report"

jq -n \
  --arg project "$project_id" \
  --argjson users "$user_count" \
  '{apply:true, project:$project, reconciledUsers:$users}'
