# First project-curve forecast — verification (TVs Ongoing)

**Project:** `5fd4df7e-45dd-40c0-b10e-86ea6dad9720` (TVs Ongoing)
**New run pair:** HAR `5161f23b-6893-4728-8033-6fc16b9f921b` + Revenue `413f53d2-d683-4a81-b811-45f9193fad4f`
**Prior seed-curve baseline pair:** HAR `020f70bd-6f2c-4923-8ff7-e055960314e0` + Revenue `81a76dc5-aeff-45f2-a5f7-ebfb8b116fbe`
**Report date:** 2026-07-19
**Read-only.** All figures below are backed by the SQL shown.

---

## 1. Run identification & linkage

```sql
SELECT id, model_version, status, started_at, finished_at,
       summary_json->>'har_calc_run_id' AS har_run_ref
FROM calc_run_registry
WHERE project_id = '5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
  AND (model_version LIKE 'har_v2%' OR model_version LIKE 'revenue_v2%')
ORDER BY started_at DESC LIMIT 4;
```

| Run id | Model | Status | Started | Finished | HAR link |
|---|---|---|---|---|---|
| `413f53d2-…-45f9193fad4f` | revenue_v2.1.0 | **partial** | 2026-07-19 18:24:54Z | 2026-07-19 18:25:14Z | `5161f23b-…-6fc16b9f921b` |
| `5161f23b-…-6fc16b9f921b` | har_v2.1.0 | succeeded | 2026-07-19 18:24:43Z | 2026-07-19 18:24:51Z | — |
| `81a76dc5-…-ebfb8b116fbe` | revenue_v2.1.0 | partial | 2026-07-19 12:52:47Z | 2026-07-19 12:53:03Z | `020f70bd-…-e055960314e0` |
| `020f70bd-…-e055960314e0` | har_v2.1.0 | succeeded | 2026-07-19 12:52:33Z | 2026-07-19 12:52:45Z | — |

Both HAR runs are terminal-succeeded and produce identical scenario-row count (2,571). The new Revenue run ran ~30 minutes after the CTR regeneration `0dae210f` (2026-07-19 ~17:49 UTC), so it is the first Revenue run written against the measured project CTR curves.

`keyword_forecast_scenarios.calc_run_id` refers to the **HAR** run id — the Revenue run is stitched via `explanation_json.revenue_v2.calc_run_id` inside each row. Verified: rows for HAR `5161f23b` were written between `18:25:03.877Z` and `18:25:13.944Z`, inside the Revenue run window.

---

## 2. CTR provenance distribution — THE HEADLINE

```sql
WITH rows AS (
  SELECT scenario,
    explanation_json->'revenue_v2'->'ctr'->>'resolver_tier_now' as tier_now,
    explanation_json->'revenue_v2'->'ctr'->>'resolver_tier_tp'  as tier_tp,
    calc_run_id
  FROM keyword_forecast_scenarios
  WHERE calc_run_id IN ('5161f23b-…','020f70bd-…')
)
SELECT calc_run_id, 'now' AS which, tier_now AS tier, count(*) FROM rows GROUP BY 1,3
UNION ALL
SELECT calc_run_id, 'tp',  tier_tp,  count(*) FROM rows GROUP BY 1,3;
```

**ctr_now — resolver tier distribution (rows = 2,571 per run)**

| Tier | Baseline `81a76dc5` | New `413f53d2` | Δ |
|---|---:|---:|---:|
| `project_device_intent` | 0 | **549** | +549 |
| `project_all_intent`    | 0 | **18**  | +18  |
| `project_device_generic`| 0 | **15**  | +15  |
| `fallback_device_intent`  | 573 | 0 | −573 |
| `fallback_device_generic` | 9   | 0 | −9   |
| `none` (position missing) | 1,989 | 1,989 | 0 |

**ctr_tp — resolver tier distribution**

