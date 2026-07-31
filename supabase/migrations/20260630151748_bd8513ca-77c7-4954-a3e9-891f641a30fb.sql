-- =========================================================================
-- Phase A: Archive foundation (schema + RLS + audit + RPCs)
-- =========================================================================

-- 1. Archive columns + partial indexes ------------------------------------
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS archived_at    timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by    uuid,
  ADD COLUMN IF NOT EXISTS archive_reason text;

ALTER TABLE public.navigator_projects
  ADD COLUMN IF NOT EXISTS archived_at    timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by    uuid,
  ADD COLUMN IF NOT EXISTS archive_reason text;

CREATE INDEX IF NOT EXISTS clients_archived_at_idx
  ON public.clients (archived_at) WHERE archived_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS navigator_projects_archived_at_idx
  ON public.navigator_projects (archived_at) WHERE archived_at IS NOT NULL;

-- 2. archive_audit table --------------------------------------------------
CREATE TABLE IF NOT EXISTS public.archive_audit (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type   text NOT NULL CHECK (entity_type IN ('client','project')),
  entity_id     uuid NOT NULL,
  client_id     uuid,
  action        text NOT NULL CHECK (action IN ('archive','restore','hard_delete')),
  actor_id      uuid,
  reason        text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.archive_audit TO authenticated;
GRANT ALL            ON public.archive_audit TO service_role;

ALTER TABLE public.archive_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins read archive_audit"  ON public.archive_audit;
DROP POLICY IF EXISTS "RPC-only insert archive_audit" ON public.archive_audit;

CREATE POLICY "Admins read archive_audit"
  ON public.archive_audit FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(),'admin'::public.app_role)
    OR public.has_role(auth.uid(),'super_admin'::public.app_role)
  );

CREATE POLICY "RPC-only insert archive_audit"
  ON public.archive_audit FOR INSERT TO authenticated
  WITH CHECK (current_setting('app.audit_writer', true) = 'rpc');

-- 3. FK backfill (orphan cleanup first, then cascade FKs) -----------------
-- helper macro-style block: each table below is defensive (ADD IF NOT EXISTS pattern).

-- Clean orphans
DELETE FROM public.categorisation_jobs    WHERE project_id NOT IN (SELECT id FROM public.navigator_projects);
DELETE FROM public.detox_jobs             WHERE project_id NOT IN (SELECT id FROM public.navigator_projects);
DELETE FROM public.detox_run_stats        WHERE project_id NOT IN (SELECT id FROM public.navigator_projects);
DELETE FROM public.har_jobs               WHERE project_id NOT IN (SELECT id FROM public.navigator_projects);
DELETE FROM public.content_plans          WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM public.navigator_projects);
DELETE FROM public.content_plans          WHERE client_id  NOT IN (SELECT id FROM public.clients);
DELETE FROM public.content_plan_jobs      WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM public.navigator_projects);
DELETE FROM public.content_plan_jobs      WHERE client_id  IS NOT NULL AND client_id  NOT IN (SELECT id FROM public.clients);
DELETE FROM public.content_plan_jobs      WHERE plan_id    IS NOT NULL AND plan_id    NOT IN (SELECT id FROM public.content_plans);
DELETE FROM public.content_plan_items     WHERE plan_id NOT IN (SELECT id FROM public.content_plans);
DELETE FROM public.detox_audit            WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM public.navigator_projects);
DELETE FROM public.detox_audit            WHERE job_id     IS NOT NULL AND job_id     NOT IN (SELECT id FROM public.detox_jobs);
DELETE FROM public.har_ahrefs_queue       WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM public.navigator_projects);
DELETE FROM public.har_ahrefs_queue       WHERE job_id     IS NOT NULL AND job_id     NOT IN (SELECT id FROM public.har_jobs);
DELETE FROM public.har_backlinks_queue    WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM public.navigator_projects);
DELETE FROM public.har_backlinks_queue    WHERE job_id     IS NOT NULL AND job_id     NOT IN (SELECT id FROM public.har_jobs);
DELETE FROM public.har_serp_tasks         WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM public.navigator_projects);
DELETE FROM public.har_serp_tasks         WHERE job_id     IS NOT NULL AND job_id     NOT IN (SELECT id FROM public.har_jobs);
DELETE FROM public.har_serp_tasks         WHERE keyword_id IS NOT NULL AND keyword_id NOT IN (SELECT id FROM public.keywords);
DELETE FROM public.keyword_tag_history    WHERE client_id  IS NOT NULL AND client_id  NOT IN (SELECT id FROM public.clients);
DELETE FROM public.keyword_tag_history    WHERE keyword_id IS NOT NULL AND keyword_id NOT IN (SELECT id FROM public.keywords);
DELETE FROM public.monitored_urls         WHERE campaign_id NOT IN (SELECT id FROM public.monitor_campaigns);
DELETE FROM public.monitor_alert_settings WHERE campaign_id NOT IN (SELECT id FROM public.monitor_campaigns);
DELETE FROM public.url_check_snapshots    WHERE monitored_url_id NOT IN (SELECT id FROM public.monitored_urls);
DELETE FROM public.url_issues             WHERE monitored_url_id NOT IN (SELECT id FROM public.monitored_urls);
DELETE FROM public.gsc_upload_keywords    WHERE upload_id NOT IN (SELECT id FROM public.gsc_uploads);

