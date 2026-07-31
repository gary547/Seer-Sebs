#!/bin/sh

set -eu

required_variables="
CLOUD_SQL_CONNECTION_NAME
DATABASE_NAME
MIGRATOR_DATABASE_USER
API_DATABASE_USER
WORKER_DATABASE_USER
DISPATCHER_DATABASE_USER
EVENTS_DATABASE_USER
"

for variable_name in $required_variables; do
  eval "variable_value=\${$variable_name:-}"
  if [ -z "$variable_value" ]; then
    echo "$variable_name is required." >&2
    exit 1
  fi
done

proxy_pid=""
stop_proxy() {
  if [ -n "$proxy_pid" ]; then
    kill "$proxy_pid" 2>/dev/null || true
    wait "$proxy_pid" 2>/dev/null || true
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
  "$CLOUD_SQL_CONNECTION_NAME" &
proxy_pid="$!"

attempt=0
until PGCONNECT_TIMEOUT=2 \
  PGDATABASE="$DATABASE_NAME" \
  PGHOST=127.0.0.1 \
  PGPORT=5432 \
  PGUSER="$MIGRATOR_DATABASE_USER" \
  psql --no-password --quiet --tuples-only \
    --command="SELECT 1" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "Cloud SQL IAM connection did not become ready." >&2
    exit 1
  fi
  sleep 1
done

export PGDATABASE="$DATABASE_NAME"
export PGHOST=127.0.0.1
export PGPORT=5432
export PGUSER="$MIGRATOR_DATABASE_USER"

for migration_file in /migrations/*.sql; do
  migration_version="$(basename "$migration_file" .sql)"
  migration_applied="$(
    psql --no-password --quiet --tuples-only --no-align \
      --command="SELECT to_regclass('public.schema_migrations') IS NOT NULL AND EXISTS (SELECT 1 FROM schema_migrations WHERE version = '$migration_version')" \
      2>/dev/null || printf 'f'
  )"
  if [ "$migration_applied" = "t" ]; then
    echo "Skipping applied migration $migration_version."
    continue
  fi

  echo "Applying migration $migration_version."
  psql --no-password --set=ON_ERROR_STOP=1 --file="$migration_file"
done

psql \
  --no-password \
  --set=ON_ERROR_STOP=1 \
  --set=api_database_user="$API_DATABASE_USER" \
  --set=worker_database_user="$WORKER_DATABASE_USER" \
  --set=dispatcher_database_user="$DISPATCHER_DATABASE_USER" \
  --set=events_database_user="$EVENTS_DATABASE_USER" \
  --file=/bootstrap/010_bind_runtime_iam.sql

psql --no-password --set=ON_ERROR_STOP=1 --command="
  SELECT role_name, grantee
  FROM information_schema.applicable_roles
  WHERE role_name IN ('seer_api', 'seer_worker', 'seer_dispatcher', 'seer_events')
  ORDER BY role_name, grantee;
"

echo "Target schema and IAM role bindings are ready."
