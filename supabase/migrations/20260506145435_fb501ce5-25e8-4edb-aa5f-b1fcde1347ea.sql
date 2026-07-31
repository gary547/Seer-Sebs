CREATE OR REPLACE FUNCTION public.claim_har_serp_fetch_by_dfs_ids(
  _job_id uuid,
  _dfs_ids text[],
  _limit integer
)
RETURNS TABLE(id uuid, keyword_id uuid, dfs_task_id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
  WITH cte AS (
    SELECT t.id FROM public.har_serp_tasks t
    WHERE t.job_id = _job_id
      AND t.status = 'posted'
      AND t.dfs_task_id = ANY(_dfs_ids)
      AND t.attempts < 6
      AND (t.locked_at IS NULL OR t.locked_at < now() - interval '2 minutes')
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

CREATE OR REPLACE FUNCTION public.bulk_update_har_serp_tasks(_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  n integer;
BEGIN
  WITH input AS (
    SELECT
      (r->>'id')::uuid                    AS id,
      NULLIF(r->>'dfs_task_id','')        AS dfs_task_id,
      (r->>'status')                      AS status,
      NULLIF(r->>'last_error','')         AS last_error
    FROM jsonb_array_elements(_rows) r
  )
  UPDATE public.har_serp_tasks t
     SET dfs_task_id = COALESCE(i.dfs_task_id, t.dfs_task_id),
         status      = i.status,
         posted_at   = CASE WHEN i.status = 'posted' AND t.posted_at IS NULL THEN now() ELSE t.posted_at END,
         locked_at   = NULL,
         last_error  = i.last_error
    FROM input i
   WHERE t.id = i.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;