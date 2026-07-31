CREATE TABLE IF NOT EXISTS project_serp_features (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL
    REFERENCES navigator_projects(id) ON DELETE CASCADE,
  keyword_id uuid NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  device text NOT NULL DEFAULT 'mobile'
    CHECK (device IN ('desktop', 'mobile', 'tablet')),
  feature_raw text NOT NULL,
  result_type text NOT NULL,
  feature_url text,
  owned boolean NOT NULL DEFAULT false,
  source text NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS project_serp_features_identity_idx
  ON project_serp_features (
    project_id,
    keyword_id,
    device,
    result_type,
    feature_raw,
    COALESCE(feature_url, '')
  );

CREATE INDEX IF NOT EXISTS project_serp_features_project_captured_idx
  ON project_serp_features (project_id, captured_at DESC, keyword_id);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON project_serp_features
  TO seer_api;

GRANT SELECT, INSERT, UPDATE
  ON serp_results
  TO seer_api;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON project_serp_features
  TO seer_worker;

INSERT INTO schema_migrations (version)
VALUES ('015_serp_import_contract')
ON CONFLICT (version) DO NOTHING;
