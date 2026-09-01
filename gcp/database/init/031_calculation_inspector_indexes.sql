CREATE INDEX CONCURRENTLY IF NOT EXISTS keyword_monthly_volumes_canonical_idx
  ON keyword_monthly_volumes (
    keyword_id,
    month,
    fetched_at DESC,
    source DESC,
    id DESC
  )
  INCLUDE (volume);

CREATE INDEX CONCURRENTLY IF NOT EXISTS har_forecasts_realistic_run_keyword_idx
  ON har_forecasts (pipeline_run_id, keyword_id)
  INCLUDE (project_id, base_rank, har_position)
  WHERE scenario = 'realistic';

CREATE INDEX CONCURRENTLY IF NOT EXISTS revenue_forecasts_realistic_run_uplift_idx
  ON revenue_forecasts (
    pipeline_run_id,
    expected_incremental_annual DESC NULLS LAST,
    keyword_id
  )
  INCLUDE (
    project_id,
    current_revenue_annual,
    target_incremental_revenue_annual
  )
  WHERE scenario = 'realistic';

INSERT INTO schema_migrations (version)
VALUES ('031_calculation_inspector_indexes')
ON CONFLICT (version) DO NOTHING;
