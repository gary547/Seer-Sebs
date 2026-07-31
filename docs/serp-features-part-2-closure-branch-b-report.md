# Part 2 Closure — `serp_features` Snapshot Discriminator (Branch B)

**Date:** 2026-07-19  
**Project:** TVs Ongoing (`5fd4df7e-45dd-40c0-b10e-86ea6dad9720`)  
**Scope:** Advisor sign-off on the Part 2 snapshot-discriminator question from the Baseline Acceptance prompt.  
**Change footprint:** none — this is a read-only closure report. No edge functions, migrations, shared modules, or UI were touched.

---

## 1. Question restated

From the Baseline Acceptance prompt, Part 2:

> Does any column in `serp_features` tie a row to a SERP snapshot or capture vintage — `serp_result_id`, `calc_run` linkage, `created_at`? For keyword `'50 inch 4k smart tv'` on TVs Ongoing, show all its rows' vintage values.

The evidence rule applies: answer with schema + row-level proof before choosing Branch A (scope fetch to latest snapshot) or Branch B (no discriminator — union-of-history stands, log staleness risk).

---

## 2. Branch taken

**Branch B — no discriminator exists.**

The `public.serp_features` schema carries no vintage, snapshot, or run-linkage column. There is nothing to scope `MAX(...)` against, and nothing on the row itself indicates which SERP capture produced it. Branch A is therefore not implementable without a schema change first.

---

## 3. Schema evidence

Full `public.serp_features` column list:

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | primary key |
| `keyword_id` | `uuid` | FK to `keywords` |
| `serp_feature_count` | `integer` | count value on the row |
| `top_serp_feature` | `text` | feature label |
| `top_serp_feature_url` | `text` | feature URL |
| `serp_feature_owned` | `boolean` | ownership flag |
| `result_type` | `text` | SERP result type (used as dedupe key by SVM) |
| `serp_intent` | `text` | intent label |
| `snippet_opportunity` | `boolean` | opportunity flag |

**Explicitly absent:**
- No `created_at` / `updated_at` / `captured_at`.
- No `serp_result_id` or any FK back into a SERP snapshot table.
- No `calc_run_id` or ingestion-batch linkage.
- No monotonically increasing `snapshot_id`, `version`, or ordinal column.

There is no column — direct or indirect — from which "latest" can be derived.

---

## 4. Row-level evidence — keyword `'50 inch 4k smart tv'`

All 21 rows for this keyword on TVs Ongoing carry only the columns listed above. There is no vintage field on any row; the rows are structurally indistinguishable in time. The rows collapse to **4 distinct `result_type` values** at the consumer boundary (SVM's first-wins dedupe by `result_type`) — figure taken from the queried breakdown in `docs/serp-features-truncation-part-c-report.md` §7. No row carries a signal that would allow the fetch layer to prefer one over another based on recency.

> **Correction (2026-07-19):** an earlier draft of this section stated "~13 distinct feature types" — that figure was narrative, not queried, and has been corrected against the Part C §7 query per the evidence rule.

This confirms the schema evidence in §3: there is no vintage discriminator at the row level either.

---

## 5. Consumer semantics under Branch B

With no discriminator, both consumers unavoidably consume the **union of all history** ever written to `serp_features`:

- **`_shared/serp-visibility-v2.ts` (`resolveSerpVisibilityV2`)** — dedupes by `(keyword_id, result_type)` on a first-wins basis when building the per-keyword feature set. SVM values reflect the all-time union of feature types ever seen for the keyword.
- **`har-calculation-v2` `serpPenalty` input path** — after the Part B/C paginated fetch + first-wins dedupe by `(keyword_id, result_type)` at the local map population, the penalty likewise reflects all-time union.

The consumer-side dedupe (added in Part B) protects SVM/serpPenalty from row-count inflation, but not from **staleness inflation**: a feature type that appeared once historically and no longer shows on the SERP is still counted as present.

---

## 6. Canonical baseline confirmation

The canonical Phase-1 TVs Ongoing baseline remains the pair captured at 2026-07-19 12:52 UTC:

- **HAR:** `020f70bd-6f2c-4923-8ff7-e055960314e0`
- **Revenue:** `81a76dc5-aeff-45f2-a5f7-ebfb8b116fbe`

Both runs post-date the truncation remediation and the `tp_abs_without_incremental` observability field. `rows_fetched.serp_features` = 19,756 raw / 4,088 distinct. The identity `Σtp_abs − Σtp_inc − tp_abs_no_inc ≤ current_revenue` holds across all three scenarios (verified in `docs/serp-features-truncation-part-c-3-baseline.md`).

The `docs/calculation-v21-programme.md` tracker already records this pair as canonical, with the "union-of-history" note attached to `serp_features`. No further baseline change is triggered by this closure — Branch B ships no code.

---

## 7. Open flag (tracker entry, verbatim)

> `serp_features` accumulates without snapshot linkage; features never expire; SVM/serpPenalty consume all-time union — staleness risk grows with snapshot count; fix candidate: vintage column + latest-snapshot scoping at write/read, revisit before Gate B calibration since stale features will distort calibration ratios.

Recorded in `docs/calculation-v21-programme.md` under the Phase-1 baseline block and carried forward into the Gate B open items list.

---

## 8. What was NOT done and why

- **No scope change in `har-calculation-v2`.** Branch A required "latest snapshot per keyword (max `created_at` batch / most recent `serp_result` linkage)." Neither column exists — there is nothing to take `MAX(...)` of. Any scoping code added today would be arbitrary (e.g. `MAX(id)`, which orders by UUID, not by time) and would silently drop real feature types without gaining recency.
- **No scope change in `compute-forecasts-v2`.** Same reason.
- **No dedupe change.** Consumer-side first-wins dedupe by `(keyword_id, result_type)` already ships from Part B/C and continues to protect SVM/serpPenalty from row-count inflation.
- **No migration.** A vintage column would need to be populated at write time by the SERP ingestion path, plus a backfill decision for existing rows; that is a design conversation, not a hotfix.

---

## 9. Recommended next step (Gate B pre-work, not in scope here)

Before Gate B calibration begins, propose an additive migration that adds `captured_at timestamptz NOT NULL DEFAULT now()` (and optionally `serp_result_id uuid`) to `serp_features`, and updates the SERP ingestion writers to stamp both. Once the column exists and has enough history, `har-calculation-v2` and `compute-forecasts-v2` can be re-scoped to the latest snapshot per keyword, and the staleness flag can be retired. Backfill policy for pre-migration rows (drop vs. treat as one legacy snapshot) is a separate decision.

This work is deliberately out of scope for the current prompt and is left as a distinct Gate B pre-work item.

---

**Report status:** ready for advisor review. No build, database, or deployment state was changed in producing this document.
