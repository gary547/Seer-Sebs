-- Round-2 keyword sanitization + stuck-pipeline self-heal.
-- 1. Strip commas / slashes / backslashes from existing keywords (the
--    previous round only stripped ?!()[]{}…). Lowercase, trim, collapse
--    whitespace.
-- 2. Mark anything that becomes empty as 'removed'.
-- 3. Dedupe rows that collapse to the same (project_id, keyword) — keep
--    the oldest, mark the rest as 'removed'.
-- 4. Reset har_status='idle' on any project currently stuck in 'running'
--    so the next Sync Now starts clean.

-- Step 1: re-sanitize
UPDATE public.keywords
SET keyword = trim(regexp_replace(
                regexp_replace(
                  lower(trim(keyword)),
                  '[?!()\[\]{}<>|\\/,";:=+*&^%$#@~`'']',
                  ' ',
                  'g'
                ),
                '\s+',
                ' ',
                'g'
              ))
WHERE keyword ~ '[,/\\?!()\[\]{}<>|";:=+*&^%$#@~`'']'
   OR keyword ~ '\s\s'
   OR keyword <> lower(trim(keyword));

-- Step 2: anything that collapsed to empty is removed
UPDATE public.keywords
SET detox_status = 'removed',
    detox_reason = COALESCE(detox_reason, 'auto-removed: empty after sanitization')
WHERE keyword = '' AND detox_status <> 'removed';

-- Step 3: dedupe within each project — keep oldest row, mark the rest removed
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY project_id, keyword
           ORDER BY created_at ASC, id ASC
         ) AS rn
  FROM public.keywords
  WHERE detox_status <> 'removed' AND keyword <> ''
)
UPDATE public.keywords k
SET detox_status = 'removed',
    detox_reason = COALESCE(k.detox_reason, 'auto-removed: duplicate after sanitization')
FROM ranked r
WHERE k.id = r.id AND r.rn > 1;

-- Step 4: self-heal stuck HAR pipelines
UPDATE public.navigator_projects
SET har_status = 'idle'
WHERE har_status = 'running';
