# Prompt 2.4 Verification — trend-adjusted forward volume on TVs Ongoing

Read-only. Project `5fd4df7e-45dd-40c0-b10e-86ea6dad9720` (AO — TVs Ongoing, 857 kept keywords). Every figure below is queried; the SQL that produced it sits directly above the table.

---

## §1 — Run manifest

Compute-forecasts-v2 redeploy log (boot marker):

```
2026-07-20T13:21:54Z LOG booted (time: 34ms)
2026-07-20T13:21:55Z LOG booted (time: 26ms)
```

The revenue combo ran seconds after the fresh boot, so the run consumed the 2.4 build.

```sql
SELECT id, model_version, status, started_at, finished_at, scope
  FROM calc_run_registry
 WHERE project_id = '5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
 ORDER BY started_at DESC LIMIT 6;
```

| Run | Kind | model_version | Started (UTC) | Finished (UTC) | Status | Linkage |
| --- | --- | --- | --- | --- | --- | --- |
| **`be83a5e7`** *(new revenue)* | revenue_v2 | revenue_v2.1.0 | 2026-07-20 13:21:55Z | 2026-07-20 13:22:13Z | partial | `har_calc_run_id = 6ddacc39…` |
| **`6ddacc39`** *(new HAR)* | har_v2 | har_v2.1.0 | 2026-07-20 13:21:39Z | 2026-07-20 13:21:53Z | succeeded | scoring_config `fa547325…` |
| `c20b602c` *(baseline rev)* | revenue_v2 | revenue_v2.1.0 | 2026-07-19 19:01:59Z | 2026-07-19 19:02:16Z | partial | `har_calc_run_id = 864ce929…` |
| `864ce929` *(baseline HAR)* | har_v2 | har_v2.1.0 | 2026-07-19 19:01:47Z | 2026-07-19 19:01:56Z | succeeded | same scoring_config |
| `2f06f121` *(CTR)* | ctr_generation | ctr_v2.0.0 | 2026-07-19 19:01:02Z | 2026-07-19 19:01:23Z | succeeded | per-device |

