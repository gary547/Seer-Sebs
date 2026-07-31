
-- 1. monitor_campaigns
CREATE TABLE public.monitor_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  navigator_project_id uuid REFERENCES public.navigator_projects(id) ON DELETE SET NULL,
  name text NOT NULL,
  description text,
  owner text,
  status text NOT NULL DEFAULT 'active',
  check_frequency text NOT NULL DEFAULT '24h',
  daily_check_time time NOT NULL DEFAULT '07:00',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, name),
  CHECK (status IN ('active','paused','archived')),
  CHECK (check_frequency IN ('1h','6h','24h'))
);
CREATE INDEX idx_monitor_campaigns_client ON public.monitor_campaigns(client_id);
CREATE INDEX idx_monitor_campaigns_navproj ON public.monitor_campaigns(navigator_project_id);

CREATE TRIGGER trg_monitor_campaigns_updated
BEFORE UPDATE ON public.monitor_campaigns
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.monitor_campaigns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Internal full access to monitor_campaigns"
ON public.monitor_campaigns FOR ALL TO authenticated
USING (get_user_role(auth.uid()) IN ('super_admin','admin','user'))
WITH CHECK (get_user_role(auth.uid()) IN ('super_admin','admin','user'));

CREATE POLICY "View-only see assigned monitor_campaigns"
ON public.monitor_campaigns FOR SELECT TO authenticated
USING (
  get_user_role(auth.uid()) = 'view_only'
  AND client_id IN (SELECT client_id FROM public.user_client_access WHERE user_id = auth.uid())
);

-- 2. monitored_urls
CREATE TABLE public.monitored_urls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.monitor_campaigns(id) ON DELETE CASCADE,
  url text NOT NULL,
  label text,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz,
  current_status text,
  current_http_status int,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, url),
  CHECK (current_status IS NULL OR current_status IN ('ok','warning','critical','unknown'))
);
CREATE INDEX idx_monitored_urls_due ON public.monitored_urls(next_check_at) WHERE is_active;
CREATE INDEX idx_monitored_urls_campaign ON public.monitored_urls(campaign_id);

ALTER TABLE public.monitored_urls ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Internal full access to monitored_urls"
ON public.monitored_urls FOR ALL TO authenticated
USING (get_user_role(auth.uid()) IN ('super_admin','admin','user'))
WITH CHECK (get_user_role(auth.uid()) IN ('super_admin','admin','user'));

CREATE POLICY "View-only see assigned monitored_urls"
ON public.monitored_urls FOR SELECT TO authenticated
USING (
  get_user_role(auth.uid()) = 'view_only'
  AND campaign_id IN (
    SELECT mc.id FROM public.monitor_campaigns mc
    JOIN public.user_client_access uca ON uca.client_id = mc.client_id
    WHERE uca.user_id = auth.uid()
  )
);

-- 3. url_check_snapshots
CREATE TABLE public.url_check_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  monitored_url_id uuid NOT NULL REFERENCES public.monitored_urls(id) ON DELETE CASCADE,
  checked_at timestamptz NOT NULL DEFAULT now(),
  http_status int,
  final_url text,
  redirect_chain jsonb,
  page_title text,
  canonical_url text,
  response_time_ms int,
  error_message text
);
CREATE INDEX idx_snapshots_url_time ON public.url_check_snapshots(monitored_url_id, checked_at DESC);

ALTER TABLE public.url_check_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Internal full access to url_check_snapshots"
ON public.url_check_snapshots FOR ALL TO authenticated
USING (get_user_role(auth.uid()) IN ('super_admin','admin','user'))
WITH CHECK (get_user_role(auth.uid()) IN ('super_admin','admin','user'));

CREATE POLICY "View-only see assigned url_check_snapshots"
ON public.url_check_snapshots FOR SELECT TO authenticated
USING (
  get_user_role(auth.uid()) = 'view_only'
  AND monitored_url_id IN (
    SELECT mu.id FROM public.monitored_urls mu
    JOIN public.monitor_campaigns mc ON mc.id = mu.campaign_id
    JOIN public.user_client_access uca ON uca.client_id = mc.client_id
    WHERE uca.user_id = auth.uid()
  )
);

-- 4. url_issues
CREATE TABLE public.url_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  monitored_url_id uuid NOT NULL REFERENCES public.monitored_urls(id) ON DELETE CASCADE,
  snapshot_id uuid NOT NULL REFERENCES public.url_check_snapshots(id) ON DELETE CASCADE,
  severity text NOT NULL,
  issue_type text NOT NULL,
  previous_value text,
  current_value text,
  detected_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  resolved_at timestamptz,
  referring_domains int,
  domain_rating numeric,
  CHECK (severity IN ('critical','warning','watch')),
  CHECK (issue_type IN ('http_status_change','http_error','new_redirect','destination_changed','title_changed','canonical_changed'))
);
CREATE INDEX idx_issues_url_open ON public.url_issues(monitored_url_id, resolved_at);

ALTER TABLE public.url_issues ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Internal full access to url_issues"
ON public.url_issues FOR ALL TO authenticated
USING (get_user_role(auth.uid()) IN ('super_admin','admin','user'))
WITH CHECK (get_user_role(auth.uid()) IN ('super_admin','admin','user'));

CREATE POLICY "View-only see assigned url_issues"
ON public.url_issues FOR SELECT TO authenticated
USING (
  get_user_role(auth.uid()) = 'view_only'
  AND monitored_url_id IN (
    SELECT mu.id FROM public.monitored_urls mu
    JOIN public.monitor_campaigns mc ON mc.id = mu.campaign_id
    JOIN public.user_client_access uca ON uca.client_id = mc.client_id
    WHERE uca.user_id = auth.uid()
  )
);

