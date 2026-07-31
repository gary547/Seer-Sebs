# Brand Classification — Pagination Fix Verification Report

**Date:** 2026-07-18
**Project verified:** SEO (`ce1f52ba-2bc1-4877-8c08-c9d6f8f2e482`)
**Job:** `a195356c-6e52-4aa9-89ab-479b918c8542`
**Function redeploy timestamp:** **2026-07-18 23:29:44 UTC**

---

## 1. Recap of the pagination bugfix

Shipped in the previous turn, scoped to `supabase/functions/_shared/pgrst-in.ts` and `supabase/functions/brand-classification/index.ts`.

### `_shared/pgrst-in.ts`
- New internal helper `pageThrough(query, pageSize=1000)` iterates `.range(from, to)` windows until a short page returns, concatenating results.
- `selectIn(...)` gained an `opts.paginate` flag — when set, each IN-chunk's query is run through `pageThrough` instead of a single call, defeating PostgREST's default 1,000-row cap per IN-chunk.
- New exported helper `fetchAllRows(sb, table, columns, filterFn?)` pages an arbitrary filtered select using the same window strategy. Callers pass a `filterFn` that applies `.eq/.in/…` to a base query builder.

### `brand-classification/index.ts`
- `keywords` prefetch: replaced the single `.select()` with `fetchAllRows(sb, "keywords", "id, keyword", q => q.eq("project_id", project_id))`.
- `gsc_upload_keywords` prefetch: replaced `selectIn(...)` with `selectIn(..., { paginate: true })` over the project's upload IDs.
- Everything downstream — distinct-query normalisation map, rule pass, uncertain adjudication via Claude under the `ai_rate_window` governor, and the chunked fan-out that writes `is_branded` / `brand_confidence` back to both tables — is unchanged.

### Tests
- 8 new cases in `_shared/pgrst-in.test.ts` covering row-count boundaries of 999 / 1000 / 1001 / 2500 for both `selectIn({paginate})` and `fetchAllRows`, plus IN-chunk × pagination interaction. Full Deno suite green (15 tests in the shared module).

---

## 2. What happened after clicking "Classify brand terms"

Reconstructed from the captured client network trace between 23:31:52 and 23:32:18 UTC.

### Trigger
```
POST /functions/v1/brand-classification
Body: { "project_id": "ce1f52ba-…", "mode": "start" }
Status: 202
Response: { "job_id": "a195356c-6e52-4aa9-89ab-479b918c8542" }
```

The card then polled `brand_classification_jobs` every ~3 seconds. Timeline of that job row:

| Time (UTC) | Status | total_keywords | processed | branded | non_branded | uncertain_resolved | ai_calls |
|---|---|---:|---:|---:|---:|---:|---:|
| 23:32:02 | queued | 0 | 0 | 0 | 0 | 0 | 0 |
| 23:32:06 | running | 18,328 | 0 | 0 | 0 | 0 | 0 |
| 23:32:09 | running | 18,328 | 0 | 0 | 0 | 0 | 0 |
| 23:32:14 | running | 18,328 | 18,321 | 111 | 42,948 | 0 | 0 |
| 23:32:18 | **complete** | **18,328** | **18,328** | **118** | **42,956** | **15** | **1** |

Brand tokens derived by the rule pass (from `brand_tokens` on the job row):

```json
{
  "splits": ["no brainer agency"],
  "tokens": ["brainer", "nobraineragency"],
  "concatenations": ["nobrainer", "braineragency", "nobraineragency"]
}
```

### Post-completion refresh
Immediately after the terminal poll, the admin panel re-issued its coverage HEAD queries against `keywords` and `gsc_upload_keywords` (`is_branded=eq.true / eq.false / is.null` and totals). All returned 200/206. No 4xx or 5xx anywhere in the trace.

### Wall clock
- End-to-end: ~16 seconds from POST to terminal poll.
- Worker time: ~12 seconds (`started_at` 23:32:06.220 → `finished_at` 23:32:18.160).

Faster than the "minutes, not seconds" projection we recorded at redeploy time because the uncertain bucket was small (15 items) and resolved in a single Claude batch (`ai_calls: 1`).

---

## 3. Before vs. after — evidence the coverage gap closed

| Metric | Previous run `17b5cea7…` (pre-fix) | This run `a195356c…` (post-fix) | Delta |
|---|---:|---:|---:|
| Distinct queries processed | 1,760 | **18,328** | +16,568 (×10.4) |
| Branded rows written | 61 | **118** | +57 |
| Non-branded rows written | 1,939 | **42,956** | +41,017 |
| Uncertain resolved | 4 | 15 | +11 |
| AI calls | 1 | 1 | — |
| Wall clock | ~3 s | ~12 s | +9 s |

Interpretation:
- The prior run capped at ~2,000 rows total across both tables — a symptom of PostgREST's default 1,000-row limit hitting the `keywords` prefetch and each `selectIn` IN-chunk independently. The new run's `total_keywords: 18,328` is the true distinct-query union for this project.
- Row-level writes now cover ~43k rows (branded 118 + non-branded 42,956 ≈ 43,074), matching the total row count HEAD probes observed in the trace.
- AI cost remained flat (1 call) — the uncertain bucket is small relative to the total, so full coverage did not blow up spend.
- Idempotency intact: a subsequent re-run over the same corpus should complete with `ai_calls: 0` since verdicts persist on both tables.

---

## 4. Caveats and follow-ups

- The branded / non-branded splits above are read from the polled job row (`branded_count`, `non_branded_count`), not a fresh `SELECT count(*)` against the tables. The post-completion HEAD probes were consistent with these counts but were not captured with `Content-Range` values in the trace. If the advisor wants independent confirmation, spot-check with:
  ```sql
  select
    (select count(*) from keywords              where project_id = 'ce1f52ba-…' and is_branded)  as k_branded,
    (select count(*) from gsc_upload_keywords g join gsc_uploads u on u.id = g.upload_id
                     where u.project_id = 'ce1f52ba-…' and g.is_branded)                        as g_branded;
  ```
- No regressions observed elsewhere in the admin panel during the run — `clients`, `navigator_projects`, `calc_run_registry`, and `admin-list-users` requests all returned 200 with expected payload shapes.
- The truncation audit findings in `docs/truncation-audit-2026-07-18.md` (9 high-risk `.select()` sites across the v2 calc functions) remain open pending advisor ruling on remediation order — `har-calculation-v2`'s per-batch `serp_results` and `link_power_scores` prefetches are still the top candidates.
