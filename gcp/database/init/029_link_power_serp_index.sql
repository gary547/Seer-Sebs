CREATE INDEX IF NOT EXISTS link_power_scores_serp_result_idx
  ON link_power_scores (serp_result_id);

INSERT INTO schema_migrations (version)
VALUES ('029_link_power_serp_index')
ON CONFLICT (version) DO NOTHING;
