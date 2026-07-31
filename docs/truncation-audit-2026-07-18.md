# Truncation Audit — v2 edge functions

**Date:** 2026-07-18 (read-only, no code changes)
**Scope:** `har-calculation-v2`, `compute-forecasts-v2`, `ctr-curves-from-gsc`, `link-power-score-compute`, `demand-signals-compute`, `site-architecture`
**Scale reference (TVs Ongoing):** 857 kept keywords · 8,804 LPS rows · 2,571 scenario rows · 25,000 GSC rows

PostgREST caps un-ranged responses at 1,000 rows. `selectIn` (MAX_IN_CHUNK = 100) shortens the URL but does **not** raise that per-chunk row cap unless `{ paginate: true }` is passed. This audit lists every `.select()` whose result set can plausibly exceed 1,000 rows in one call at current scale. **No fixes here — findings only.** Fix ranking / bundling is for the advisor.

Mitigation legend:
- **paginates** — has an explicit `.range()` loop.
- **chunked-in (safe)** — `selectIn` where each chunk's return set stays well under 1,000.
- **chunked-in (RISK)** — `selectIn` where a single chunk can plausibly break 1,000.
- **capped-by-filter** — natural cap in the query (e.g. `.limit(1)`, `.eq(pk, ...)`, small config table).
- **TRUNCATION RISK** — no mitigation, worst case > 1,000.

---

## 1. `har-calculation-v2` — priority focus

Per-batch loop is `for (const kwBatch of chunk(keywordIds, KW_CHUNK))` with `KW_CHUNK = 100` (line 48, 349). All per-batch prefetches inherit that 100-keyword slice.

| # | file:line | Description | Worst-case rows/call @ TVs Ongoing | Status |
|---|---|---|---|---|
| 1 | `supabase/functions/har-calculation-v2/index.ts:272-282` | Kept-keywords fetch by `project_id`, `.range(offset, offset+999)` loop. | 857 total, 1,000/page | **paginates** |
| 2 | `:307` `selectIn keyword_forecasts` by `keyword_id`, `MAX_IN_CHUNK=100` | ~1 forecast row per keyword → ≤ 100 rows/chunk. | ≤ 100/chunk | chunked-in (safe) |
| 3 | **`:352-357` per-batch `serp_results` `.in("keyword_id", kwBatch)`** | TVs Ongoing SERP density ≈ 10 rows/kw × 100 kw = **~1,000 rows/chunk (at the cap)**; a batch with any high-density SERPs (20 rows/kw is normal on top-of-funnel) trips the truncation silently — no error, missing competitors → wrong HAR. | **1,000–2,000+/chunk** | **TRUNCATION RISK (priority)** |
| 4 | **`:390-394` per-batch `link_power_scores` `.eq(calc_run_id).in("keyword_id", kwBatch)`** | 8,804 LPS rows across 857 kws ≈ **10.3 rows/kw**; 100 kw × ~10 = **~1,030 rows/chunk**. At exactly the cap. | **~1,030/chunk** | **TRUNCATION RISK (priority)** |
| 5 | `:429-431` `site_architecture` `.in("keyword_id", kwBatch)` | 1 row per keyword → ≤ 100/chunk. | ≤ 100/chunk | chunked-in (safe) |
| 6 | `:440-442` `serp_features` `.in("keyword_id", kwBatch)` | 1 row per keyword typically → ≤ 100/chunk. Multi-feature rows possible on wide SERPs but unlikely > 300/chunk. | ~100–300/chunk | chunked-in (safe) |
| 7 | `:108`, `:116`, `:129`, `:149`, `:163`, `:184`, `:202`, `:244` | User/role, project, latest LPS run, `client_domain_metrics.limit(1)`, `clients.maybeSingle`, `har_scoring_config.maybeSingle` | 1–few | capped-by-filter |

**Priority note.** Rows 3 and 4 are the exact spots the advisor called out. Silent truncation here would produce wrong HAR without any error surface — the function would succeed with plausible-looking numbers. Neither call has a `.range()` loop; `selectIn` alone does not fix this because the cap is per-chunk, not per-request-size.

---

## 2. `compute-forecasts-v2`

Same 100-keyword chunk pattern via `selectIn`.

