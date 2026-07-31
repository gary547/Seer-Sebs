#!/usr/bin/env bash

set -euo pipefail

admin_url="postgresql://seer_owner:local-owner-only@127.0.0.1:25432/seer"
source_database="seer_source_migration_$$"
target_database="seer_target_migration_$$"
source_url="postgresql://seer_owner:local-owner-only@127.0.0.1:25432/$source_database"
target_url="postgresql://seer_owner:local-owner-only@127.0.0.1:25432/$target_database"
test_directory="$(mktemp -d /private/tmp/seer-canonical-transfer.XXXXXX)"

cleanup() {
  psql "$admin_url" -v ON_ERROR_STOP=1 -c "
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname IN ('$source_database', '$target_database')
      AND pid <> pg_backend_pid();
  " >/dev/null 2>&1 || true
  psql "$admin_url" -v ON_ERROR_STOP=1 -c \
    "DROP DATABASE IF EXISTS \"$source_database\";" >/dev/null 2>&1 || true
  psql "$admin_url" -v ON_ERROR_STOP=1 -c \
    "DROP DATABASE IF EXISTS \"$target_database\";" >/dev/null 2>&1 || true
  rm -rf "$test_directory"
}
trap cleanup EXIT

psql "$admin_url" -v ON_ERROR_STOP=1 -c \
  "CREATE DATABASE \"$source_database\";" >/dev/null
psql "$admin_url" -v ON_ERROR_STOP=1 -c \
  "CREATE DATABASE \"$target_database\";" >/dev/null

for migration in gcp/database/init/[0-9][0-9][0-9]_*.sql; do
  psql "$target_url" -v ON_ERROR_STOP=1 -f "$migration" >/dev/null
done

psql "$source_url" -v ON_ERROR_STOP=1 -c "
  CREATE TABLE profiles (
    id uuid PRIMARY KEY,
    email text NOT NULL,
    full_name text,
    approval_status text NOT NULL,
    created_at timestamptz NOT NULL
  );
  CREATE TABLE clients (
    id uuid PRIMARY KEY,
    company_name text NOT NULL,
    domain text NOT NULL,
    industry text,
    brand_terms text[],
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  );
  CREATE TABLE navigator_projects (
    id uuid PRIMARY KEY,
    client_id uuid NOT NULL,
    project_name text NOT NULL,
    category_focus text,
    duplicated_from uuid,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  );
  CREATE TABLE keywords (
    id uuid PRIMARY KEY,
    project_id uuid NOT NULL,
    keyword text NOT NULL,
    source text,
    kw_cluster text,
    detox_status text NOT NULL,
    device text NOT NULL,
    created_at timestamptz NOT NULL
  );
  CREATE TABLE monitor_campaigns (
    id uuid PRIMARY KEY,
    client_id uuid NOT NULL,
    navigator_project_id uuid,
    name text NOT NULL,
    status text NOT NULL,
    check_frequency text NOT NULL,
    daily_check_time time NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  );
  CREATE TABLE monitored_urls (
    id uuid PRIMARY KEY,
    campaign_id uuid NOT NULL,
    url text NOT NULL,
    is_active boolean NOT NULL,
    next_check_at timestamptz NOT NULL,
    current_status text,
    current_http_status integer,
    created_at timestamptz NOT NULL
  );
  CREATE TABLE url_check_snapshots (
    id uuid PRIMARY KEY,
    monitored_url_id uuid NOT NULL,
    checked_at timestamptz NOT NULL,
    http_status integer,
    final_url text,
    redirect_chain jsonb,
    page_title text,
    canonical_url text,
    response_time_ms integer,
    error_message text
  );
  CREATE TABLE url_issues (
    id uuid PRIMARY KEY,
    monitored_url_id uuid NOT NULL,
    snapshot_id uuid NOT NULL,
    severity text NOT NULL,
    issue_type text NOT NULL,
    previous_value text,
    current_value text,
    detected_at timestamptz NOT NULL
  );

  INSERT INTO profiles
    (id, email, full_name, approval_status, created_at)
  VALUES (
    '10000000-0000-4000-8000-000000000001',
    'owner@example.dev',
    'Migration Owner',
    'approved',
    '2026-07-30T08:00:00Z'
  );
  INSERT INTO clients
    (id, company_name, domain, industry, brand_terms, created_at, updated_at)
  VALUES (
    '20000000-0000-4000-8000-000000000001',
    'Synthetic Client',
    'example.com',
    'Retail',
    NULL,
    '2026-07-30T08:05:00Z',
    '2026-07-30T08:05:00Z'
  );
  INSERT INTO navigator_projects
    (id, client_id, project_name, category_focus, duplicated_from, created_at, updated_at)
  VALUES
    (
      '30000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000001',
      'Copied Project',
      'Footwear',
      '30000000-0000-4000-8000-000000000001',
      '2026-07-30T08:11:00Z',
      '2026-07-30T08:11:00Z'
    ),
    (
      '30000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      'Primary Project',
      'Footwear',
      NULL,
      '2026-07-30T08:10:00Z',
      '2026-07-30T08:10:00Z'
    );
  INSERT INTO keywords
    (id, project_id, keyword, source, kw_cluster, detox_status, device, created_at)
  VALUES
    (
      '40000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000002',
      '  Summer   SHOES ',
      NULL,
      'Footwear',
      'keep',
      'mobile',
      '2026-07-30T08:20:00Z'
    ),
    (
      '40000000-0000-4000-8000-000000000002',
      '30000000-0000-4000-8000-000000000002',
      'Winter boots',
      'manual',
      'Footwear',
      'removed',
      'desktop',
      '2026-07-30T08:21:00Z'
    ),
    (
      '40000000-0000-4000-8000-000000000003',
      '30000000-0000-4000-8000-000000000002',
      'Running socks',
      'manual',
      'Footwear',
      'flagged_remove',
      'mobile',
      '2026-07-30T08:22:00Z'
    );
  INSERT INTO monitor_campaigns
    (id, client_id, navigator_project_id, name, status, check_frequency, daily_check_time, created_at, updated_at)
  VALUES (
    '50000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000002',
    'Primary URLs',
    'active',
    '24h',
    '07:00',
    '2026-07-30T08:30:00Z',
    '2026-07-30T08:30:00Z'
  );
  INSERT INTO monitored_urls
    (id, campaign_id, url, is_active, next_check_at, current_status, current_http_status, created_at)
  VALUES (
    '60000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001',
    'HTTPS://Example.COM/path#fragment',
    true,
    '2026-07-31T07:00:00Z',
    'critical',
    500,
    '2026-07-30T08:35:00Z'
  );
  INSERT INTO url_check_snapshots
    (id, monitored_url_id, checked_at, http_status, final_url, redirect_chain, page_title, canonical_url, response_time_ms)
  VALUES
    (
      '70000000-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000001',
      '2026-07-30T09:00:00Z',
      200,
      'https://example.com/path',
      NULL,
      'Summer Shoes',
      'https://example.com/path',
      120
    ),
    (
      '70000000-0000-4000-8000-000000000002',
      '60000000-0000-4000-8000-000000000001',
      '2026-07-30T10:00:00Z',
      500,
      'https://example.com/path',
      '[]'::jsonb,
      'Summer Shoes',
      'https://example.com/path',
      150
    );
  INSERT INTO url_issues
    (id, monitored_url_id, snapshot_id, severity, issue_type, previous_value, current_value, detected_at)
  VALUES (
    '80000000-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000002',
    'critical',
    'http_status_change',
    '200',
    '500',
    '2026-07-30T10:00:00Z'
  );
