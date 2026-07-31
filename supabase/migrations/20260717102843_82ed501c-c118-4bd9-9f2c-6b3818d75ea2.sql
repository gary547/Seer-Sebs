UPDATE public.har_scoring_config
SET thresholds_json = thresholds_json || jsonb_build_object(
  'scenario_thresholds', jsonb_build_object('conservative', 0.60, 'realistic', 0.50, 'stretch', 0.40),
  'scenario_temperatures', jsonb_build_object('conservative', 1.6, 'realistic', 1.0, 'stretch', 0.7),
  'scenario_floor_multipliers', jsonb_build_object('conservative', 0.7, 'realistic', 0.5, 'stretch', 0.3),
  'scenario_prob_factors', jsonb_build_object('conservative', 0.85, 'realistic', 1.0, 'stretch', 1.15)
)
WHERE is_active = true;