| # | file:line | Description | Worst-case rows/call | Status |
|---|---|---|---|---|
| 1 | `:250-252` `ctr_curves` by `project_id` OR `is_fallback=true` | ~4 devices × ~4 intents × 100 positions ≈ few hundred; fallback set similar. | < 1,000 | capped-by-filter |
| 2 | `:253-254` `ctr_curve_metadata` (no filter) | One row per curve; small config-scale table. | < 1,000 | capped-by-filter |
| 3 | `:263-265` `project_conversion_overrides` by `project_id` | Small per-project set. | < 100 | capped-by-filter |
| 4 | `:283-292` `keyword_forecast_scenarios` by `calc_run_id`, `.range(offset, offset+999)` loop | 2,571 scenarios / paged. | 1,000/page | **paginates** |
| 5 | `:328-334` `selectIn keywords` by `id` (PK) | 100 ids → 100 rows/chunk. | ≤ 100/chunk | chunked-in (safe) |
| 6 | **`:351-357` `selectIn keyword_monthly_volumes` by `keyword_id`** | 12 months per keyword × 100 kw/chunk = **~1,200 rows/chunk**; multi-source rows push higher. | **~1,200–1,800/chunk** | **TRUNCATION RISK** |
| 7 | `:367-370` `serp_feature_ctr_adjustments` `.eq("is_active", true)` | Global small config table. | < 100 | capped-by-filter |
| 8 | `:377-383` `selectIn serp_features` by `keyword_id` | Typically 1–3 rows/kw × 100 kw = few hundred/chunk. | ~100–500/chunk | chunked-in (safe) |
| 9 | `:129`, `:137`, `:157`, `:179`, `:194`, `:221` | User/role, project, run registry lookups | 1–few | capped-by-filter |

**Note.** Row 6 (monthly volumes) is the biggest silent-loss risk in this function: hitting 1,000 exactly returns without error, leaving later monthly-volume rows in each chunk invisible → understated volumes → understated revenue.

---

## 3. `ctr-curves-from-gsc`

| # | file:line | Description | Worst-case rows/call | Status |
|---|---|---|---|---|
| 1 | `:74-86` `loadAllKeywords` — `gsc_upload_keywords` by `upload_id`, `.range(from, to)` with `KEYWORD_PAGE` | 25,000 GSC rows / paged. | KEYWORD_PAGE/page | **paginates** |
| 2 | `:130` `user_roles.select("role")` | 1–few | capped-by-filter |
| 3 | `:139`, `:159` `navigator_projects.select("id")` / `gsc_uploads.select("id")` scoped by project | ≤ dozens of uploads | capped-by-filter |
| 4 | `:180` `gsc_uploads.select(...)` project scoped | ≤ dozens | capped-by-filter |
| 5 | `:244-253` `ctr_curves` filtered by project + device + intent + `is_fallback=false` | ≤ 100 ranks per (device, intent) combo. | < 200 | capped-by-filter |
| 6 | `:302` `ctr_curves.select("id, rank_position")` — need to re-check filter scope | filtered further downstream by delete/insert — small per-run set. | < 500 | capped-by-filter |

No truncation risk observed.

---

## 4. `link-power-score-compute`

`KW_ID_CHUNK = 100`, `MAX_LIMIT = 5000` (keywords are capped).

| # | file:line | Description | Worst-case rows/call | Status |
|---|---|---|---|---|
| 1 | `:210-217` kept keywords with `.limit(effectiveLimit + 1)` | `effectiveLimit` up to 5,000. When caller doesn't pass a limit and project has > 1,000 kept kws, the `.limit()` **succeeds** because PostgREST honours explicit `.limit()` above the default cap — but any project with > 5,000 kept keywords silently truncates via the explicit cap. Acceptable per design (surfaced as `keyword_cap_applied` warning). | ≤ 5,001 | capped-by-filter |
| 2 | **`:252-256` per-batch `serp_results.select("id, keyword_id, rank_absolute, url, domain, url_rating, domain_rating, referring_domains, backlinks").in("keyword_id", ids)`** | Same density as har-v2 row 3 — 10–20 SERP rows/kw × 100 kw = **~1,000–2,000/chunk**. | **~1,000–2,000/chunk** | **TRUNCATION RISK** |

