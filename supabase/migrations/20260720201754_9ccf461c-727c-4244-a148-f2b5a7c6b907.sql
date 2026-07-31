-- 1. Relax rank ceiling from 20 to 30 to admit the rank-tail band.
ALTER TABLE public.ctr_curves DROP CONSTRAINT IF EXISTS ctr_curves_rank_position_check;
ALTER TABLE public.ctr_curves ADD CONSTRAINT ctr_curves_rank_position_check
  CHECK (rank_position >= 1 AND rank_position <= 30);

-- 2. Extend the global fallback ladder from r20 to r30 (INSERT-only).
--    Geometric decay anchored at the r10->r20 tail (per-step ratio ≈ 0.826),
--    rounded to 2dp and enforced monotone-non-increasing:
--      r21 0.25  r22 0.20  r23 0.17  r24 0.14  r25 0.12
--      r26 0.10  r27 0.08  r28 0.07  r29 0.06  r30 0.05
INSERT INTO public.ctr_curves
  (project_id, device, intent_segment, rank_position, ctr_percentage, is_fallback)
SELECT NULL, d.device, i.intent_segment, r.rank_position, r.ctr_percentage, TRUE
FROM (VALUES ('all'), ('mobile'), ('desktop')) AS d(device)
CROSS JOIN (VALUES
  ('transactional'::text),
  ('commercial'),
  ('informational'),
  ('navigational'),
  ('generic'),
  (NULL)
) AS i(intent_segment)
CROSS JOIN (VALUES
  (21, 0.25::numeric), (22, 0.20), (23, 0.17), (24, 0.14), (25, 0.12),
  (26, 0.10),          (27, 0.08), (28, 0.07), (29, 0.06), (30, 0.05)
) AS r(rank_position, ctr_percentage)
WHERE NOT EXISTS (
  SELECT 1 FROM public.ctr_curves c
  WHERE c.project_id IS NULL
    AND c.is_fallback = TRUE
    AND c.device = d.device
    AND c.rank_position = r.rank_position
    AND c.intent_segment IS NOT DISTINCT FROM i.intent_segment
);