ALTER TABLE keywords
  ADD COLUMN IF NOT EXISTS human_reviewed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS competition text,
  ADD COLUMN IF NOT EXISTS intent_confidence text,
  ADD COLUMN IF NOT EXISTS intent_source text,
  ADD COLUMN IF NOT EXISTS categorisation_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS categorisation_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS categorisation_last_error text,
  ADD COLUMN IF NOT EXISTS categorisation_locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS device text NOT NULL DEFAULT 'mobile';

ALTER TABLE keywords
  DROP CONSTRAINT IF EXISTS keywords_categorisation_status_check,
  DROP CONSTRAINT IF EXISTS keywords_categorisation_attempts_check,
  DROP CONSTRAINT IF EXISTS keywords_device_check;

ALTER TABLE keywords
  ADD CONSTRAINT keywords_categorisation_status_check
    CHECK (
      categorisation_status IN (
        'pending',
        'processing',
        'done',
        'error',
        'skipped'
      )
    ),
  ADD CONSTRAINT keywords_categorisation_attempts_check
    CHECK (categorisation_attempts >= 0),
  ADD CONSTRAINT keywords_device_check
    CHECK (device IN ('desktop', 'mobile', 'tablet'));

CREATE INDEX IF NOT EXISTS keywords_project_management_idx
  ON keywords (
    project_id,
    detox_status,
    categorisation_status,
    normalised_keyword,
    id
  );

CREATE TABLE IF NOT EXISTS keyword_monthly_volumes (
  id uuid PRIMARY KEY,
  keyword_id uuid NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  month date NOT NULL,
  volume integer NOT NULL CHECK (volume >= 0),
  source text NOT NULL DEFAULT 'dataforseo_search_volume',
  fetched_at timestamptz NOT NULL DEFAULT now(),
  CHECK (month = date_trunc('month', month)::date),
  UNIQUE (keyword_id, month, source)
);

CREATE INDEX IF NOT EXISTS keyword_monthly_volumes_keyword_month_idx
  ON keyword_monthly_volumes (keyword_id, month);

CREATE UNIQUE INDEX IF NOT EXISTS pipeline_runs_active_project_idx
  ON pipeline_runs ((input->>'projectId'))
  WHERE
    input ? 'projectId'
    AND status IN ('pending', 'running');

GRANT SELECT, INSERT, UPDATE, DELETE
  ON keyword_monthly_volumes
  TO seer_api;

GRANT SELECT, INSERT, UPDATE
  ON keyword_monthly_volumes
  TO seer_worker;

INSERT INTO schema_migrations (version)
VALUES ('013_keyword_management_contract')
ON CONFLICT (version) DO NOTHING;
