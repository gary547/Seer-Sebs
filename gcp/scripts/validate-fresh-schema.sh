#!/usr/bin/env bash

set -euo pipefail

container_name="seer-gcp-fresh-schema-$$"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}

trap cleanup EXIT

docker build \
  --file gcp/database.local.Dockerfile \
  --tag seer-gcp-postgres:fresh-schema \
  .

docker run \
  --detach \
  --name "$container_name" \
  --tmpfs /var/lib/postgresql/data \
  --env POSTGRES_DB=seer \
  --env POSTGRES_PASSWORD=fresh-schema-owner \
  --env POSTGRES_USER=seer_owner \
  seer-gcp-postgres:fresh-schema >/dev/null

for _ in $(seq 1 60); do
  if [[ "$(
    docker exec "$container_name" \
      psql -U seer_owner -d seer -Atqc "
        SELECT
          to_regclass('public.schema_migrations') IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM pg_roles
            WHERE rolname = 'seer_worker_local'
          );
      " 2>/dev/null || true
  )" == "t" ]]; then
    break
  fi
  sleep 1
done

docker exec "$container_name" \
  psql -U seer_owner -d seer -Atqc "
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'seer_worker_local';
  " | rg -qx "1"

validation_counts="$(
  docker exec "$container_name" \
    psql -U seer_owner -d seer -Atqc "
      SELECT
        (SELECT count(*) FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN (
              'clients',
              'navigator_projects',
              'keywords',
              'gsc_uploads',
              'pipeline_runs',
              'pipeline_stage_runs',
              'profiles',
              'user_roles'
            )),
        (SELECT count(*)
          FROM pg_index
          JOIN pg_class ON pg_class.oid = pg_index.indexrelid
          WHERE pg_class.relnamespace = 'public'::regnamespace
            AND (NOT indisready OR NOT indisvalid)),
        has_table_privilege('seer_worker_local', 'navigator_projects', 'UPDATE');
    "
)"

if [[ "$validation_counts" != "8|0|t" ]]; then
  echo "Unexpected fresh schema validation counts: $validation_counts" >&2
  exit 1
fi

expected_migrations="001_foundation,002_core_domain,003_local_provider_contract,004_serp_authority_contract,005_calculation_contract,006_forecast_calibration_contract,007_managed_runtime_contract,008_model_parity_contract,009_outbox_publication_contract,010_identity_access_contract,011_client_project_parity,012_keyword_gsc_parity,013_keyword_management_contract,014_roadmap_contract,015_serp_import_contract,016_archive_contract,017_url_monitor_contract,018_admin_reference_contract,019_conversion_override_application,020_content_planner_contract,021_slide_export_contract,022_live_provider_contract,023_source_migration_archive,024_url_monitor_leases,025_migration_load_contract"
applied_migrations="$(
  docker exec "$container_name" \
    psql -U seer_owner -d seer -Atqc "
      SELECT string_agg(version, ',' ORDER BY version)
      FROM schema_migrations;
    "
)"

if [[ "$applied_migrations" != "$expected_migrations" ]]; then
  echo "Fresh schema migration set is incomplete or unexpected." >&2
  exit 1
fi

test_user_id="00000000-0000-4000-8000-000000000099"

docker exec "$container_name" \
  psql -v ON_ERROR_STOP=1 -U seer_owner -d seer -c "
    INSERT INTO profiles (
      user_id,
      email,
      identity_provider,
      approval_status
    )
    VALUES (
      '$test_user_id',
      'fresh-schema-viewer@example.dev',
      'local',
      'approved'
    );
    INSERT INTO user_roles (user_id, role)
    VALUES ('$test_user_id', 'view_only');
  " >/dev/null

docker exec "$container_name" \
  psql -v ON_ERROR_STOP=1 -U seer_owner -d seer \
  -f /docker-entrypoint-initdb.d/010_identity_access_contract.sql >/dev/null

role_counts="$(
  docker exec "$container_name" \
    psql -U seer_owner -d seer -Atqc "
      SELECT
        count(*) FILTER (WHERE role = 'view_only'),
        count(*) FILTER (WHERE role <> 'view_only')
      FROM user_roles
      WHERE user_id = '$test_user_id';
    "
)"

if [[ "$role_counts" != "1|0" ]]; then
  echo "Identity migration changed an existing view-only role: $role_counts" >&2
  exit 1
fi

echo "Fresh GCP database schema validation passed."
