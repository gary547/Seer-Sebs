-- Fix categorisation cron predicate: re-poke whenever next_run_at is due,
-- not only when the heartbeat has been silent for 5 minutes.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobid = 6;

SELECT cron.schedule(
  'categorisation-live-resume',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xvkfuakwhujtjeaybtzu.supabase.co/functions/v1/keyword-categorisation',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer [REDACTED_LEGACY_SUPABASE_ANON_KEY]'
    ),
    body := jsonb_build_object('mode', 'tick', 'job_id', cj.id)
  )
  FROM public.categorisation_jobs cj
  WHERE cj.tier = 'live'
    AND cj.status IN ('queued','running','rate_limited')
    AND COALESCE(cj.next_run_at, cj.started_at) <= now()
    AND (cj.heartbeat_at IS NULL OR cj.heartbeat_at < now() - interval '90 seconds');
  $$
);

-- One-shot unblock: reset attempts on rows stuck above the retry limit so
-- the in-function fallback path can finally close them out on the next claim.
UPDATE public.keywords
   SET categorisation_attempts = 0,
       categorisation_status = 'pending',
       categorisation_locked_at = NULL
 WHERE tag_1 IS NULL
   AND detox_status = 'keep'
   AND categorisation_attempts >= 4;
