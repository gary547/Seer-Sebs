# Orchestration Dossier — Part 5: GSC → keywords Promotion Gap

Purpose: give the advisor the exhaustive evidence that no code path currently promotes rows from `gsc_upload_keywords` into `keywords`. This matters because for an 18,000-keyword project driven by GSC ingest, the pipeline stops at the staging table.

## 5.1 What exists on the ingest side

- `gsc_uploads` — one row per uploaded CSV (columns in Part 4 §4.4).
- `gsc_upload_keywords` — one row per (upload, keyword, device); enriched by `gsc-intent-enrichment` (writes `search_intent`) and `brand-classification` (writes `is_branded`, `brand_confidence`).
- `gsc_upload_pages` — landing page × query aggregations for CTR modelling and calibration.

FK topology: `gsc_upload_keywords.upload_id → gsc_uploads.id ON DELETE CASCADE`. There is **no** FK from `gsc_upload_keywords` to `keywords`.

## 5.2 Every write to `public.keywords` currently in the codebase

```sh
$ rg -n 'from\("keywords"\)|INTO public.keywords|INSERT INTO keywords' -g '!src/integrations/supabase/types.ts'
```

Search space: all `supabase/functions/**`, all `src/**`. Reviewed writes (INSERT/UPSERT/UPDATE) hit `public.keywords` from:

| Path | Effect |
|------|--------|
| `src/lib/addKeywordsToProject.ts` | INSERT — user-typed / pasted keyword lists. |
| `src/pages/NavigatorProjectFormPage.tsx` (via `addKeywordsToProject`) | INSERT during project creation. |
| `supabase/functions/keyword-enrichment` | UPDATE — enriches volume / intent / difficulty. |
| `supabase/functions/dataforseo-historical-volume-backfill` | UPDATE — volumes only. |
| `supabase/functions/dfs-core-keyword-backfill` | UPDATE — cluster columns only. |
| `supabase/functions/keyword-detox` | UPDATE — `detox_status`, `detox_reason`. |
| `supabase/functions/keyword-categorisation` | UPDATE — `tag_1..5`, categorisation_status. |
| `supabase/functions/keyword-cluster-recompute` | UPDATE — cluster columns. |
| `supabase/functions/base-rank-backfill` | UPDATE — `base_rank`, `base_rank_source`. |
| `supabase/functions/ranking-url-lookup` | UPDATE — `ranking_url`. |
| `supabase/functions/site-architecture` | UPDATE — reads for tagging, updates cluster/architecture columns. |

**No hit** inserts from `gsc_upload_keywords` into `keywords`. The `rg` result set above (deliberately captured live for this dossier) contains only SELECT-and-DELETE calls against `gsc_upload_keywords`, plus `useNavigatorSync.ts:545–553` which reads a GSC upload solely to hand its `upload_id` back to `gsc-intent-enrichment`.

## 5.3 The client-side loop confirms it

`src/hooks/useNavigatorSync.ts` (verbatim in Part 3) runs, for each project sync:

1. Optional keyword-enrichment loop (`keyword-enrichment` on rows already in `keywords`).
2. Optional GSC intent enrichment — fetches the latest `gsc_uploads` row and calls `gsc-intent-enrichment` with `{ upload_id, project_id }`. The function updates `gsc_upload_keywords.search_intent`; it **does not** create matching `keywords` rows.
3. Detox → Categorisation → HAR → LPS → Demand Signals → Site Architecture — all of which operate on `keywords`, not on `gsc_upload_keywords`.

There is no step "promote GSC keywords into `keywords`" and no separate button or edge function that does the same. A GSC-only project therefore requires an operator to (a) upload the CSV, (b) *separately* add those keywords to the project through `addKeywordsToProject`. The two data flows never converge automatically.

## 5.4 Confirmation queries the advisor can rerun

```sql
-- 1. No FK links the two tables:
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.gsc_upload_keywords'::regclass;
--   → only the pkey and upload_id → gsc_uploads FK

-- 2. No trigger on gsc_upload_keywords writes to keywords:
SELECT tgname, tgrelid::regclass, pg_get_triggerdef(oid)
FROM pg_trigger
WHERE tgrelid = 'public.gsc_upload_keywords'::regclass
  AND NOT tgisinternal;
--   → 0 rows

-- 3. No function references both tables:
SELECT proname
FROM pg_proc
WHERE pg_get_functiondef(oid) ILIKE '%gsc_upload_keywords%'
  AND pg_get_functiondef(oid) ILIKE '%INSERT INTO public.keywords%';
--   → 0 rows
```

Together these three checks close the door on "maybe there's a promotion path we missed at the database layer."

## 5.5 Implication for the 18k-keyword autonomous target

Any autonomous run whose input is a GSC CSV will:

1. Land in `gsc_upload_keywords` (fast, single request).
2. Be enriched (intent + brand) by two edge functions.
3. Stop.

No downstream stage of the pipeline can see those rows. Detox, categorisation, HAR, LPS, demand signals, site architecture, and Revenue v2 all read from `keywords`, which is empty for a GSC-only project. The advisor must either (a) require a mandatory promotion step at the top of the pipeline, or (b) refactor every downstream stage to read a union of `keywords` and `gsc_upload_keywords`. Neither exists today.
