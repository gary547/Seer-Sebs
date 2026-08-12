CREATE TABLE IF NOT EXISTS legacy_keyword_forecasts (
  project_id uuid NOT NULL REFERENCES navigator_projects(id) ON DELETE CASCADE,
  keyword_id uuid PRIMARY KEY REFERENCES keywords(id) ON DELETE CASCADE,
  har numeric,
  har_is_manual boolean NOT NULL DEFAULT false,
  har_source text,
  current_revenue_annual numeric,
  target_incremental_revenue_annual numeric,
  archived_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS legacy_keyword_forecasts_project_keyword_idx
  ON legacy_keyword_forecasts (project_id, keyword_id);

CREATE INDEX IF NOT EXISTS pipeline_runs_project_created_idx
  ON pipeline_runs (
    (input->>'projectId'),
    created_at DESC,
    id DESC
  )
  WHERE input ? 'projectId';

INSERT INTO legacy_keyword_forecasts (
  project_id,
  keyword_id,
  har,
  har_is_manual,
  har_source,
  current_revenue_annual,
  target_incremental_revenue_annual,
  archived_at
)
SELECT
  keyword.project_id,
  keyword.id,
  CASE
    WHEN archived.source_row->>'har' ~ '^-?[0-9]+([.][0-9]+)?$'
      THEN (archived.source_row->>'har')::numeric
    ELSE NULL
  END,
  CASE
    WHEN lower(archived.source_row->>'har_is_manual') IN ('true', 't', '1')
      THEN true
    ELSE false
  END,
  NULLIF(archived.source_row->>'har_source', ''),
  CASE
    WHEN archived.source_row->>'est_current_revenue_annual'
      ~ '^-?[0-9]+([.][0-9]+)?$'
      THEN (archived.source_row->>'est_current_revenue_annual')::numeric
    ELSE NULL
  END,
  CASE
    WHEN archived.source_row->>'har_revenue_gain_annual'
      ~ '^-?[0-9]+([.][0-9]+)?$'
      THEN (archived.source_row->>'har_revenue_gain_annual')::numeric
    ELSE NULL
  END,
  archived.archived_at
FROM migration.source_rows AS archived
JOIN keywords AS keyword
  ON keyword.id::text = archived.source_row->>'keyword_id'
WHERE archived.source_table = 'public.keyword_forecasts'
ON CONFLICT (keyword_id) DO UPDATE
SET
  project_id = EXCLUDED.project_id,
  har = EXCLUDED.har,
  har_is_manual = EXCLUDED.har_is_manual,
  har_source = EXCLUDED.har_source,
  current_revenue_annual = EXCLUDED.current_revenue_annual,
  target_incremental_revenue_annual =
    EXCLUDED.target_incremental_revenue_annual,
  archived_at = EXCLUDED.archived_at;

GRANT SELECT ON legacy_keyword_forecasts TO seer_api;

INSERT INTO schema_migrations (version)
VALUES ('027_calculation_control_contract')
ON CONFLICT (version) DO NOTHING;
