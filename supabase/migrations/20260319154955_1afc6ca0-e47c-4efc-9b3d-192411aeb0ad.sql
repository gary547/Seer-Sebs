
-- keyword_forecasts table
CREATE TABLE public.keyword_forecasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword_id uuid NOT NULL UNIQUE REFERENCES public.keywords(id) ON DELETE CASCADE,
  har integer,
  har_is_manual boolean NOT NULL DEFAULT false,
  weighted_sum integer,
  opportunity text CHECK (opportunity IN ('opportunity', 'grow', 'improve', 'maintain')),
  current_ctr_pct numeric,
  est_current_clicks_annual numeric,
  est_current_revenue_annual numeric,
  expected_traffic_rank1_annual numeric,
  yearly_traffic_gain_rank1 numeric,
  har_traffic_gain_annual numeric,
  yearly_revenue_gain_rank1 numeric,
  har_revenue_gain_annual numeric
);

-- serp_feature_index table (static 97-row reference)
CREATE TABLE public.serp_feature_index (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  serp_feature_raw text NOT NULL UNIQUE,
  result_type text NOT NULL,
  serp_intent text NOT NULL
);

-- serp_features table
CREATE TABLE public.serp_features (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword_id uuid NOT NULL REFERENCES public.keywords(id) ON DELETE CASCADE,
  serp_feature_count integer,
  top_serp_feature text,
  top_serp_feature_url text,
  serp_feature_owned boolean NOT NULL DEFAULT false
);

-- serp_landscape table
CREATE TABLE public.serp_landscape (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword_id uuid NOT NULL REFERENCES public.keywords(id) ON DELETE CASCADE,
  serp_feature_raw text,
  result_type text,
  serp_intent text,
  ranking_url text,
  owned boolean NOT NULL DEFAULT false
);

-- site_architecture table
CREATE TABLE public.site_architecture (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword_id uuid NOT NULL REFERENCES public.keywords(id) ON DELETE CASCADE,
  matched_url text,
  relevancy_score numeric,
  content_status text CHECK (content_status IN ('green', 'amber', 'red')),
  tactical_rag_status text CHECK (tactical_rag_status IN ('no_action_needed', 'create_content', 'optimise_content', 'new_content', 'green'))
);

-- Indexes
CREATE INDEX idx_keyword_forecasts_keyword_id ON public.keyword_forecasts(keyword_id);
CREATE INDEX idx_serp_features_keyword_id ON public.serp_features(keyword_id);
CREATE INDEX idx_serp_landscape_keyword_id ON public.serp_landscape(keyword_id);
CREATE INDEX idx_site_architecture_keyword_id ON public.site_architecture(keyword_id);

-- RLS policies
CREATE POLICY "Authenticated full access" ON public.keyword_forecasts FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON public.serp_feature_index FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON public.serp_features FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON public.serp_landscape FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON public.site_architecture FOR ALL TO authenticated USING (true) WITH CHECK (true);
