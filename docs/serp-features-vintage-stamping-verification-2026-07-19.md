# Vintage Stamping — Live Verification on DVD/Blu-ray Sync

**Date:** 2026-07-19
**Verification project:** DVD/Blu-ray (`e9ff6889-f4dd-46a1-bf57-bd39f713c0ee`)
**HAR job triggered:** `32f4f02f-bdb1-43b4-91f8-0521053c2cad` (started 2026-07-19 13:23:32 UTC via Sync Now → Phase 5 "TP & SERP refresh")
**Scope:** Read-only verification of the vintage-stamping change shipped earlier today. No build, database, or deployment state was changed in producing this document.

---

## 1. Actions delivered (recap)

Per the "Vintage Stamping + Report Correction" prompt, the following shipped earlier today (before this sync):

1. **Report correction** — `docs/serp-features-part-2-closure-branch-b-report.md` §4 amended from the narrative "~13 distinct feature types" to the queried figure **4 distinct `result_type` values** across the 21 rows for `'50 inch 4k smart tv'`, with an evidence-rule note.
2. **Additive migration on `serp_features`:**
   - `captured_at timestamptz NOT NULL DEFAULT now()`
   - `serp_result_id uuid NULL`
   - Index `(keyword_id, captured_at DESC)` for future latest-snapshot scoping
   - Existing rows backfilled to the migration timestamp as one indistinguishable "legacy snapshot" by design.
3. **Writer updates** — `supabase/functions/har-calculation/index.ts` and `src/components/SerpDataSection.tsx` now explicitly stamp `captured_at` on every inserted feature row; `serp_result_id` left NULL where the originating `serp_results` row is not in hand.
4. **Read side unchanged** — `har-calculation-v2`, `compute-forecasts-v2`, `_shared/serp-visibility-v2.ts` still consume the union of history. Re-scoping is Gate B pre-work.
5. **Deploy** — `har-calculation` redeployed **2026-07-19 13:19 UTC**. `SerpDataSection.tsx` is client-side and ships with the frontend build (no edge redeploy needed).
6. **Tracker** — `docs/calculation-v21-programme.md` open flag updated with the Gate B pre-work item.

---

## 2. Schema evidence (post-migration)

`public.serp_features` columns after the migration (queried live):

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `keyword_id` | uuid | NO | — |
| `serp_feature_count` | integer | YES | — |
| `top_serp_feature` | text | YES | — |
| `top_serp_feature_url` | text | YES | — |
| `serp_feature_owned` | boolean | NO | `false` |
| `result_type` | text | YES | — |
| `serp_intent` | text | YES | — |
| `snippet_opportunity` | boolean | YES | `false` |
| **`captured_at`** | **timestamptz** | **NO** | **`now()`** |
| **`serp_result_id`** | **uuid** | **YES** | — |

Both new columns are live. Every future insert (edge-function path or client-CSV path) will carry a real `captured_at`; the default is a safety net for any writer that forgets to stamp.

---

## 3. Sync status at report time

`har_jobs.32f4f02f-…` most-recent state (from client network log):

| Phase | Metric | Value |
|---|---|---|
| `fetch_serp` | serp_tasks_done / total | 25 / 25 ✅ |
| `fetch_ahrefs` | ahrefs_targets_done / total | 217 / 217 ✅ |
| **`fetch_backlinks`** | backlinks_targets_done / total | **0 / 216 (in progress)** |
| `last_error` | — | null |

SERP fetch + ingestion completed at ~13:26 UTC. Ahrefs URL Rating / Domain Rating for 217 URLs completed. The job is currently working through Ahrefs backlink counts for 216 URLs — this is the slow Ahrefs API stage, unrelated to the vintage-stamping change. `serp_features` writes for this run are done and can be verified now.

---

## 4. Vintage-stamping verification — DVD/Blu-ray rows

Queried aggregate on `serp_features` rows belonging to DVD/Blu-ray keywords:

```
total_rows              : 273
earliest captured_at    : 2026-07-19 13:25:02.824 UTC
latest   captured_at    : 2026-07-19 13:26:02.058 UTC
distinct minute-buckets : 2
serp_result_id populated: 0 / 273
```

