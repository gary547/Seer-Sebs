CREATE OR REPLACE FUNCTION public.restore_client(_client_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_ts timestamptz;
  v_restored uuid[];
  v_domain text;
  v_conflict_name text;
BEGIN
  PERFORM public._require_admin();

  SELECT archived_at, domain_normalized
    INTO v_ts, v_domain
    FROM public.clients
   WHERE id = _client_id;

  IF v_ts IS NULL THEN
    RETURN;
  END IF;

  -- Domain-uniqueness pre-flight: block restore if the domain is now used by
  -- another live client. Surfaces a friendly message instead of a raw 23505.
  IF v_domain IS NOT NULL THEN
    SELECT company_name INTO v_conflict_name
      FROM public.clients
     WHERE domain_normalized = v_domain
       AND archived_at IS NULL
       AND id <> _client_id
     LIMIT 1;

    IF v_conflict_name IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot restore — domain % is now used by another live client (%)', v_domain, v_conflict_name
        USING ERRCODE = '23505';
    END IF;
  END IF;

  UPDATE public.navigator_projects
     SET archived_at = NULL, archived_by = NULL, archive_reason = NULL
   WHERE client_id = _client_id AND archived_at = v_ts;

  SELECT array_agg(id) INTO v_restored
    FROM public.navigator_projects
   WHERE client_id = _client_id AND archived_at IS NULL;

  UPDATE public.clients
     SET archived_at = NULL, archived_by = NULL, archive_reason = NULL
   WHERE id = _client_id;

  PERFORM set_config('app.audit_writer','rpc', true);
  INSERT INTO public.archive_audit(entity_type, entity_id, client_id, action, actor_id, metadata)
  VALUES ('client', _client_id, _client_id, 'restore', v_actor,
          jsonb_build_object('restored_project_ids', COALESCE(to_jsonb(v_restored), '[]'::jsonb), 'matched_archived_at', v_ts));
END$function$;