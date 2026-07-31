CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Remove any prior schedule with the same name (idempotent)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'url-monitor-tick-every-5-min') THEN
    PERFORM cron.unschedule('url-monitor-tick-every-5-min');
  END IF;
END $$;

-- Heartbeat: every 5 minutes, POST to url-monitor-tick.
-- The function itself filters by next_check_at <= now() so this is safe & idempotent.
SELECT cron.schedule(
  'url-monitor-tick-every-5-min',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://xvkfuakwhujtjeaybtzu.supabase.co/functions/v1/url-monitor-tick',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer [REDACTED_LEGACY_SUPABASE_ANON_KEY]"}'::jsonb,
    body    := jsonb_build_object('source','pg_cron','at',now())
  ) AS request_id;
  $$
);