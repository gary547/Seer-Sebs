ALTER TABLE public.keyword_demand_signals DROP CONSTRAINT IF EXISTS kds_trend_direction_chk;
ALTER TABLE public.keyword_demand_signals ADD CONSTRAINT kds_trend_direction_chk CHECK (trend_direction = ANY (ARRAY['growing','stable','declining','volatile','insufficient_data']));

ALTER TABLE public.category_demand_signals DROP CONSTRAINT IF EXISTS cds_trend_direction_chk;
ALTER TABLE public.category_demand_signals ADD CONSTRAINT cds_trend_direction_chk CHECK (trend_direction = ANY (ARRAY['growing','stable','declining','volatile','insufficient_data']));

UPDATE public.calc_run_registry
SET status = 'failed',
    finished_at = now(),
    errors = COALESCE(errors, '[]'::jsonb) ||
             '[{"code":"stale_running","message":"Row left in running state before constraint fix; closed by maintenance."}]'::jsonb
WHERE model_version = 'demand_signals_v1.0.0'
  AND status = 'running'
  AND started_at < now() - interval '5 minutes';