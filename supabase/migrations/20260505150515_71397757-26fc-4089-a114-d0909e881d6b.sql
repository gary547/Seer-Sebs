
-- Background detox jobs
CREATE TABLE IF NOT EXISTS public.detox_jobs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  total INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  kept INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  heartbeat_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_detox_jobs_project_status ON public.detox_jobs(project_id, status);
CREATE INDEX IF NOT EXISTS idx_detox_jobs_status_heartbeat ON public.detox_jobs(status, heartbeat_at);

ALTER TABLE public.detox_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Internal users full access to detox_jobs"
ON public.detox_jobs FOR ALL TO authenticated
USING (get_user_role(auth.uid()) = ANY (ARRAY['super_admin'::text, 'admin'::text, 'user'::text]))
WITH CHECK (get_user_role(auth.uid()) = ANY (ARRAY['super_admin'::text, 'admin'::text, 'user'::text]));

CREATE POLICY "View-only see assigned detox_jobs"
ON public.detox_jobs FOR SELECT TO authenticated
USING (
  (get_user_role(auth.uid()) = 'view_only'::text)
  AND (project_id IN (
    SELECT np.id FROM navigator_projects np
    JOIN user_client_access uca ON uca.client_id = np.client_id
    WHERE uca.user_id = auth.uid()
  ))
);

CREATE TRIGGER trg_detox_jobs_updated_at
BEFORE UPDATE ON public.detox_jobs
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Silent quality audit log
CREATE TABLE IF NOT EXISTS public.detox_audit (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id UUID,
  project_id UUID NOT NULL,
  keyword TEXT NOT NULL,
  ai_verdict TEXT,
  ai_reason TEXT,
  pass2_verdict TEXT,
  pass2_reason TEXT,
  rule_name TEXT,
  final_verdict TEXT NOT NULL,
  audit_sample BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_detox_audit_project ON public.detox_audit(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_detox_audit_job ON public.detox_audit(job_id);

ALTER TABLE public.detox_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Internal users full access to detox_audit"
ON public.detox_audit FOR ALL TO authenticated
USING (get_user_role(auth.uid()) = ANY (ARRAY['super_admin'::text, 'admin'::text, 'user'::text]))
WITH CHECK (get_user_role(auth.uid()) = ANY (ARRAY['super_admin'::text, 'admin'::text, 'user'::text]));
