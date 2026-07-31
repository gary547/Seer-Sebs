ALTER TABLE public.keywords
ADD COLUMN IF NOT EXISTS keyword_priority integer;

ALTER TABLE public.keywords
DROP CONSTRAINT IF EXISTS keywords_keyword_priority_check;

ALTER TABLE public.keywords
ADD CONSTRAINT keywords_keyword_priority_check
CHECK (keyword_priority IS NULL OR keyword_priority IN (1, 2, 3));

CREATE INDEX IF NOT EXISTS idx_keywords_project_priority
ON public.keywords(project_id, keyword_priority);

CREATE TABLE IF NOT EXISTS public.project_roadmaps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL UNIQUE REFERENCES public.navigator_projects(id) ON DELETE CASCADE,
  roadmap_markdown text NOT NULL,
  generated_at timestamp with time zone NOT NULL DEFAULT now(),
  synced_at timestamp with time zone NULL
);

ALTER TABLE public.project_roadmaps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Internal users full access to project_roadmaps" ON public.project_roadmaps;
CREATE POLICY "Internal users full access to project_roadmaps"
ON public.project_roadmaps
FOR ALL
TO authenticated
USING (public.get_user_role(auth.uid()) IN ('super_admin', 'admin', 'user'))
WITH CHECK (public.get_user_role(auth.uid()) IN ('super_admin', 'admin', 'user'));

DROP POLICY IF EXISTS "View-only see assigned project_roadmaps" ON public.project_roadmaps;
CREATE POLICY "View-only see assigned project_roadmaps"
ON public.project_roadmaps
FOR SELECT
TO authenticated
USING (
  public.get_user_role(auth.uid()) = 'view_only'
  AND project_id IN (
    SELECT np.id
    FROM public.navigator_projects np
    JOIN public.user_client_access uca ON uca.client_id = np.client_id
    WHERE uca.user_id = auth.uid()
  )
);

CREATE INDEX IF NOT EXISTS idx_project_roadmaps_project_id
ON public.project_roadmaps(project_id);