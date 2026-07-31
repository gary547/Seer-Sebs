-- 1. De-duplicate existing rows: keep the best row per (project_id, lower(trim(keyword)))
WITH ranked AS (
  SELECT
    id,
    project_id,
    lower(trim(keyword)) AS norm_keyword,
    ROW_NUMBER() OVER (
      PARTITION BY project_id, lower(trim(keyword))
      ORDER BY human_reviewed DESC, created_at DESC
    ) AS rn
  FROM public.keywords
)
DELETE FROM public.keywords k
USING ranked r
WHERE k.id = r.id AND r.rn > 1;

-- 2. Prevent future duplicates (case/whitespace-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS keywords_project_keyword_unique
  ON public.keywords (project_id, lower(trim(keyword)));

-- 3. Speed up status-filtered queries / counts
CREATE INDEX IF NOT EXISTS keywords_project_status_idx
  ON public.keywords (project_id, detox_status);

-- 4. Speed up search ILIKE queries with trigram
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS keywords_keyword_trgm_idx
  ON public.keywords USING gin (keyword gin_trgm_ops);