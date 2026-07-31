
CREATE TABLE public.serp_feature_ctr_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_type text NOT NULL,
  device text NOT NULL DEFAULT 'all',
  intent text NOT NULL DEFAULT 'generic',
  multiplier numeric NOT NULL,
  confidence text NOT NULL DEFAULT 'medium',
  notes text NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT serp_feature_ctr_adjustments_multiplier_positive
    CHECK (multiplier > 0 AND multiplier <= 2),
  CONSTRAINT serp_feature_ctr_adjustments_confidence_check
    CHECK (confidence IN ('low','medium','high'))
);

CREATE INDEX serp_feature_ctr_adjustments_lookup_idx
  ON public.serp_feature_ctr_adjustments (feature_type, device, intent) WHERE is_active;

CREATE TABLE public.har_scoring_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version text NOT NULL,
  is_active boolean NOT NULL DEFAULT false,
  weights_json jsonb NOT NULL,
  thresholds_json jsonb NOT NULL,
  notes text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT har_scoring_config_version_unique UNIQUE (version)
);

CREATE UNIQUE INDEX har_scoring_config_single_active_idx
  ON public.har_scoring_config ((is_active)) WHERE is_active;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.serp_feature_ctr_adjustments TO authenticated;
GRANT ALL ON public.serp_feature_ctr_adjustments TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.har_scoring_config TO authenticated;
GRANT ALL ON public.har_scoring_config TO service_role;

ALTER TABLE public.serp_feature_ctr_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.har_scoring_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Internal roles read serp adjustments"
  ON public.serp_feature_ctr_adjustments FOR SELECT TO authenticated
  USING (public.get_user_role(auth.uid()) IN ('super_admin','admin','user','view_only'));

CREATE POLICY "Admins manage serp adjustments"
  ON public.serp_feature_ctr_adjustments FOR ALL TO authenticated
  USING (public.get_user_role(auth.uid()) IN ('super_admin','admin'))
  WITH CHECK (public.get_user_role(auth.uid()) IN ('super_admin','admin'));

CREATE POLICY "Internal roles read har config"
  ON public.har_scoring_config FOR SELECT TO authenticated
  USING (public.get_user_role(auth.uid()) IN ('super_admin','admin','user','view_only'));

CREATE POLICY "Admins manage har config"
  ON public.har_scoring_config FOR ALL TO authenticated
  USING (public.get_user_role(auth.uid()) IN ('super_admin','admin'))
  WITH CHECK (public.get_user_role(auth.uid()) IN ('super_admin','admin'));

CREATE TRIGGER trg_serp_feature_ctr_adjustments_updated_at
  BEFORE UPDATE ON public.serp_feature_ctr_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER trg_har_scoring_config_updated_at
  BEFORE UPDATE ON public.har_scoring_config
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.serp_feature_ctr_adjustments (feature_type, device, intent, multiplier, confidence, notes) VALUES
  ('organic_default',  'all', 'generic',        1.00, 'high',   'Clean/default SERP baseline'),
  ('featured_snippet', 'all', 'generic',        0.85, 'medium', 'Answer box deflation'),
  ('people_also_ask',  'all', 'generic',        0.90, 'medium', 'PAA-heavy SERP'),
  ('local_pack',       'all', 'generic',        0.70, 'medium', 'Local pack pulls click share'),
  ('shopping',         'all', 'commercial',     0.60, 'medium', 'Shopping-heavy commercial SERP'),
  ('shopping',         'all', 'transactional',  0.60, 'medium', 'Shopping-heavy transactional SERP'),
  ('video_carousel',   'all', 'informational',  0.75, 'low',    'Video-heavy informational (intent-dependent)'),
  ('video_carousel',   'all', 'generic',        0.85, 'low',    'Video-heavy default — conservative'),
  ('image_pack',       'all', 'informational',  0.85, 'low',    'Image pack informational'),
  ('image_pack',       'all', 'generic',        0.90, 'low',    'Image pack default — conservative');

INSERT INTO public.har_scoring_config (version, is_active, weights_json, thresholds_json, notes) VALUES
  ('har_v2.0.0', true,
    '{"link_power_score":0.35,"content_fit_score":0.25,"serp_visibility_multiplier":0.20,"link_gap_score":0.20}'::jsonb,
    '{"conservative_percentile":0.75,"realistic_percentile":0.50,"stretch_percentile":0.25,"min_confidence":0.4,"observed_rank_clamp_delta":5}'::jsonb,
    'Baseline v2 config for admin-triggered test runs. Semantics finalised in Prompt 9.2.'),
  ('har_v2.0.0-draft', false,
    '{"link_power_score":0.35,"content_fit_score":0.25,"serp_visibility_multiplier":0.20,"link_gap_score":0.20}'::jsonb,
    '{"conservative_percentile":0.75,"realistic_percentile":0.50,"stretch_percentile":0.25,"min_confidence":0.4,"observed_rank_clamp_delta":5}'::jsonb,
    'Draft slot for Prompt 9.2 tuning; edit-in-place before promoting to active.');
