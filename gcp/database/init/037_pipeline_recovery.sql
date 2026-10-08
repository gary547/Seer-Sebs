ALTER TABLE provider_work_items
  ADD COLUMN IF NOT EXISTS attempt_offset integer NOT NULL DEFAULT 0 CHECK (attempt_offset >= 0);

ALTER TABLE local_task_queue
  ADD COLUMN IF NOT EXISTS generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0);

ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS last_activity_at timestamptz;
UPDATE pipeline_runs SET last_activity_at = created_at WHERE last_activity_at IS NULL;
ALTER TABLE pipeline_runs ALTER COLUMN last_activity_at SET DEFAULT now();
ALTER TABLE pipeline_runs ALTER COLUMN last_activity_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS pipeline_runs_project_activity_idx
  ON pipeline_runs ((input->>'projectId'), last_activity_at DESC, id DESC);

GRANT UPDATE (state, last_error, attempt_offset, updated_at) ON provider_work_items TO seer_api;

INSERT INTO schema_migrations (version) VALUES ('037_pipeline_recovery')
ON CONFLICT (version) DO NOTHING;