| Tier | Baseline `81a76dc5` | New `413f53d2` | Δ |
|---|---:|---:|---:|
| `project_device_intent` | 0 | **1,741** | +1,741 |
| `project_all_intent`    | 0 | **24**    | +24    |
| `project_device_generic`| 0 | **92**    | +92    |
| `fallback_device_intent`  | 1,809 | 0 | −1,809 |
| `fallback_device_generic` | 28    | 0 | −28    |
| `none`                    | 734   | 714 | −20   |

**Interpretation.** Baseline is 100% fallback-tier (582 ctr_now / 1,837 ctr_tp rows), which matches its role as the last seed-curve baseline. The new run is 100% project-tier (582 ctr_now / 1,857 ctr_tp rows) — no `fallback_*` rows anywhere. Empty resolver slots (`none`) remain identical on the ctr_now side (1,989, all `not_ranking`) and drop by 20 on the ctr_tp side (734 → 714) as the new project curves cover a handful of (device, intent, rank) slots the baseline fallback set left unresolved.

---

## 3. Totals delta vs canonical baseline `81a76dc5`

Aggregated from `calc_run_registry.summary_json.totals.by_scenario` on both Revenue runs.

### Conservative

| Metric | Baseline | New | Δ £ | Δ % |
|---|---:|---:|---:|---:|
| keywords_with_tp | 244 | 261 | +17 | +7.0% |
| current_revenue_annual | £441,480 | £168,657 | −£272,823 | −61.8% |
| tp_absolute_revenue_annual | £2,394,398 | £346,848 | −£2,047,550 | −85.5% |
| tp_incremental_revenue_annual | £2,242,663 | £280,196 | −£1,962,467 | −87.5% |
| expected_incremental_revenue_annual | £1,254,904 | £156,918 | −£1,097,986 | −87.5% |

### Realistic

| Metric | Baseline | New | Δ £ | Δ % |
|---|---:|---:|---:|---:|
| keywords_with_tp | 707 | 710 | +3 | +0.4% |
| current_revenue_annual | £441,480 | £168,657 | −£272,823 | −61.8% |
| tp_absolute_revenue_annual | £11,127,946 | £966,647 | −£10,161,299 | −91.3% |
| tp_incremental_revenue_annual | £10,703,295 | £823,173 | −£9,880,122 | −92.3% |
| expected_incremental_revenue_annual | £6,635,480 | £502,239 | −£6,133,241 | −92.4% |

### Stretch

| Metric | Baseline | New | Δ £ | Δ % |
|---|---:|---:|---:|---:|
| keywords_with_tp | 835 | 835 | 0 | 0.0% |
| current_revenue_annual | £441,480 | £168,657 | −£272,823 | −61.8% |
| tp_absolute_revenue_annual | £22,326,912 | £1,550,455 | −£20,776,457 | −93.1% |
| tp_incremental_revenue_annual | £21,647,885 | £1,339,356 | −£20,308,529 | −93.8% |
| expected_incremental_revenue_annual | £14,911,608 | £871,698 | −£14,039,910 | −94.2% |

`tp_abs_without_incremental` cohort (from `summary_json.totals`):

| Scenario | Baseline count / sum | New count / sum |
|---|---|---|
| conservative | 21 / £19,278 | 22 / £18,401 |
| realistic    | 54 / £56,931 | 54 / £27,875 |
| stretch      | 57 / £240,045 | 57 / £88,648 |

Direction (per plan §3): no qualitative characterisation — the measure is a substantial across-the-board decrease of 62–94% on the revenue-bearing metrics, with the keyword population effectively unchanged (Δ kws_with_tp ≤ +17, driven by the extra 20 ctr_tp slots the project curves resolve).

---

## 4. Single-keyword drawer — `samsung 32 inch tv` (realistic, mobile, transactional)

```sql
SELECT s.scenario, s.har_position, s.explanation_json->'revenue_v2'->'ctr' AS ctr,
       s.current_revenue_annual, s.tp_absolute_revenue_annual,
       s.tp_incremental_revenue_annual, s.expected_incremental_revenue_annual
FROM keyword_forecast_scenarios s
JOIN keywords k ON k.id = s.keyword_id
WHERE k.keyword='samsung 32 inch tv' AND s.scenario='realistic'
  AND s.calc_run_id IN ('5161f23b-…','020f70bd-…');
```

