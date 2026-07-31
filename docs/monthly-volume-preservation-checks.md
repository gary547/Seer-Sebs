# Monthly-Volume Preservation Checks

## Background

`public.keyword_monthly_volumes` stores monthly search-volume rows keyed by
`(keyword_id, month, source)` (unique index
`keyword_monthly_volumes_keyword_month_source_uq`, added in Phase 2.1). The
standard DataForSEO enrichment path writes rows with
`source = 'dataforseo_search_volume'`. Future / adjacent paths (e.g.
`dataforseo_historical_backfill`, GSC-derived signals) will write rows with
different `source` values into the same table.

## Rule

**Never reintroduce `delete().eq("keyword_id", id)` on `keyword_monthly_volumes`.**

Phase 2.2 replaced the old delete-then-insert with an upsert on
`(keyword_id, month, source)` for exactly this reason. Any code that deletes by
`keyword_id` alone will silently wipe historical-backfill rows and any other
source's data for that keyword. The writer must always scope deletes/upserts by
`source` as well.

The guarded writer lives in `supabase/functions/keyword-enrichment/index.ts`
(the monthly-volume block near the end of the enrichment handler).

## Manual SQL regression checks

Run these against the Supabase SQL editor (or via `supabase--read_query`).
Pick any existing `keyword_id` for `<kw>`; the month `2099-01-01` is used as a
scratch date that won't collide with real data.

```sql
-- Setup: pick any existing keyword_id.
-- SELECT id FROM public.keywords LIMIT 1;

-- Check 1: standard-source upsert refreshes volume + fetched_at, no dup row.
INSERT INTO public.keyword_monthly_volumes (keyword_id, month, volume, source)
VALUES ('<kw>', '2099-01-01', 100, 'dataforseo_search_volume')
ON CONFLICT (keyword_id, month, source)
DO UPDATE SET volume = EXCLUDED.volume, fetched_at = now();

INSERT INTO public.keyword_monthly_volumes (keyword_id, month, volume, source)
VALUES ('<kw>', '2099-01-01', 250, 'dataforseo_search_volume')
ON CONFLICT (keyword_id, month, source)
DO UPDATE SET volume = EXCLUDED.volume, fetched_at = now();

SELECT count(*) AS should_be_1, max(volume) AS should_be_250
FROM public.keyword_monthly_volumes
WHERE keyword_id = '<kw>' AND month = '2099-01-01'
  AND source = 'dataforseo_search_volume';

-- Check 2 (critical regression): a historical-source row for the SAME month
-- coexists with the standard-source row.
INSERT INTO public.keyword_monthly_volumes (keyword_id, month, volume, source)
VALUES ('<kw>', '2099-01-01', 999, 'dataforseo_historical_backfill');

SELECT source, volume FROM public.keyword_monthly_volumes
WHERE keyword_id = '<kw>' AND month = '2099-01-01'
ORDER BY source;
-- Expect 2 rows:
--   dataforseo_historical_backfill = 999
--   dataforseo_search_volume       = 250
--
-- If a future refactor reintroduces `delete().eq("keyword_id", id)` in
-- keyword-enrichment, the historical-backfill row will disappear after the
-- next enrichment run. That is the failure mode Phase 2.2 exists to prevent.

-- Check 3: duplicate (keyword_id, month, source) is rejected.
INSERT INTO public.keyword_monthly_volumes (keyword_id, month, volume, source)
VALUES ('<kw>', '2099-01-01', 1, 'dataforseo_search_volume');
-- Expect: ERROR duplicate key value violates unique constraint
--   "keyword_monthly_volumes_keyword_month_source_uq"

-- Cleanup
DELETE FROM public.keyword_monthly_volumes
WHERE keyword_id = '<kw>' AND month = '2099-01-01';
```

## What to do if a check fails

- **Check 1 fails (more than one row, or volume not 250):** the unique index
  or upsert conflict target is wrong. Verify
  `keyword_monthly_volumes_keyword_month_source_uq` exists on
  `(keyword_id, month, source)`.
- **Check 2 fails (historical row missing):** a writer has reintroduced a
  broad delete. Inspect recent changes to
  `supabase/functions/keyword-enrichment/index.ts` and any new writer that
  targets this table. Restore source-scoped upsert semantics.
- **Check 3 does not error:** the unique index is missing. Re-run the Phase
  2.1 migration.
