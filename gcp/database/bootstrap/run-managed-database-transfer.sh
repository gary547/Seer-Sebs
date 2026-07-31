#!/usr/bin/env bash

set -euo pipefail

required_variables=(
  CLOUD_SQL_CONNECTION_NAME
  SEER_DATABASE_TRANSFER_CHECKPOINT_OBJECT
  SEER_DATABASE_TRANSFER_LOCK_OBJECT
  SEER_DATABASE_TRANSFER_PLAN_OBJECT
  SEER_DATABASE_TRANSFER_PLAN_SHA256
  SEER_MIGRATION_EVIDENCE_BUCKET
  SEER_SOURCE_DATABASE_URL
  SEER_TARGET_DATABASE_URL
)

for variable_name in "${required_variables[@]}"; do
  if [[ -z "${!variable_name:-}" ]]; then
    echo "${variable_name} is required." >&2
    exit 1
  fi
done

proxy_pid=""
stop_proxy() {
  if [[ -n "${proxy_pid}" ]]; then
    kill "${proxy_pid}" 2>/dev/null || true
    wait "${proxy_pid}" 2>/dev/null || true
  fi
}
trap stop_proxy EXIT INT TERM

cloud-sql-proxy \
  --address=127.0.0.1 \
  --auto-iam-authn \
  --lazy-refresh \
  --port=5432 \
  --private-ip \
  --structured-logs \
  "${CLOUD_SQL_CONNECTION_NAME}" &
proxy_pid="$!"

attempt=0
until (: >/dev/tcp/127.0.0.1/5432) 2>/dev/null; do
  attempt=$((attempt + 1))
  if [[ "${attempt}" -ge 60 ]]; then
    echo "Cloud SQL IAM connection did not become ready." >&2
    exit 1
  fi
  sleep 1
done

node /app/gcp/scripts/managed-migrate-database.mjs
