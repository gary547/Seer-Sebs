
-- Content Planner tables

CREATE TABLE public.content_plans (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id UUID NOT NULL,
  project_id UUID NOT NULL,
  name TEXT NOT NULL,
  start_month DATE,
  end_month DATE,
  mix JSONB NOT NULL DEFAULT '{"hero":2,"blog":6,"page":2,"category":1,"product":1}'::jsonb,
  default_lead_weeks INTEGER NOT NULL DEFAULT 12,
  hero_lead_weeks INTEGER NOT NULL DEFAULT 16,
  status TEXT NOT NULL DEFAULT 'briefed',
  total_revenue_gain NUMERIC,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_content_plans_client ON public.content_plans(client_id);
CREATE INDEX idx_content_plans_project ON public.content_plans(project_id);

CREATE POLICY "Internal users full access to content_plans"
ON public.content_plans FOR ALL TO authenticated
USING (get_user_role(auth.uid()) = ANY (ARRAY['super_admin','admin','user']))
WITH CHECK (get_user_role(auth.uid()) = ANY (ARRAY['super_admin','admin','user']));

CREATE POLICY "View-only see assigned content_plans"
ON public.content_plans FOR SELECT TO authenticated
USING ((get_user_role(auth.uid()) = 'view_only') AND (client_id IN (
  SELECT user_client_access.client_id FROM user_client_access
  WHERE user_client_access.user_id = auth.uid()
)));

CREATE TRIGGER update_content_plans_updated_at
BEFORE UPDATE ON public.content_plans
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


CREATE TABLE public.content_plan_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  plan_id UUID NOT NULL REFERENCES public.content_plans(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  content_format TEXT NOT NULL, -- hero | blog | page | category | product
  content_action TEXT, -- optimise | create | watch
  primary_keyword_id UUID,
  secondary_keyword_ids UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  primary_keyword_text TEXT,
  secondary_keyword_text TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  recommended_url TEXT,
  page_title_h1 TEXT,
  synopsis TEXT,
  meta_title TEXT,
  meta_description TEXT,
  internal_links JSONB NOT NULL DEFAULT '[]'::jsonb,
  inbound_links JSONB NOT NULL DEFAULT '[]'::jsonb,
  serp_top3 JSONB NOT NULL DEFAULT '[]'::jsonb,
  serp_fetched_at TIMESTAMPTZ,
  potential_revenue_gain NUMERIC,
  audience TEXT,
  journey_stage TEXT,
  business_area TEXT,
  campaign_tie_in TEXT,
  responsibility TEXT,
  first_draft_deadline DATE,
  publish_month DATE,
  cluster_score NUMERIC,
  hero_promoted BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'queued',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_content_plan_items_plan ON public.content_plan_items(plan_id);

CREATE POLICY "Internal users full access to content_plan_items"
ON public.content_plan_items FOR ALL TO authenticated
USING (get_user_role(auth.uid()) = ANY (ARRAY['super_admin','admin','user']))
WITH CHECK (get_user_role(auth.uid()) = ANY (ARRAY['super_admin','admin','user']));

CREATE POLICY "View-only see assigned content_plan_items"
ON public.content_plan_items FOR SELECT TO authenticated
USING ((get_user_role(auth.uid()) = 'view_only') AND (plan_id IN (
  SELECT cp.id FROM content_plans cp
  JOIN user_client_access uca ON uca.client_id = cp.client_id
  WHERE uca.user_id = auth.uid()
)));

CREATE TRIGGER update_content_plan_items_updated_at
BEFORE UPDATE ON public.content_plan_items
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


CREATE TABLE public.content_plan_jobs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  plan_id UUID REFERENCES public.content_plans(id) ON DELETE CASCADE,
  client_id UUID NOT NULL,
  project_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | error
  total INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE POLICY "Internal users full access to content_plan_jobs"
ON public.content_plan_jobs FOR ALL TO authenticated
USING (get_user_role(auth.uid()) = ANY (ARRAY['super_admin','admin','user']))
WITH CHECK (get_user_role(auth.uid()) = ANY (ARRAY['super_admin','admin','user']));

CREATE TRIGGER update_content_plan_jobs_updated_at
BEFORE UPDATE ON public.content_plan_jobs
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


CREATE TABLE public.serp_top3_cache (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  keyword_text TEXT NOT NULL,
  location_code INTEGER NOT NULL DEFAULT 2826, -- UK
  language_code TEXT NOT NULL DEFAULT 'en',
  results JSONB NOT NULL DEFAULT '[]'::jsonb,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (keyword_text, location_code, language_code)
);

CREATE INDEX idx_serp_top3_cache_keyword ON public.serp_top3_cache(keyword_text);

CREATE POLICY "Authenticated read serp_top3_cache"
ON public.serp_top3_cache FOR SELECT TO authenticated
USING (true);

CREATE POLICY "Internal users manage serp_top3_cache"
ON public.serp_top3_cache FOR ALL TO authenticated
USING (get_user_role(auth.uid()) = ANY (ARRAY['super_admin','admin','user']))
WITH CHECK (get_user_role(auth.uid()) = ANY (ARRAY['super_admin','admin','user']));
