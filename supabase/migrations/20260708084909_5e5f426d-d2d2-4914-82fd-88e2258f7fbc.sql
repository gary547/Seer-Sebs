
-- Phase 1.3: v2 output tables

-- Additive unique index on v1 ctr_curves
CREATE UNIQUE INDEX IF NOT EXISTS ctr_curves_project_device_intent_rank_uq
  ON public.ctr_curves(project_id, device, intent_segment, rank_position);

-- A. ctr_curve_metadata
CREATE TABLE public.ctr_curve_metadata (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.navigator_projects(id) ON DELETE CASCADE,
  ctr_curve_id uuid NOT NULL REFERENCES public.ctr_curves(id) ON DELETE CASCADE,
  calc_run_id uuid NULL REFERENCES public.calc_run_registry(id) ON DELETE SET NULL,
  source text NOT NULL,
  sample_impressions bigint NOT NULL DEFAULT 0,
  sample_clicks bigint NOT NULL DEFAULT 0,
  confidence text NOT NULL DEFAULT 'low',
  date_range_start date NULL,
  date_range_end date NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ctr_curve_metadata_ctr_curve_id_uq UNIQUE (ctr_curve_id),
  CONSTRAINT ctr_curve_metadata_confidence_chk CHECK (confidence IN ('low','medium','high'))
);
CREATE INDEX ctr_curve_metadata_project_idx ON public.ctr_curve_metadata(project_id);
CREATE INDEX ctr_curve_metadata_calc_run_idx ON public.ctr_curve_metadata(calc_run_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ctr_curve_metadata TO authenticated;
GRANT ALL ON public.ctr_curve_metadata TO service_role;
ALTER TABLE public.ctr_curve_metadata ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ctr_curve_metadata_select" ON public.ctr_curve_metadata FOR SELECT TO authenticated
  USING (public.get_user_role(auth.uid()) IN ('super_admin','admin','user','view_only'));
CREATE POLICY "ctr_curve_metadata_write" ON public.ctr_curve_metadata FOR ALL TO authenticated
  USING (public.get_user_role(auth.uid()) IN ('super_admin','admin'))
  WITH CHECK (public.get_user_role(auth.uid()) IN ('super_admin','admin'));

-- B. link_power_scores
CREATE TABLE public.link_power_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.navigator_projects(id) ON DELETE CASCADE,
  calc_run_id uuid NOT NULL REFERENCES public.calc_run_registry(id) ON DELETE CASCADE,
  serp_result_id uuid NULL REFERENCES public.serp_results(id) ON DELETE SET NULL,
  keyword_id uuid NULL REFERENCES public.keywords(id) ON DELETE CASCADE,
  url text NOT NULL,
  domain text NULL,
  rank_absolute integer NULL,
  lps_score numeric NOT NULL,
  components_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence text NOT NULL DEFAULT 'medium',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT link_power_scores_confidence_chk CHECK (confidence IN ('low','medium','high'))
);
CREATE INDEX link_power_scores_calc_run_idx ON public.link_power_scores(calc_run_id);
CREATE INDEX link_power_scores_project_keyword_idx ON public.link_power_scores(project_id, keyword_id);
CREATE INDEX link_power_scores_project_domain_idx ON public.link_power_scores(project_id, domain);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.link_power_scores TO authenticated;
GRANT ALL ON public.link_power_scores TO service_role;
ALTER TABLE public.link_power_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "link_power_scores_select" ON public.link_power_scores FOR SELECT TO authenticated
  USING (public.get_user_role(auth.uid()) IN ('super_admin','admin','user','view_only'));
CREATE POLICY "link_power_scores_write" ON public.link_power_scores FOR ALL TO authenticated
  USING (public.get_user_role(auth.uid()) IN ('super_admin','admin'))
  WITH CHECK (public.get_user_role(auth.uid()) IN ('super_admin','admin'));

