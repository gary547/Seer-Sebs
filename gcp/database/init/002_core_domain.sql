CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clients (
  id uuid PRIMARY KEY,
  company_name text NOT NULL,
  domain text NOT NULL,
  industry text,
  created_by uuid REFERENCES profiles(user_id),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_client_access (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  access_role text NOT NULL DEFAULT 'viewer'
    CHECK (access_role IN ('owner', 'editor', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, client_id),
  UNIQUE (id)
);

CREATE INDEX IF NOT EXISTS user_client_access_client_idx
  ON user_client_access (client_id, user_id);

CREATE TABLE IF NOT EXISTS navigator_projects (
  id uuid PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  project_name text NOT NULL,
  country char(2),
  language text,
  currency char(3),
  category_focus text,
  authority_domain_rating numeric(5,2) NOT NULL DEFAULT 0
    CHECK (authority_domain_rating BETWEEN 0 AND 100),
  authority_referring_domains integer NOT NULL DEFAULT 0
    CHECK (authority_referring_domains >= 0),
  authority_backlinks bigint NOT NULL DEFAULT 0
    CHECK (authority_backlinks >= 0),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, project_name)
);

CREATE INDEX IF NOT EXISTS navigator_projects_client_created_idx
  ON navigator_projects (client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS project_keyword_rules (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES navigator_projects(id) ON DELETE CASCADE,
  rule_type text NOT NULL
    CHECK (rule_type IN ('whitelist', 'blacklist', 'own_brand', 'competitor_brand', 'relevant_term')),
  value text NOT NULL,
  normalised_value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, rule_type, normalised_value)
);

CREATE INDEX IF NOT EXISTS project_keyword_rules_project_type_idx
  ON project_keyword_rules (project_id, rule_type, id);

CREATE TABLE IF NOT EXISTS keywords (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES navigator_projects(id) ON DELETE CASCADE,
  keyword text NOT NULL,
  normalised_keyword text NOT NULL,
  sources text[] NOT NULL DEFAULT ARRAY['source']::text[],
  avg_monthly_volume integer CHECK (avg_monthly_volume >= 0),
  keyword_difficulty numeric(5,2)
    CHECK (keyword_difficulty BETWEEN 0 AND 100),
  keyword_priority integer CHECK (
    keyword_priority IS NULL
    OR keyword_priority BETWEEN 1 AND 3
  ),
  ranking_url text,
  gsc_clicks integer CHECK (gsc_clicks >= 0),
  gsc_impressions integer CHECK (gsc_impressions >= 0),
  gsc_ctr numeric(12,8) CHECK (gsc_ctr BETWEEN 0 AND 1),
  gsc_position numeric(10,4) CHECK (gsc_position >= 0),
  gsc_devices text[],
  detox_status text NOT NULL DEFAULT 'pending'
    CHECK (detox_status IN ('pending', 'keep', 'remove', 'review')),
  detox_reason text,
  detox_rule text,
  category text,
  tags text[],
  search_intent text
    CHECK (search_intent IN ('transactional', 'commercial', 'informational', 'navigational')),
  categorisation_tier text CHECK (categorisation_tier IN ('live', 'deferred')),
  categorisation_source text CHECK (
    categorisation_source IN ('client_supplied', 'rule', 'taxonomy')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, normalised_keyword)
);

CREATE INDEX IF NOT EXISTS keywords_project_detox_idx
  ON keywords (project_id, detox_status, id);

CREATE INDEX IF NOT EXISTS keywords_project_tier_idx
  ON keywords (project_id, categorisation_tier, id)
  WHERE detox_status = 'keep';

CREATE TABLE IF NOT EXISTS gsc_uploads (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES navigator_projects(id) ON DELETE CASCADE,
  source_name text NOT NULL,
  row_count integer NOT NULL CHECK (row_count >= 0),
  date_range_end date,
  date_range_start date,
  device text NOT NULL DEFAULT 'all'
    CHECK (device IN ('all', 'desktop', 'mixed', 'mobile', 'tablet')),
  original_filename text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gsc_uploads_project_created_idx
  ON gsc_uploads (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS gsc_upload_keywords (
  id uuid PRIMARY KEY,
  upload_id uuid NOT NULL REFERENCES gsc_uploads(id) ON DELETE CASCADE,
  query text NOT NULL,
  normalised_query text NOT NULL,
  page text NOT NULL,
  device text NOT NULL CHECK (device IN ('all', 'desktop', 'mobile', 'tablet')),
  clicks integer NOT NULL CHECK (clicks >= 0),
  impressions integer NOT NULL CHECK (impressions >= 0),
  ctr numeric(12,8) NOT NULL CHECK (ctr BETWEEN 0 AND 1),
  position numeric(10,4) NOT NULL CHECK (position >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (upload_id, normalised_query, page, device)
);

CREATE INDEX IF NOT EXISTS gsc_upload_keywords_upload_query_idx
  ON gsc_upload_keywords (upload_id, normalised_query, id);

CREATE TABLE IF NOT EXISTS gsc_upload_pages (
  id uuid PRIMARY KEY,
  upload_id uuid NOT NULL REFERENCES gsc_uploads(id) ON DELETE CASCADE,
  page_url text NOT NULL,
  device text NOT NULL CHECK (device IN ('all', 'desktop', 'mobile', 'tablet')),
  clicks integer NOT NULL CHECK (clicks >= 0),
  impressions integer NOT NULL CHECK (impressions >= 0),
  ctr numeric(12,8) NOT NULL CHECK (ctr BETWEEN 0 AND 1),
  position numeric(10,4) NOT NULL CHECK (position >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (upload_id, page_url, device)
);

CREATE INDEX IF NOT EXISTS gsc_upload_pages_upload_idx
  ON gsc_upload_pages (upload_id, id);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON clients, user_client_access, navigator_projects, project_keyword_rules, keywords,
     gsc_uploads, gsc_upload_keywords, gsc_upload_pages
  TO seer_api;

GRANT SELECT ON clients, user_client_access, navigator_projects, project_keyword_rules,
  gsc_uploads, gsc_upload_keywords, gsc_upload_pages
  TO seer_worker;

GRANT SELECT, INSERT, UPDATE ON keywords TO seer_worker;

INSERT INTO schema_migrations (version)
VALUES ('002_core_domain')
ON CONFLICT (version) DO NOTHING;