Rows 1 (writers) and the LPS insert loop use `INSERT_CHUNK = 500`; those are writes, not read caps.

---

## 5. `demand-signals-compute`

`KW_ID_CHUNK = 100`, `MAX_LIMIT = 5000`.

| # | file:line | Description | Worst-case rows/call | Status |
|---|---|---|---|---|
| 1 | `:216-222` kept keywords with optional `.limit(limitKeywords)` | When caller omits limit, PostgREST default 1,000-row cap **applies** — a project with > 1,000 kept keywords silently loses the tail. Unlike LPS this function does not set `MAX_LIMIT` as a default `.limit()`. | up to 1,000 without explicit cap | **TRUNCATION RISK** |
| 2 | **`:247-252` per-batch `keyword_monthly_volumes` by `keyword_id`** | 12 months × multiple sources per keyword × 100 kw. Multi-source dedupe happens client-side, so raw fetch can hit **~1,200–2,400/chunk** easily. | **~1,200–2,400/chunk** | **TRUNCATION RISK** |
| 3 | `:98`, `:106`, `:174` | User/role, project, run registry | 1–few | capped-by-filter |

---

## 6. `site-architecture`

`READ_CHUNK = 150` for `site_architecture` reads, `CHUNK = 200` for writes.

| # | file:line | Description | Worst-case rows/call | Status |
|---|---|---|---|---|
| 1 | `:183-186` project + client lookup `.eq(id).single()` | 1 | capped-by-filter |
| 2 | **`:201-206` kept keywords by `project_id` + `detox_status=keep`, no `.range()` loop, no `.limit()`** | With 857 kept keywords this is fine today, but any project with > 1,000 kept kws silently loses the tail — and this list drives every subsequent chunked read. | up to 1,000 | **TRUNCATION RISK** (latent, scale-dependent) |
| 3 | `:229-232` existing `site_architecture` by `keyword_id`, `READ_CHUNK=150`. Each chunk returns 1 row/kw → ≤ 150/chunk. | ≤ 150/chunk | chunked-in (safe) |
| 4 | `:383-388` cross-project cache: `keywords.select(...).eq(client_id).neq(project_id).in("keyword", keywords)` — no chunking, no `.range()` loop. If the same query text repeats across many client projects, this can exceed 1,000. | scale-dependent, up to 1,000 | **TRUNCATION RISK** (latent) |
| 5 | `:394-398` cached `site_architecture` by 500-id `.in()` slice, `.not("relevancy_score", "is", null)` | 500-id slice × 1 row/kw = ≤ 500/chunk. But `.in()` at 500 UUIDs also revives the URL-length risk from incident 2026-07-16-part2. | ≤ 500/chunk (rows fine; URL length ~19 KB) | chunked-in (safe rows) + **URL-length RISK** |
| 6 | `:611`, `:630` post-write recompute reads chunked at `READ_CHUNK=150` | ≤ 150/chunk | chunked-in (safe) |

---

## Summary — TRUNCATION RISK items (recommendation queue for advisor)

Ordered by blast radius / customer impact:

1. **`har-calculation-v2:352` per-batch `serp_results`** — silent HAR miscalculation. Priority.
2. **`har-calculation-v2:390` per-batch `link_power_scores`** — silent LPS attachment miss → wrong HAR. Priority.
3. **`link-power-score-compute:252` per-batch `serp_results`** — silent LPS miscalculation, feeds #2 on the next run.
4. **`compute-forecasts-v2:351` `keyword_monthly_volumes`** — silent revenue understatement.
5. **`demand-signals-compute:247` `keyword_monthly_volumes`** — silent trend distortion feeding compute-forecasts.
6. **`demand-signals-compute:216` kept keywords, no `.limit()`** — silently loses the tail past 1,000 kept kws.
7. **`site-architecture:201` kept keywords, no `.limit()`** — silently loses the tail past 1,000 kept kws (latent; TVs Ongoing at 857 currently under cap).
8. **`site-architecture:383` cross-project cache `keywords` fetch** — latent, scale-dependent.
9. **`site-architecture:394` 500-id `.in()`** — URL-length risk (rows OK).

All fixable via `{ paginate: true }` on `selectIn`, `fetchAllRows`, or an explicit `.range()` loop — advisor to rule on batching order.