-- 5. monitor_alert_settings
CREATE TABLE public.monitor_alert_settings (
  campaign_id uuid PRIMARY KEY REFERENCES public.monitor_campaigns(id) ON DELETE CASCADE,
  alert_on_critical boolean NOT NULL DEFAULT true,
  alert_on_warning boolean NOT NULL DEFAULT true,
  alert_on_watch boolean NOT NULL DEFAULT false,
  weekly_summary boolean NOT NULL DEFAULT true,
  weekly_summary_day int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_alert_settings_updated
BEFORE UPDATE ON public.monitor_alert_settings
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.monitor_alert_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Internal full access to monitor_alert_settings"
ON public.monitor_alert_settings FOR ALL TO authenticated
USING (get_user_role(auth.uid()) IN ('super_admin','admin','user'))
WITH CHECK (get_user_role(auth.uid()) IN ('super_admin','admin','user'));

CREATE POLICY "View-only see assigned monitor_alert_settings"
ON public.monitor_alert_settings FOR SELECT TO authenticated
USING (
  get_user_role(auth.uid()) = 'view_only'
  AND campaign_id IN (
    SELECT mc.id FROM public.monitor_campaigns mc
    JOIN public.user_client_access uca ON uca.client_id = mc.client_id
    WHERE uca.user_id = auth.uid()
  )
);

-- 6. profiles opt-in
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS notify_url_monitor boolean NOT NULL DEFAULT true;

-- 7. Diff trigger
CREATE OR REPLACE FUNCTION public.url_snapshot_detect_issues()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  prev RECORD;
  new_severity text := NULL;
  prev_chain_len int;
  new_chain_len int;
BEGIN
  SELECT * INTO prev
  FROM public.url_check_snapshots
  WHERE monitored_url_id = NEW.monitored_url_id
    AND id <> NEW.id
  ORDER BY checked_at DESC
  LIMIT 1;

  -- HTTP status change / error
  IF prev.id IS NOT NULL AND prev.http_status IS DISTINCT FROM NEW.http_status THEN
    IF NEW.http_status IS NULL OR NEW.http_status >= 400 THEN
      INSERT INTO public.url_issues(monitored_url_id, snapshot_id, severity, issue_type, previous_value, current_value)
      VALUES (NEW.monitored_url_id, NEW.id, 'critical',
              CASE WHEN NEW.http_status IS NULL THEN 'http_error' ELSE 'http_status_change' END,
              prev.http_status::text, COALESCE(NEW.http_status::text, NEW.error_message));
      new_severity := 'critical';
    ELSE
      INSERT INTO public.url_issues(monitored_url_id, snapshot_id, severity, issue_type, previous_value, current_value)
      VALUES (NEW.monitored_url_id, NEW.id, 'warning', 'http_status_change',
              prev.http_status::text, NEW.http_status::text);
      new_severity := COALESCE(new_severity, 'warning');
    END IF;
  END IF;

  -- Redirect chain length grew
  prev_chain_len := COALESCE(jsonb_array_length(prev.redirect_chain), 0);
  new_chain_len := COALESCE(jsonb_array_length(NEW.redirect_chain), 0);
  IF prev.id IS NOT NULL AND new_chain_len > prev_chain_len THEN
    INSERT INTO public.url_issues(monitored_url_id, snapshot_id, severity, issue_type, previous_value, current_value)
    VALUES (NEW.monitored_url_id, NEW.id, 'warning', 'new_redirect',
            prev_chain_len::text, new_chain_len::text);
    new_severity := COALESCE(new_severity, 'warning');
  END IF;

  -- Final URL changed
  IF prev.id IS NOT NULL AND prev.final_url IS DISTINCT FROM NEW.final_url THEN
    INSERT INTO public.url_issues(monitored_url_id, snapshot_id, severity, issue_type, previous_value, current_value)
    VALUES (NEW.monitored_url_id, NEW.id, 'warning', 'destination_changed', prev.final_url, NEW.final_url);
    new_severity := COALESCE(new_severity, 'warning');
  END IF;

  -- Title changed
  IF prev.id IS NOT NULL AND prev.page_title IS DISTINCT FROM NEW.page_title THEN
    INSERT INTO public.url_issues(monitored_url_id, snapshot_id, severity, issue_type, previous_value, current_value)
    VALUES (NEW.monitored_url_id, NEW.id, 'watch', 'title_changed', prev.page_title, NEW.page_title);
    new_severity := COALESCE(new_severity, 'watch');
  END IF;

  -- Canonical changed
  IF prev.id IS NOT NULL AND prev.canonical_url IS DISTINCT FROM NEW.canonical_url THEN
    INSERT INTO public.url_issues(monitored_url_id, snapshot_id, severity, issue_type, previous_value, current_value)
    VALUES (NEW.monitored_url_id, NEW.id, 'watch', 'canonical_changed', prev.canonical_url, NEW.canonical_url);
    new_severity := COALESCE(new_severity, 'watch');
  END IF;

  -- Update parent monitored_urls
  UPDATE public.monitored_urls
  SET current_http_status = NEW.http_status,
      last_checked_at = NEW.checked_at,
      current_status = CASE
        WHEN NEW.http_status IS NULL OR NEW.http_status >= 400 THEN 'critical'
        WHEN new_severity = 'warning' THEN 'warning'
        WHEN NEW.http_status BETWEEN 200 AND 399 THEN 'ok'
        ELSE 'unknown'
      END
  WHERE id = NEW.monitored_url_id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_url_snapshot_detect_issues
AFTER INSERT ON public.url_check_snapshots
FOR EACH ROW EXECUTE FUNCTION public.url_snapshot_detect_issues();
