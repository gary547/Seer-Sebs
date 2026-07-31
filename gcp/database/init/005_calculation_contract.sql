CREATE TABLE IF NOT EXISTS local_provider_keyword_monthly_volumes (
  project_id uuid NOT NULL,
  normalised_keyword text NOT NULL,
  month date NOT NULL,
  volume integer NOT NULL CHECK (volume >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, normalised_keyword, month),
  FOREIGN KEY (project_id, normalised_keyword)
    REFERENCES local_provider_keyword_inputs(project_id, normalised_keyword)
    ON DELETE CASCADE,
  CHECK (month = date_trunc('month', month)::date)
);

CREATE INDEX IF NOT EXISTS local_provider_keyword_monthly_project_idx
  ON local_provider_keyword_monthly_volumes
  (project_id, normalised_keyword, month);

CREATE TABLE IF NOT EXISTS local_provider_site_architecture_inputs (
  project_id uuid NOT NULL REFERENCES navigator_projects(id) ON DELETE CASCADE,
  normalised_keyword text NOT NULL,
  keyword text NOT NULL,
  matched_url text,
  relevancy_score numeric(5,2) NOT NULL
    CHECK (relevancy_score BETWEEN 0 AND 100),
  content_status text NOT NULL
    CHECK (content_status IN ('green', 'amber', 'red')),
  tactical_status text NOT NULL
    CHECK (
      tactical_status IN (
        'create_content',
        'green',
        'new_content',
        'no_action_needed',
        'optimise_content'
      )
    ),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, normalised_keyword)
);

CREATE TABLE IF NOT EXISTS site_architecture (
  project_id uuid NOT NULL REFERENCES navigator_projects(id) ON DELETE CASCADE,
  keyword_id uuid NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  pipeline_run_id uuid NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  matched_url text,
  relevancy_score numeric(5,2)
    CHECK (relevancy_score BETWEEN 0 AND 100),
  content_status text CHECK (content_status IN ('green', 'amber', 'red')),
  tactical_status text CHECK (
    tactical_status IN (
      'create_content',
      'green',
      'new_content',
      'no_action_needed',
      'optimise_content'
    )
  ),
  provider_status text NOT NULL
    CHECK (provider_status IN ('matched', 'missing-provider')),
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pipeline_run_id, keyword_id)
);

CREATE INDEX IF NOT EXISTS site_architecture_project_run_idx
  ON site_architecture (project_id, pipeline_run_id, keyword_id);

CREATE TABLE IF NOT EXISTS link_power_scores (
  project_id uuid NOT NULL REFERENCES navigator_projects(id) ON DELETE CASCADE,
  keyword_id uuid NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  serp_result_id uuid NOT NULL REFERENCES serp_results(id) ON DELETE CASCADE,
  pipeline_run_id uuid NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  score numeric(6,2) NOT NULL CHECK (score BETWEEN 0 AND 100),
  confidence text NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pipeline_run_id, serp_result_id)
);

CREATE INDEX IF NOT EXISTS link_power_scores_project_run_idx
  ON link_power_scores (project_id, pipeline_run_id, keyword_id);

CREATE TABLE IF NOT EXISTS keyword_demand_signals (
  project_id uuid NOT NULL REFERENCES navigator_projects(id) ON DELETE CASCADE,
  keyword_id uuid NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  pipeline_run_id uuid NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  coverage_months integer NOT NULL CHECK (coverage_months >= 0),
  trend_direction text NOT NULL CHECK (
    trend_direction IN (
      'declining',
      'growing',
      'insufficient_data',
      'stable',
      'volatile'
    )
  ),
  trend_pct numeric,
  trend_slope numeric,
  trend_confidence text NOT NULL
    CHECK (trend_confidence IN ('low', 'medium', 'high')),
  volatility_score numeric CHECK (volatility_score >= 0),
  seasonality_strength numeric CHECK (seasonality_strength BETWEEN 0 AND 1),
  peak_months integer[] NOT NULL DEFAULT ARRAY[]::integer[],
  demand_warning boolean NOT NULL,
  demand_warning_reason text,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pipeline_run_id, keyword_id)
);

CREATE INDEX IF NOT EXISTS keyword_demand_signals_project_run_idx
  ON keyword_demand_signals (project_id, pipeline_run_id, keyword_id);

CREATE TABLE IF NOT EXISTS ctr_curves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES navigator_projects(id) ON DELETE CASCADE,
  pipeline_run_id uuid NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  device text NOT NULL CHECK (device IN ('desktop', 'mobile', 'tablet')),
  search_intent text NOT NULL CHECK (
    search_intent IN (
      'transactional',
      'commercial',
      'informational',
      'navigational',
      'generic'
    )
  ),
  is_branded boolean NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pipeline_run_id, device, search_intent, is_branded)
);

CREATE INDEX IF NOT EXISTS ctr_curves_project_run_idx
  ON ctr_curves (project_id, pipeline_run_id, device);

CREATE TABLE IF NOT EXISTS ctr_curve_points (
  curve_id uuid NOT NULL REFERENCES ctr_curves(id) ON DELETE CASCADE,
  rank integer NOT NULL CHECK (rank BETWEEN 1 AND 100),
  ctr numeric(12,8) NOT NULL CHECK (ctr BETWEEN 0 AND 1),
  impressions bigint NOT NULL CHECK (impressions >= 0),
  confidence text NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  source text NOT NULL CHECK (source IN ('gsc', 'fallback')),
  PRIMARY KEY (curve_id, rank)
);

CREATE TABLE IF NOT EXISTS keyword_clusters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES navigator_projects(id) ON DELETE CASCADE,
  pipeline_run_id uuid NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  cluster_key text NOT NULL,
  canonical_keyword_id uuid NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  canonical_basis text NOT NULL
    CHECK (canonical_basis IN ('alphabetical', 'base_rank', 'gsc_clicks', 'volume')),
  member_count integer NOT NULL CHECK (member_count > 0),
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pipeline_run_id, cluster_key)
);

CREATE INDEX IF NOT EXISTS keyword_clusters_project_run_idx
  ON keyword_clusters (project_id, pipeline_run_id, cluster_key);

CREATE TABLE IF NOT EXISTS keyword_cluster_members (
  cluster_id uuid NOT NULL REFERENCES keyword_clusters(id) ON DELETE CASCADE,
  keyword_id uuid NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  is_canonical boolean NOT NULL,
  PRIMARY KEY (cluster_id, keyword_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS keyword_cluster_members_one_canonical_idx
  ON keyword_cluster_members (cluster_id)
  WHERE is_canonical;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON local_provider_keyword_monthly_volumes,
     local_provider_site_architecture_inputs
  TO seer_api;

GRANT SELECT
  ON site_architecture,
     link_power_scores,
     keyword_demand_signals,
     ctr_curves,
     ctr_curve_points,
     keyword_clusters,
     keyword_cluster_members
  TO seer_api;

GRANT SELECT
  ON local_provider_keyword_monthly_volumes,
     local_provider_site_architecture_inputs
  TO seer_worker;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON site_architecture,
     link_power_scores,
     keyword_demand_signals,
     ctr_curves,
     ctr_curve_points,
     keyword_clusters,
     keyword_cluster_members
  TO seer_worker;

INSERT INTO schema_migrations (version)
VALUES ('005_calculation_contract')
ON CONFLICT (version) DO NOTHING;
