
-- =========================================================================
-- HAR DURABLE WORKER INFRASTRUCTURE
-- =========================================================================

-- ---- har_jobs -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.har_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
    -- pending | seeding | posting_serp | polling_serp | fetching_ahrefs |
    -- fetching_backlinks | computing | completed | error | rate_limited
  phase text,
  total_keywords integer NOT NULL DEFAULT 0,
  serp_tasks_total integer NOT NULL DEFAULT 0,
  serp_tasks_posted integer NOT NULL DEFAULT 0,
  serp_tasks_done integer NOT NULL DEFAULT 0,
  ahrefs_targets_total integer NOT NULL DEFAULT 0,
  ahrefs_targets_done integer NOT NULL DEFAULT 0,
  backlinks_targets_total integer NOT NULL DEFAULT 0,
  backlinks_targets_done integer NOT NULL DEFAULT 0,
  backlinks_skipped boolean NOT NULL DEFAULT false,
  har_rows_done integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_har_jobs_active_per_project
  ON public.har_jobs (project_id)
  WHERE status NOT IN ('completed','error');

CREATE INDEX IF NOT EXISTS idx_har_jobs_runnable
  ON public.har_jobs (next_run_at)
  WHERE status NOT IN ('completed','error');

ALTER TABLE public.har_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Internal users full access to har_jobs"
ON public.har_jobs FOR ALL TO authenticated
USING (get_user_role(auth.uid()) = ANY (ARRAY['super_admin','admin','user']))
WITH CHECK (get_user_role(auth.uid()) = ANY (ARRAY['super_admin','admin','user']));

CREATE POLICY "View-only see assigned har_jobs"
ON public.har_jobs FOR SELECT TO authenticated
USING (
  get_user_role(auth.uid()) = 'view_only'
  AND project_id IN (
    SELECT np.id FROM navigator_projects np
    JOIN user_client_access uca ON uca.client_id = np.client_id
    WHERE uca.user_id = auth.uid()
  )
);

CREATE TRIGGER trg_har_jobs_updated
BEFORE UPDATE ON public.har_jobs
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---- har_serp_tasks -----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.har_serp_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  project_id uuid NOT NULL,
  keyword_id uuid NOT NULL,
  keyword text NOT NULL,
  dfs_task_id text,
  status text NOT NULL DEFAULT 'queued',
    -- queued | posted | fetched | error
  attempts integer NOT NULL DEFAULT 0,
  locked_at timestamptz,
  posted_at timestamptz,
  fetched_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_har_serp_tasks_job_status
  ON public.har_serp_tasks (job_id, status);
CREATE INDEX IF NOT EXISTS idx_har_serp_tasks_dfs_id
  ON public.har_serp_tasks (dfs_task_id) WHERE dfs_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_har_serp_tasks_locked
  ON public.har_serp_tasks (locked_at) WHERE status IN ('posted');

ALTER TABLE public.har_serp_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Internal full access har_serp_tasks"
ON public.har_serp_tasks FOR ALL TO authenticated
USING (get_user_role(auth.uid()) = ANY (ARRAY['super_admin','admin','user']))
WITH CHECK (get_user_role(auth.uid()) = ANY (ARRAY['super_admin','admin','user']));

CREATE POLICY "View-only see assigned har_serp_tasks"
ON public.har_serp_tasks FOR SELECT TO authenticated
USING (
  get_user_role(auth.uid()) = 'view_only'
  AND project_id IN (
    SELECT np.id FROM navigator_projects np
    JOIN user_client_access uca ON uca.client_id = np.client_id
    WHERE uca.user_id = auth.uid()
  )
);

-- ---- har_ahrefs_queue ---------------------------------------------------
CREATE TABLE IF NOT EXISTS public.har_ahrefs_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  project_id uuid NOT NULL,
  target_url text NOT NULL,
  target_mode text NOT NULL DEFAULT 'exact',
  status text NOT NULL DEFAULT 'pending',
    -- pending | processing | done | error
  attempts integer NOT NULL DEFAULT 0,
  locked_at timestamptz,
  url_rating numeric,
  domain_rating numeric,
  ahrefs_rank integer,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_har_ahrefs_job_status
  ON public.har_ahrefs_queue (job_id, status);
CREATE INDEX IF NOT EXISTS idx_har_ahrefs_locked
  ON public.har_ahrefs_queue (locked_at) WHERE status = 'processing';
CREATE UNIQUE INDEX IF NOT EXISTS uniq_har_ahrefs_job_target
  ON public.har_ahrefs_queue (job_id, target_url);

ALTER TABLE public.har_ahrefs_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Internal full access har_ahrefs_queue"
ON public.har_ahrefs_queue FOR ALL TO authenticated
USING (get_user_role(auth.uid()) = ANY (ARRAY['super_admin','admin','user']))
WITH CHECK (get_user_role(auth.uid()) = ANY (ARRAY['super_admin','admin','user']));

