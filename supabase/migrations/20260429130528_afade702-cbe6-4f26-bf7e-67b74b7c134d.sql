CREATE OR REPLACE FUNCTION public.url_snapshot_detect_issues()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- Title changed (now warning)
  IF prev.id IS NOT NULL AND prev.page_title IS DISTINCT FROM NEW.page_title THEN
    INSERT INTO public.url_issues(monitored_url_id, snapshot_id, severity, issue_type, previous_value, current_value)
    VALUES (NEW.monitored_url_id, NEW.id, 'warning', 'title_changed', prev.page_title, NEW.page_title);
    new_severity := COALESCE(new_severity, 'warning');
  END IF;

  -- Canonical changed (now warning)
  IF prev.id IS NOT NULL AND prev.canonical_url IS DISTINCT FROM NEW.canonical_url THEN
    INSERT INTO public.url_issues(monitored_url_id, snapshot_id, severity, issue_type, previous_value, current_value)
    VALUES (NEW.monitored_url_id, NEW.id, 'warning', 'canonical_changed', prev.canonical_url, NEW.canonical_url);
    new_severity := COALESCE(new_severity, 'warning');
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
$function$;