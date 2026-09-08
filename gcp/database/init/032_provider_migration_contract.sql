ALTER TABLE provider_work_items ADD COLUMN IF NOT EXISTS result jsonb;

CREATE INDEX IF NOT EXISTS keyword_cluster_members_keyword_lookup_idx
  ON keyword_cluster_members (keyword_id, cluster_id);

ALTER TABLE keywords DROP CONSTRAINT IF EXISTS keywords_categorisation_source_check;
ALTER TABLE keywords ADD CONSTRAINT keywords_categorisation_source_check
  CHECK (categorisation_source IN ('client_supplied', 'rule', 'taxonomy', 'openrouter'));

ALTER TABLE navigator_projects
  ADD COLUMN IF NOT EXISTS authority_metric_source text,
  ADD COLUMN IF NOT EXISTS authority_fetched_at timestamptz;

ALTER TABLE authority_url_cache
  ADD COLUMN IF NOT EXISTS authority_scope text NOT NULL DEFAULT 'page';

ALTER TABLE local_provider_serp_results
  ADD COLUMN IF NOT EXISTS metric_source text,
  ADD COLUMN IF NOT EXISTS authority_scope text NOT NULL DEFAULT 'page';

ALTER TABLE local_provider_site_architecture_inputs
  ADD COLUMN IF NOT EXISTS metric_source text,
  ADD COLUMN IF NOT EXISTS input_scope text NOT NULL DEFAULT 'page';

ALTER TABLE serp_results
  ADD COLUMN IF NOT EXISTS authority_scope text NOT NULL DEFAULT 'page';

ALTER TABLE site_architecture
  ADD COLUMN IF NOT EXISTS metric_source text,
  ADD COLUMN IF NOT EXISTS input_scope text NOT NULL DEFAULT 'page';

INSERT INTO schema_migrations (version)
VALUES ('032_provider_migration_contract')
ON CONFLICT (version) DO NOTHING;
