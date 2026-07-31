
CREATE TABLE public.gsc_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.navigator_projects(id) ON DELETE CASCADE,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  device text NOT NULL DEFAULT 'mobile',
  row_count integer NOT NULL DEFAULT 0
);

ALTER TABLE public.gsc_uploads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Internal users full access to gsc_uploads"
  ON public.gsc_uploads FOR ALL TO authenticated
  USING (get_user_role(auth.uid()) = ANY (ARRAY['super_admin'::text, 'admin'::text, 'user'::text]))
  WITH CHECK (get_user_role(auth.uid()) = ANY (ARRAY['super_admin'::text, 'admin'::text, 'user'::text]));

CREATE POLICY "View-only see assigned gsc_uploads"
  ON public.gsc_uploads FOR SELECT TO authenticated
  USING (
    get_user_role(auth.uid()) = 'view_only'
    AND project_id IN (
      SELECT np.id FROM navigator_projects np
      JOIN user_client_access uca ON uca.client_id = np.client_id
      WHERE uca.user_id = auth.uid()
    )
  );

CREATE TABLE public.gsc_upload_keywords (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id uuid NOT NULL REFERENCES public.gsc_uploads(id) ON DELETE CASCADE,
  keyword text NOT NULL,
  clicks integer NOT NULL DEFAULT 0,
  impressions integer NOT NULL DEFAULT 0,
  ctr numeric NOT NULL DEFAULT 0,
  position numeric NOT NULL DEFAULT 0,
  search_intent text
);

ALTER TABLE public.gsc_upload_keywords ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Internal users full access to gsc_upload_keywords"
  ON public.gsc_upload_keywords FOR ALL TO authenticated
  USING (get_user_role(auth.uid()) = ANY (ARRAY['super_admin'::text, 'admin'::text, 'user'::text]))
  WITH CHECK (get_user_role(auth.uid()) = ANY (ARRAY['super_admin'::text, 'admin'::text, 'user'::text]));

CREATE POLICY "View-only see assigned gsc_upload_keywords"
  ON public.gsc_upload_keywords FOR SELECT TO authenticated
  USING (
    get_user_role(auth.uid()) = 'view_only'
    AND upload_id IN (
      SELECT gu.id FROM gsc_uploads gu
      JOIN navigator_projects np ON np.id = gu.project_id
      JOIN user_client_access uca ON uca.client_id = np.client_id
      WHERE uca.user_id = auth.uid()
    )
  );
