CREATE TABLE IF NOT EXISTS monitor_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  navigator_project_id uuid REFERENCES navigator_projects(id) ON DELETE SET NULL,
  name text NOT NULL,
  description text,
  owner text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'archived')),
  check_frequency text NOT NULL DEFAULT '24h'
    CHECK (check_frequency IN ('1h', '6h', '24h')),
  daily_check_time time NOT NULL DEFAULT '07:00',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, name)
);

CREATE INDEX IF NOT EXISTS monitor_campaigns_client_created_idx
  ON monitor_campaigns (client_id, created_at DESC);

CREATE INDEX IF NOT EXISTS monitor_campaigns_project_idx
  ON monitor_campaigns (navigator_project_id)
  WHERE navigator_project_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS monitored_urls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES monitor_campaigns(id) ON DELETE CASCADE,
  url text NOT NULL,
  normalized_url text NOT NULL,
  label text,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz,
  current_status text
    CHECK (current_status IS NULL OR current_status IN ('ok', 'warning', 'critical', 'unknown')),
  current_http_status integer,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, normalized_url)
);

CREATE INDEX IF NOT EXISTS monitored_urls_due_idx
  ON monitored_urls (next_check_at, id)
  WHERE is_active;

CREATE INDEX IF NOT EXISTS monitored_urls_campaign_created_idx
  ON monitored_urls (campaign_id, created_at DESC);

CREATE TABLE IF NOT EXISTS url_check_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  monitored_url_id uuid NOT NULL REFERENCES monitored_urls(id) ON DELETE CASCADE,
  checked_at timestamptz NOT NULL DEFAULT now(),
  http_status integer,
  final_url text,
  redirect_chain jsonb NOT NULL DEFAULT '[]'::jsonb,
  page_title text,
  canonical_url text,
  response_time_ms integer CHECK (response_time_ms IS NULL OR response_time_ms >= 0),
  error_message text
);

CREATE INDEX IF NOT EXISTS url_check_snapshots_url_checked_idx
  ON url_check_snapshots (monitored_url_id, checked_at DESC, id);

CREATE TABLE IF NOT EXISTS url_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  monitored_url_id uuid NOT NULL REFERENCES monitored_urls(id) ON DELETE CASCADE,
  snapshot_id uuid NOT NULL REFERENCES url_check_snapshots(id) ON DELETE CASCADE,
  severity text NOT NULL CHECK (severity IN ('critical', 'warning', 'watch')),
  issue_type text NOT NULL CHECK (
    issue_type IN (
      'http_status_change',
      'http_error',
      'new_redirect',
      'destination_changed',
      'title_changed',
      'canonical_changed'
    )
  ),
  previous_value text,
  current_value text,
  detected_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  resolved_at timestamptz,
  referring_domains integer,
  domain_rating numeric
);

CREATE INDEX IF NOT EXISTS url_issues_url_detected_idx
  ON url_issues (monitored_url_id, detected_at DESC, id);