" >/dev/null

SEER_INVENTORY_DATABASE_URL="$source_url" \
  node gcp/scripts/capture-source-inventory.mjs \
  --label canonical-source \
  --output "$test_directory/source-inventory.json" >/dev/null
SEER_INVENTORY_DATABASE_URL="$target_url" \
  node gcp/scripts/capture-source-inventory.mjs \
  --label canonical-target \
  --output "$test_directory/target-inventory.json" >/dev/null

node gcp/scripts/generate-database-archive-plan.mjs \
  --source "$test_directory/source-inventory.json" \
  --catalog gcp/fixtures/database-canonical-catalog.test.json \
  --output "$test_directory/archive-plan.json" \
  --approve-archive >/dev/null
node gcp/scripts/generate-database-canonical-plan.mjs \
  --source "$test_directory/source-inventory.json" \
  --target "$test_directory/target-inventory.json" \
  --catalog gcp/fixtures/database-canonical-catalog.test.json \
  --rules gcp/fixtures/database-canonical-rules.test.json \
  --output "$test_directory/canonical-plan.json" \
  --approve-canonical >/dev/null

SEER_SOURCE_DATABASE_URL="$source_url" \
SEER_TARGET_DATABASE_URL="$target_url" \
  node gcp/scripts/migrate-database.mjs \
  --apply \
  --batch-size 1 \
  --checkpoint "$test_directory/archive-checkpoint.json" \
  --plan "$test_directory/archive-plan.json" >/dev/null
SEER_SOURCE_DATABASE_URL="$source_url" \
SEER_TARGET_DATABASE_URL="$target_url" \
  node gcp/scripts/migrate-database.mjs \
  --apply \
  --batch-size 1 \
  --checkpoint "$test_directory/canonical-checkpoint.json" \
  --plan "$test_directory/canonical-plan.json" >/dev/null

SEER_TARGET_DATABASE_URL="$target_url" \
  node gcp/scripts/sync-identity-profiles.mjs \
  --identity gcp/fixtures/identity-profiles.test.json \
  --output "$test_directory/identity-profile-reconciliation.json" \
  --apply >/dev/null

result="$(
  psql "$target_url" -Atqc "
    SELECT
      (SELECT count(*) FROM migration.source_rows),
      (SELECT count(DISTINCT source_table) FROM migration.source_rows),
      (SELECT count(*) FROM navigator_projects),
      (SELECT count(*) FROM keywords
        WHERE normalised_keyword = 'summer shoes'
          AND sources = ARRAY['legacy_supabase']::text[]
          AND category = 'Footwear'),
      (SELECT count(*) FROM keywords WHERE detox_status = 'remove'),
      (SELECT count(*) FROM keywords WHERE detox_status = 'review'),
      (SELECT count(*) FROM monitored_urls
        WHERE normalized_url = 'https://example.com/path'),
      (SELECT count(*) FROM url_check_snapshots),
      (SELECT count(*) FROM url_issues),
      (SELECT count(*) FROM profiles
        WHERE identity_provider = 'identity-platform'
          AND identity_email_verified),
      (SELECT count(*) FROM navigator_projects
        WHERE id = '30000000-0000-4000-8000-000000000002'
          AND duplicated_from = '30000000-0000-4000-8000-000000000001');
  "
)"

if [[ "$result" != "12|8|2|1|1|1|1|2|1|1|1" ]]; then
  echo "Unexpected canonical migration result: $result" >&2
  exit 1
fi

echo "Database archive-to-canonical transfer integration test passed."
