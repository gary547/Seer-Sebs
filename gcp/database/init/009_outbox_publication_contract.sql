ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text;

CREATE INDEX IF NOT EXISTS outbox_events_retry_idx
  ON outbox_events (state, next_attempt_at, id)
  WHERE state IN ('pending', 'processing');

INSERT INTO schema_migrations (version)
VALUES ('009_outbox_publication_contract')
ON CONFLICT (version) DO NOTHING;
