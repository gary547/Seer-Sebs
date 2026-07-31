
-- ============================================================================
-- 1. Per-keyword categorisation state (row-level claiming)
-- ============================================================================
ALTER TABLE public.keywords
  ADD COLUMN IF NOT EXISTS categorisation_status text NOT NULL DEFAULT 'pending'
    CHECK (categorisation_status IN ('pending','processing','done','error','skipped')),
  ADD COLUMN IF NOT EXISTS categorisation_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS categorisation_locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS categorisation_last_error text;

-- Backfill: anything that already has tag_1 is done; everything else is pending.
UPDATE public.keywords
   SET categorisation_status = 'done'
 WHERE tag_1 IS NOT NULL
   AND categorisation_status <> 'done';

-- Fast backlog index (project + tier + status), only over rows still needing work.
CREATE INDEX IF NOT EXISTS idx_keywords_cat_backlog
  ON public.keywords (project_id, categorisation_tier, categorisation_status)
  WHERE tag_1 IS NULL AND categorisation_status <> 'done';

-- Lock-aging index for stale-claim sweeps.
CREATE INDEX IF NOT EXISTS idx_keywords_cat_locked
  ON public.keywords (categorisation_locked_at)
  WHERE categorisation_status = 'processing';

-- ============================================================================
-- 2. Job table extensions
-- ============================================================================
ALTER TABLE public.categorisation_jobs
  ADD COLUMN IF NOT EXISTS from_rules integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS from_cache integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS from_fast_path integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS from_ai integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rate_limited_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_run_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS rate_limited_until timestamptz;

-- Allow a "rate_limited" status for clearer UI surfacing.
ALTER TABLE public.categorisation_jobs DROP CONSTRAINT IF EXISTS categorisation_jobs_status_check;
ALTER TABLE public.categorisation_jobs
  ADD CONSTRAINT categorisation_jobs_status_check
  CHECK (status IN ('queued','running','rate_limited','done','error'));

-- One active job per project+tier (queued/running/rate_limited).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_categorisation_jobs_active
  ON public.categorisation_jobs (project_id, tier)
  WHERE status IN ('queued','running','rate_limited');

CREATE INDEX IF NOT EXISTS idx_categorisation_jobs_due
  ON public.categorisation_jobs (status, next_run_at)
  WHERE status IN ('queued','running','rate_limited');

-- ============================================================================
-- 3. Atomic row-claim function (SKIP LOCKED)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.claim_categorisation_batch(
  _project_id uuid,
  _tier text,
  _limit integer
)
RETURNS TABLE (
  id uuid,
  keyword text,
  search_intent text,
  categorisation_tier text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH cte AS (
    SELECT k.id
      FROM public.keywords k
     WHERE k.project_id = _project_id
       AND k.detox_status = 'keep'
       AND k.tag_1 IS NULL
       AND k.categorisation_status IN ('pending','error')
       AND (
         _tier IS NULL
         OR k.categorisation_tier = _tier
         OR k.categorisation_tier IS NULL
       )
       -- Skip rows that have failed too many times so they don't block the queue.
       AND k.categorisation_attempts < 5
     ORDER BY k.categorisation_attempts ASC, k.created_at ASC
     FOR UPDATE SKIP LOCKED
     LIMIT _limit
  )
  UPDATE public.keywords k
     SET categorisation_status   = 'processing',
         categorisation_locked_at = now(),
         categorisation_attempts = k.categorisation_attempts + 1
    FROM cte
   WHERE k.id = cte.id
   RETURNING k.id, k.keyword, k.search_intent, k.categorisation_tier;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_categorisation_batch(uuid, text, integer) TO authenticated;

-- Recover stale claims (rows stuck in 'processing' for >5 minutes — likely a
-- crashed worker). Safe to run repeatedly.
CREATE OR REPLACE FUNCTION public.release_stale_categorisation_claims()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH released AS (
    UPDATE public.keywords
       SET categorisation_status = 'pending',
           categorisation_locked_at = NULL
     WHERE categorisation_status = 'processing'
       AND categorisation_locked_at < now() - interval '5 minutes'
     RETURNING 1
  )
  SELECT COALESCE(COUNT(*), 0)::integer FROM released;
$$;

GRANT EXECUTE ON FUNCTION public.release_stale_categorisation_claims() TO authenticated;

-- ============================================================================
-- 4. Cron: run the resumer every minute (replaces the nightly-only schedule)
-- ============================================================================
DO $$
BEGIN
  PERFORM cron.unschedule('categorisation-deferred-nightly');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

DO $$
BEGIN
  PERFORM cron.unschedule('categorisation-worker-tick');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'categorisation-worker-tick',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xvkfuakwhujtjeaybtzu.supabase.co/functions/v1/categorisation-deferred-tick',
    headers := '{"Content-Type": "application/json", "apikey": "[REDACTED_LEGACY_SUPABASE_ANON_KEY]"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
