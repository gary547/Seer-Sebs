-- 1. Extend tactical_rag_status to allow "watch"
ALTER TABLE public.site_architecture
  DROP CONSTRAINT IF EXISTS site_architecture_tactical_rag_status_check;

ALTER TABLE public.site_architecture
  ADD CONSTRAINT site_architecture_tactical_rag_status_check
  CHECK (tactical_rag_status = ANY (ARRAY[
    'no_action_needed','create_content','optimise_content','new_content','green','watch'
  ]));

-- 2. Backfill: clean keyword text on existing rows
WITH cleaned AS (
  SELECT
    id,
    keyword AS original,
    regexp_replace(
      regexp_replace(
        lower(trim(keyword)),
        '[?!()\[\]{}<>|\\";:=+*&^%$#@~`'']',
        ' ',
        'g'
      ),
      '\s+', ' ', 'g'
    ) AS cleaned_kw
  FROM public.keywords
)
UPDATE public.keywords k
SET keyword = trim(c.cleaned_kw)
FROM cleaned c
WHERE k.id = c.id
  AND trim(c.cleaned_kw) <> ''
  AND k.keyword <> trim(c.cleaned_kw);

-- 3. Mark rows that became empty after cleaning as removed
UPDATE public.keywords
SET detox_status = 'removed',
    detox_reason = 'invalid characters only'
WHERE trim(keyword) = ''
  AND detox_status <> 'removed';

-- 4. De-duplicate within each project — keep the oldest, mark the rest as removed
WITH ranked AS (
  SELECT
    id,
    project_id,
    keyword,
    ROW_NUMBER() OVER (
      PARTITION BY project_id, lower(trim(keyword))
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM public.keywords
  WHERE trim(keyword) <> ''
)
UPDATE public.keywords k
SET detox_status = 'removed',
    detox_reason = COALESCE(k.detox_reason, 'duplicate after cleaning')
FROM ranked r
WHERE k.id = r.id
  AND r.rn > 1
  AND k.detox_status <> 'removed';