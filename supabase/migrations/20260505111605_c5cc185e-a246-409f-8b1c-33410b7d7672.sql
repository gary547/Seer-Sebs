ALTER TABLE public.keywords
  ADD COLUMN IF NOT EXISTS volume_fetched_at      timestamptz,
  ADD COLUMN IF NOT EXISTS difficulty_fetched_at  timestamptz,
  ADD COLUMN IF NOT EXISTS intent_fetched_at      timestamptz,
  ADD COLUMN IF NOT EXISTS enrichment_source      text,
  ADD COLUMN IF NOT EXISTS ranking_lookup_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS ranking_lookup_no_match boolean NOT NULL DEFAULT false;

-- Backfill: any keyword that already has a value is treated as freshly fetched
-- right now so the next sync doesn't refetch everything in the world.
UPDATE public.keywords
SET volume_fetched_at = COALESCE(volume_fetched_at, now())
WHERE avg_monthly_volume IS NOT NULL;

UPDATE public.keywords
SET difficulty_fetched_at = COALESCE(difficulty_fetched_at, now())
WHERE keyword_difficulty IS NOT NULL;

UPDATE public.keywords
SET intent_fetched_at = COALESCE(intent_fetched_at, now())
WHERE search_intent IS NOT NULL AND intent_source = 'dataforseo';

-- If we already have a ranking_url, we successfully looked it up.
UPDATE public.keywords
SET ranking_lookup_checked_at = COALESCE(ranking_lookup_checked_at, now())
WHERE ranking_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_keywords_volume_fetched_at      ON public.keywords (volume_fetched_at);
CREATE INDEX IF NOT EXISTS idx_keywords_difficulty_fetched_at  ON public.keywords (difficulty_fetched_at);
CREATE INDEX IF NOT EXISTS idx_keywords_ranking_lookup_checked_at ON public.keywords (ranking_lookup_checked_at);