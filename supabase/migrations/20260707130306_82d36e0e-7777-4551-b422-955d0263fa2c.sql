
-- ─────────────────────────────────────────────────────────────────────
-- HAR queue tables: drop unscoped "Internal full access" policies and
-- replace them with project-scoped equivalents.
-- ─────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Internal full access har_serp_tasks"       ON public.har_serp_tasks;
DROP POLICY IF EXISTS "Internal full access har_ahrefs_queue"     ON public.har_ahrefs_queue;
DROP POLICY IF EXISTS "Internal full access har_backlinks_queue"  ON public.har_backlinks_queue;

CREATE POLICY "Internal scoped access har_serp_tasks"
ON public.har_serp_tasks FOR ALL TO authenticated
USING (
  public.get_user_role(auth.uid()) IN ('super_admin','admin','user')
  AND public.is_visible_project(project_id)
)
WITH CHECK (
  public.get_user_role(auth.uid()) IN ('super_admin','admin','user')
  AND public.is_visible_project(project_id)
);

CREATE POLICY "Internal scoped access har_ahrefs_queue"
ON public.har_ahrefs_queue FOR ALL TO authenticated
USING (
  public.get_user_role(auth.uid()) IN ('super_admin','admin','user')
  AND public.is_visible_project(project_id)
)
WITH CHECK (
  public.get_user_role(auth.uid()) IN ('super_admin','admin','user')
  AND public.is_visible_project(project_id)
);

CREATE POLICY "Internal scoped access har_backlinks_queue"
ON public.har_backlinks_queue FOR ALL TO authenticated
USING (
  public.get_user_role(auth.uid()) IN ('super_admin','admin','user')
  AND public.is_visible_project(project_id)
)
WITH CHECK (
  public.get_user_role(auth.uid()) IN ('super_admin','admin','user')
  AND public.is_visible_project(project_id)
);

-- ─────────────────────────────────────────────────────────────────────
-- Monitoring tables: drop unscoped policies and replace with
-- client-scoped equivalents.
-- ─────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Internal full access to monitor_campaigns"      ON public.monitor_campaigns;
DROP POLICY IF EXISTS "Internal full access to monitored_urls"         ON public.monitored_urls;
DROP POLICY IF EXISTS "Internal full access to url_check_snapshots"    ON public.url_check_snapshots;
DROP POLICY IF EXISTS "Internal full access to url_issues"             ON public.url_issues;
DROP POLICY IF EXISTS "Internal full access to monitor_alert_settings" ON public.monitor_alert_settings;

CREATE POLICY "Internal scoped access monitor_campaigns"
ON public.monitor_campaigns FOR ALL TO authenticated
USING (
  public.get_user_role(auth.uid()) IN ('super_admin','admin','user')
  AND public.is_visible_client(client_id)
)
WITH CHECK (
  public.get_user_role(auth.uid()) IN ('super_admin','admin','user')
  AND public.is_visible_client(client_id)
);

CREATE POLICY "Internal scoped access monitored_urls"
ON public.monitored_urls FOR ALL TO authenticated
USING (
  public.get_user_role(auth.uid()) IN ('super_admin','admin','user')
  AND public.is_visible_client(
    (SELECT client_id FROM public.monitor_campaigns WHERE id = campaign_id)
  )
)
WITH CHECK (
  public.get_user_role(auth.uid()) IN ('super_admin','admin','user')
  AND public.is_visible_client(
    (SELECT client_id FROM public.monitor_campaigns WHERE id = campaign_id)
  )
);

CREATE POLICY "Internal scoped access url_check_snapshots"
ON public.url_check_snapshots FOR ALL TO authenticated
USING (
  public.get_user_role(auth.uid()) IN ('super_admin','admin','user')
  AND public.is_visible_client(
    (SELECT mc.client_id
       FROM public.monitored_urls mu
       JOIN public.monitor_campaigns mc ON mc.id = mu.campaign_id
      WHERE mu.id = monitored_url_id)
  )
)
WITH CHECK (
  public.get_user_role(auth.uid()) IN ('super_admin','admin','user')
  AND public.is_visible_client(
    (SELECT mc.client_id
       FROM public.monitored_urls mu
       JOIN public.monitor_campaigns mc ON mc.id = mu.campaign_id
      WHERE mu.id = monitored_url_id)
  )
);

CREATE POLICY "Internal scoped access url_issues"
ON public.url_issues FOR ALL TO authenticated
USING (
  public.get_user_role(auth.uid()) IN ('super_admin','admin','user')
  AND public.is_visible_client(
    (SELECT mc.client_id
       FROM public.monitored_urls mu
       JOIN public.monitor_campaigns mc ON mc.id = mu.campaign_id
      WHERE mu.id = monitored_url_id)
  )
)
WITH CHECK (
  public.get_user_role(auth.uid()) IN ('super_admin','admin','user')
  AND public.is_visible_client(
    (SELECT mc.client_id
       FROM public.monitored_urls mu
       JOIN public.monitor_campaigns mc ON mc.id = mu.campaign_id
      WHERE mu.id = monitored_url_id)
  )
);

CREATE POLICY "Internal scoped access monitor_alert_settings"
ON public.monitor_alert_settings FOR ALL TO authenticated
USING (
  public.get_user_role(auth.uid()) IN ('super_admin','admin','user')
  AND public.is_visible_client(
    (SELECT client_id FROM public.monitor_campaigns WHERE id = campaign_id)
  )
)
WITH CHECK (
  public.get_user_role(auth.uid()) IN ('super_admin','admin','user')
  AND public.is_visible_client(
    (SELECT client_id FROM public.monitor_campaigns WHERE id = campaign_id)
  )
);

-- ─────────────────────────────────────────────────────────────────────
-- SECURITY DEFINER helpers: revoke authenticated EXECUTE on functions
-- that are only meant to be called by service-role edge functions or
-- as triggers. Keep RLS-required helpers (has_role, get_user_role,
-- is_visible_*) and admin RPCs (archive_*, restore_*, hard_delete_*,
-- _require_admin) callable — those either self-guard via _require_admin
-- or are required by RLS at runtime.
-- ─────────────────────────────────────────────────────────────────────

REVOKE EXECUTE ON FUNCTION public.claim_har_serp_post_batch(uuid, integer)              FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.claim_har_serp_fetch_batch(uuid, integer)             FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.claim_har_serp_fetch_by_dfs_ids(uuid, text[], integer) FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.claim_har_ahrefs_batch(uuid, integer)                 FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.claim_har_backlinks_batch(uuid, integer)              FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.claim_categorisation_batch(uuid, text, integer)       FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.release_stale_categorisation_claims()                 FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.release_stale_har_claims()                            FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.bulk_update_har_serp_tasks(jsonb)                     FROM PUBLIC, authenticated, anon;

GRANT EXECUTE ON FUNCTION public.claim_har_serp_post_batch(uuid, integer)               TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_har_serp_fetch_batch(uuid, integer)              TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_har_serp_fetch_by_dfs_ids(uuid, text[], integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_har_ahrefs_batch(uuid, integer)                  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_har_backlinks_batch(uuid, integer)               TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_categorisation_batch(uuid, text, integer)        TO service_role;
GRANT EXECUTE ON FUNCTION public.release_stale_categorisation_claims()                  TO service_role;
GRANT EXECUTE ON FUNCTION public.release_stale_har_claims()                             TO service_role;
GRANT EXECUTE ON FUNCTION public.bulk_update_har_serp_tasks(jsonb)                      TO service_role;
