#!/usr/bin/env bash

set -euo pipefail

compose_file="gcp/docker-compose.local.yml"
database_name="seer_restore_validation"
dump_path="/tmp/seer_restore_validation.dump"

cleanup() {
  docker compose -f "$compose_file" exec -T postgres \
    dropdb --if-exists --force -U seer_owner "$database_name" >/dev/null
  docker compose -f "$compose_file" exec -T postgres \
    rm -f "$dump_path"
}
trap cleanup EXIT

cleanup

source_counts="$(
  docker compose -f "$compose_file" exec -T postgres \
    psql -U seer_owner -d seer -Atqc "
      SELECT concat_ws(
        '|',
        (SELECT count(*) FROM schema_migrations),
        (SELECT count(*) FROM clients),
        (SELECT count(*) FROM navigator_projects),
        (SELECT count(*) FROM pipeline_runs),
        (SELECT count(*) FROM url_check_snapshots),
        (SELECT count(*) FROM migration.source_rows)
      );
    "
)"

docker compose -f "$compose_file" exec -T postgres \
  pg_dump -U seer_owner -d seer \
  --format=custom \
  --no-owner \
  --file="$dump_path"
docker compose -f "$compose_file" exec -T postgres \
  createdb -U seer_owner "$database_name"
docker compose -f "$compose_file" exec -T postgres \
  pg_restore -U seer_owner -d "$database_name" \
  --exit-on-error \
  --no-owner \
  --no-privileges \
  "$dump_path"

restored_counts="$(
  docker compose -f "$compose_file" exec -T postgres \
    psql -U seer_owner -d "$database_name" -Atqc "
      SELECT concat_ws(
        '|',
        (SELECT count(*) FROM schema_migrations),
        (SELECT count(*) FROM clients),
        (SELECT count(*) FROM navigator_projects),
        (SELECT count(*) FROM pipeline_runs),
        (SELECT count(*) FROM url_check_snapshots),
        (SELECT count(*) FROM migration.source_rows)
      );
    "
)"

if [[ "$source_counts" != "$restored_counts" ]]; then
  echo "Backup restore reconciliation failed: $source_counts != $restored_counts" >&2
  exit 1
fi

invalid_indexes="$(
  docker compose -f "$compose_file" exec -T postgres \
    psql -U seer_owner -d "$database_name" -Atqc "
      SELECT count(*)
      FROM pg_index
      WHERE NOT indisready OR NOT indisvalid;
    "
)"

if [[ "$invalid_indexes" != "0" ]]; then
  echo "Restored database contains $invalid_indexes invalid indexes." >&2
  exit 1
fi

echo "Backup restore integration test passed."
