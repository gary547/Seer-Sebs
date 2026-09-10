BEGIN;

ALTER TABLE gsc_uploads
  ADD COLUMN IF NOT EXISTS source_files jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(source_files) = 'array');

INSERT INTO schema_migrations (version)
VALUES ('033_gsc_batch_provenance')
ON CONFLICT (version) DO NOTHING;

COMMIT;
