#!/usr/bin/env bash

set -euo pipefail

api_url="postgresql://seer_api_local:local-api-only@127.0.0.1:25432/seer"
worker_url="postgresql://seer_worker_local:local-worker-only@127.0.0.1:25432/seer"
dispatcher_url="postgresql://seer_dispatcher_local:local-dispatcher-only@127.0.0.1:25432/seer"
events_url="postgresql://seer_events_local:local-events-only@127.0.0.1:25432/seer"

expect_allowed() {
  local database_url="$1"
  local statement="$2"
  if ! psql "$database_url" -v ON_ERROR_STOP=1 -Atqc "$statement" >/dev/null 2>&1; then
    echo "Expected database operation to be allowed." >&2
    exit 1
  fi
}

expect_denied() {
  local database_url="$1"
  local statement="$2"
  if psql "$database_url" -v ON_ERROR_STOP=1 -Atqc "$statement" >/dev/null 2>&1; then
    echo "Expected database operation to be denied." >&2
    exit 1
  fi
}

expect_allowed "$api_url" "SELECT 1 FROM clients LIMIT 1"
expect_allowed "$worker_url" "SELECT 1 FROM monitored_urls LIMIT 1"
expect_allowed "$dispatcher_url" "SELECT 1 FROM local_task_queue LIMIT 1"
expect_allowed "$events_url" "SELECT 1 FROM outbox_events LIMIT 1"

expect_denied "$api_url" "SELECT 1 FROM migration.source_rows LIMIT 1"
expect_denied "$worker_url" "DELETE FROM clients WHERE false"
expect_denied "$dispatcher_url" "SELECT 1 FROM clients LIMIT 1"
expect_denied "$events_url" "SELECT 1 FROM profiles LIMIT 1"

echo "Database access boundary integration test passed."