-- Add FKs with cascade (idempotent guard via DO block)
DO $$
DECLARE
  fk RECORD;
  fks text[][] := ARRAY[
    ['categorisation_jobs','project_id','navigator_projects','id'],
    ['detox_jobs','project_id','navigator_projects','id'],
    ['detox_run_stats','project_id','navigator_projects','id'],
    ['har_jobs','project_id','navigator_projects','id'],
    ['content_plans','project_id','navigator_projects','id'],
    ['content_plans','client_id','clients','id'],
    ['content_plan_jobs','project_id','navigator_projects','id'],
    ['content_plan_jobs','client_id','clients','id'],
    ['content_plan_jobs','plan_id','content_plans','id'],
    ['content_plan_items','plan_id','content_plans','id'],
    ['detox_audit','project_id','navigator_projects','id'],
    ['detox_audit','job_id','detox_jobs','id'],
    ['har_ahrefs_queue','project_id','navigator_projects','id'],
    ['har_ahrefs_queue','job_id','har_jobs','id'],
    ['har_backlinks_queue','project_id','navigator_projects','id'],
    ['har_backlinks_queue','job_id','har_jobs','id'],
    ['har_serp_tasks','project_id','navigator_projects','id'],
    ['har_serp_tasks','job_id','har_jobs','id'],
    ['har_serp_tasks','keyword_id','keywords','id'],
    ['keyword_tag_history','client_id','clients','id'],
    ['keyword_tag_history','keyword_id','keywords','id'],
    ['monitored_urls','campaign_id','monitor_campaigns','id'],
    ['monitor_alert_settings','campaign_id','monitor_campaigns','id'],
    ['url_check_snapshots','monitored_url_id','monitored_urls','id'],
    ['url_issues','monitored_url_id','monitored_urls','id'],
    ['gsc_upload_keywords','upload_id','gsc_uploads','id']
  ];
  i int;
BEGIN
  FOR i IN 1 .. array_length(fks,1) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = fks[i][1]
        AND c.conname = fks[i][1] || '_' || fks[i][2] || '_fkey'
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.%I(%I) ON DELETE CASCADE',
        fks[i][1], fks[i][1] || '_' || fks[i][2] || '_fkey', fks[i][2], fks[i][3], fks[i][4]
      );
    END IF;
  END LOOP;
END$$;

