ALTER TABLE navigator_projects
  DROP CONSTRAINT IF EXISTS navigator_projects_duplicated_from_fkey,
  ADD CONSTRAINT navigator_projects_duplicated_from_fkey
    FOREIGN KEY (duplicated_from)
    REFERENCES navigator_projects(id)
    ON DELETE SET NULL
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE archive_audit
  ALTER COLUMN actor_id DROP NOT NULL;

INSERT INTO schema_migrations (version)
VALUES ('025_migration_load_contract')
ON CONFLICT (version) DO NOTHING;
