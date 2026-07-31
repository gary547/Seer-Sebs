ALTER TABLE keywords
  ADD COLUMN IF NOT EXISTS enrichment_source text,
  ADD COLUMN IF NOT EXISTS volume_fetched_at timestamptz,
  ADD COLUMN IF NOT EXISTS difficulty_fetched_at timestamptz,
  ADD COLUMN IF NOT EXISTS intent_fetched_at timestamptz,
  ADD COLUMN IF NOT EXISTS ranking_lookup_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS ranking_lookup_no_match boolean,
  ADD COLUMN IF NOT EXISTS base_rank integer CHECK (base_rank >= 0),
  ADD COLUMN IF NOT EXISTS base_rank_source text;

ALTER TABLE gsc_upload_keywords
  ADD COLUMN IF NOT EXISTS search_intent text,
  ADD COLUMN IF NOT EXISTS intent_source text;

CREATE TABLE IF NOT EXISTS local_provider_keyword_inputs (
  project_id uuid NOT NULL REFERENCES navigator_projects(id) ON DELETE CASCADE,
  normalised_keyword text NOT NULL,
  keyword text NOT NULL,
  avg_monthly_volume integer CHECK (avg_monthly_volume >= 0),
  keyword_difficulty numeric(5,2) CHECK (keyword_difficulty BETWEEN 0 AND 100),
  search_intent text
    CHECK (search_intent IN ('transactional', 'commercial', 'informational', 'navigational')),
  ranking_url text,
  rank integer CHECK (rank >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, normalised_keyword)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON local_provider_keyword_inputs TO seer_api;
GRANT SELECT ON local_provider_keyword_inputs TO seer_worker;
GRANT UPDATE ON gsc_upload_keywords TO seer_worker;

INSERT INTO schema_migrations (version)
VALUES ('003_local_provider_contract')
ON CONFLICT (version) DO NOTHING;