-- C. keyword_forecast_scenarios
CREATE TABLE public.keyword_forecast_scenarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.navigator_projects(id) ON DELETE CASCADE,
  keyword_id uuid NOT NULL REFERENCES public.keywords(id) ON DELETE CASCADE,
  calc_run_id uuid NOT NULL REFERENCES public.calc_run_registry(id) ON DELETE CASCADE,
  scenario text NOT NULL,
  har_position numeric NULL,
  har_confidence numeric NULL,
  rank_attainment_probability numeric NULL,
  authority_score numeric NULL,
  link_power_score numeric NULL,
  link_gap_score numeric NULL,
  content_fit_score numeric NULL,
  serp_visibility_multiplier numeric NULL,
  current_revenue_annual numeric NULL,
  tp_absolute_revenue_annual numeric NULL,
  tp_incremental_revenue_annual numeric NULL,
  expected_incremental_revenue_annual numeric NULL,
  monthly_revenue_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  explanation_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kfs_scenario_chk CHECK (scenario IN ('conservative','realistic','stretch')),
  CONSTRAINT kfs_keyword_run_scenario_uq UNIQUE (keyword_id, calc_run_id, scenario)
);
CREATE INDEX kfs_calc_run_idx ON public.keyword_forecast_scenarios(calc_run_id);
CREATE INDEX kfs_project_scenario_idx ON public.keyword_forecast_scenarios(project_id, scenario);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.keyword_forecast_scenarios TO authenticated;
GRANT ALL ON public.keyword_forecast_scenarios TO service_role;
ALTER TABLE public.keyword_forecast_scenarios ENABLE ROW LEVEL SECURITY;
CREATE POLICY "kfs_select" ON public.keyword_forecast_scenarios FOR SELECT TO authenticated
  USING (public.get_user_role(auth.uid()) IN ('super_admin','admin','user','view_only'));
CREATE POLICY "kfs_write" ON public.keyword_forecast_scenarios FOR ALL TO authenticated
  USING (public.get_user_role(auth.uid()) IN ('super_admin','admin'))
  WITH CHECK (public.get_user_role(auth.uid()) IN ('super_admin','admin'));

