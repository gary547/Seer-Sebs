# SERP Features Truncation — Part C Verification Report

Redeploy timestamp: **2026-07-19 12:31:34 UTC**
Functions redeployed: `har-calculation-v2`, `compute-forecasts-v2`
Project: TVs Ongoing (`5fd4df7e-45dd-40c0-b10e-86ea6dad9720`)

## 1. Corrected §3 comparison table (metric-matched)

Advisor-supplied pre-fix values are `tp_incremental` totals. The Part-4 report accidentally compared them against the post-fix `expected_incremental` totals. The corrected grid below keeps each metric on its own axis; the post-fix row is populated after the operator re-runs the combo (§2).

| Scenario     | tp_incremental (pre) | tp_incremental (post-B) | expected_incremental (pre)† | expected_incremental (post-B) |
| ------------ | -------------------: | ----------------------: | --------------------------: | ----------------------------: |
| Conservative |        £4,046,043    |             (fill C.2)  |          (fill from pre-B)  |               (fill C.2)      |
| Realistic    |       £13,786,208    |             (fill C.2)  |          (fill from pre-B)  |               (fill C.2)      |
| Stretch      |       £17,259,191    |             (fill C.2)  |          (fill from pre-B)  |               (fill C.2)      |

† pre-fix `expected_incremental` totals must be sourced from the Part-4 run's `summary_json.totals`, not from advisor headline figures. The Part-4 report's Revenue-v2 totals (cons 612 / £7.49M / £6.94M · real 827 / £21.88M / £21.14M · stretch 835 / £30.84M / £29.85M) are `expected_incremental` and are the correct "pre-B" values for that column — they will be transcribed here once the post-B run is available so both columns are guaranteed metric-consistent.

**Identity check (applied to the post-B run before publication):** for each scenario, Σtp_abs − Σtp_incremental ≤ current revenue baseline for the scoped keyword population. Documented in `summary_json.totals` for the post-B `calc_run_registry` row and re-verified here before finalising the table.

## 2. Canonical post-remediation baseline (post-B combo)

_Placeholder — populated after the operator runs HAR v2 + Revenue v2 on TVs Ongoing._

- HAR v2 run ID: `TBD`
- Revenue v2 run ID: `TBD`
- HAR `rows_fetched.serp_features`: `TBD` (expected ≈ 19,756)
- HAR `rows_fetched.serp_features_distinct`: `TBD` (expected ≈ 4,088)
- Revenue `rows_fetched.serp_features`: `TBD` (expected ≈ 19,756)
- Revenue `rows_fetched.serp_features_distinct`: `TBD` (expected ≈ 4,088)
- Scenario totals: Conservative / Realistic / Stretch `TBD`
- Sample keyword `svm.matched`: `TBD` — should contain unique `featureType` values only (no repeats).

Once populated, this run supersedes the Part-4 TVs Ongoing baseline. A cross-reference note goes into `docs/calculation-v21-programme.md` §Phase-1 baselines.

## 3. Fix summary (for the tracker)

- `_shared/serp-visibility-v2.ts` — unchanged (already dedupes by lowercased `result_type`); expanded test coverage.
- `compute-forecasts-v2/index.ts` — `serp_features` fetch now `selectIn({ paginate: true })`; `summary_json.rows_fetched.serp_features_distinct` added.
- `har-calculation-v2/index.ts` — raw `.in("keyword_id", kwBatch)` replaced with `selectIn({ paginate: true })`; consumer now dedupes by `(keyword_id, result_type)` first-wins; `rows_fetched.serp_features_distinct` added.
- Tests: 4 new dedupe cases in `_shared/serp-visibility-v2.test.ts`; new `har-calculation-v2/serp-features-dedupe_test.ts` locks the first-wins reducer. All 20 tests green locally.
- Redeployed: **2026-07-19 12:31:34 UTC**.

## 4. Scope note — no "latest snapshot" today

`serp_features` has no `created_at`, `snapshot_id`, or `run_id` column. "Latest snapshot per keyword" is not derivable from schema, so the fix is fetch-complete + consumer dedupe by `(keyword_id, result_type)`. This is functionally equivalent for both SVM and HAR's serpPenalty inputs (both are per-feature-type, not per-ingest). A follow-up ticket to add a snapshot discriminator remains open in the tracker for the day we need true snapshot semantics.
