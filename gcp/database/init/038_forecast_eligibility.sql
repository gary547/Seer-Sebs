CREATE TABLE IF NOT EXISTS pipeline_forecast_exclusions (
  run_id uuid NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  keyword_id uuid NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  normalised_text text NOT NULL CHECK (length(normalised_text) BETWEEN 1 AND 200),
  source_keyword_id uuid NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (reason IN ('missing_volume', 'below_operator_threshold', 'no_organic_results')),
  policy text NOT NULL CHECK (policy = 'automatic-v1'),
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, keyword_id)
);
CREATE INDEX IF NOT EXISTS pipeline_forecast_exclusions_keyword_idx ON pipeline_forecast_exclusions (keyword_id);
CREATE INDEX IF NOT EXISTS pipeline_forecast_exclusions_source_idx ON pipeline_forecast_exclusions (source_keyword_id);

GRANT SELECT, INSERT ON pipeline_forecast_exclusions TO seer_worker, seer_api;

INSERT INTO schema_migrations (version) VALUES ('038_forecast_eligibility')
ON CONFLICT (version) DO NOTHING;
