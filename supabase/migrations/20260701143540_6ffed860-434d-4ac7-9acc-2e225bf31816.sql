
-- ── content_plan_jobs: scope view-only readers to their assigned clients ──
DROP POLICY IF EXISTS "View-only can read content_plan_jobs" ON public.content_plan_jobs;
CREATE POLICY "View-only can read content_plan_jobs"
  ON public.content_plan_jobs
  FOR SELECT
  TO authenticated
  USING (
    public.get_user_role(auth.uid()) = 'view_only'
    AND public.is_visible_client(client_id)
  );

-- ── detox_audit: scope view-only readers via project → client access ──
DROP POLICY IF EXISTS "View-only can read detox_audit" ON public.detox_audit;
CREATE POLICY "View-only can read detox_audit"
  ON public.detox_audit
  FOR SELECT
  TO authenticated
  USING (
    public.get_user_role(auth.uid()) = 'view_only'
    AND public.is_visible_project(project_id)
  );

-- ── archive_audit: replace GUC-based insert gate with a hard deny.
-- The archive_client / restore_client / hard_delete_* functions are
-- SECURITY DEFINER owned by postgres (superuser), which bypasses RLS,
-- so legitimate audit inserts continue to work while any direct client
-- INSERT is refused.
DROP POLICY IF EXISTS "RPC-only insert archive_audit" ON public.archive_audit;
CREATE POLICY "Deny direct client inserts to archive_audit"
  ON public.archive_audit
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (false);

-- ── SECURITY DEFINER visibility helpers: remove PUBLIC execute so they
-- are not callable by anonymous sessions. They remain callable by
-- authenticated (needed for RLS policies) and service_role.
REVOKE EXECUTE ON FUNCTION public.is_visible_client(uuid)  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_visible_project(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_visible_keyword(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_visible_client(uuid)  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_visible_project(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_visible_keyword(uuid) TO authenticated, service_role;
