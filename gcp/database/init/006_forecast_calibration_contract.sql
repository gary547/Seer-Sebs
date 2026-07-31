ALTER TABLE navigator_projects
  ADD COLUMN IF NOT EXISTS conversion_rate numeric(8,6)
    CHECK (conversion_rate BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS aov numeric(14,2)
    CHECK (aov >= 0),
  ADD COLUMN IF NOT EXISTS gsc_window_days integer NOT NULL DEFAULT 30
    CHECK (gsc_window_days > 0);

CREATE TABLE IF NOT EXISTS har_forecasts (
  project_id uuid NOT NULL REFERENCES navigator_projects(id) ON DELETE CASCADE,
  keyword_id uuid NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  pipeline_run_id uuid NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  scenario text NOT NULL
    CHECK (scenario IN ('conservative', 'realistic', 'stretch')),
  model_version text NOT NULL,
  base_rank integer,
  har_position integer,
  har_confidence numeric(8,6) NOT NULL
    CHECK (har_confidence BETWEEN 0 AND 1),
  rank_attainment_probability numeric(8,6)
    CHECK (rank_attainment_probability BETWEEN 0 AND 1),
  authority_score numeric(8,6)
    CHECK (authority_score BETWEEN 0 AND 1),
  link_power_score numeric(6,2)
    CHECK (link_power_score BETWEEN 0 AND 100),
  link_gap_score numeric(8,6)
    CHECK (link_gap_score BETWEEN 0 AND 1),
  content_fit_score numeric(8,6)
    CHECK (content_fit_score BETWEEN 0 AND 1),
  serp_visibility_multiplier numeric(8,6) NOT NULL
    CHECK (serp_visibility_multiplier BETWEEN 0 AND 1),
  explanation_json jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pipeline_run_id, keyword_id, scenario)
);

CREATE INDEX IF NOT EXISTS har_forecasts_project_run_idx
  ON har_forecasts (project_id, pipeline_run_id, keyword_id, scenario);

CREATE TABLE IF NOT EXISTS revenue_forecasts (
  project_id uuid NOT NULL REFERENCES navigator_projects(id) ON DELETE CASCADE,
  keyword_id uuid NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  pipeline_run_id uuid NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  scenario text NOT NULL
    CHECK (scenario IN ('conservative', 'realistic', 'stretch')),
  model_version text NOT NULL,
  annual_volume numeric,
  volume_forward numeric,
  factor_applied numeric NOT NULL,
  ctr_now numeric(12,8) CHECK (ctr_now BETWEEN 0 AND 1),
  ctr_target numeric(12,8) CHECK (ctr_target BETWEEN 0 AND 1),
  current_revenue_annual numeric,
  target_absolute_revenue_annual numeric,
  target_incremental_revenue_annual numeric,
  expected_incremental_annual numeric,
  expected_incremental_low_annual numeric,
  expected_incremental_high_annual numeric,
  modelled_monthly_clicks numeric,
  warnings text[] NOT NULL DEFAULT ARRAY[]::text[],
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pipeline_run_id, keyword_id, scenario)
);

CREATE INDEX IF NOT EXISTS revenue_forecasts_project_run_idx
  ON revenue_forecasts (project_id, pipeline_run_id, keyword_id, scenario);

CREATE TABLE IF NOT EXISTS calibration_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES navigator_projects(id) ON DELETE CASCADE,
  pipeline_run_id uuid NOT NULL UNIQUE
    REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  model_version text NOT NULL,
  overall_ratio numeric,
  status text NOT NULL CHECK (status IN ('green', 'amber', 'red', 'unavailable')),
  matched integer NOT NULL CHECK (matched >= 0),
  excluded_noise_floor integer NOT NULL CHECK (excluded_noise_floor >= 0),
  pair_count integer NOT NULL CHECK (pair_count >= 0),
  by_intent jsonb NOT NULL,
  by_rank_band jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS calibration_snapshots_project_computed_idx
  ON calibration_snapshots (project_id, computed_at DESC);

GRANT SELECT
  ON har_forecasts, revenue_forecasts, calibration_snapshots
  TO seer_api;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON har_forecasts, revenue_forecasts, calibration_snapshots
  TO seer_worker;

INSERT INTO schema_migrations (version)
VALUES ('006_forecast_calibration_contract')
ON CONFLICT (version) DO NOTHING;
