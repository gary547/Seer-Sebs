
CREATE TABLE public.calibration_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.navigator_projects(id) ON DELETE CASCADE,
  gsc_upload_id uuid NOT NULL REFERENCES public.gsc_uploads(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  window_days integer NOT NULL,
  overall_ratio numeric,
  by_intent jsonb NOT NULL DEFAULT '{}'::jsonb,
  by_rank_band jsonb NOT NULL DEFAULT '{}'::jsonb,
  keywords_matched integer NOT NULL DEFAULT 0,
  keywords_unmatched integer NOT NULL DEFAULT 0,
  notes text
);

CREATE INDEX calibration_snapshots_project_created_idx
  ON public.calibration_snapshots (project_id, created_at DESC);

GRANT SELECT ON public.calibration_snapshots TO authenticated;
GRANT ALL ON public.calibration_snapshots TO service_role;

ALTER TABLE public.calibration_snapshots ENABLE ROW LEVEL SECURITY;

-- Readable when the caller can already see the parent project. Mirrors the
-- visibility rule used by calc_run_registry.
CREATE POLICY "calibration_snapshots_select_visible_project"
  ON public.calibration_snapshots FOR SELECT
  TO authenticated
  USING (public.is_visible_project(project_id));

-- Writes are performed exclusively by the calibration-compute edge function
-- via the service role client; no authenticated INSERT/UPDATE/DELETE policy is
-- created intentionally.
