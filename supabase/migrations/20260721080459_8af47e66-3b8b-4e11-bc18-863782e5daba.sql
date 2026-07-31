ALTER TABLE public.keywords
  ADD COLUMN IF NOT EXISTS cluster_key text,
  ADD COLUMN IF NOT EXISTS cluster_canonical_keyword_id uuid REFERENCES public.keywords(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cluster_member_count int,
  ADD COLUMN IF NOT EXISTS cluster_computed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_keywords_project_cluster_key
  ON public.keywords (project_id, cluster_key);