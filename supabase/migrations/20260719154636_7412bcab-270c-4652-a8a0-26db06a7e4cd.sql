-- Measured (is_fallback=false) and fallback (is_fallback=true) curves must
-- coexist per (project, device, intent, rank). The v2 resolver's tier ladder
-- (project_device_intent → project_all_intent → project_*_generic →
-- fallback_*) depends on both rows being present in the same slot.
DROP INDEX IF EXISTS public.ctr_curves_project_device_rank_intent;
DROP INDEX IF EXISTS public.ctr_curves_project_device_intent_rank_uq;

CREATE UNIQUE INDEX IF NOT EXISTS ctr_curves_project_device_intent_rank_fallback_uq
  ON public.ctr_curves (
    project_id,
    device,
    COALESCE(intent_segment, ''),
    rank_position,
    is_fallback
  );