-- 4. Visibility helpers ---------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_visible_client(_client_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.has_role(auth.uid(),'admin'::public.app_role)
    OR public.has_role(auth.uid(),'super_admin'::public.app_role)
    OR EXISTS (
      SELECT 1 FROM public.clients c
      WHERE c.id = _client_id AND c.archived_at IS NULL
    );
$$;

CREATE OR REPLACE FUNCTION public.is_visible_project(_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.has_role(auth.uid(),'admin'::public.app_role)
    OR public.has_role(auth.uid(),'super_admin'::public.app_role)
    OR EXISTS (
      SELECT 1
      FROM public.navigator_projects np
      JOIN public.clients c ON c.id = np.client_id
      WHERE np.id = _project_id
        AND np.archived_at IS NULL
        AND c.archived_at IS NULL
    );
$$;

CREATE OR REPLACE FUNCTION public.is_visible_keyword(_keyword_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_visible_project((SELECT project_id FROM public.keywords WHERE id = _keyword_id));
$$;

GRANT EXECUTE ON FUNCTION public.is_visible_client(uuid)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_visible_project(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_visible_keyword(uuid) TO authenticated;

-- 5. RLS rewrites ---------------------------------------------------------
-- Parent: clients
DROP POLICY IF EXISTS "Internal users full access to clients" ON public.clients;
DROP POLICY IF EXISTS "View-only users see assigned clients" ON public.clients;

CREATE POLICY "Internal users full access to clients"
  ON public.clients FOR ALL TO authenticated
  USING (
    public.get_user_role(auth.uid()) IN ('super_admin','admin')
    OR (public.get_user_role(auth.uid()) = 'user' AND archived_at IS NULL)
  )
  WITH CHECK (
    public.get_user_role(auth.uid()) IN ('super_admin','admin')
    OR (public.get_user_role(auth.uid()) = 'user' AND archived_at IS NULL)
  );

CREATE POLICY "View-only users see assigned clients"
  ON public.clients FOR SELECT TO authenticated
  USING (
    public.get_user_role(auth.uid()) = 'view_only'
    AND archived_at IS NULL
    AND id IN (SELECT client_id FROM public.user_client_access WHERE user_id = auth.uid())
  );

-- Parent: navigator_projects
DROP POLICY IF EXISTS "Internal users full access to projects" ON public.navigator_projects;
DROP POLICY IF EXISTS "View-only users see assigned projects" ON public.navigator_projects;

CREATE POLICY "Internal users full access to projects"
  ON public.navigator_projects FOR ALL TO authenticated
  USING (
    public.get_user_role(auth.uid()) IN ('super_admin','admin')
    OR (
      public.get_user_role(auth.uid()) = 'user'
      AND archived_at IS NULL
      AND public.is_visible_client(client_id)
    )
  )
  WITH CHECK (
    public.get_user_role(auth.uid()) IN ('super_admin','admin')
    OR (
      public.get_user_role(auth.uid()) = 'user'
      AND archived_at IS NULL
      AND public.is_visible_client(client_id)
    )
  );

CREATE POLICY "View-only users see assigned projects"
  ON public.navigator_projects FOR SELECT TO authenticated
  USING (
    public.get_user_role(auth.uid()) = 'view_only'
    AND archived_at IS NULL
    AND public.is_visible_client(client_id)
    AND client_id IN (SELECT client_id FROM public.user_client_access WHERE user_id = auth.uid())
  );

-- Child tables: rewrite "Internal users full access to <X>" with archive gate
-- The gate predicate per table is provided inline. View-only policies remain unchanged
-- (they already JOIN through parent rows and we explicitly do NOT widen their access).

DO $$
DECLARE
  rec RECORD;
  pol_name text;
  gate text;
  mapping jsonb := jsonb_build_array(
    -- project_id direct
    jsonb_build_object('t','keywords',                'g','public.is_visible_project(project_id)'),
    jsonb_build_object('t','ctr_curves',              'g','public.is_visible_project(project_id)'),
    jsonb_build_object('t','ctr_estimate_cache',      'g','public.is_visible_project(project_id)'),
    jsonb_build_object('t','keyword_challenges',      'g','public.is_visible_project(project_id)'),
    jsonb_build_object('t','serp_results',            'g','public.is_visible_project(project_id)'),
    jsonb_build_object('t','har_results',             'g','public.is_visible_project(project_id)'),
    jsonb_build_object('t','har_jobs',                'g','public.is_visible_project(project_id)'),
    jsonb_build_object('t','har_serp_tasks',          'g','public.is_visible_project(project_id)'),
    jsonb_build_object('t','har_ahrefs_queue',        'g','public.is_visible_project(project_id)'),
    jsonb_build_object('t','har_backlinks_queue',     'g','public.is_visible_project(project_id)'),
    jsonb_build_object('t','gsc_uploads',             'g','public.is_visible_project(project_id)'),
    jsonb_build_object('t','client_domain_metrics',   'g','public.is_visible_project(project_id)'),
    jsonb_build_object('t','project_roadmaps',        'g','public.is_visible_project(project_id)'),
    jsonb_build_object('t','detox_jobs',              'g','public.is_visible_project(project_id)'),
    jsonb_build_object('t','detox_audit',             'g','public.is_visible_project(project_id)'),
    jsonb_build_object('t','detox_run_stats',         'g','public.is_visible_project(project_id)'),
    jsonb_build_object('t','categorisation_jobs',     'g','public.is_visible_project(project_id)'),
    jsonb_build_object('t','content_plans',           'g','public.is_visible_client(client_id)'),
    jsonb_build_object('t','content_plan_jobs',       'g','public.is_visible_client(client_id)'),
    -- client_id direct
    jsonb_build_object('t','competitors',             'g','public.is_visible_client(client_id)'),
    jsonb_build_object('t','keyword_rules',           'g','public.is_visible_client(client_id)'),
    jsonb_build_object('t','monitor_campaigns',       'g','public.is_visible_client(client_id)'),
    jsonb_build_object('t','user_client_access',      'g','public.is_visible_client(client_id)'),
    -- keyword_id only
    jsonb_build_object('t','keyword_forecasts',       'g','public.is_visible_keyword(keyword_id)'),
    jsonb_build_object('t','keyword_monthly_volumes', 'g','public.is_visible_keyword(keyword_id)'),
    jsonb_build_object('t','serp_rankings',           'g','public.is_visible_keyword(keyword_id)'),
    jsonb_build_object('t','serp_features',           'g','public.is_visible_keyword(keyword_id)'),
    jsonb_build_object('t','serp_landscape',          'g','public.is_visible_keyword(keyword_id)'),
    jsonb_build_object('t','site_architecture',       'g','public.is_visible_keyword(keyword_id)'),
    -- indirect
    jsonb_build_object('t','content_plan_items',      'g','public.is_visible_client((SELECT client_id FROM public.content_plans WHERE id = plan_id))'),
    jsonb_build_object('t','monitored_urls',          'g','public.is_visible_client((SELECT client_id FROM public.monitor_campaigns WHERE id = campaign_id))'),
    jsonb_build_object('t','monitor_alert_settings',  'g','public.is_visible_client((SELECT client_id FROM public.monitor_campaigns WHERE id = campaign_id))'),
    jsonb_build_object('t','url_check_snapshots',     'g','public.is_visible_client((SELECT mc.client_id FROM public.monitored_urls mu JOIN public.monitor_campaigns mc ON mc.id = mu.campaign_id WHERE mu.id = monitored_url_id))'),
    jsonb_build_object('t','url_issues',              'g','public.is_visible_client((SELECT mc.client_id FROM public.monitored_urls mu JOIN public.monitor_campaigns mc ON mc.id = mu.campaign_id WHERE mu.id = monitored_url_id))'),
    jsonb_build_object('t','gsc_upload_keywords',     'g','public.is_visible_project((SELECT project_id FROM public.gsc_uploads WHERE id = upload_id))'),
    jsonb_build_object('t','backlink_metrics',        'g','public.is_visible_project((SELECT k.project_id FROM public.serp_rankings sr JOIN public.keywords k ON k.id = sr.keyword_id WHERE sr.id = serp_ranking_id))'),
    jsonb_build_object('t','keyword_tag_history',     'g','public.is_visible_client(client_id)')
  );
BEGIN
  FOR rec IN SELECT * FROM jsonb_array_elements(mapping) AS m LOOP
    pol_name := 'Internal users full access to ' || (rec.value->>'t');
    gate := rec.value->>'g';
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol_name, rec.value->>'t');
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (%s) WITH CHECK (%s)',
      pol_name,
      rec.value->>'t',
      'public.get_user_role(auth.uid()) IN (''super_admin'',''admin'') OR (public.get_user_role(auth.uid()) = ''user'' AND ' || gate || ')',
      'public.get_user_role(auth.uid()) IN (''super_admin'',''admin'') OR (public.get_user_role(auth.uid()) = ''user'' AND ' || gate || ')'
    );
  END LOOP;
END$$;

-- 6. Archive / restore / hard-delete RPCs ---------------------------------
CREATE OR REPLACE FUNCTION public._require_admin()
RETURNS void
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (
    public.has_role(auth.uid(),'admin'::public.app_role)
    OR public.has_role(auth.uid(),'super_admin'::public.app_role)
  ) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
END$$;

REVOKE EXECUTE ON FUNCTION public._require_admin() FROM public;
GRANT  EXECUTE ON FUNCTION public._require_admin() TO authenticated;

CREATE OR REPLACE FUNCTION public.archive_client(_client_id uuid, _reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  v_actor uuid := auth.uid();
  v_cascaded uuid[];
BEGIN
  PERFORM public._require_admin();

  UPDATE public.clients
     SET archived_at = v_now, archived_by = v_actor, archive_reason = _reason
   WHERE id = _client_id AND archived_at IS NULL;

  UPDATE public.navigator_projects
     SET archived_at = v_now, archived_by = v_actor, archive_reason = COALESCE(_reason, 'Cascaded from client archive')
   WHERE client_id = _client_id AND archived_at IS NULL
   RETURNING id INTO v_cascaded;

  SELECT array_agg(id) INTO v_cascaded
    FROM public.navigator_projects
   WHERE client_id = _client_id AND archived_at = v_now;

  PERFORM set_config('app.audit_writer','rpc', true);
  INSERT INTO public.archive_audit(entity_type, entity_id, client_id, action, actor_id, reason, metadata)
  VALUES ('client', _client_id, _client_id, 'archive', v_actor, _reason,
          jsonb_build_object('cascaded_project_ids', COALESCE(to_jsonb(v_cascaded), '[]'::jsonb), 'archived_at', v_now));
END$$;

CREATE OR REPLACE FUNCTION public.restore_client(_client_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_ts timestamptz;
  v_restored uuid[];
BEGIN
  PERFORM public._require_admin();

  SELECT archived_at INTO v_ts FROM public.clients WHERE id = _client_id;
  IF v_ts IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.navigator_projects
     SET archived_at = NULL, archived_by = NULL, archive_reason = NULL
   WHERE client_id = _client_id AND archived_at = v_ts
   RETURNING id INTO v_restored;

  SELECT array_agg(id) INTO v_restored
    FROM public.navigator_projects
   WHERE client_id = _client_id AND archived_at IS NULL;

  UPDATE public.clients
     SET archived_at = NULL, archived_by = NULL, archive_reason = NULL
   WHERE id = _client_id;

  PERFORM set_config('app.audit_writer','rpc', true);
  INSERT INTO public.archive_audit(entity_type, entity_id, client_id, action, actor_id, metadata)
  VALUES ('client', _client_id, _client_id, 'restore', v_actor,
          jsonb_build_object('restored_project_ids', COALESCE(to_jsonb(v_restored), '[]'::jsonb), 'matched_archived_at', v_ts));
END$$;

CREATE OR REPLACE FUNCTION public.archive_project(_project_id uuid, _reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  v_actor uuid := auth.uid();
  v_client uuid;
BEGIN
  PERFORM public._require_admin();

  SELECT client_id INTO v_client FROM public.navigator_projects WHERE id = _project_id;

  UPDATE public.navigator_projects
     SET archived_at = v_now, archived_by = v_actor, archive_reason = _reason
   WHERE id = _project_id AND archived_at IS NULL;

  PERFORM set_config('app.audit_writer','rpc', true);
  INSERT INTO public.archive_audit(entity_type, entity_id, client_id, action, actor_id, reason, metadata)
  VALUES ('project', _project_id, v_client, 'archive', v_actor, _reason,
          jsonb_build_object('archived_at', v_now));
END$$;

CREATE OR REPLACE FUNCTION public.restore_project(_project_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_client uuid;
  v_client_archived timestamptz;
BEGIN
  PERFORM public._require_admin();

  SELECT np.client_id, c.archived_at
    INTO v_client, v_client_archived
    FROM public.navigator_projects np
    JOIN public.clients c ON c.id = np.client_id
   WHERE np.id = _project_id;

  IF v_client_archived IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot restore project while parent client is archived' USING ERRCODE = '22000';
  END IF;

  UPDATE public.navigator_projects
     SET archived_at = NULL, archived_by = NULL, archive_reason = NULL
   WHERE id = _project_id;

  PERFORM set_config('app.audit_writer','rpc', true);
  INSERT INTO public.archive_audit(entity_type, entity_id, client_id, action, actor_id, metadata)
  VALUES ('project', _project_id, v_client, 'restore', v_actor, '{}'::jsonb);
END$$;

CREATE OR REPLACE FUNCTION public.hard_delete_client(_client_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_archived timestamptz;
BEGIN
  PERFORM public._require_admin();

  SELECT archived_at INTO v_archived FROM public.clients WHERE id = _client_id;
  IF v_archived IS NULL THEN
    RAISE EXCEPTION 'Client must be archived before hard delete' USING ERRCODE = '22000';
  END IF;

  PERFORM set_config('app.audit_writer','rpc', true);
  INSERT INTO public.archive_audit(entity_type, entity_id, client_id, action, actor_id, metadata)
  VALUES ('client', _client_id, _client_id, 'hard_delete', v_actor,
          jsonb_build_object('deleted_at', now()));

  DELETE FROM public.clients WHERE id = _client_id;
END$$;

CREATE OR REPLACE FUNCTION public.hard_delete_project(_project_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_archived timestamptz;
  v_client uuid;
BEGIN
  PERFORM public._require_admin();

  SELECT archived_at, client_id INTO v_archived, v_client FROM public.navigator_projects WHERE id = _project_id;
  IF v_archived IS NULL THEN
    RAISE EXCEPTION 'Project must be archived before hard delete' USING ERRCODE = '22000';
  END IF;

  PERFORM set_config('app.audit_writer','rpc', true);
  INSERT INTO public.archive_audit(entity_type, entity_id, client_id, action, actor_id, metadata)
  VALUES ('project', _project_id, v_client, 'hard_delete', v_actor,
          jsonb_build_object('deleted_at', now()));

  DELETE FROM public.navigator_projects WHERE id = _project_id;
END$$;

REVOKE EXECUTE ON FUNCTION public.archive_client(uuid, text)   FROM public;
REVOKE EXECUTE ON FUNCTION public.restore_client(uuid)         FROM public;
REVOKE EXECUTE ON FUNCTION public.archive_project(uuid, text)  FROM public;
REVOKE EXECUTE ON FUNCTION public.restore_project(uuid)        FROM public;
REVOKE EXECUTE ON FUNCTION public.hard_delete_client(uuid)     FROM public;
REVOKE EXECUTE ON FUNCTION public.hard_delete_project(uuid)    FROM public;

GRANT EXECUTE ON FUNCTION public.archive_client(uuid, text)    TO authenticated;
GRANT EXECUTE ON FUNCTION public.restore_client(uuid)          TO authenticated;
GRANT EXECUTE ON FUNCTION public.archive_project(uuid, text)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.restore_project(uuid)         TO authenticated;
GRANT EXECUTE ON FUNCTION public.hard_delete_client(uuid)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.hard_delete_project(uuid)     TO authenticated;
