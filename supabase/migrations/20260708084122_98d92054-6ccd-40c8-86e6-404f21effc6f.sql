
ALTER TABLE public.navigator_projects
  ADD COLUMN calculations_v2_compute_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN calculations_v2_visible_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE public.calc_run_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.navigator_projects(id) ON DELETE CASCADE,
  triggered_by uuid NULL,
  trigger_source text NOT NULL DEFAULT 'manual_admin',
  model_version text NOT NULL,
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NULL,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT calc_run_registry_status_check
    CHECK (status IN ('queued','running','succeeded','failed','partial'))
);

CREATE INDEX calc_run_registry_project_started_idx
  ON public.calc_run_registry (project_id, started_at DESC);
CREATE INDEX calc_run_registry_status_idx
  ON public.calc_run_registry (status);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.calc_run_registry TO authenticated;
GRANT ALL ON public.calc_run_registry TO service_role;

ALTER TABLE public.calc_run_registry ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Internal users read calc runs"
  ON public.calc_run_registry FOR SELECT TO authenticated
  USING (
    public.get_user_role(auth.uid()) IN ('super_admin','admin','user')
    AND public.is_visible_project(project_id)
  );

CREATE POLICY "View-only users read calc runs"
  ON public.calc_run_registry FOR SELECT TO authenticated
  USING (
    public.get_user_role(auth.uid()) = 'view_only'
    AND public.is_visible_project(project_id)
  );

CREATE POLICY "Admins insert calc runs"
  ON public.calc_run_registry FOR INSERT TO authenticated
  WITH CHECK (public.get_user_role(auth.uid()) IN ('super_admin','admin'));

CREATE POLICY "Admins update calc runs"
  ON public.calc_run_registry FOR UPDATE TO authenticated
  USING (public.get_user_role(auth.uid()) IN ('super_admin','admin'))
  WITH CHECK (public.get_user_role(auth.uid()) IN ('super_admin','admin'));

CREATE POLICY "Admins delete calc runs"
  ON public.calc_run_registry FOR DELETE TO authenticated
  USING (public.get_user_role(auth.uid()) IN ('super_admin','admin'));
