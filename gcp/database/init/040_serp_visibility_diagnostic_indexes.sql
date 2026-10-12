CREATE INDEX CONCURRENTLY IF NOT EXISTS project_serp_features_diagnostic_idx
  ON project_serp_features (project_id, keyword_id, result_type)
  INCLUDE (owned);

CREATE INDEX CONCURRENTLY IF NOT EXISTS har_forecasts_realistic_visibility_idx
  ON har_forecasts (project_id, pipeline_run_id)
  INCLUDE (serp_visibility_multiplier)
  WHERE scenario = 'realistic';

INSERT INTO schema_migrations (version)
VALUES ('040_serp_visibility_diagnostic_indexes')
ON CONFLICT (version) DO NOTHING;
