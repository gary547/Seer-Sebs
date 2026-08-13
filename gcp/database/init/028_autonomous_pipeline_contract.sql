ALTER TABLE navigator_projects
  ADD COLUMN IF NOT EXISTS gsc_promotion_impressions_floor integer NOT NULL DEFAULT 1
    CHECK (gsc_promotion_impressions_floor >= 0),
  ADD COLUMN IF NOT EXISTS competitive_enrichment_volume_floor integer NOT NULL DEFAULT 0
    CHECK (competitive_enrichment_volume_floor >= 0),
  ADD COLUMN IF NOT EXISTS pipeline_policy_reviewed_at timestamptz;

ALTER TABLE keywords
  ADD COLUMN IF NOT EXISTS core_keyword text,
  ADD COLUMN IF NOT EXISTS core_keyword_source text,
  ADD COLUMN IF NOT EXISTS volume_source text,
  ADD COLUMN IF NOT EXISTS competitive_eligible boolean,
  ADD COLUMN IF NOT EXISTS competitive_eligibility_reason text,
  ADD COLUMN IF NOT EXISTS serp_inherited_from_keyword_id uuid
    REFERENCES keywords(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS keywords_project_competitive_idx
  ON keywords (project_id, competitive_eligible, id)
  WHERE detox_status = 'keep';

ALTER TABLE local_provider_keyword_inputs
  ADD COLUMN IF NOT EXISTS core_keyword text,
  ADD COLUMN IF NOT EXISTS core_keyword_source text,
  ADD COLUMN IF NOT EXISTS synonym_clustering_algorithm text,
  ADD COLUMN IF NOT EXISTS fetched_at timestamptz;

ALTER TABLE local_provider_serp_keywords
  ADD COLUMN IF NOT EXISTS source_keyword_id uuid REFERENCES keywords(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS fetched_at timestamptz;

CREATE TABLE IF NOT EXISTS authority_domain_cache (
  domain text PRIMARY KEY,
  domain_rating numeric(5,2) CHECK (domain_rating BETWEEN 0 AND 100),
  ahrefs_rank bigint CHECK (ahrefs_rank >= 0),
  referring_domains bigint CHECK (referring_domains >= 0),
  backlinks bigint CHECK (backlinks >= 0),
  metric_source text NOT NULL,
  fetched_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS authority_domain_cache_fetched_idx
  ON authority_domain_cache (fetched_at DESC, domain);

CREATE TABLE IF NOT EXISTS authority_url_cache (
  url text PRIMARY KEY,
  domain text NOT NULL,
  url_rating numeric(5,2) CHECK (url_rating BETWEEN 0 AND 100),
  domain_rating numeric(5,2) CHECK (domain_rating BETWEEN 0 AND 100),
  ahrefs_rank bigint CHECK (ahrefs_rank >= 0),
  referring_domains bigint CHECK (referring_domains >= 0),
  backlinks bigint CHECK (backlinks >= 0),
  metric_source text NOT NULL,
  fetched_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS authority_url_cache_domain_fetched_idx
  ON authority_url_cache (domain, fetched_at DESC);

ALTER TABLE ctr_curves
  ADD COLUMN IF NOT EXISTS source_date_range_start date,
  ADD COLUMN IF NOT EXISTS source_date_range_end date,
  ADD COLUMN IF NOT EXISTS source_sample_size bigint,
  ADD COLUMN IF NOT EXISTS provenance jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE calibration_snapshots
  ADD COLUMN IF NOT EXISTS unavailable_reason text;

ALTER TABLE ctr_curve_points DROP CONSTRAINT IF EXISTS ctr_curve_points_source_check;
ALTER TABLE ctr_curve_points
  ADD CONSTRAINT ctr_curve_points_source_check
  CHECK (source IN ('gsc', 'blended', 'fallback'));

CREATE TABLE IF NOT EXISTS serp_feature_visibility_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_type text NOT NULL,
  device text NOT NULL CHECK (device IN ('desktop', 'mobile', 'tablet', 'all')),
  search_intent text NOT NULL CHECK (
    search_intent IN ('transactional', 'commercial', 'informational', 'navigational', 'generic')
  ),
  multiplier numeric(6,5) NOT NULL CHECK (multiplier > 0 AND multiplier <= 1),
  is_active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (feature_type, device, search_intent)
);

INSERT INTO serp_feature_visibility_adjustments (
  feature_type,
  device,
  search_intent,
  multiplier
)
VALUES
  ('ai_overview', 'all', 'informational', 0.55),
  ('ai_overview', 'all', 'commercial', 0.72),
  ('ai_overview', 'all', 'transactional', 0.86),
  ('featured_snippet', 'all', 'informational', 0.78),
  ('featured_snippet', 'all', 'commercial', 0.88),
  ('featured_snippet', 'all', 'transactional', 0.94),
  ('shopping', 'all', 'informational', 0.93),
  ('shopping', 'all', 'commercial', 0.78),
  ('shopping', 'all', 'transactional', 0.68),
  ('local_pack', 'all', 'informational', 0.90),
  ('local_pack', 'all', 'commercial', 0.78),
  ('local_pack', 'all', 'transactional', 0.70),
  ('video', 'all', 'informational', 0.86),
  ('video', 'all', 'commercial', 0.94),
  ('video', 'all', 'transactional', 0.97),
  ('people_also_ask', 'all', 'informational', 0.88),
  ('people_also_ask', 'all', 'commercial', 0.95),
  ('people_also_ask', 'all', 'transactional', 0.98)
ON CONFLICT (feature_type, device, search_intent) DO NOTHING;

CREATE TABLE IF NOT EXISTS pipeline_rollups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_run_id uuid NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES navigator_projects(id) ON DELETE CASCADE,
  scenario text NOT NULL CHECK (scenario IN ('conservative', 'realistic', 'stretch')),
  naive_expected_incremental_annual numeric NOT NULL DEFAULT 0,
  cluster_deduped_expected_incremental_annual numeric NOT NULL DEFAULT 0,
  double_count_annual numeric NOT NULL DEFAULT 0,
  cluster_rollup jsonb NOT NULL DEFAULT '[]'::jsonb,
  category_rollup jsonb NOT NULL DEFAULT '[]'::jsonb,
  quarter_rollup jsonb NOT NULL DEFAULT '[]'::jsonb,
  trend_rollup jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence_distribution jsonb NOT NULL DEFAULT '{}'::jsonb,
  cannibalisation_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pipeline_run_id, scenario)
);

CREATE INDEX IF NOT EXISTS pipeline_rollups_project_run_idx
  ON pipeline_rollups (project_id, pipeline_run_id, scenario);

CREATE INDEX IF NOT EXISTS event_deliveries_aggregate_idx
  ON event_deliveries (aggregate_id);

CREATE INDEX IF NOT EXISTS revenue_forecasts_realistic_run_cover_idx
  ON revenue_forecasts (pipeline_run_id)
  INCLUDE (
    keyword_id,
    expected_incremental_annual,
    target_incremental_revenue_annual,
    annual_volume,
    ctr_target,
    svm_used
  )
  WHERE scenario = 'realistic';

ALTER TABLE pipeline_stage_runs
  ALTER COLUMN output SET COMPRESSION lz4;

GRANT SELECT, UPDATE ON navigator_projects TO seer_worker;
GRANT SELECT, UPDATE ON keywords TO seer_worker;
GRANT SELECT ON competitors TO seer_worker;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON authority_domain_cache,
     authority_url_cache,
     serp_feature_visibility_adjustments,
     pipeline_rollups
  TO seer_worker;
GRANT SELECT
  ON authority_domain_cache,
     authority_url_cache,
     serp_feature_visibility_adjustments,
     pipeline_rollups
  TO seer_api;

INSERT INTO schema_migrations (version)
VALUES ('028_autonomous_pipeline_contract')
ON CONFLICT (version) DO NOTHING;
