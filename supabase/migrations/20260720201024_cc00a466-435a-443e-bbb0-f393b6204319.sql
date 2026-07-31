ALTER TABLE public.keywords
  ADD COLUMN IF NOT EXISTS base_rank_source text,
  ADD COLUMN IF NOT EXISTS base_rank_checked_at timestamptz;

ALTER TABLE public.keywords
  DROP CONSTRAINT IF EXISTS keywords_base_rank_source_check;

ALTER TABLE public.keywords
  ADD CONSTRAINT keywords_base_rank_source_check
  CHECK (base_rank_source IS NULL OR base_rank_source IN ('serp_results','dfs_labs'));