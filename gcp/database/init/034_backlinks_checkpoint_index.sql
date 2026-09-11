CREATE INDEX CONCURRENTLY IF NOT EXISTS local_provider_serp_project_url_idx
  ON local_provider_serp_results (project_id, url);

INSERT INTO schema_migrations (version)
VALUES ('034_backlinks_checkpoint_index')
ON CONFLICT (version) DO NOTHING;
