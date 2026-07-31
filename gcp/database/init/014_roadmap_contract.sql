CREATE TABLE IF NOT EXISTS project_roadmaps (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL
    REFERENCES navigator_projects(id) ON DELETE CASCADE,
  pipeline_run_id uuid
    REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  roadmap_markdown text NOT NULL,
  generation_source text NOT NULL
    CHECK (generation_source IN ('anthropic', 'deterministic', 'vertex')),
  model_version text NOT NULL,
  generated_by uuid REFERENCES profiles(user_id) ON DELETE SET NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  synced_at timestamptz
);

CREATE INDEX IF NOT EXISTS project_roadmaps_project_generated_idx
  ON project_roadmaps (project_id, generated_at DESC, id DESC);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON project_roadmaps
  TO seer_api;

GRANT SELECT ON project_roadmaps TO seer_worker;

INSERT INTO schema_migrations (version)
VALUES ('014_roadmap_contract')
ON CONFLICT (version) DO NOTHING;
