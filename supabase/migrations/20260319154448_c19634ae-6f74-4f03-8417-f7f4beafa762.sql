
-- keywords table
CREATE TABLE public.keywords (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.navigator_projects(id) ON DELETE CASCADE,
  keyword text NOT NULL,
  device text NOT NULL DEFAULT 'mobile' CHECK (device IN ('mobile', 'desktop')),
  source text CHECK (source IN ('dataforseo', 'ahrefs', 'gsc', 'all', 'manual')),
  avg_monthly_volume integer,
  base_rank integer,
  ranking_url text,
  tag_1 text,
  tag_2 text,
  tag_3 text,
  tag_4 text,
  tag_5 text,
  kw_cluster text,
  detox_status text NOT NULL DEFAULT 'pending' CHECK (detox_status IN ('pending', 'keep', 'flagged_remove', 'removed')),
  detox_reason text,
  human_reviewed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- keyword_monthly_volumes table
CREATE TABLE public.keyword_monthly_volumes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword_id uuid NOT NULL REFERENCES public.keywords(id) ON DELETE CASCADE,
  month date NOT NULL,
  volume integer NOT NULL
);

-- ctr_curves table
CREATE TABLE public.ctr_curves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.navigator_projects(id) ON DELETE CASCADE,
  device text NOT NULL CHECK (device IN ('mobile', 'desktop')),
  rank_position integer NOT NULL CHECK (rank_position BETWEEN 1 AND 20),
  ctr_percentage numeric NOT NULL,
  is_fallback boolean NOT NULL DEFAULT false
);

-- serp_rankings table
CREATE TABLE public.serp_rankings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword_id uuid NOT NULL REFERENCES public.keywords(id) ON DELETE CASCADE,
  rank_position integer NOT NULL CHECK (rank_position BETWEEN 1 AND 20),
  ranking_url text,
  ranking_domain text,
  is_our_domain boolean NOT NULL DEFAULT false
);

-- backlink_metrics table
CREATE TABLE public.backlink_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  serp_ranking_id uuid NOT NULL REFERENCES public.serp_rankings(id) ON DELETE CASCADE,
  url_rating numeric,
  domain_rating numeric,
  referring_domains integer,
  backlinks_total integer
);

-- Indexes
CREATE INDEX idx_keywords_project_id ON public.keywords(project_id);
CREATE INDEX idx_keywords_keyword ON public.keywords(keyword);
CREATE INDEX idx_keyword_monthly_volumes_keyword_id ON public.keyword_monthly_volumes(keyword_id);
CREATE INDEX idx_serp_rankings_keyword_id ON public.serp_rankings(keyword_id);
CREATE INDEX idx_ctr_curves_project_id ON public.ctr_curves(project_id);

-- RLS policies (authenticated full access, to be tightened later)
CREATE POLICY "Authenticated full access" ON public.keywords FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON public.keyword_monthly_volumes FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON public.ctr_curves FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON public.serp_rankings FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON public.backlink_metrics FOR ALL TO authenticated USING (true) WITH CHECK (true);
