#!/usr/bin/env bash

set -euo pipefail

database_url="postgresql://seer_owner:local-owner-only@127.0.0.1:25432/seer"
test_directory="$(mktemp -d /private/tmp/seer-database-transfer.XXXXXX)"
checkpoint_path="$test_directory/checkpoint.json"

cleanup() {
  psql "$database_url" -v ON_ERROR_STOP=1 -c \
    "DROP SCHEMA IF EXISTS migration_transfer_test CASCADE; DELETE FROM migration.source_rows WHERE plan_entry_id = 'archive-integration-source-items';" \
    >/dev/null
  rm -rf "$test_directory"
}
trap cleanup EXIT

psql "$database_url" -v ON_ERROR_STOP=1 \
  -f gcp/database/init/023_source_migration_archive.sql >/dev/null
psql "$database_url" -v ON_ERROR_STOP=1 -c "
  DROP SCHEMA IF EXISTS migration_transfer_test CASCADE;
  DELETE FROM migration.source_rows
  WHERE plan_entry_id = 'archive-integration-source-items';
  CREATE SCHEMA migration_transfer_test;
  CREATE TABLE migration_transfer_test.source_items (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, id)
  );
  INSERT INTO migration_transfer_test.source_items
    (tenant_id, id, payload, created_at)
  VALUES
    (
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '{\"label\":\"alpha\",\"score\":10}'::jsonb,
      '2026-07-30T10:00:00Z'
    ),
    (
      '22222222-2222-4222-8222-222222222222',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      '{\"label\":\"beta\",\"score\":20}'::jsonb,
      '2026-07-30T11:00:00Z'
    );
" >/dev/null

SEER_SOURCE_DATABASE_URL="$database_url" \
SEER_TARGET_DATABASE_URL="$database_url" \
node gcp/scripts/migrate-database.mjs \
  --apply \
  --batch-size 1 \
  --checkpoint "$checkpoint_path" \
  --plan gcp/fixtures/database-archive-plan.test.json >/dev/null

result="$(
  psql "$database_url" -Atqc "
    SELECT
      count(*) || '|' ||
      count(DISTINCT source_key) || '|' ||
      count(*) FILTER (WHERE row_sha256 ~ '^[0-9a-f]{64}$') || '|' ||
      count(*) FILTER (WHERE source_row->'payload'->>'label' IN ('alpha', 'beta'))
    FROM migration.source_rows
    WHERE plan_entry_id = 'archive-integration-source-items';
  "
)"

if [[ "$result" != "2|2|2|2" ]]; then
  echo "Unexpected archive reconciliation result: $result" >&2
  exit 1
fi

SEER_SOURCE_DATABASE_URL="$database_url" \
SEER_TARGET_DATABASE_URL="$database_url" \
node gcp/scripts/migrate-database.mjs \
  --apply \
  --batch-size 1 \
  --checkpoint "$checkpoint_path" \
  --plan gcp/fixtures/database-archive-plan.test.json >/dev/null

echo "Database archive transfer integration test passed."
