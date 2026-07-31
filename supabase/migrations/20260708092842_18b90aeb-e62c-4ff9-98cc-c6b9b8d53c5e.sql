ALTER TABLE public.gsc_uploads
  ADD COLUMN IF NOT EXISTS date_range_start date NULL,
  ADD COLUMN IF NOT EXISTS date_range_end   date NULL,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'legacy_csv';

CREATE TABLE IF NOT EXISTS public.gsc_upload_pages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id    uuid NOT NULL REFERENCES public.gsc_uploads(id) ON DELETE CASCADE,
  page_url     text NOT NULL,
  clicks       numeric NULL,
  impressions  numeric NULL,
  ctr          numeric NULL,
  position     numeric NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gsc_upload_pages_upload_id
  ON public.gsc_upload_pages (upload_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.gsc_upload_pages TO authenticated;
GRANT ALL ON public.gsc_upload_pages TO service_role;

ALTER TABLE public.gsc_upload_pages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Internal users full access to gsc_upload_pages"
  ON public.gsc_upload_pages
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.gsc_uploads u
      WHERE u.id = gsc_upload_pages.upload_id
        AND (
          public.get_user_role(auth.uid()) = ANY (ARRAY['super_admin','admin'])
          OR (public.get_user_role(auth.uid()) = 'user'
              AND public.is_visible_project(u.project_id))
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.gsc_uploads u
      WHERE u.id = gsc_upload_pages.upload_id
        AND (
          public.get_user_role(auth.uid()) = ANY (ARRAY['super_admin','admin'])
          OR (public.get_user_role(auth.uid()) = 'user'
              AND public.is_visible_project(u.project_id))
        )
    )
  );

CREATE POLICY "View-only see assigned gsc_upload_pages"
  ON public.gsc_upload_pages
  FOR SELECT
  TO authenticated
  USING (
    public.get_user_role(auth.uid()) = 'view_only'
    AND EXISTS (
      SELECT 1
      FROM public.gsc_uploads u
      JOIN public.navigator_projects np ON np.id = u.project_id
      JOIN public.user_client_access uca ON uca.client_id = np.client_id
      WHERE u.id = gsc_upload_pages.upload_id
        AND uca.user_id = auth.uid()
    )
  );