CREATE POLICY "View-only see assigned har_ahrefs_queue"
ON public.har_ahrefs_queue FOR SELECT TO authenticated
USING (
  get_user_role(auth.uid()) = 'view_only'
  AND project_id IN (
    SELECT np.id FROM navigator_projects np
    JOIN user_client_access uca ON uca.client_id = np.client_id
    WHERE uca.user_id = auth.uid()
  )
);

-- ---- har_backlinks_queue ------------------------------------------------
CREATE TABLE IF NOT EXISTS public.har_backlinks_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  project_id uuid NOT NULL,
  target_url text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  locked_at timestamptz,
  referring_domains integer,
  backlinks bigint,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_har_backlinks_job_status
  ON public.har_backlinks_queue (job_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_har_backlinks_job_target
  ON public.har_backlinks_queue (job_id, target_url);

ALTER TABLE public.har_backlinks_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Internal full access har_backlinks_queue"
ON public.har_backlinks_queue FOR ALL TO authenticated
USING (get_user_role(auth.uid()) = ANY (ARRAY['super_admin','admin','user']))
WITH CHECK (get_user_role(auth.uid()) = ANY (ARRAY['super_admin','admin','user']));

CREATE POLICY "View-only see assigned har_backlinks_queue"
ON public.har_backlinks_queue FOR SELECT TO authenticated
USING (
  get_user_role(auth.uid()) = 'view_only'
  AND project_id IN (
    SELECT np.id FROM navigator_projects np
    JOIN user_client_access uca ON uca.client_id = np.client_id
    WHERE uca.user_id = auth.uid()
  )
);

-- =========================================================================
-- CLAIM FUNCTIONS
-- =========================================================================

CREATE OR REPLACE FUNCTION public.claim_har_serp_post_batch(_job_id uuid, _limit integer)
RETURNS TABLE(id uuid, keyword_id uuid, keyword text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH cte AS (
    SELECT t.id FROM public.har_serp_tasks t
    WHERE t.job_id = _job_id
      AND t.status = 'queued'
      AND t.attempts < 4
    ORDER BY t.created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT _limit
  )
  UPDATE public.har_serp_tasks t
     SET locked_at = now(),
         attempts = t.attempts + 1
    FROM cte WHERE t.id = cte.id
  RETURNING t.id, t.keyword_id, t.keyword;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_har_serp_fetch_batch(_job_id uuid, _limit integer)
RETURNS TABLE(id uuid, keyword_id uuid, dfs_task_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH cte AS (
    SELECT t.id FROM public.har_serp_tasks t
    WHERE t.job_id = _job_id
      AND t.status = 'posted'
      AND t.dfs_task_id IS NOT NULL
      AND t.attempts < 6
    ORDER BY t.posted_at ASC NULLS FIRST
    FOR UPDATE SKIP LOCKED
    LIMIT _limit
  )
  UPDATE public.har_serp_tasks t
     SET locked_at = now(),
         attempts = t.attempts + 1
    FROM cte WHERE t.id = cte.id
  RETURNING t.id, t.keyword_id, t.dfs_task_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_har_ahrefs_batch(_job_id uuid, _limit integer)
RETURNS TABLE(id uuid, target_url text, target_mode text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH cte AS (
    SELECT q.id FROM public.har_ahrefs_queue q
    WHERE q.job_id = _job_id
      AND q.status = 'pending'
      AND q.attempts < 3
    ORDER BY q.created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT _limit
  )
  UPDATE public.har_ahrefs_queue q
     SET status = 'processing',
         locked_at = now(),
         attempts = q.attempts + 1
    FROM cte WHERE q.id = cte.id
  RETURNING q.id, q.target_url, q.target_mode;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_har_backlinks_batch(_job_id uuid, _limit integer)
RETURNS TABLE(id uuid, target_url text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH cte AS (
    SELECT q.id FROM public.har_backlinks_queue q
    WHERE q.job_id = _job_id
      AND q.status = 'pending'
      AND q.attempts < 3
    ORDER BY q.created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT _limit
  )
  UPDATE public.har_backlinks_queue q
     SET status = 'processing',
         locked_at = now(),
         attempts = q.attempts + 1
    FROM cte WHERE q.id = cte.id
  RETURNING q.id, q.target_url;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_stale_har_claims()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  n integer := 0;
  m integer;
BEGIN
  UPDATE public.har_ahrefs_queue
     SET status = 'pending', locked_at = NULL
   WHERE status = 'processing'
     AND locked_at < now() - interval '5 minutes';
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;

  UPDATE public.har_backlinks_queue
     SET status = 'pending', locked_at = NULL
   WHERE status = 'processing'
     AND locked_at < now() - interval '5 minutes';
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;

  -- SERP tasks: clear stale locks but keep status (queued or posted)
  UPDATE public.har_serp_tasks
     SET locked_at = NULL
   WHERE locked_at IS NOT NULL
     AND locked_at < now() - interval '5 minutes';
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;

  RETURN n;
END;
$$;

-- =========================================================================
-- CRON: tick worker every minute
-- =========================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

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
    headers := '{"Content-Type":"application/json","apikey":"[REDACTED_LEGACY_SUPABASE_ANON_KEY]"}'::jsonb,
    body := '{"mode":"tick"}'::jsonb
  );
  $cron$
);
