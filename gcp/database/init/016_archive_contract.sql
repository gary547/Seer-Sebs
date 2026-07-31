CREATE TABLE IF NOT EXISTS archive_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL CHECK (entity_type IN ('client', 'project')),
  entity_id uuid NOT NULL,
  client_id uuid,
  action text NOT NULL CHECK (action IN ('archive', 'restore', 'hard_delete')),
  actor_id uuid NOT NULL,
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS archive_audit_entity_created_idx
  ON archive_audit (entity_type, entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS archive_audit_client_created_idx
  ON archive_audit (client_id, created_at DESC);

ALTER TABLE navigator_projects
  DROP CONSTRAINT IF EXISTS navigator_projects_duplicated_from_fkey,
  ADD CONSTRAINT navigator_projects_duplicated_from_fkey
    FOREIGN KEY (duplicated_from)
    REFERENCES navigator_projects(id)
    ON DELETE SET NULL;

GRANT SELECT, INSERT ON archive_audit TO seer_api;

INSERT INTO schema_migrations (version)
VALUES ('016_archive_contract')
ON CONFLICT (version) DO NOTHING;
