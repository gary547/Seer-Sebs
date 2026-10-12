CREATE INDEX CONCURRENTLY IF NOT EXISTS link_power_scores_inspector_order_idx
  ON link_power_scores (project_id, pipeline_run_id, score DESC, keyword_id, serp_result_id)
  INCLUDE (confidence);

INSERT INTO schema_migrations (version)
VALUES ('039_link_power_inspector_index')
ON CONFLICT (version) DO NOTHING;
