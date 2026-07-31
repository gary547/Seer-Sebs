ALTER TABLE public.keywords
  ADD COLUMN IF NOT EXISTS cluster_volume_annual        numeric,
  ADD COLUMN IF NOT EXISTS cluster_base_rank            integer,
  ADD COLUMN IF NOT EXISTS cluster_base_rank_keyword_id uuid,
  ADD COLUMN IF NOT EXISTS cluster_ranking_url          text,
  ADD COLUMN IF NOT EXISTS cluster_url_conflict         boolean;

COMMENT ON COLUMN public.keywords.cluster_volume_annual        IS 'MAX annual volume across all cluster members; identical for every member';
COMMENT ON COLUMN public.keywords.cluster_base_rank            IS 'MIN non-null base_rank across cluster members; identical for every member';
COMMENT ON COLUMN public.keywords.cluster_base_rank_keyword_id IS 'Member id supplying cluster_base_rank (tie-break: highest annual_volume DESC, then keyword ASC)';
COMMENT ON COLUMN public.keywords.cluster_ranking_url          IS 'Modal non-null ranking_url in cluster; NULL if all members are NULL';
COMMENT ON COLUMN public.keywords.cluster_url_conflict         IS 'true iff members carry >=2 distinct non-null ranking_url values';