-- D. project_conversion_overrides
CREATE TABLE public.project_conversion_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.navigator_projects(id) ON DELETE CASCADE,
  scope_type text NOT NULL,
  scope_value text NULL,
  conversion_rate numeric NULL,
  average_order_value numeric NULL,
  source text NOT NULL DEFAULT 'manual',
  confidence text NOT NULL DEFAULT 'medium',
  note text NULL,
  created_by uuid NULL,
  updated_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pco_scope_type_chk CHECK (scope_type IN ('project','url','category','intent')),
  CONSTRAINT pco_confidence_chk CHECK (confidence IN ('low','medium','high')),
  CONSTRAINT pco_conversion_rate_chk CHECK (conversion_rate IS NULL OR conversion_rate >= 0),
  CONSTRAINT pco_aov_chk CHECK (average_order_value IS NULL OR average_order_value >= 0),
  CONSTRAINT pco_note_required_chk CHECK (
    scope_type NOT IN ('url','category') OR (note IS NOT NULL AND length(btrim(note)) > 0)
  ),
  CONSTRAINT pco_scope_uq UNIQUE (project_id, scope_type, scope_value)
);
CREATE INDEX pco_project_idx ON public.project_conversion_overrides(project_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_conversion_overrides TO authenticated;
GRANT ALL ON public.project_conversion_overrides TO service_role;
ALTER TABLE public.project_conversion_overrides ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pco_select" ON public.project_conversion_overrides FOR SELECT TO authenticated
  USING (public.get_user_role(auth.uid()) IN ('super_admin','admin','user','view_only'));
CREATE POLICY "pco_write" ON public.project_conversion_overrides FOR ALL TO authenticated
  USING (public.get_user_role(auth.uid()) IN ('super_admin','admin'))
  WITH CHECK (public.get_user_role(auth.uid()) IN ('super_admin','admin'));
CREATE TRIGGER pco_set_updated_at BEFORE UPDATE ON public.project_conversion_overrides
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- E. keyword_demand_signals
CREATE TABLE public.keyword_demand_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.navigator_projects(id) ON DELETE CASCADE,
  keyword_id uuid NOT NULL REFERENCES public.keywords(id) ON DELETE CASCADE,
  calc_run_id uuid NOT NULL REFERENCES public.calc_run_registry(id) ON DELETE CASCADE,
  data_coverage_months smallint NOT NULL,
  trend_direction text NOT NULL,
  trend_pct numeric NULL,
  trend_slope numeric NULL,
  trend_confidence text NOT NULL DEFAULT 'low',
  volatility_score numeric NULL,
  seasonality_strength numeric NULL,
  peak_months_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  shoulder_months_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  demand_warning boolean NOT NULL DEFAULT false,
  demand_warning_reason text NULL,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kds_trend_direction_chk CHECK (trend_direction IN ('up','down','flat','volatile','insufficient_data')),
  CONSTRAINT kds_trend_confidence_chk CHECK (trend_confidence IN ('low','medium','high'))
);
CREATE INDEX kds_calc_run_idx ON public.keyword_demand_signals(calc_run_id);
CREATE INDEX kds_project_keyword_idx ON public.keyword_demand_signals(project_id, keyword_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.keyword_demand_signals TO authenticated;
GRANT ALL ON public.keyword_demand_signals TO service_role;
ALTER TABLE public.keyword_demand_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "kds_select" ON public.keyword_demand_signals FOR SELECT TO authenticated
  USING (public.get_user_role(auth.uid()) IN ('super_admin','admin','user','view_only'));
CREATE POLICY "kds_write" ON public.keyword_demand_signals FOR ALL TO authenticated
  USING (public.get_user_role(auth.uid()) IN ('super_admin','admin'))
  WITH CHECK (public.get_user_role(auth.uid()) IN ('super_admin','admin'));

-- F. category_demand_signals
CREATE TABLE public.category_demand_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.navigator_projects(id) ON DELETE CASCADE,
  calc_run_id uuid NOT NULL REFERENCES public.calc_run_registry(id) ON DELETE CASCADE,
  tag_1 text NULL,
  tag_2 text NULL,
  intent text NULL,
  brand_type text NULL DEFAULT 'mixed',
  trend_direction text NOT NULL,
  trend_pct numeric NULL,
  trend_confidence text NOT NULL DEFAULT 'low',
  seasonality_strength numeric NULL,
  peak_months_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  keyword_count integer NOT NULL DEFAULT 0,
  total_volume numeric NULL,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cds_trend_direction_chk CHECK (trend_direction IN ('up','down','flat','volatile','insufficient_data')),
  CONSTRAINT cds_trend_confidence_chk CHECK (trend_confidence IN ('low','medium','high')),
  CONSTRAINT cds_brand_type_chk CHECK (brand_type IS NULL OR brand_type IN ('brand','non_brand','mixed'))
);
CREATE INDEX cds_calc_run_idx ON public.category_demand_signals(calc_run_id);
CREATE INDEX cds_project_group_idx ON public.category_demand_signals(project_id, tag_1, tag_2, intent);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.category_demand_signals TO authenticated;
GRANT ALL ON public.category_demand_signals TO service_role;
ALTER TABLE public.category_demand_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cds_select" ON public.category_demand_signals FOR SELECT TO authenticated
  USING (public.get_user_role(auth.uid()) IN ('super_admin','admin','user','view_only'));
CREATE POLICY "cds_write" ON public.category_demand_signals FOR ALL TO authenticated
  USING (public.get_user_role(auth.uid()) IN ('super_admin','admin'))
  WITH CHECK (public.get_user_role(auth.uid()) IN ('super_admin','admin'));
