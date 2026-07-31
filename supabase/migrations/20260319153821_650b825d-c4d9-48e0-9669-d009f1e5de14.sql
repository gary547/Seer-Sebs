
-- clients table
CREATE TABLE public.clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name text NOT NULL,
  domain text NOT NULL,
  industry text,
  campaign_type text CHECK (campaign_type IN ('retainer', 'project', 'pitch')),
  brand_type text CHECK (brand_type IN ('ecom', 'lead_gen')),
  team_members text[],
  gsc_connected boolean NOT NULL DEFAULT false,
  analytics_connected boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- competitors table
CREATE TABLE public.competitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  competitor_name text NOT NULL,
  competitor_domain text NOT NULL,
  added_by text CHECK (added_by IN ('client', 'nobrainer')),
  verified boolean NOT NULL DEFAULT false
);

-- navigator_projects table
CREATE TABLE public.navigator_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  project_name text NOT NULL,
  category_focus text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'data_collection', 'review', 'forecast', 'complete')),
  duplicated_from uuid REFERENCES public.navigator_projects(id),
  seasonality_start date,
  seasonality_end date,
  aov numeric,
  conversion_rate numeric,
  ctr numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- keyword_rules table
CREATE TABLE public.keyword_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  rule_type text NOT NULL CHECK (rule_type IN ('whitelist', 'blacklist', 'competitor_brand', 'own_brand')),
  keyword_categorisation text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- updated_at trigger function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_clients_updated_at BEFORE UPDATE ON public.clients FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_navigator_projects_updated_at BEFORE UPDATE ON public.navigator_projects FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- RLS: allow all authenticated users full access (to be tightened later)
CREATE POLICY "Authenticated full access" ON public.clients FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON public.competitors FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON public.navigator_projects FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access" ON public.keyword_rules FOR ALL TO authenticated USING (true) WITH CHECK (true);
