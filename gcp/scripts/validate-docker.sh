#!/usr/bin/env bash

set -euo pipefail

compose_file="gcp/docker-compose.local.yml"
validation_state="/private/tmp/seer-gcp-local-validation-state.json"
node_executable="${SEER_NODE_EXECUTABLE:-node}"

run_npm() {
  if [[ -n "${SEER_NPM_CLI:-}" ]]; then
    "$node_executable" "$SEER_NPM_CLI" "$@"
    return
  fi

  npm "$@"
}

docker compose -f "$compose_file" config --quiet
run_npm run check:gcp-boundary
run_npm run check:gcp-infra
run_npm run check:gcp-workflow
run_npm run check:gcp-model-parity
run_npm run typecheck:gcp
run_npm run test:gcp
run_npm run build:gcp

docker compose -f "$compose_file" build api postgres
docker compose -f "$compose_file" up -d --wait postgres
docker compose -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U seer_owner -d seer \
  -f /docker-entrypoint-initdb.d/002_core_domain.sql
docker compose -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U seer_owner -d seer \
  -f /docker-entrypoint-initdb.d/003_local_provider_contract.sql
docker compose -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U seer_owner -d seer \
  -f /docker-entrypoint-initdb.d/004_serp_authority_contract.sql
docker compose -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U seer_owner -d seer \
  -f /docker-entrypoint-initdb.d/005_calculation_contract.sql
docker compose -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U seer_owner -d seer \
  -f /docker-entrypoint-initdb.d/006_forecast_calibration_contract.sql
docker compose -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U seer_owner -d seer \
  -f /docker-entrypoint-initdb.d/007_managed_runtime_contract.sql
docker compose -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U seer_owner -d seer \
  -f /docker-entrypoint-initdb.d/008_model_parity_contract.sql
docker compose -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U seer_owner -d seer \
  -f /docker-entrypoint-initdb.d/009_outbox_publication_contract.sql
docker compose -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U seer_owner -d seer \
  -f /docker-entrypoint-initdb.d/010_identity_access_contract.sql
docker compose -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U seer_owner -d seer \
  -f /docker-entrypoint-initdb.d/011_client_project_parity.sql
docker compose -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U seer_owner -d seer \
  -f /docker-entrypoint-initdb.d/012_keyword_gsc_parity.sql
docker compose -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U seer_owner -d seer \
  -f /docker-entrypoint-initdb.d/013_keyword_management_contract.sql
docker compose -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U seer_owner -d seer \
  -f /docker-entrypoint-initdb.d/014_roadmap_contract.sql
docker compose -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U seer_owner -d seer \
  -f /docker-entrypoint-initdb.d/015_serp_import_contract.sql
docker compose -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U seer_owner -d seer \
  -f /docker-entrypoint-initdb.d/016_archive_contract.sql
docker compose -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U seer_owner -d seer \
  -f /docker-entrypoint-initdb.d/017_url_monitor_contract.sql
docker compose -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U seer_owner -d seer \
  -f /docker-entrypoint-initdb.d/018_admin_reference_contract.sql
docker compose -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U seer_owner -d seer \
  -f /docker-entrypoint-initdb.d/019_conversion_override_application.sql
docker compose -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U seer_owner -d seer \
  -f /docker-entrypoint-initdb.d/020_content_planner_contract.sql
docker compose -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U seer_owner -d seer \
  -f /docker-entrypoint-initdb.d/021_slide_export_contract.sql
docker compose -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U seer_owner -d seer \
  -f /docker-entrypoint-initdb.d/022_live_provider_contract.sql
docker compose -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U seer_owner -d seer \
  -f /docker-entrypoint-initdb.d/023_source_migration_archive.sql
docker compose -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U seer_owner -d seer \
  -f /docker-entrypoint-initdb.d/024_url_monitor_leases.sql
docker compose -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U seer_owner -d seer \
  -f /docker-entrypoint-initdb.d/025_migration_load_contract.sql
docker compose -f "$compose_file" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U seer_owner -d seer \
  -f /docker-entrypoint-initdb.d/999_local_runtime_users.sql
docker compose -f "$compose_file" up -d --wait

run_npm run test:gcp-database-transfer
run_npm run test:gcp-database-canonical
run_npm run test:gcp-url-monitor-maintenance
run_npm run test:gcp-backup-restore
run_npm run test:gcp-database-access

SEER_LOCAL_VALIDATION_STATE="$validation_state" "$node_executable" gcp/scripts/validate-local.mjs
"$node_executable" gcp/scripts/validate-synthetic.mjs
"$node_executable" gcp/scripts/validate-project-data.mjs

docker compose -f "$compose_file" restart
docker compose -f "$compose_file" up -d --wait

SEER_LOCAL_VALIDATION_STATE="$validation_state" "$node_executable" gcp/scripts/validate-local.mjs --persistence
"$node_executable" gcp/scripts/validate-project-data.mjs --persistence
"$node_executable" gcp/scripts/check-local-boundary.mjs

validation_counts="$(
  docker compose -f "$compose_file" exec -T postgres \
    psql -U seer_owner -d seer -Atqc "
      WITH target AS (
        SELECT id
        FROM pipeline_runs
        WHERE status = 'succeeded'
        ORDER BY created_at DESC
        LIMIT 1
      )
      SELECT
        (SELECT count(*) FROM pipeline_stage_runs JOIN target ON target.id = pipeline_stage_runs.run_id WHERE state = 'succeeded'),
        (SELECT count(*) FROM local_task_queue JOIN target ON target.id = local_task_queue.run_id WHERE state = 'succeeded'),
        (SELECT count(*) FROM outbox_events JOIN target ON target.id = outbox_events.aggregate_id WHERE state = 'delivered'),
        (SELECT count(*) FROM event_deliveries JOIN target ON target.id = event_deliveries.aggregate_id),
        (SELECT count(*) FROM pg_index JOIN pg_class ON pg_class.oid = pg_index.indexrelid WHERE pg_class.relnamespace = 'public'::regnamespace AND (NOT indisready OR NOT indisvalid));
    "
)"

if [[ "$validation_counts" != "19|19|19|19|0" ]]; then
  echo "Unexpected database validation counts: $validation_counts" >&2
  exit 1
fi

echo "Local GCP runtime validation passed."
