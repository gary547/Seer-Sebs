SELECT cron.schedule(
  'categorisation-deferred-nightly',
  '0 2 * * *',
  $$
  SELECT net.http_post(
    url := 'https://xvkfuakwhujtjeaybtzu.supabase.co/functions/v1/categorisation-deferred-tick',
    headers := '{"Content-Type": "application/json", "apikey": "[REDACTED_LEGACY_SUPABASE_ANON_KEY]"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);