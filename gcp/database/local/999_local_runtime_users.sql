DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'seer_api_local') THEN
    CREATE ROLE seer_api_local LOGIN PASSWORD 'local-api-only';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'seer_worker_local') THEN
    CREATE ROLE seer_worker_local LOGIN PASSWORD 'local-worker-only';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'seer_dispatcher_local') THEN
    CREATE ROLE seer_dispatcher_local LOGIN PASSWORD 'local-dispatcher-only';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'seer_events_local') THEN
    CREATE ROLE seer_events_local LOGIN PASSWORD 'local-events-only';
  END IF;
END
$$;

GRANT seer_api TO seer_api_local;
GRANT seer_worker TO seer_worker_local;
GRANT seer_dispatcher TO seer_dispatcher_local;
GRANT seer_events TO seer_events_local;
