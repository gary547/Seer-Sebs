
-- Shared OTPM governor for AI providers.
CREATE TABLE public.ai_rate_window (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  model TEXT NOT NULL,
  reserved_tokens INTEGER NOT NULL,
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_rate_window_model_time ON public.ai_rate_window (model, reserved_at DESC);
ALTER TABLE public.ai_rate_window ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Internal users full access to ai_rate_window"
  ON public.ai_rate_window FOR ALL TO authenticated
  USING (get_user_role(auth.uid()) = ANY (ARRAY['super_admin'::text, 'admin'::text, 'user'::text]))
  WITH CHECK (get_user_role(auth.uid()) = ANY (ARRAY['super_admin'::text, 'admin'::text, 'user'::text]));

-- Background categorisation jobs (live + deferred tiers).
CREATE TABLE public.categorisation_jobs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL,
  tier TEXT NOT NULL DEFAULT 'live' CHECK (tier IN ('live','deferred')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','error')),
  total INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_categorisation_jobs_project_status ON public.categorisation_jobs (project_id, status);
CREATE INDEX idx_categorisation_jobs_tier_status ON public.categorisation_jobs (tier, status);
ALTER TABLE public.categorisation_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Internal users full access to categorisation_jobs"
  ON public.categorisation_jobs FOR ALL TO authenticated
  USING (get_user_role(auth.uid()) = ANY (ARRAY['super_admin'::text, 'admin'::text, 'user'::text]))
  WITH CHECK (get_user_role(auth.uid()) = ANY (ARRAY['super_admin'::text, 'admin'::text, 'user'::text]));

CREATE POLICY "View-only see assigned categorisation_jobs"
  ON public.categorisation_jobs FOR SELECT TO authenticated
  USING (
    (get_user_role(auth.uid()) = 'view_only'::text)
    AND (project_id IN (
      SELECT np.id FROM navigator_projects np
      JOIN user_client_access uca ON uca.client_id = np.client_id
      WHERE uca.user_id = auth.uid()
    ))
  );

CREATE TRIGGER update_categorisation_jobs_updated_at
  BEFORE UPDATE ON public.categorisation_jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Per-keyword tier flag so the worker can pick up only its tier.
ALTER TABLE public.keywords ADD COLUMN IF NOT EXISTS categorisation_tier TEXT;
CREATE INDEX IF NOT EXISTS idx_keywords_cat_tier ON public.keywords (project_id, categorisation_tier) WHERE tag_1 IS NULL;
