-- global fallback ladder — replaces the deleted per-project seed copies; single source, resolver tiers 5-7.

-- 1. Allow global rows (project_id IS NULL)
ALTER TABLE public.ctr_curves ALTER COLUMN project_id DROP NOT NULL;

-- 2. Replace unique index so NULL project_id collides via COALESCE
DROP INDEX IF EXISTS public.ctr_curves_project_device_intent_rank_fallback_uq;
CREATE UNIQUE INDEX ctr_curves_project_device_intent_rank_fallback_uq
  ON public.ctr_curves (
    COALESCE(project_id::text, ''),
    device,
    COALESCE(intent_segment, ''),
    rank_position,
    is_fallback
  );

-- 3. Seed the global fallback ladder.
-- Values sourced verbatim from STANDARD_CTR in
-- supabase/functions/ctr-curves-from-gsc/index.ts (r1=28 … r20=0.3).
-- Devices: mobile/desktop/all. Intents: transactional/commercial/informational/
-- navigational/generic + NULL (matches resolver's generic/null segment).
WITH ranks(rank_position, ctr_percentage) AS (
  VALUES
    (1, 28.0), (2, 15.0), (3, 11.0), (4, 8.0),  (5, 7.0),
    (6, 5.0),  (7, 4.0),  (8, 3.0),  (9, 2.5),  (10, 2.0),
    (11, 1.5), (12, 1.2), (13, 1.0), (14, 0.9), (15, 0.8),
    (16, 0.7), (17, 0.6), (18, 0.5), (19, 0.4), (20, 0.3)
),
devices(device) AS (VALUES ('mobile'), ('desktop'), ('all')),
intents(intent_segment) AS (
  VALUES ('transactional'), ('commercial'), ('informational'),
         ('navigational'), ('generic'), (NULL)
)
INSERT INTO public.ctr_curves
  (project_id, device, intent_segment, rank_position, ctr_percentage, is_fallback)
SELECT NULL, d.device, i.intent_segment, r.rank_position, r.ctr_percentage, true
  FROM devices d
 CROSS JOIN intents i
 CROSS JOIN ranks r
ON CONFLICT DO NOTHING;