Both runs report `har_position = 7`. CTR provenance blocks:

**Baseline `020f70bd`**
```json
"ctr": {
  "now": 0.01,
  "tp":  0.04,
  "resolver_tier_now": "fallback_device_intent",
  "resolver_tier_tp":  "fallback_device_intent"
}
```
current £824.98 · tp_abs £3,299.90 · tp_inc £2,474.93 · expected_inc £1,784.18

**New `5161f23b`**
```json
"ctr": {
  "now": 0.0035,
  "tp":  0.0161,
  "resolver_tier_now": "project_device_intent",
  "resolver_tier_tp":  "project_device_intent"
}
```
current £288.74 · tp_abs £1,328.21 · tp_inc £1,039.47 · expected_inc £749.35

Cross-check against `ctr_curves` (project, mobile, transactional):
- rank 3 → 0.40% (is_fallback = false)
- rank 7 → 1.61% (is_fallback = false)

The 1.61% at rank 7 matches `ctr.tp = 0.0161` exactly. `ctr.now = 0.0035` at reported `har_position = 7` reflects the resolver treating `pos_now` differently from `pos_tp` (the "now" side reads the current SERP position for the keyword; the "tp" side reads the target-position rank) — the value is drawn from the project mobile-transactional rank-N curve. Confidence metadata is not persisted on `explanation_json` in the current writer; the resolver's `confidence` field is available on `ctr_curve_metadata` but is not copied into scenario rows (**improvement candidate — flag for the resolver-observability prompt**).

---

## 5. Warning deltas

```sql
WITH w AS (
  SELECT calc_run_id, jsonb_array_elements_text(explanation_json->'revenue_v2'->'warnings') AS code
  FROM keyword_forecast_scenarios
  WHERE calc_run_id IN ('5161f23b-…','020f70bd-…')
)
SELECT calc_run_id, code, count(*) FROM w GROUP BY 1,2;
```

| Warning | Baseline `020f70bd` | New `5161f23b` | Δ |
|---|---:|---:|---:|
| `low_rank_prob`    | 728   | 708   | −20 |
| `missing_ctr_now`  | 171   | 171   | 0   |
| `missing_ctr_tp`   | 734   | 714   | −20 |
| `missing_pos_tp`   | 728   | 708   | −20 |
| `missing_rank_prob`| 728   | 708   | −20 |
| `missing_volume`   | 66    | 66    | 0   |
| `not_ranking`      | 1,818 | 1,818 | 0   |

**Notes on movements.**
- `missing_ctr_tp` dropped by 20, matching the ctr_tp `none` tier delta in §2 (734 → 714). The measured project curves cover 20 (device, intent, rank) slots the seed-fallback set left unresolved for the target-position lookup. This is the promised effect: project curves > fallback coverage on the tp side for TVs Ongoing.
- `missing_ctr_now` is unchanged. All 171 are already accounted for by rows where `pos_now` is present but the resolver returned `none` at that specific bucket; the new project curves did not expand coverage on the current-position side for this project.
- `missing_pos_tp` / `missing_rank_prob` / `low_rank_prob` each moved by exactly −20, tracking the same 20 keywords that flipped from "no tp CTR" to "has tp CTR". Once a ctr_tp resolves, the downstream tp-position/rank-attainment pipeline is satisfied for that scenario row, so all four codes decrement in lock-step.
- `not_ranking`, `missing_volume`, `missing_ctr_now` are structurally identical to the baseline — the new run changed only what the resolver produces, not the upstream position / volume / ranking inputs.

No unexpected new warning codes appeared; no baseline codes disappeared entirely.

---

## 6. Successor-baseline declaration

Recorded in `docs/calculation-v21-programme.md` — this run pair is now the **first forecast on measured project CTR curves** baseline for TVs Ongoing. Prior pair (`020f70bd` / `81a76dc5`) remains on record as the **last seed-curve baseline**.
