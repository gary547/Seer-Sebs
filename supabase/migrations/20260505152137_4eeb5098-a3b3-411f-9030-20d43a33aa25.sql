
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Remove prior schedule if it exists, then re-add (idempotent)
DO $$
DECLARE jid bigint;
BEGIN
  SELECT jobid INTO jid FROM cron.job WHERE jobname = 'detox-jobs-tick';
  IF jid IS NOT NULL THEN
    PERFORM cron.unschedule(jid);
  END IF;
END $$;

SELECT cron.schedule(
  'detox-jobs-tick',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xvkfuakwhujtjeaybtzu.supabase.co/functions/v1/keyword-detox',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer [REDACTED_LEGACY_SUPABASE_ANON_KEY]'
    ),
    body := jsonb_build_object('mode', 'tick', 'job_id', dj.id)
  )
  FROM public.detox_jobs dj
  WHERE dj.status IN ('queued','running')
    AND (dj.heartbeat_at IS NULL OR dj.heartbeat_at < now() - interval '5 minutes');
  $$
);
