CREATE TABLE IF NOT EXISTS content_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES navigator_projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  start_month date,
  end_month date,
  mix jsonb NOT NULL DEFAULT
    '{"hero":2,"blog":6,"page":2,"category":1,"product":1}'::jsonb,
  default_lead_weeks integer NOT NULL DEFAULT 12
    CHECK (default_lead_weeks BETWEEN 1 AND 52),
  hero_lead_weeks integer NOT NULL DEFAULT 16
    CHECK (hero_lead_weeks BETWEEN 1 AND 52),
  status text NOT NULL DEFAULT 'briefed',
  total_revenue_gain numeric CHECK (
    total_revenue_gain IS NULL OR total_revenue_gain >= 0
  ),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    jsonb_typeof(mix) = 'object'
    AND COALESCE((mix->>'hero')::integer, 0) >= 0
    AND COALESCE((mix->>'blog')::integer, 0) >= 0
    AND COALESCE((mix->>'page')::integer, 0) >= 0
    AND COALESCE((mix->>'category')::integer, 0) >= 0
    AND COALESCE((mix->>'product')::integer, 0) >= 0
  )
);

CREATE INDEX IF NOT EXISTS content_plans_client_created_idx
  ON content_plans (client_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS content_plans_project_created_idx
  ON content_plans (project_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS content_plan_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES content_plans(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position > 0),
  content_format text NOT NULL
    CHECK (content_format IN ('hero', 'blog', 'page', 'category', 'product')),
  content_action text CHECK (
    content_action IS NULL
    OR content_action IN ('optimise', 'create', 'watch')
  ),
  primary_keyword_id uuid REFERENCES keywords(id) ON DELETE SET NULL,
  secondary_keyword_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  primary_keyword_text text,
  secondary_keyword_text text[] NOT NULL DEFAULT ARRAY[]::text[],
  recommended_url text,
  page_title_h1 text,
  synopsis text,
  meta_title text,
  meta_description text,
  internal_links jsonb NOT NULL DEFAULT '[]'::jsonb,
  inbound_links jsonb NOT NULL DEFAULT '[]'::jsonb,
  serp_top3 jsonb NOT NULL DEFAULT '[]'::jsonb,
  serp_fetched_at timestamptz,
  potential_revenue_gain numeric CHECK (
    potential_revenue_gain IS NULL OR potential_revenue_gain >= 0
  ),
  audience text,
  journey_stage text,
  business_area text,
  campaign_tie_in text,
  responsibility text,
  first_draft_deadline date,
  publish_month date,
  cluster_score numeric,
  hero_promoted boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'queued'
    CHECK (
      status IN (
        'queued',
        'in_progress',
        'review',
        'approved',
        'live',
        'archived'
      )
    ),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, position)
);

CREATE INDEX IF NOT EXISTS content_plan_items_plan_position_idx
  ON content_plan_items (plan_id, position, id);

CREATE TABLE IF NOT EXISTS content_plan_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid REFERENCES content_plans(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES navigator_projects(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'error')),
  total integer NOT NULL DEFAULT 0 CHECK (total >= 0),
  processed integer NOT NULL DEFAULT 0 CHECK (processed >= 0),
  last_error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS content_plan_jobs_project_created_idx
  ON content_plan_jobs (project_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS serp_top3_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword_text text NOT NULL,
  location_code integer NOT NULL DEFAULT 2826,
  language_code text NOT NULL DEFAULT 'en',
  results jsonb NOT NULL DEFAULT '[]'::jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (keyword_text, location_code, language_code)
);

CREATE INDEX IF NOT EXISTS serp_top3_cache_keyword_idx
  ON serp_top3_cache (keyword_text, fetched_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON content_plans, content_plan_items, content_plan_jobs, serp_top3_cache
  TO seer_api;

INSERT INTO schema_migrations (version)
VALUES ('020_content_planner_contract')
ON CONFLICT (version) DO NOTHING;
