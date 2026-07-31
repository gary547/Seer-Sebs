
-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Tighten is_visible_client / is_visible_project so plain 'user' role only
--    sees clients/projects they are explicitly mapped to via user_client_access.
--    Admins and super_admins retain global visibility.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_visible_client(_client_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT
    public.has_role(auth.uid(),'admin'::public.app_role)
    OR public.has_role(auth.uid(),'super_admin'::public.app_role)
    OR EXISTS (
      SELECT 1
      FROM public.clients c
      JOIN public.user_client_access uca
        ON uca.client_id = c.id
      WHERE c.id = _client_id
        AND c.archived_at IS NULL
        AND uca.user_id = auth.uid()
    );
$$;

CREATE OR REPLACE FUNCTION public.is_visible_project(_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT
    public.has_role(auth.uid(),'admin'::public.app_role)
    OR public.has_role(auth.uid(),'super_admin'::public.app_role)
    OR EXISTS (
      SELECT 1
      FROM public.navigator_projects np
      JOIN public.clients c ON c.id = np.client_id
      JOIN public.user_client_access uca ON uca.client_id = c.id
      WHERE np.id = _project_id
        AND np.archived_at IS NULL
        AND c.archived_at IS NULL
        AND uca.user_id = auth.uid()
    );
$$;

-- Keep grants: policies + client rpc still need these executable by authenticated.
GRANT EXECUTE ON FUNCTION public.is_visible_client(uuid)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_visible_project(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_visible_keyword(uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Add explicit view_only SELECT policies for content_plan_jobs & detox_audit
--    so they match the pattern used by sibling tables.
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "View-only can read content_plan_jobs" ON public.content_plan_jobs;
CREATE POLICY "View-only can read content_plan_jobs"
  ON public.content_plan_jobs
  FOR SELECT
  TO authenticated
  USING (public.get_user_role(auth.uid()) = 'view_only');

DROP POLICY IF EXISTS "View-only can read detox_audit" ON public.detox_audit;
CREATE POLICY "View-only can read detox_audit"
  ON public.detox_audit
  FOR SELECT
  TO authenticated
  USING (public.get_user_role(auth.uid()) = 'view_only');

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) Revoke EXECUTE on SECURITY DEFINER functions that should not be callable
--    directly by anon/authenticated clients. RLS-helper and client-RPC
--    functions retain their grants.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  fn text;
  -- Functions safe to keep callable by authenticated (client RPCs + RLS helpers):
  --   has_role, get_user_role, is_visible_client, is_visible_project,
  --   is_visible_keyword, archive_client, restore_client, archive_project,
  --   restore_project
  fns text[] := ARRAY[
    'public._require_admin()',
    'public.hard_delete_client(uuid)',
    'public.hard_delete_project(uuid)',
    'public.guard_user_roles_insert()',
    'public.rls_auto_enable()',
    'public.handle_new_user()',
    'public.update_updated_at_column()',
    'public.url_snapshot_detect_issues()',
    'public.claim_har_serp_post_batch(uuid,integer)',
    'public.claim_har_serp_fetch_batch(uuid,integer)',
    'public.claim_har_serp_fetch_by_dfs_ids(uuid,text[],integer)',
    'public.claim_har_ahrefs_batch(uuid,integer)',
    'public.claim_har_backlinks_batch(uuid,integer)',
    'public.claim_categorisation_batch(uuid,text,integer)',
    'public.release_stale_har_claims()',
    'public.release_stale_categorisation_claims()',
    'public.bulk_update_har_serp_tasks(jsonb)'
  ];
BEGIN
  FOREACH fn IN ARRAY fns LOOP
    BEGIN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXCEPTION WHEN undefined_function THEN
      RAISE NOTICE 'Skipping missing function: %', fn;
    END;
  END LOOP;
END$$;

-- Service role retains full access for edge functions / cron.
GRANT EXECUTE ON FUNCTION public._require_admin() TO service_role;
GRANT EXECUTE ON FUNCTION public.hard_delete_client(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.hard_delete_project(uuid) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) Rewire the har-calculation pg_cron watchdog to send a shared secret
--    header instead of relying on the anon apikey, so unauthenticated internet
--    callers can no longer trigger tick even after the edge-function auth gate.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM cron.unschedule('har-worker-tick');
EXCEPTION WHEN OTHERS THEN NULL;
END$$;

SELECT cron.schedule(
  'har-worker-tick',
  '* * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://xvkfuakwhujtjeaybtzu.supabase.co/functions/v1/har-calculation',
    headers := '{"Content-Type":"application/json","apikey":"[REDACTED_LEGACY_SUPABASE_ANON_KEY]","x-cron-secret":"LH-VkbeyeUTV5wTkRS9LLKUiVGQ0-8IEJXD4sCR0rbA"}'::jsonb,
    body := '{"mode":"tick"}'::jsonb
  );
  $cron$
);
