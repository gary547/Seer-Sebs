ALTER TABLE monitored_urls
  ADD COLUMN IF NOT EXISTS lease_token uuid,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS monitored_urls_lease_expiry_idx
  ON monitored_urls (lease_expires_at, id)
  WHERE lease_token IS NOT NULL;

GRANT SELECT, INSERT, UPDATE
  ON monitored_urls, url_check_snapshots, url_issues
  TO seer_worker;

INSERT INTO schema_migrations (version)
VALUES ('024_url_monitor_leases')
ON CONFLICT (version) DO NOTHING;
