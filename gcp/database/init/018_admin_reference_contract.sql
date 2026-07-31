CREATE TABLE IF NOT EXISTS serp_feature_index (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  serp_feature_raw text NOT NULL UNIQUE,
  result_type text NOT NULL,
  serp_intent text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS serp_feature_index_type_raw_idx
  ON serp_feature_index (result_type, serp_feature_raw, id);

INSERT INTO serp_feature_index (serp_feature_raw, result_type, serp_intent)
VALUES
  ('answers / paragraph', 'Featured Snippets', 'Answer'),
  ('carousel / image / organic', 'Image Carousel', 'Visual'),
  ('images', 'Images', 'Visual'),
  ('knowledge graph / other', 'Knowledge Graph', 'Branded'),
  ('people also ask', 'People Also Ask', 'Research'),
  ('placesv3', 'Local Pack', 'Local'),
  ('shopping', 'Google Shopping', 'Transactional'),
  ('carousel / videos', 'Videos', 'Video'),
  ('news', 'News', 'Fresh/News'),
  ('organic / sitelinks', 'Sitelinks', 'Transactional')
ON CONFLICT (serp_feature_raw) DO NOTHING;

CREATE TABLE IF NOT EXISTS har_scoring_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version text NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT false,
  weights_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  thresholds_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS har_scoring_config_active_idx
  ON har_scoring_config ((is_active))
  WHERE is_active;

INSERT INTO har_scoring_config (
  version,
  is_active,
  weights_json,
  thresholds_json,
  notes
)
VALUES (
  'har_v2.1.0',
  true,
  '{"authority_gap":3.2,"content_edge":1.6}'::jsonb,
  '{
    "thresholds":{"conservative":0.6,"realistic":0.5,"stretch":0.4},
    "temperatures":{"conservative":1.6,"realistic":1.0,"stretch":0.7},
    "floor_multipliers":{"conservative":0.7,"realistic":0.5,"stretch":0.3},
    "probability_factors":{"conservative":0.85,"realistic":1.0,"stretch":1.15}
  }'::jsonb,
  'Deployed deterministic HAR model contract.'
)
ON CONFLICT (version) DO UPDATE
SET
  is_active = EXCLUDED.is_active,
  weights_json = EXCLUDED.weights_json,
  thresholds_json = EXCLUDED.thresholds_json,
  notes = EXCLUDED.notes,
  updated_at = now();

CREATE TABLE IF NOT EXISTS project_conversion_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES navigator_projects(id) ON DELETE CASCADE,
  scope_type text NOT NULL
    CHECK (scope_type IN ('project', 'url', 'category', 'intent')),
  scope_value text,
  conversion_rate numeric
    CHECK (conversion_rate IS NULL OR conversion_rate BETWEEN 0 AND 1),
  average_order_value numeric
    CHECK (average_order_value IS NULL OR average_order_value >= 0),
  source text NOT NULL DEFAULT 'manual',
  confidence text NOT NULL DEFAULT 'medium'
    CHECK (confidence IN ('low', 'medium', 'high')),
  note text,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    scope_type = 'project'
    OR (scope_value IS NOT NULL AND length(btrim(scope_value)) > 0)
  ),
  CHECK (
    scope_type NOT IN ('url', 'category')
    OR (note IS NOT NULL AND length(btrim(note)) > 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS project_conversion_overrides_scope_idx
  ON project_conversion_overrides (
    project_id,
    scope_type,
    COALESCE(scope_value, '')
  );

CREATE INDEX IF NOT EXISTS project_conversion_overrides_project_updated_idx
  ON project_conversion_overrides (project_id, scope_type, updated_at DESC);

CREATE TABLE IF NOT EXISTS keyword_category_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword_id uuid NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by uuid,
  source text NOT NULL,
  batch_id uuid NOT NULL,
  category_before text,
  category_after text
);

CREATE INDEX IF NOT EXISTS keyword_category_history_client_changed_idx
  ON keyword_category_history (client_id, changed_at DESC, batch_id);

CREATE INDEX IF NOT EXISTS keyword_category_history_batch_idx
  ON keyword_category_history (batch_id, keyword_id);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON serp_feature_index, har_scoring_config, project_conversion_overrides,
    keyword_category_history
  TO seer_api;

GRANT SELECT ON serp_feature_index, har_scoring_config,
  project_conversion_overrides TO seer_worker;

INSERT INTO schema_migrations (version)
VALUES ('018_admin_reference_contract')
ON CONFLICT (version) DO NOTHING;
