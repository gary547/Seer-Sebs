ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS brand_terms text[] NOT NULL DEFAULT ARRAY[]::text[];

ALTER TABLE keywords
  ADD COLUMN IF NOT EXISTS is_branded boolean,
  ADD COLUMN IF NOT EXISTS brand_confidence numeric(4,3)
    CHECK (brand_confidence BETWEEN 0 AND 1),
  ADD COLUMN IF NOT EXISTS brand_source text,
  ADD COLUMN IF NOT EXISTS brand_matched_term text,
  ADD COLUMN IF NOT EXISTS brand_classified_at timestamptz,
  ADD COLUMN IF NOT EXISTS serp_lookup_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS serp_lookup_no_result boolean,
  ADD COLUMN IF NOT EXISTS serp_provider_missing boolean,
  ADD COLUMN IF NOT EXISTS base_rank_checked_at timestamptz;

ALTER TABLE gsc_upload_keywords
  ADD COLUMN IF NOT EXISTS is_branded boolean,
  ADD COLUMN IF NOT EXISTS brand_confidence numeric(4,3)
    CHECK (brand_confidence BETWEEN 0 AND 1),
  ADD COLUMN IF NOT EXISTS brand_source text,
  ADD COLUMN IF NOT EXISTS brand_matched_term text,
  ADD COLUMN IF NOT EXISTS brand_classified_at timestamptz;

CREATE TABLE IF NOT EXISTS serp_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES navigator_projects(id) ON DELETE CASCADE,
  keyword_id uuid NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  rank_absolute integer NOT NULL CHECK (rank_absolute BETWEEN 1 AND 100),
  url text NOT NULL,
  domain text NOT NULL,
  is_client_domain boolean NOT NULL DEFAULT false,
  url_rating numeric(5,2) CHECK (url_rating BETWEEN 0 AND 100),
  domain_rating numeric(5,2) CHECK (domain_rating BETWEEN 0 AND 100),
  ahrefs_rank bigint CHECK (ahrefs_rank >= 0),
  referring_domains bigint CHECK (referring_domains >= 0),
  backlinks bigint CHECK (backlinks >= 0),
  metric_source text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  metrics_fetched_at timestamptz,
  UNIQUE (keyword_id, rank_absolute),
  UNIQUE (keyword_id, url)
);

CREATE INDEX IF NOT EXISTS serp_results_project_keyword_idx
  ON serp_results (project_id, keyword_id, rank_absolute);

CREATE INDEX IF NOT EXISTS serp_results_project_fetched_idx
  ON serp_results (project_id, fetched_at DESC);

CREATE TABLE IF NOT EXISTS client_domain_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL UNIQUE
    REFERENCES navigator_projects(id) ON DELETE CASCADE,
  domain text NOT NULL,
  url_rating numeric(5,2) CHECK (url_rating BETWEEN 0 AND 100),
  domain_rating numeric(5,2) CHECK (domain_rating BETWEEN 0 AND 100),
  ahrefs_rank bigint CHECK (ahrefs_rank >= 0),
  referring_domains bigint CHECK (referring_domains >= 0),
  backlinks bigint CHECK (backlinks >= 0),
  metric_source text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS local_provider_serp_keywords (
  project_id uuid NOT NULL REFERENCES navigator_projects(id) ON DELETE CASCADE,
  normalised_keyword text NOT NULL,
  keyword text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, normalised_keyword)
);

CREATE TABLE IF NOT EXISTS local_provider_serp_results (
  project_id uuid NOT NULL,
  normalised_keyword text NOT NULL,
  rank_absolute integer NOT NULL CHECK (rank_absolute BETWEEN 1 AND 100),
  url text NOT NULL,
  domain text NOT NULL,
  url_rating numeric(5,2) CHECK (url_rating BETWEEN 0 AND 100),
  domain_rating numeric(5,2) CHECK (domain_rating BETWEEN 0 AND 100),
  ahrefs_rank bigint CHECK (ahrefs_rank >= 0),
  referring_domains bigint CHECK (referring_domains >= 0),
  backlinks bigint CHECK (backlinks >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, normalised_keyword, rank_absolute),
  UNIQUE (project_id, normalised_keyword, url),
  FOREIGN KEY (project_id, normalised_keyword)
    REFERENCES local_provider_serp_keywords(project_id, normalised_keyword)
    ON DELETE CASCADE
);

GRANT SELECT ON serp_results, client_domain_metrics TO seer_api;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON local_provider_serp_keywords, local_provider_serp_results
  TO seer_api;

GRANT SELECT, INSERT, UPDATE, DELETE ON serp_results TO seer_worker;
GRANT SELECT, INSERT, UPDATE ON client_domain_metrics TO seer_worker;
GRANT SELECT ON local_provider_serp_keywords, local_provider_serp_results
  TO seer_worker;
GRANT UPDATE ON gsc_upload_keywords TO seer_worker;

INSERT INTO schema_migrations (version)
VALUES ('004_serp_authority_contract')
ON CONFLICT (version) DO NOTHING;
