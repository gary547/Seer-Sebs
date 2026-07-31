CREATE TABLE IF NOT EXISTS slide_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES navigator_projects(id) ON DELETE CASCADE,
  created_by uuid,
  template_id text NOT NULL,
  object_key text NOT NULL,
  deck_id text,
  deck_url text,
  deck_name text,
  model_version text NOT NULL DEFAULT 'revenue_v2.1.0',
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'succeeded', 'failed')),
  error_message text,
  object_deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS slide_exports_project_created_idx
  ON slide_exports (project_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS slide_exports_status_created_idx
  ON slide_exports (status, created_at DESC, id);

GRANT SELECT, INSERT, UPDATE, DELETE ON slide_exports TO seer_api;

INSERT INTO schema_migrations (version)
VALUES ('021_slide_export_contract')
ON CONFLICT (version) DO NOTHING;
