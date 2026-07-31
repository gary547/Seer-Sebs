CREATE INDEX IF NOT EXISTS pipeline_runs_succeeded_project_completed_idx
  ON pipeline_runs (
    (input->>'projectId'),
    completed_at DESC,
    id DESC
  )
  WHERE
    input ? 'projectId'
    AND status = 'succeeded';

INSERT INTO schema_migrations (version)
VALUES ('026_portfolio_query_indexes')
ON CONFLICT (version) DO NOTHING;
