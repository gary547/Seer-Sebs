ALTER TABLE public.keywords
  ADD COLUMN IF NOT EXISTS core_keyword text,
  ADD COLUMN IF NOT EXISTS keyword_cluster_id text,
  ADD COLUMN IF NOT EXISTS cluster_source text;

CREATE INDEX IF NOT EXISTS keywords_cluster_id_idx
  ON public.keywords (project_id, keyword_cluster_id);