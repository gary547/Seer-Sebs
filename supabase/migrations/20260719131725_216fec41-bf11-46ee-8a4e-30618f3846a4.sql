ALTER TABLE public.serp_features
  ADD COLUMN IF NOT EXISTS captured_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS serp_result_id uuid NULL;

COMMENT ON COLUMN public.serp_features.captured_at IS
  'Vintage of the SERP capture that produced this row. Rows created before this column existed carry the migration timestamp and represent one indistinguishable legacy "union-of-history" snapshot; treat them as such until Gate B pre-work re-scopes reads to latest-snapshot semantics.';

COMMENT ON COLUMN public.serp_features.serp_result_id IS
  'Optional link to the originating serp_results row when known at write time. Nullable because non-organic feature types (PAA, Answer, etc.) and CSV-import paths do not always have a specific serp_results row in hand.';

CREATE INDEX IF NOT EXISTS serp_features_keyword_captured_idx
  ON public.serp_features (keyword_id, captured_at DESC);