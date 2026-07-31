ALTER TABLE public.keyword_monthly_volumes
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'dataforseo_search_volume',
  ADD COLUMN IF NOT EXISTS fetched_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS keyword_monthly_volumes_keyword_month_source_uq
  ON public.keyword_monthly_volumes (keyword_id, month, source);

CREATE INDEX IF NOT EXISTS idx_kmv_keyword_month
  ON public.keyword_monthly_volumes (keyword_id, month);