ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS full_name text,
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by uuid,
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  ADD COLUMN IF NOT EXISTS theme_preference text NOT NULL DEFAULT 'dark',
  ADD COLUMN IF NOT EXISTS notify_url_monitor boolean NOT NULL DEFAULT true;

ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_approval_status_check,
  DROP CONSTRAINT IF EXISTS profiles_theme_preference_check;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_approval_status_check
    CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  ADD CONSTRAINT profiles_theme_preference_check
    CHECK (theme_preference IN ('light', 'dark'));

CREATE TABLE IF NOT EXISTS user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
  role text NOT NULL
    CHECK (role IN ('super_admin', 'admin', 'user', 'view_only')),
  UNIQUE (user_id, role)
);

CREATE INDEX IF NOT EXISTS user_roles_user_id_idx
  ON user_roles (user_id);

UPDATE profiles
SET
  approval_status = 'approved',
  approved_at = COALESCE(approved_at, now())
WHERE identity_provider = 'local'
  AND approval_status = 'pending';

INSERT INTO user_roles (user_id, role)
SELECT profile.user_id, 'user'
FROM profiles AS profile
WHERE profile.identity_provider = 'local'
  AND NOT EXISTS (
    SELECT 1
    FROM user_roles AS existing_role
    WHERE existing_role.user_id = profile.user_id
  )
ON CONFLICT (user_id, role) DO NOTHING;

GRANT SELECT, INSERT, UPDATE
  ON profiles, user_roles
  TO seer_api;
GRANT DELETE ON user_roles TO seer_api;

INSERT INTO schema_migrations (version)
VALUES ('010_identity_access_contract')
ON CONFLICT (version) DO NOTHING;
