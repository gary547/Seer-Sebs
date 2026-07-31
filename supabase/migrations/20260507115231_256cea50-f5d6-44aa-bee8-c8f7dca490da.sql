-- Add a per-minute cron to resume stalled live categorisation jobs.
-- Mirrors the detox-jobs-tick pattern: any queued/running job whose heartbeat
-- has gone silent for >5 minutes gets a tick poke. Idempotent — does nothing
-- when no jobs are stalled.

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
    AND cj.status IN ('queued','running')
    AND (cj.heartbeat_at IS NULL OR cj.heartbeat_at < now() - interval '5 minutes');
  $$
);