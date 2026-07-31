
-- Add intent + difficulty columns to keywords
ALTER TABLE public.keywords
  ADD COLUMN IF NOT EXISTS search_intent text,
  ADD COLUMN IF NOT EXISTS intent_source text,
  ADD COLUMN IF NOT EXISTS intent_confidence text,
  ADD COLUMN IF NOT EXISTS keyword_difficulty integer;

CREATE INDEX IF NOT EXISTS idx_keywords_search_intent ON public.keywords(search_intent);

-- Add intent_segment to ctr_curves
ALTER TABLE public.ctr_curves
  ADD COLUMN IF NOT EXISTS intent_segment text;

-- Drop existing unique constraint if any, then create null-safe unique index
CREATE UNIQUE INDEX IF NOT EXISTS ctr_curves_project_device_rank_intent
  ON public.ctr_curves (project_id, device, rank_position, COALESCE(intent_segment, ''));
