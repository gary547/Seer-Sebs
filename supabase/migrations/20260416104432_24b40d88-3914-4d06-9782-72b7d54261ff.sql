-- Phase 4: Keyword challenges table
CREATE TABLE public.keyword_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.navigator_projects(id) ON DELETE CASCADE,
  ranking_url text NOT NULL,
  current_keyword_id uuid NOT NULL REFERENCES public.keywords(id) ON DELETE CASCADE,
  current_annual_revenue numeric,
  challenge_keyword_id uuid NOT NULL REFERENCES public.keywords(id) ON DELETE CASCADE,
  challenge_revenue_gain numeric,
  revenue_uplift_pct numeric,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Phase 6: Peak month column
ALTER TABLE public.keywords ADD COLUMN peak_month text;

-- RLS for keyword_challenges
ALTER TABLE public.keyword_challenges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Internal users full access to keyword_challenges"
ON public.keyword_challenges
FOR ALL
TO authenticated
USING (get_user_role(auth.uid()) = ANY (ARRAY['super_admin'::text, 'admin'::text, 'user'::text]))
WITH CHECK (get_user_role(auth.uid()) = ANY (ARRAY['super_admin'::text, 'admin'::text, 'user'::text]));

CREATE POLICY "View-only see assigned keyword_challenges"
ON public.keyword_challenges
FOR SELECT
TO authenticated
USING (
  get_user_role(auth.uid()) = 'view_only'::text
  AND project_id IN (
    SELECT np.id FROM navigator_projects np
    JOIN user_client_access uca ON uca.client_id = np.client_id
    WHERE uca.user_id = auth.uid()
  )
);

CREATE INDEX idx_keyword_challenges_project_id ON public.keyword_challenges(project_id);