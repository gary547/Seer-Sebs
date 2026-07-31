-- SVM orphan seeds round 2: ai_overview intent-tiered + images/PAS/find_results_on.
-- Additive INSERT-only. No existing rows modified.
-- ai_overview device='all', intent-tiered:
INSERT INTO public.serp_feature_ctr_adjustments (feature_type, device, intent, multiplier, confidence, is_active, notes)
VALUES
  ('ai_overview', 'all', 'informational',  0.65, 'low', true, 'provisional seed — review at Gate B calibration'),
  ('ai_overview', 'all', 'commercial',     0.85, 'low', true, 'provisional seed — review at Gate B calibration'),
  ('ai_overview', 'all', 'transactional',  0.90, 'low', true, 'provisional seed — review at Gate B calibration'),
  ('ai_overview', 'all', 'navigational',   0.95, 'low', true, 'provisional seed — review at Gate B calibration'),
  ('ai_overview', 'all', 'generic',        0.80, 'low', true, 'provisional seed — review at Gate B calibration'),
  -- images at all/generic must match existing image_pack all/generic row (0.90)
  ('images',              'all', 'generic', 0.90, 'low', true, 'provisional seed — alias of image_pack (all/generic=0.90); review at Gate B'),
  ('people_also_search',  'all', 'generic', 0.95, 'low', true, 'provisional seed — review at Gate B calibration'),
  ('find_results_on',     'all', 'generic', 0.95, 'low', true, 'provisional seed — review at Gate B calibration');