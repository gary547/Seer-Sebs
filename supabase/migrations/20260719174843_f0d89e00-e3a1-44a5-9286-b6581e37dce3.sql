-- CTR curves provenance hotfix: purge legacy v1-origin project-scoped fallback rows.
-- These rows were persisted by the v1 setup-page writer (src/components/CtrCurveSection.tsx)
-- with is_fallback=true scoped to a project_id. After the writer honesty fix
-- (empty-bucket ranks no longer persisted as is_fallback=false), the resolver
-- would otherwise resolve empty slots through these v1 project rows instead of
-- the intended global seed ladder. Global seeds (project_id IS NULL,
-- is_fallback=true) are NOT touched.

DO $$
DECLARE
  v_row_count bigint;
  v_project_count bigint;
BEGIN
  SELECT COUNT(*), COUNT(DISTINCT project_id)
    INTO v_row_count, v_project_count
  FROM public.ctr_curves
  WHERE is_fallback = true AND project_id IS NOT NULL;

  RAISE NOTICE 'ctr_curves cleanup: deleting % project-scoped fallback rows across % projects',
    v_row_count, v_project_count;
END $$;

DELETE FROM public.ctr_curves
WHERE is_fallback = true
  AND project_id IS NOT NULL;
