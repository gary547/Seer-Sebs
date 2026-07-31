CREATE TABLE public.ctr_estimate_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.navigator_projects(id) ON DELETE CASCADE,
  domain text NOT NULL,
  device text NOT NULL,
  intent_segment text,
  ctr_data jsonb NOT NULL DEFAULT '[]'::jsonb,
  top_keywords jsonb NOT NULL DEFAULT '[]'::jsonb,
  keywords_analyzed integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, domain, device, intent_segment)
);

ALTER TABLE public.ctr_estimate_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Internal users full access to ctr_estimate_cache"
  ON public.ctr_estimate_cache FOR ALL TO authenticated
  USING (get_user_role(auth.uid()) = ANY (ARRAY['super_admin'::text, 'admin'::text, 'user'::text]))
  WITH CHECK (get_user_role(auth.uid()) = ANY (ARRAY['super_admin'::text, 'admin'::text, 'user'::text]));

CREATE POLICY "View-only see assigned ctr_estimate_cache"
  ON public.ctr_estimate_cache FOR SELECT TO authenticated
  USING (
    get_user_role(auth.uid()) = 'view_only'
    AND project_id IN (
      SELECT np.id FROM navigator_projects np
      JOIN user_client_access uca ON uca.client_id = np.client_id
      WHERE uca.user_id = auth.uid()
    )
  );