CREATE INDEX IF NOT EXISTS url_issues_open_idx
  ON url_issues (severity, detected_at DESC, id)
  WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS monitor_alert_settings (
  campaign_id uuid PRIMARY KEY REFERENCES monitor_campaigns(id) ON DELETE CASCADE,
  alert_on_critical boolean NOT NULL DEFAULT true,
  alert_on_warning boolean NOT NULL DEFAULT true,
  alert_on_watch boolean NOT NULL DEFAULT false,
  weekly_summary boolean NOT NULL DEFAULT true,
  weekly_summary_day integer NOT NULL DEFAULT 1
    CHECK (weekly_summary_day BETWEEN 0 AND 6),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION detect_url_snapshot_issues()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  previous_snapshot url_check_snapshots%ROWTYPE;
  detected_severity text;
  previous_chain_length integer;
  current_chain_length integer;
BEGIN
  SELECT *
  INTO previous_snapshot
  FROM url_check_snapshots
  WHERE monitored_url_id = NEW.monitored_url_id
    AND id <> NEW.id
  ORDER BY checked_at DESC, id DESC
  LIMIT 1;

  IF previous_snapshot.id IS NOT NULL
    AND previous_snapshot.http_status IS DISTINCT FROM NEW.http_status THEN
    IF NEW.http_status IS NULL OR NEW.http_status >= 400 THEN
      INSERT INTO url_issues (
        monitored_url_id, snapshot_id, severity, issue_type, previous_value, current_value
      )
      VALUES (
        NEW.monitored_url_id,
        NEW.id,
        'critical',
        CASE WHEN NEW.http_status IS NULL THEN 'http_error' ELSE 'http_status_change' END,
        previous_snapshot.http_status::text,
        COALESCE(NEW.http_status::text, NEW.error_message)
      );
      detected_severity := 'critical';
    ELSE
      INSERT INTO url_issues (
        monitored_url_id, snapshot_id, severity, issue_type, previous_value, current_value
      )
      VALUES (
        NEW.monitored_url_id,
        NEW.id,
        'warning',
        'http_status_change',
        previous_snapshot.http_status::text,
        NEW.http_status::text
      );
      detected_severity := 'warning';
    END IF;
  END IF;

  previous_chain_length := COALESCE(jsonb_array_length(previous_snapshot.redirect_chain), 0);
  current_chain_length := COALESCE(jsonb_array_length(NEW.redirect_chain), 0);
  IF previous_snapshot.id IS NOT NULL
    AND current_chain_length > previous_chain_length THEN
    INSERT INTO url_issues (
      monitored_url_id, snapshot_id, severity, issue_type, previous_value, current_value
    )
    VALUES (
      NEW.monitored_url_id,
      NEW.id,
      'warning',
      'new_redirect',
      previous_chain_length::text,
      current_chain_length::text
    );
    detected_severity := COALESCE(detected_severity, 'warning');
  END IF;

  IF previous_snapshot.id IS NOT NULL
    AND previous_snapshot.final_url IS DISTINCT FROM NEW.final_url THEN
    INSERT INTO url_issues (
      monitored_url_id, snapshot_id, severity, issue_type, previous_value, current_value
    )
    VALUES (
      NEW.monitored_url_id,
      NEW.id,
      'warning',
      'destination_changed',
      previous_snapshot.final_url,
      NEW.final_url
    );
    detected_severity := COALESCE(detected_severity, 'warning');
  END IF;

  IF previous_snapshot.id IS NOT NULL
    AND previous_snapshot.page_title IS DISTINCT FROM NEW.page_title THEN
    INSERT INTO url_issues (
      monitored_url_id, snapshot_id, severity, issue_type, previous_value, current_value
    )
    VALUES (
      NEW.monitored_url_id,
      NEW.id,
      'watch',
      'title_changed',
      previous_snapshot.page_title,
      NEW.page_title
    );
    detected_severity := COALESCE(detected_severity, 'watch');
  END IF;

  IF previous_snapshot.id IS NOT NULL
    AND previous_snapshot.canonical_url IS DISTINCT FROM NEW.canonical_url THEN
    INSERT INTO url_issues (
      monitored_url_id, snapshot_id, severity, issue_type, previous_value, current_value
    )
    VALUES (
      NEW.monitored_url_id,
      NEW.id,
      'watch',
      'canonical_changed',
      previous_snapshot.canonical_url,
      NEW.canonical_url
    );
    detected_severity := COALESCE(detected_severity, 'watch');
  END IF;

  UPDATE monitored_urls
  SET
    current_http_status = NEW.http_status,
    last_checked_at = NEW.checked_at,
    current_status = CASE
      WHEN NEW.http_status IS NULL OR NEW.http_status >= 400 THEN 'critical'
      WHEN detected_severity = 'warning' THEN 'warning'
      WHEN NEW.http_status BETWEEN 200 AND 399 THEN 'ok'
      ELSE 'unknown'
    END
  WHERE id = NEW.monitored_url_id;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS url_snapshot_issue_detection ON url_check_snapshots;
CREATE TRIGGER url_snapshot_issue_detection
AFTER INSERT ON url_check_snapshots
FOR EACH ROW
EXECUTE FUNCTION detect_url_snapshot_issues();

GRANT SELECT, INSERT, UPDATE, DELETE
  ON monitor_campaigns, monitored_urls, url_check_snapshots, url_issues,
    monitor_alert_settings
  TO seer_api;

GRANT SELECT, INSERT, UPDATE
  ON monitored_urls, url_check_snapshots, url_issues
  TO seer_worker;

INSERT INTO schema_migrations (version)
VALUES ('017_url_monitor_contract')
ON CONFLICT (version) DO NOTHING;
