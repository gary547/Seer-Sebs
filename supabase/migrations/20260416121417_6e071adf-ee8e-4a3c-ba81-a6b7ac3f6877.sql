
-- serp_results: top-20 SERP positions per keyword with authority metrics
CREATE TABLE IF NOT EXISTS public.serp_results (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES navigator_projects(id) ON DELETE CASCADE,
  keyword_id          uuid NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  rank_absolute       integer NOT NULL,
  url                 text NOT NULL,
  domain              text NOT NULL,
  url_rating          numeric(5,2),
  domain_rating       numeric(5,2),
  ahrefs_rank         integer,
  referring_domains   integer,
  backlinks           bigint,
  fetched_at          timestamptz DEFAULT now(),
  UNIQUE (keyword_id, rank_absolute)
);

CREATE INDEX idx_serp_results_keyword ON serp_results(keyword_id);
CREATE INDEX idx_serp_results_project ON serp_results(project_id);

ALTER TABLE public.serp_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Internal users full access to serp_results"
  ON public.serp_results FOR ALL TO authenticated
  USING (get_user_role(auth.uid()) IN ('super_admin','admin','user'))
  WITH CHECK (get_user_role(auth.uid()) IN ('super_admin','admin','user'));

CREATE POLICY "View-only see assigned serp_results"
  ON public.serp_results FOR SELECT TO authenticated
  USING (
    get_user_role(auth.uid()) = 'view_only'
    AND keyword_id IN (
      SELECT k.id FROM keywords k
      JOIN navigator_projects np ON np.id = k.project_id
      JOIN user_client_access uca ON uca.client_id = np.client_id
      WHERE uca.user_id = auth.uid()
    )
  );

-- har_results: one row per keyword with calculated HAR position
CREATE TABLE IF NOT EXISTS public.har_results (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES navigator_projects(id) ON DELETE CASCADE,
  keyword_id          uuid NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  har_position        integer,
  client_url_rating   numeric(5,2),
  har_competitor_ur   numeric(5,2),
  har_competitor_url  text,
  calculated_at       timestamptz DEFAULT now(),
  UNIQUE (keyword_id)
);

CREATE INDEX idx_har_results_project ON har_results(project_id);

ALTER TABLE public.har_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Internal users full access to har_results"
  ON public.har_results FOR ALL TO authenticated
  USING (get_user_role(auth.uid()) IN ('super_admin','admin','user'))
  WITH CHECK (get_user_role(auth.uid()) IN ('super_admin','admin','user'));

CREATE POLICY "View-only see assigned har_results"
  ON public.har_results FOR SELECT TO authenticated
  USING (
    get_user_role(auth.uid()) = 'view_only'
    AND keyword_id IN (
      SELECT k.id FROM keywords k
      JOIN navigator_projects np ON np.id = k.project_id
      JOIN user_client_access uca ON uca.client_id = np.client_id
      WHERE uca.user_id = auth.uid()
    )
  );

-- client_domain_metrics: caches client domain authority per project
CREATE TABLE IF NOT EXISTS public.client_domain_metrics (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES navigator_projects(id) ON DELETE CASCADE,
  domain          text NOT NULL,
  url_rating      numeric(5,2),
  domain_rating   numeric(5,2),
  ahrefs_rank     integer,
  fetched_at      timestamptz DEFAULT now(),
  UNIQUE (project_id)
);

ALTER TABLE public.client_domain_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Internal users full access to client_domain_metrics"
  ON public.client_domain_metrics FOR ALL TO authenticated
  USING (get_user_role(auth.uid()) IN ('super_admin','admin','user'))
  WITH CHECK (get_user_role(auth.uid()) IN ('super_admin','admin','user'));

CREATE POLICY "View-only see assigned client_domain_metrics"
  ON public.client_domain_metrics FOR SELECT TO authenticated
  USING (
    get_user_role(auth.uid()) = 'view_only'
    AND project_id IN (
      SELECT np.id FROM navigator_projects np
      JOIN user_client_access uca ON uca.client_id = np.client_id
      WHERE uca.user_id = auth.uid()
    )
  );

-- Grant service_role access for edge function operations
GRANT SELECT, INSERT, UPDATE, DELETE ON public.serp_results TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.har_results TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.client_domain_metrics TO service_role;
