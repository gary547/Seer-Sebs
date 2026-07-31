DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'navigator_projects'
      AND column_name = 'name'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'navigator_projects'
      AND column_name = 'project_name'
  ) THEN
    ALTER TABLE navigator_projects RENAME COLUMN name TO project_name;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'navigator_projects'
      AND column_name = 'average_order_value'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'navigator_projects'
      AND column_name = 'aov'
  ) THEN
    ALTER TABLE navigator_projects RENAME COLUMN average_order_value TO aov;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'keyword_rules'
      AND column_name = 'project_id'
  ) AND to_regclass('public.project_keyword_rules') IS NULL THEN
    ALTER TABLE keyword_rules RENAME TO project_keyword_rules;
  END IF;
END
$$;

ALTER TABLE clients
  DROP CONSTRAINT IF EXISTS clients_domain_key,
  ALTER COLUMN created_by DROP NOT NULL,
  ALTER COLUMN industry DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS analytics_connected boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS archive_reason text,
  ADD COLUMN IF NOT EXISTS archived_by uuid,
  ADD COLUMN IF NOT EXISTS brand_type text,
  ADD COLUMN IF NOT EXISTS campaign_type text,
  ADD COLUMN IF NOT EXISTS domain_normalized text,
  ADD COLUMN IF NOT EXISTS gsc_connected boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS logo_url text,
  ADD COLUMN IF NOT EXISTS team_members jsonb;

UPDATE clients
SET domain_normalized = lower(
  regexp_replace(
    regexp_replace(
      regexp_replace(btrim(domain), '^https?://', '', 'i'),
      '^www\.',
      '',
      'i'
    ),
    '[/?#].*$',
    ''
  )
)
WHERE domain_normalized IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS clients_domain_normalized_active_idx
  ON clients (domain_normalized)
  WHERE archived_at IS NULL AND domain_normalized IS NOT NULL;

CREATE TABLE IF NOT EXISTS competitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  competitor_name text NOT NULL,
  competitor_domain text NOT NULL,
  added_by uuid,
  verified boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS competitors_client_id_idx
  ON competitors (client_id, competitor_name, id);

CREATE TABLE IF NOT EXISTS keyword_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  keyword_categorisation text NOT NULL,
  rule_type text NOT NULL
    CHECK (rule_type IN ('whitelist', 'blacklist', 'competitor_brand', 'own_brand')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS keyword_rules_client_type_idx
  ON keyword_rules (client_id, rule_type, id);

ALTER TABLE user_client_access
  ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE user_client_access
  ALTER COLUMN access_role SET DEFAULT 'viewer';

CREATE UNIQUE INDEX IF NOT EXISTS user_client_access_id_idx
  ON user_client_access (id);

ALTER TABLE navigator_projects
  DROP CONSTRAINT IF EXISTS navigator_projects_conversion_rate_check,
  ALTER COLUMN country DROP NOT NULL,
  ALTER COLUMN language DROP NOT NULL,
  ALTER COLUMN currency DROP NOT NULL,
  ALTER COLUMN category_focus DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS archive_reason text,
  ADD COLUMN IF NOT EXISTS archived_by uuid,
  ADD COLUMN IF NOT EXISTS calculations_v2_compute_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS calculations_v2_visible_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ctr numeric(12, 8),
  ADD COLUMN IF NOT EXISTS duplicated_from uuid REFERENCES navigator_projects(id),
  ADD COLUMN IF NOT EXISTS har_status text NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS inputs_dirty boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS keywords_dirty boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_dirty_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS ranking_lookup_status text NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS seasonality_end date,
  ADD COLUMN IF NOT EXISTS seasonality_start date,
  ADD COLUMN IF NOT EXISTS serp_dirty boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft';

ALTER TABLE navigator_projects
  ADD CONSTRAINT navigator_projects_conversion_rate_check
    CHECK (conversion_rate BETWEEN 0 AND 100);

CREATE INDEX IF NOT EXISTS navigator_projects_client_updated_idx
  ON navigator_projects (client_id, updated_at DESC, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON clients, competitors, keyword_rules, navigator_projects,
    project_keyword_rules, user_client_access
  TO seer_api;

GRANT UPDATE ON navigator_projects TO seer_worker;

INSERT INTO schema_migrations (version)
VALUES ('011_client_project_parity')
ON CONFLICT (version) DO NOTHING;