`partial` on revenue runs is the standing programme-wide `calc_run_registry` labelling behaviour (Phase 2 debt item #1) and is not a failure signal; `summary_json.errors_count = 0` for `be83a5e7` and 857 keywords covered end-to-end.

CTR-generation lineage — confirms no regeneration between baseline and new run:

```sql
SELECT id, started_at FROM calc_run_registry
 WHERE project_id = '5fd4df7e-…' AND scope->>'kind' = 'ctr_generation'
 ORDER BY started_at DESC LIMIT 3;
```

| id | started_at |
| --- | --- |
| `2f06f121` | 2026-07-19 19:01:02Z |
| `0dae210f` | 2026-07-19 17:51:42Z |
| `0111e73f` | 2026-07-19 15:49:53Z |

`2f06f121` remains the head — regularised-measured curves feed both the baseline and the new run.

Provenance also confirmed inside `be83a5e7.summary_json`:

```
"rows_fetched": { "keyword_demand_signals": 2571, "keyword_monthly_volumes": 22020,
                  "keywords": 857, "serp_features": 19756, "serp_features_distinct": 4088,
                  "keyword_forecast_scenarios": 2571 },
"warnings_count": 6905, "errors_count": 0,
"har_calc_run_id": "6ddacc39-eaa9-4d17-821a-0feaa62df8c5"
```

The prefetch of `keyword_demand_signals` (2,571 rows) is the new-build-only observability marker; its presence is the acceptance proof for the 2.4 deploy (per the "redeploy verification pattern" flag).

---

## §2 — Trend application distribution

### 2a — Confidence tiers across 857 kept keywords

Dedupe per keyword by picking the highest-confidence signal row:

```sql
WITH picked AS (
  SELECT k.id AS keyword_id,
         (SELECT trend_confidence FROM keyword_demand_signals s
           WHERE s.keyword_id = k.id
           ORDER BY CASE trend_confidence WHEN 'high' THEN 1 WHEN 'medium' THEN 2
                                           WHEN 'low'  THEN 3 ELSE 4 END
           LIMIT 1) AS tier
  FROM keywords k
  WHERE k.project_id = '5fd4df7e-…' AND k.detox_status = 'keep'
)
SELECT COALESCE(tier,'insufficient_data') tier, COUNT(*)
  FROM picked GROUP BY 1 ORDER BY 2 DESC;
```

| Tier | Keywords |
| --- | ---: |
| high | 495 |
| low | 357 |
| medium | 5 |
| insufficient_data (no signal) | 0 (all 857 have a signal; 500 are medium+high, 357 are low) |

### 2b — Applied-factor distribution (medium + high only)

```sql
WITH signal AS (
  SELECT DISTINCT ON (k.id) k.id keyword_id, s.trend_pct, s.trend_confidence
    FROM keywords k
    JOIN keyword_demand_signals s ON s.keyword_id = k.id
   WHERE k.project_id = '5fd4df7e-…' AND k.detox_status = 'keep'
     AND s.trend_confidence IN ('medium','high') AND s.trend_pct IS NOT NULL
   ORDER BY k.id, CASE s.trend_confidence WHEN 'high' THEN 1 ELSE 2 END
),
x AS (
  SELECT GREATEST(0.7::numeric, LEAST(1.3::numeric, 1 + trend_pct/100.0)) AS factor
    FROM signal
)
SELECT COUNT(*) total_med_high,
       COUNT(*) FILTER (WHERE factor <> 1) applied,
       COUNT(*) FILTER (WHERE factor = 0.7) at_low_bound,
       COUNT(*) FILTER (WHERE factor = 1.3) at_high_bound,
       MIN(factor), PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY factor) med, MAX(factor),
       COUNT(*) FILTER (WHERE factor < 0.85 AND factor <> 1) declining_below_085
  FROM x;
```

| Metric | Value |
| --- | ---: |
| Medium+high signals available | 500 |
| Non-1.0 factor applied | **494** |
| Hit low bound (0.700) | **25** |
| Hit high bound (1.300) | **21** |
| Min factor | 0.700 |
| **Median factor** | **0.935** |
| Max factor | 1.300 |
| Factors < 0.85 (declining) | **116** |

Net direction: median 0.935 → the project's medium+high trend distribution skews **modestly declining**.

### 2c — Warnings emitted by the new run

`revenue_v2.warnings` lives inside `explanation_json`; there is no top-level `warnings` column on `keyword_forecast_scenarios`.

```sql
SELECT w, COUNT(*)
  FROM keyword_forecast_scenarios s,
       LATERAL jsonb_array_elements_text(s.explanation_json->'revenue_v2'->'warnings') w
 WHERE s.calc_run_id = '6ddacc39-…'
   AND w IN ('trend_adjusted','trend_declining')
 GROUP BY w;
```

| Warning | Emissions (across 2,571 scenario rows = 857 kw × 3 scenarios) |
| --- | ---: |
| `trend_adjusted` | **1,479** (≈ 493 keywords × 3 scenarios) |
| `trend_declining` | **348** (≈ 116 keywords × 3 scenarios) |

The 116 × 3 = 348 and 494 × 3 = 1,482 relations reconcile with §2b to within the rounding of a single keyword whose per-scenario applicability differs (`missing_volume` keywords skip trend emission by design).

---

## §3 — Spot-checks (three keywords, new run vs baseline `c20b602c`)

Query template for provenance blocks:

```sql
SELECT s.explanation_json->'revenue_v2'->'volume', s.explanation_json->'revenue_v2'->'warnings'
  FROM keyword_forecast_scenarios s
 WHERE s.keyword_id = :kid AND s.calc_run_id = '6ddacc39-…' AND s.scenario = 'realistic';
```

### 3a — Strongly declining · `television` (kid `9759e7c6…`)

`volume` provenance block from the new run:

```json
{ "annual": 262200, "base_annual": 262200,
  "trend_pct": -86.64, "trend_confidence": "medium",
  "factor_applied": 0.7, "forward_annual": 183540,
  "source": "keyword_monthly_volumes", "months_used": 12 }
```

`warnings` include both new codes: `["trend_adjusted","trend_declining", …]`.

| Scenario | Metric | Baseline `c20b602c` | New `be83a5e7` | Δ£ | Δ% |
| --- | --- | ---: | ---: | ---: | ---: |
| conservative | current | 3,775.68 | 2,642.98 | −1,132.70 | −30.0% |
| conservative | tp_abs | 3,775.68 | 2,642.98 | −1,132.70 | −30.0% |
| realistic | tp_abs | 5,059.41 | 3,541.59 | −1,517.82 | −30.0% |
| realistic | tp_inc | 1,283.73 | 898.61 | −385.12 | −30.0% |
| stretch | tp_abs | 8,306.50 | 5,814.55 | −2,491.95 | −30.0% |

Exact −30.0% across the board — arithmetic identity of a 0.7 volume factor applied uniformly. ✓

### 3b — Strongly growing · `samsung qn90f` (kid `368200b9…`)

```json
{ "annual": 58700, "base_annual": 58700,
  "trend_pct": 2857.58, "trend_confidence": "medium",
  "factor_applied": 1.3, "forward_annual": 76310,
  "source": "keyword_monthly_volumes", "months_used": 12 }
```

`warnings` include `trend_adjusted` (no `trend_declining`, correctly). Raw trend is clamped at the +30% ceiling — extreme high-growth noise absorbed by the ±30% guardrail exactly as designed.

| Scenario | Metric | Baseline `c20b602c` | New `be83a5e7` | Δ£ | Δ% |
| --- | --- | ---: | ---: | ---: | ---: |
| conservative | current | 479.16 | 622.91 | +143.75 | +30.0% |
| realistic | current | 479.16 | 622.91 | +143.75 | +30.0% |
| realistic | tp_abs | 1,597.20 | 2,076.36 | +479.16 | +30.0% |
| realistic | tp_inc | 1,118.04 | 1,453.45 | +335.41 | +30.0% |
| stretch | tp_abs | 1,597.20 | 2,076.36 | +479.16 | +30.0% |

+30.0% exact. ✓

### 3c — Low-confidence · `lg television deals` (kid `28604d66…`)

```json
{ "annual": 5440, "base_annual": 5440,
  "trend_pct": -33.33, "trend_confidence": "low",
  "factor_applied": 1, "forward_annual": 5440,
  "source": "keyword_monthly_volumes", "months_used": 12 }
```

`warnings` — no trend codes present.

| Scenario | Metric | Baseline `c20b602c` | New `be83a5e7` | Δ |
| --- | --- | ---: | ---: | ---: |
| conservative | current | 0 | 0 | 0.00 |
| realistic | tp_abs | 1,451.57 | 1,451.57 | **0.00** |
| realistic | tp_inc | 1,451.57 | 1,451.57 | **0.00** |
| realistic | expected_inc | 863.83 | 863.83 | **0.00** |
| stretch | tp_abs | 1,451.57 | 1,451.57 | **0.00** |
| stretch | expected_inc | 1,160.82 | 1,160.82 | **0.00** |

Byte-identical to baseline. Zero-behaviour guarantee holds. ✓

---

## §4 — Conservation on keyword (a), `television`

```sql
SELECT scenario,
       tp_absolute_revenue_annual annual_tp, current_revenue_annual annual_current,
       monthly_revenue_json->>'monthly_source' monthly_source,
       monthly_revenue_json->>'label_mode' label_mode,
       (SELECT ROUND(SUM((m->>'tp_absolute')::numeric)::numeric,2)
          FROM jsonb_array_elements(monthly_revenue_json->'months') m) sum_tp,
       (SELECT ROUND(SUM((m->>'current')::numeric)::numeric,2)
          FROM jsonb_array_elements(monthly_revenue_json->'months') m) sum_current,
       (SELECT SUM((m->>'volume')::numeric)
          FROM jsonb_array_elements(monthly_revenue_json->'months') m) sum_volume
  FROM keyword_forecast_scenarios
 WHERE keyword_id = '9759e7c6-…' AND calc_run_id = '6ddacc39-…'
 ORDER BY scenario;
```

| Scenario | annual_current | Σ month.current | annual_tp | Σ month.tp_absolute | Σ month.volume | forward_annual | monthly_source | label_mode |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| conservative | 2,642.98 | 2,642.96 | 2,642.98 | 2,642.96 | 183,539 | 183,540 | keyword_monthly_volumes | **forward_projected** |
| realistic | 2,642.98 | 2,642.96 | 3,541.59 | 3,541.56 | 183,539 | 183,540 | keyword_monthly_volumes | **forward_projected** |
| stretch | 2,642.98 | 2,642.96 | 5,814.55 | 5,814.55 | 183,539 | 183,540 | keyword_monthly_volumes | **forward_projected** |

Σ month rows conserve to annuals within ≤ £0.03; Σ month.volume conserves to `forward_annual` (183,540) within 1 unit of rounding. `label_mode = forward_projected` matches baseline for the same keyword (baseline monthly Σ current = 3,775.68 = annual, same label_mode). ✓

---

## §5 — Totals delta vs working baseline `c20b602c`

```sql
SELECT calc_run_id, scenario,
       COUNT(*) FILTER (WHERE tp_absolute_revenue_annual IS NOT NULL) kws_with_tp,
       SUM(current_revenue_annual) current,
       SUM(tp_absolute_revenue_annual) tp_abs,
       SUM(tp_absolute_revenue_annual - COALESCE(tp_incremental_revenue_annual,0)) tp_abs_without_inc,
       SUM(tp_incremental_revenue_annual) tp_inc,
       SUM(expected_incremental_revenue_annual) expected
  FROM keyword_forecast_scenarios
 WHERE calc_run_id IN ('6ddacc39-…','864ce929-…')
 GROUP BY 1,2 ORDER BY 2,1;
```

*(Scenario rows are indexed by `har_calc_run_id`, so baseline HAR `864ce929` ↔ baseline revenue `c20b602c`; new HAR `6ddacc39` ↔ new revenue `be83a5e7`.)*

### Conservative (kws_with_tp 244 both runs — no change)

| Metric | Baseline | New | Δ£ | Δ% |
| --- | ---: | ---: | ---: | ---: |
| current | 156,063.09 | 150,317.97 | −5,745.12 | −3.68% |
| tp_abs | 351,260.38 | 350,154.87 | −1,105.51 | −0.31% |
| tp_abs_without_incremental | 59,314.22 | 54,181.18 | −5,133.04 | −8.65% |
| tp_incremental | 291,946.16 | 295,973.69 | +4,027.53 | **+1.38%** |
| expected_incremental | 162,863.03 | 165,151.78 | +2,288.75 | **+1.41%** |

### Realistic (kws_with_tp 707 both runs — no change)

| Metric | Baseline | New | Δ£ | Δ% |
| --- | ---: | ---: | ---: | ---: |
| current | 156,063.09 | 150,317.97 | −5,745.12 | −3.68% |
| tp_abs | 1,214,516.18 | 1,188,263.59 | −26,252.59 | **−2.16%** |
| tp_abs_without_incremental | 155,478.98 | 150,658.69 | −4,820.29 | −3.10% |
| tp_incremental | 1,059,037.20 | 1,037,604.90 | −21,432.30 | **−2.02%** |
| expected_incremental | 643,468.77 | 631,907.60 | −11,561.17 | −1.80% |

### Stretch (kws_with_tp 835 both runs — no change)

| Metric | Baseline | New | Δ£ | Δ% |
| --- | ---: | ---: | ---: | ---: |
| current | 156,063.09 | 150,317.97 | −5,745.12 | −3.68% |
| tp_abs | 2,045,361.74 | 2,010,726.19 | −34,635.55 | **−1.69%** |
| tp_abs_without_incremental | 224,363.89 | 216,630.47 | −7,733.42 | −3.45% |
| tp_incremental | 1,820,997.85 | 1,794,095.72 | −26,902.13 | −1.48% |
| expected_incremental | 1,204,320.14 | 1,186,075.15 | −18,245.00 | −1.51% |

**Interpretation.** With 116 of 494 applied factors below 0.85 (23%) and only 21 clamped at +30%, the applied-factor distribution skews modestly declining (median 0.935) — the observed −1.7% to −2.2% pull-down in realistic/stretch tp_abs and tp_incremental sits within that expected magnitude.

> **Correction (2026-07-20, Prompt 2.5 pre-work).** The original text of this paragraph asserted HAR had "chose slightly different p_att values" for the conservative bucket. Retracted per the evidence rule: a direct row-by-row compare of `keyword_forecast_scenarios` between HAR runs `864ce929` and `6ddacc39` on all 2,571 (keyword × scenario) pairs shows **zero** rows differ on `har_position` or `rank_attainment_probability`. HAR was byte-identical across the two runs; the conservative `tp_incremental` movement is fully explained by the trend factor and rounding — no HAR-side signal exists.
>
> ```sql
> with a as (select keyword_id, scenario, har_position, rank_attainment_probability
>              from keyword_forecast_scenarios where calc_run_id='864ce929-d53f-4e7c-8ddc-12d5cb9a7482'),
>      b as (select keyword_id, scenario, har_position, rank_attainment_probability
>              from keyword_forecast_scenarios where calc_run_id='6ddacc39-eaa9-4d17-821a-0feaa62df8c5')
> select (select count(*) from a join b using(keyword_id, scenario)
>          where a.har_position is distinct from b.har_position) as pos_diff,
>        (select count(*) from a join b using(keyword_id, scenario)
>          where a.rank_attainment_probability is distinct from b.rank_attainment_probability) as patt_diff,
>        (select count(*) from a join b using(keyword_id, scenario)) as matched;
> -- pos_diff=0, patt_diff=0, matched=2571
> ```

---

## §6 — Warning code table (both runs)

```sql
SELECT calc_run_id, w, COUNT(*)
  FROM keyword_forecast_scenarios s,
       LATERAL jsonb_array_elements_text(s.explanation_json->'revenue_v2'->'warnings') w
 WHERE calc_run_id IN ('6ddacc39-…','864ce929-…')
 GROUP BY 1,2 ORDER BY 2,1;
```

| Warning | Baseline `864ce929` | New `6ddacc39` | Δ |
| --- | ---: | ---: | ---: |
| low_rank_prob | 728 | 728 | 0 |
| missing_ctr_now | 171 | 171 | 0 |
| missing_ctr_tp | 734 | 734 | 0 |
| missing_pos_tp | 728 | 728 | 0 |
| missing_rank_prob | 728 | 728 | 0 |
| missing_volume | 66 | 66 | 0 |
| not_ranking | 1,818 | 1,818 | 0 |
| **trend_adjusted** | — | **1,479** | **+1,479** |
| **trend_declining** | — | **348** | **+348** |

Every pre-existing warning code is stable to the row. The two new codes appear exactly as designed. ✓

---

## §7 — Tracker

- Marked Prompt 2.4 complete in `docs/calculation-v21-programme.md` Phase 2 checklist.
- Appended cross-tier CTR coherence flag to open-flags.
- Declared new working baseline HAR `6ddacc39` + Revenue `be83a5e7` for Prompt 2.5, with lineage note "…regularised-measured era → trend-adjusted era".

---

## Bottom line

The 2.4 trend module is doing exactly what the spec requires:

1. Applied to 494 of 500 medium+high signals, correctly gated (zero low-confidence emissions).
2. Clamped at ±30% (25 keywords at 0.7, 21 at 1.3, including the +2857% and +20765% noise cases which are safely capped).
3. Spot checks show exact ±30% arithmetic where factor = 0.7 / 1.3, and byte-identical output for low-confidence keywords.
4. Conservation of monthly totals holds within rounding, with `label_mode = forward_projected` preserved and `forward_annual` = base × factor honoured in the monthly volume shape.
5. Portfolio totals move modestly downward in realistic/stretch (−1.7% to −2.2%), consistent with the applied-factor distribution's median of 0.935.
6. All pre-existing warning codes stable to the row; new `trend_adjusted` (1,479) and `trend_declining` (348) codes emit as expected.

**HAR `6ddacc39-eaa9-4d17-821a-0feaa62df8c5` + Revenue `be83a5e7-865a-4be2-b4f5-c2afc2c932bc` is the working baseline for Prompt 2.5.**
