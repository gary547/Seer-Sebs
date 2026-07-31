ALTER TABLE public.keywords
  ADD COLUMN IF NOT EXISTS is_branded boolean,
  ADD COLUMN IF NOT EXISTS brand_confidence numeric;

ALTER TABLE public.gsc_upload_keywords
  ADD COLUMN IF NOT EXISTS is_branded boolean,
  ADD COLUMN IF NOT EXISTS brand_confidence numeric;

CREATE TABLE IF NOT EXISTS public.brand_classification_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.navigator_projects(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued',
  total_keywords int NOT NULL DEFAULT 0,
  processed_keywords int NOT NULL DEFAULT 0,
  branded_count int NOT NULL DEFAULT 0,
  non_branded_count int NOT NULL DEFAULT 0,
  uncertain_resolved_count int NOT NULL DEFAULT 0,
  ai_calls int NOT NULL DEFAULT 0,
  brand_tokens jsonb,
  last_error text,
  heartbeat_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.brand_classification_jobs TO authenticated;
GRANT ALL ON public.brand_classification_jobs TO service_role;

ALTER TABLE public.brand_classification_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "brand_jobs_visible_project" ON public.brand_classification_jobs;
CREATE POLICY "brand_jobs_visible_project" ON public.brand_classification_jobs
  FOR SELECT TO authenticated USING (public.is_visible_project(project_id));

DROP POLICY IF EXISTS "brand_jobs_write_admin" ON public.brand_classification_jobs;
CREATE POLICY "brand_jobs_write_admin" ON public.brand_classification_jobs
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin'::public.app_role) OR public.has_role(auth.uid(),'super_admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(),'admin'::public.app_role) OR public.has_role(auth.uid(),'super_admin'::public.app_role));

CREATE INDEX IF NOT EXISTS brand_classification_jobs_project_created_idx
  ON public.brand_classification_jobs (project_id, created_at DESC);

DROP TRIGGER IF EXISTS brand_jobs_updated ON public.brand_classification_jobs;
CREATE TRIGGER brand_jobs_updated BEFORE UPDATE ON public.brand_classification_jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();