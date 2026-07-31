-- Allow multiple roadmap versions per project (history)
ALTER TABLE public.project_roadmaps DROP CONSTRAINT IF EXISTS project_roadmaps_project_id_key;

-- Index for fast "latest first" lookups and history listing
CREATE INDEX IF NOT EXISTS idx_project_roadmaps_project_generated
  ON public.project_roadmaps (project_id, generated_at DESC);