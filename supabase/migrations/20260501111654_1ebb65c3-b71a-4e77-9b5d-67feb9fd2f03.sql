-- Section 2: per-user theme preference (additive, default 'dark')
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS theme_preference text DEFAULT 'dark';

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_theme_preference_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_theme_preference_check
  CHECK (theme_preference IN ('light','dark'));

-- Section 6b: audit table for any Tag 1 / kw_cluster mutation
CREATE TABLE IF NOT EXISTS public.keyword_tag_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword_id uuid NOT NULL,
  client_id uuid,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by uuid,
  source text NOT NULL,
  batch_id uuid,
  tag_1_before text,
  tag_1_after text,
  kw_cluster_before text,
  kw_cluster_after text
);

CREATE INDEX IF NOT EXISTS idx_keyword_tag_history_keyword
  ON public.keyword_tag_history (keyword_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_keyword_tag_history_batch
  ON public.keyword_tag_history (batch_id);
CREATE INDEX IF NOT EXISTS idx_keyword_tag_history_client
  ON public.keyword_tag_history (client_id, changed_at DESC);

ALTER TABLE public.keyword_tag_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Internal users full access to keyword_tag_history" ON public.keyword_tag_history;
CREATE POLICY "Internal users full access to keyword_tag_history"
  ON public.keyword_tag_history
  FOR ALL
  TO authenticated
  USING (public.get_user_role(auth.uid()) = ANY (ARRAY['super_admin','admin','user']))
  WITH CHECK (public.get_user_role(auth.uid()) = ANY (ARRAY['super_admin','admin','user']));

DROP POLICY IF EXISTS "View-only see assigned keyword_tag_history" ON public.keyword_tag_history;
CREATE POLICY "View-only see assigned keyword_tag_history"
  ON public.keyword_tag_history
  FOR SELECT
  TO authenticated
  USING (
    public.get_user_role(auth.uid()) = 'view_only'
    AND keyword_id IN (
      SELECT k.id
      FROM public.keywords k
      JOIN public.navigator_projects np ON np.id = k.project_id
      JOIN public.user_client_access uca ON uca.client_id = np.client_id
      WHERE uca.user_id = auth.uid()
    )
  );