CREATE TABLE IF NOT EXISTS provider_work_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_run_id uuid NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES navigator_projects(id) ON DELETE CASCADE,
  stage_id text NOT NULL,
  item_key text NOT NULL,
  provider text NOT NULL,
  provider_task_id text,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'submitted', 'succeeded', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  submitted_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pipeline_run_id, stage_id, item_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_work_items_task_id_idx
  ON provider_work_items (provider, provider_task_id)
  WHERE provider_task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS provider_work_items_claim_idx
  ON provider_work_items (pipeline_run_id, stage_id, state, id);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON provider_work_items,
    local_provider_keyword_inputs,
    local_provider_keyword_monthly_volumes,
    local_provider_serp_keywords,
    local_provider_serp_results,
    local_provider_site_architecture_inputs
  TO seer_worker;

GRANT SELECT ON provider_work_items TO seer_api;

INSERT INTO schema_migrations (version)
VALUES ('022_live_provider_contract')
ON CONFLICT (version) DO NOTHING;
