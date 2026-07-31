ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_user_id_fkey;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS identity_provider text NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS identity_email_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_authenticated_at timestamptz;

CREATE INDEX IF NOT EXISTS profiles_identity_provider_idx
  ON profiles (identity_provider, user_id);

GRANT SELECT, INSERT, UPDATE
  ON profiles
  TO seer_api;

INSERT INTO schema_migrations (version)
VALUES ('007_managed_runtime_contract')
ON CONFLICT (version) DO NOTHING;
