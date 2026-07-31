CREATE SCHEMA IF NOT EXISTS migration;

REVOKE ALL ON SCHEMA migration FROM PUBLIC;

CREATE TABLE IF NOT EXISTS migration.source_rows (
  plan_entry_id text NOT NULL,
  source_table text NOT NULL,
  source_key text NOT NULL,
  source_row jsonb NOT NULL,
  row_sha256 char(64) NOT NULL CHECK (row_sha256 ~ '^[0-9a-f]{64}$'),
  archived_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_entry_id, source_key)
);

CREATE INDEX IF NOT EXISTS source_rows_source_table_idx
  ON migration.source_rows (source_table);

CREATE INDEX IF NOT EXISTS source_rows_sha256_idx
  ON migration.source_rows (row_sha256);

INSERT INTO public.schema_migrations (version)
VALUES ('023_source_migration_archive')
ON CONFLICT (version) DO NOTHING;