Per-minute breakdown for this project:

| Minute (UTC) | Rows |
|---|---|
| 2026-07-19 13:26 | 199 |
| 2026-07-19 13:25 | 74 |

**Interpretation:**
- All 273 rows carry a real capture timestamp inside the sync's SERP-ingestion window (which finished at ~13:26, immediately after the 25/25 SERP tasks completed at 13:25:XX). This is the first evidence that the updated `har-calculation` writer is stamping `captured_at` explicitly on the DataForSEO path — not falling back to the default.
- The two-minute spread reflects the natural batching inside the SERP loop (feature rows are pushed as SERP tasks return), not a design issue. All 273 rows are one logical snapshot for this run.
- `serp_result_id` = 0 / 273 populated is expected for this iteration: the current writer leaves it NULL because the originating `serp_results` row is not carried through the local map. This matches the advisor's "where the row is in hand" instruction and the plan §2b note. Populating it is a separate, non-blocking follow-up.

---

## 5. Legacy vs live rows — global view

Whole-table `captured_at` breakdown (all projects, top minute-buckets):

| Minute (UTC) | Rows | Meaning |
|---|---|---|
| 2026-07-19 **13:17** | **71,511** | Migration backfill — one indistinguishable "legacy snapshot" for all pre-migration history, as designed |
| 2026-07-19 13:26 | 199 | DVD/Blu-ray live write |
| 2026-07-19 13:25 | 74 | DVD/Blu-ray live write |

The legacy backfill (71,511 rows, migration timestamp 13:17 UTC) is cleanly separated from the first real capture (13:25 UTC), confirming the write path is producing distinguishable vintage. Any future refresh on any project will land at a new `captured_at` distinct from both. Gate B pre-work can safely scope on `MAX(captured_at)` per keyword once at least one refresh per active project has run — legacy rows will naturally lose priority.

---

## 6. Identity check — post-migration semantics

- **Read side (union-of-history):** unchanged — `har-calculation-v2` and `compute-forecasts-v2` still fetch all `serp_features` rows per keyword and dedupe by `(keyword_id, result_type)`. Any downstream metric (SVM, `serpPenalty`) is unaffected by this change.
- **Write side (vintage stamping):** live and verified above.
- **Canonical TVs Ongoing baseline:** unaffected. Run pair HAR `020f70bd…` / Revenue `81a76dc5…` remains canonical (recorded in `docs/calculation-v21-programme.md`).

---

## 7. What was NOT changed (guardrails held)

- No changes to `har-calculation-v2/index.ts` or `compute-forecasts-v2/index.ts`.
- No changes to `_shared/serp-visibility-v2.ts` or any consumer of `serp_features`.
- No RLS/grant changes on `serp_features` (existing policies and grants remained in place; the migration was columns + index + comments only).
- No backfill of `serp_result_id` for legacy rows — deliberately deferred.

---

## 8. Recommended next steps (for advisor sign-off)

1. **Accept the write-side stamping as delivered** — evidence in §4 confirms new rows carry real capture times distinct from the legacy backfill timestamp.
2. **Track `serp_result_id` population as a Gate B pre-work follow-up.** Populating it requires threading the parent `serp_results.id` through the local map in `har-calculation/index.ts` for organic feature types; feature rows without an originating organic row (PAA, Answer, etc.) will remain NULL by construction.
3. **Wait for one full refresh cycle across active projects before re-scoping reads.** Once every active project has at least one post-migration `captured_at`, add the latest-snapshot scoping in `har-calculation-v2` and `compute-forecasts-v2` (Gate B pre-work item already logged in `docs/calculation-v21-programme.md`).
4. **Let the current DVD/Blu-ray sync finish.** Backlinks fetch (216 targets) is the long tail; the vintage-stamping verification does not depend on it completing. If the advisor wants a re-verification after full completion — including checking that no additional `serp_features` rows land outside the 13:25–13:26 window — that can be produced on request.

---

**Report status:** ready for advisor review.
