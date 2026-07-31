-- =========================================================
-- P2: Revoke SELECT from anon on every public-schema table
-- (RLS already blocks rows, this removes the historic grant)
-- =========================================================
DO $$
DECLARE
  tbl record;
BEGIN
  FOR tbl IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
  LOOP
    EXECUTE format('REVOKE SELECT, INSERT, UPDATE, DELETE ON public.%I FROM anon', tbl.relname);
  END LOOP;
END $$;

-- =========================================================
-- P1: Lock down SECURITY DEFINER helpers
-- Internal helpers -> service_role only.
-- has_role / get_user_role stay callable by authenticated.
-- =========================================================

-- Internal: revoke from PUBLIC/anon/authenticated, grant to service_role only
DO $$
DECLARE
  fn text;
  fns text[] := ARRAY[
    'guard_user_roles_insert()',
    'claim_categorisation_batch(uuid, text, integer)',
    'release_stale_categorisation_claims()',
    'claim_har_serp_post_batch(uuid, integer)',
    'url_snapshot_detect_issues()',
    'claim_har_serp_fetch_batch(uuid, integer)',
    'claim_har_ahrefs_batch(uuid, integer)',
    'claim_har_backlinks_batch(uuid, integer)',
    'release_stale_har_claims()',
    'claim_har_serp_fetch_by_dfs_ids(uuid, text[], integer)',
    'bulk_update_har_serp_tasks(jsonb)',
    'handle_new_user()',
    'update_updated_at_column()'
  ];
BEGIN
  FOREACH fn IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', fn);
  END LOOP;
END $$;

-- Caller-facing helpers: signed-in users + service_role only
REVOKE ALL ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_user_role(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_user_role(uuid) TO authenticated, service_role;