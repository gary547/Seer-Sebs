-- Completes the 2.5 spec's "RLS mirroring calc_run_registry" — INSERT policy + grants were omitted in the original migration.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.calibration_snapshots TO authenticated;
GRANT ALL ON public.calibration_snapshots TO service_role;

CREATE POLICY "Admins insert calibration snapshots"
  ON public.calibration_snapshots
  FOR INSERT
  TO authenticated
  WITH CHECK (get_user_role(auth.uid()) = ANY (ARRAY['super_admin','admin']));