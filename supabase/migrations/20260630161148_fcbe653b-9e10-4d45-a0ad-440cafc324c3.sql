CREATE OR REPLACE FUNCTION public.archive_client(_client_id uuid, _reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_now timestamptz := now();
  v_actor uuid := auth.uid();
  v_cascaded uuid[];
BEGIN
  PERFORM public._require_admin();

  UPDATE public.clients
     SET archived_at = v_now, archived_by = v_actor, archive_reason = _reason
   WHERE id = _client_id AND archived_at IS NULL;

  UPDATE public.navigator_projects
     SET archived_at = v_now, archived_by = v_actor, archive_reason = COALESCE(_reason, 'Cascaded from client archive')
   WHERE client_id = _client_id AND archived_at IS NULL;

  SELECT array_agg(id) INTO v_cascaded
    FROM public.navigator_projects
   WHERE client_id = _client_id AND archived_at = v_now;

  PERFORM set_config('app.audit_writer','rpc', true);
  INSERT INTO public.archive_audit(entity_type, entity_id, client_id, action, actor_id, reason, metadata)
  VALUES ('client', _client_id, _client_id, 'archive', v_actor, _reason,
          jsonb_build_object('cascaded_project_ids', COALESCE(to_jsonb(v_cascaded), '[]'::jsonb), 'archived_at', v_now));
END$function$;

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
BEGIN
  PERFORM public._require_admin();

  SELECT archived_at INTO v_ts FROM public.clients WHERE id = _client_id;
  IF v_ts IS NULL THEN
    RETURN;
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