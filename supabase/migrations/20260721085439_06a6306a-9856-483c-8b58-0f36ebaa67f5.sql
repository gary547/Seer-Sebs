ALTER TABLE public.keywords
  ADD COLUMN IF NOT EXISTS cluster_canonical_basis text;

COMMENT ON COLUMN public.keywords.cluster_canonical_basis IS
  'How the cluster canonical was selected: gsc_clicks | volume | base_rank | alphabetical';