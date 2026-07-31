
-- =========================================================================
-- 1. Make slide-exports bucket private + replace public read policy
-- =========================================================================
UPDATE storage.buckets SET public = false WHERE id = 'slide-exports';

DROP POLICY IF EXISTS "Public read slide-exports" ON storage.objects;

CREATE POLICY "Internal users read slide-exports"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'slide-exports'
  AND get_user_role(auth.uid()) = ANY (ARRAY['super_admin','admin','user'])
);

-- =========================================================================
-- 2. Harden user_roles against privilege escalation
--    - Hard-cap handle_new_user defaults to 'user' / 'view_only'
--    - Add a BEFORE INSERT trigger as defense-in-depth
-- =========================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  default_role public.app_role;
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'full_name', ''));

  IF NEW.email LIKE '%@nobraineragency.com' THEN
    default_role := 'user';
  ELSE
    default_role := 'view_only';
  END IF;

  -- Defensive: only ever assign safe defaults here, never admin/super_admin
  IF default_role NOT IN ('user','view_only') THEN
    default_role := 'view_only';
  END IF;

  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, default_role);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_user_roles_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  caller uuid := auth.uid();
BEGIN
  -- Allow the SECURITY DEFINER signup trigger (no auth.uid()) only for
  -- safe default roles. All other paths must come from a super_admin.
  IF caller IS NULL THEN
    IF NEW.role IN ('user','view_only') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Cannot assign elevated role % via system path', NEW.role;
  END IF;

  IF public.has_role(caller, 'super_admin'::public.app_role) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Only super_admins can insert into user_roles';
END;
$$;

DROP TRIGGER IF EXISTS guard_user_roles_insert ON public.user_roles;
CREATE TRIGGER guard_user_roles_insert
BEFORE INSERT ON public.user_roles
FOR EACH ROW
EXECUTE FUNCTION public.guard_user_roles_insert();

-- =========================================================================
-- 3. Tighten SECURITY DEFINER function exposure
-- =========================================================================
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_user_role(uuid) FROM anon;

-- Trigger-only helpers should not be callable from the API at all
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.url_snapshot_detect_issues() FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.guard_user_roles_insert() FROM anon, authenticated, public;

-- =========================================================================
-- 4. Move public-schema extensions into an `extensions` schema
-- =========================================================================
CREATE SCHEMA IF NOT EXISTS extensions;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
             WHERE e.extname = 'pg_trgm' AND n.nspname = 'public') THEN
    EXECUTE 'ALTER EXTENSION pg_trgm SET SCHEMA extensions';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
             WHERE e.extname = 'unaccent' AND n.nspname = 'public') THEN
    EXECUTE 'ALTER EXTENSION unaccent SET SCHEMA extensions';
  END IF;
END $$;
