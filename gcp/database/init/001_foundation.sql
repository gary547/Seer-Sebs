DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'seer_api') THEN
    CREATE ROLE seer_api NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'seer_worker') THEN
    CREATE ROLE seer_worker NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'seer_dispatcher') THEN
    CREATE ROLE seer_dispatcher NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'seer_events') THEN
    CREATE ROLE seer_events NOLOGIN;
  END IF;
END
$$;

ALTER ROLE seer_api NOLOGIN;
ALTER ROLE seer_worker NOLOGIN;
ALTER ROLE seer_dispatcher NOLOGIN;
ALTER ROLE seer_events NOLOGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE local_users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  password_salt text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE local_auth_sessions (
  token_hash char(64) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES local_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX local_auth_sessions_expiry_idx
  ON local_auth_sessions (expires_at);

CREATE TABLE profiles (
  user_id uuid PRIMARY KEY REFERENCES local_users(id) ON DELETE CASCADE,
  email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assets (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
  object_key text NOT NULL UNIQUE,
  file_name text NOT NULL,
  content_type text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes >= 0),
  sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX assets_user_created_idx
  ON assets (user_id, created_at DESC);

CREATE TABLE pipeline_runs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX pipeline_runs_user_created_idx
  ON pipeline_runs (user_id, created_at DESC);

CREATE INDEX pipeline_runs_status_created_idx
  ON pipeline_runs (status, created_at);

CREATE TABLE pipeline_stage_runs (
  run_id uuid NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  stage_id text NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'queued', 'running', 'succeeded', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  output jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY (run_id, stage_id)
);

CREATE INDEX pipeline_stage_runs_state_idx
  ON pipeline_stage_runs (state, run_id);

CREATE TABLE local_task_queue (
  id bigserial PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  run_id uuid NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  stage_id text NOT NULL,
  state text NOT NULL DEFAULT 'ready'
    CHECK (state IN ('ready', 'leased', 'succeeded', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (run_id, stage_id)
);

CREATE INDEX local_task_queue_claim_idx
  ON local_task_queue (state, available_at, id);

CREATE INDEX local_task_queue_lease_idx
  ON local_task_queue (state, lease_expires_at)
  WHERE state = 'leased';

CREATE TABLE outbox_events (
  id bigserial PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  idempotency_key text NOT NULL UNIQUE,
  event_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'processing', 'delivered')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);

CREATE INDEX outbox_events_delivery_idx
  ON outbox_events (state, id);

CREATE TABLE event_deliveries (
  event_id uuid PRIMARY KEY,
  event_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  delivered_at timestamptz NOT NULL DEFAULT now()
);

GRANT CONNECT ON DATABASE seer TO seer_api, seer_worker, seer_dispatcher, seer_events;
GRANT USAGE ON SCHEMA public TO seer_api, seer_worker, seer_dispatcher, seer_events;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON local_users, local_auth_sessions, profiles, assets, pipeline_runs, pipeline_stage_runs
  TO seer_api;
GRANT SELECT ON event_deliveries TO seer_api;

GRANT SELECT, UPDATE ON pipeline_runs, pipeline_stage_runs TO seer_worker;
GRANT INSERT ON outbox_events TO seer_worker;
GRANT USAGE, SELECT ON SEQUENCE outbox_events_id_seq TO seer_worker;

GRANT SELECT, UPDATE ON pipeline_runs, pipeline_stage_runs TO seer_dispatcher;
GRANT SELECT, INSERT, UPDATE ON local_task_queue TO seer_dispatcher;
GRANT USAGE, SELECT ON SEQUENCE local_task_queue_id_seq TO seer_dispatcher;

GRANT SELECT, UPDATE ON outbox_events TO seer_events;
GRANT SELECT, INSERT ON event_deliveries TO seer_events;

INSERT INTO schema_migrations (version)
VALUES ('001_foundation')
ON CONFLICT (version) DO NOTHING;
