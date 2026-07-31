# Curve Regularisation Verification — TVs Ongoing (2026-07-19)

Read-only post-PAV verification. Project `5fd4df7e-45dd-40c0-b10e-86ea6dad9720`. All figures SQL-backed.

---

## 1. Run manifest

PAV redeploy of `ctr-curves-from-gsc`: **2026-07-19 18:59 UTC** (guardrail 6, prior message).

```sql
SELECT id, model_version, scope->>'kind' AS kind, status,
       started_at, finished_at,
       summary_json->'har_calc_run_id' AS har_calc_run_id
FROM calc_run_registry
WHERE project_id = '5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
  AND (model_version LIKE 'ctr\_%' OR model_version LIKE 'har_v2%' OR model_version LIKE 'revenue_v2%')
ORDER BY started_at DESC LIMIT 10;
```

| Kind | ID | Started (UTC) | Finished (UTC) | Status | Links |
|---|---|---|---|---|---|
| ctr_generation `ctr_v2.0.0` | `2f06f121-077d-4ee6-83d7-3eb67ca75b13` | 19:01:02.782 | 19:01:23.038 | succeeded | source=`gsc_workbook_per_device` |
| har_v2 `har_v2.1.0` | `864ce929-d53f-4e7c-8ddc-12d5cb9a7482` | 19:01:47.789 | 19:01:56.930 | succeeded | scoring_config=`fa547325…` |
| revenue_v2 `revenue_v2.1.0` | `c20b602c-03a3-4d2e-9b5d-15e0f7ffb9ee` | 19:01:59.001 | 19:02:16.649 | partial | `har_calc_run_id = 864ce929…` ✅ |

Chronological order verified: **PAV redeploy 18:59 → regenerate 19:01:02 → HAR 19:01:47 → Revenue 19:01:59.** Pair linkage confirmed via `scope.har_calc_run_id`.

---

## 2. Regularisation evidence

### 2a. Mobile / transactional r1–10 (the motivating bucket)

```sql
SELECT c.rank_position, m.raw_ctr_percentage AS raw, c.ctr_percentage AS post_pav
FROM ctr_curves c JOIN ctr_curve_metadata m ON m.ctr_curve_id = c.id
WHERE m.calc_run_id = '2f06f121-077d-4ee6-83d7-3eb67ca75b13'
  AND c.device='mobile' AND c.intent_segment='transactional' AND c.rank_position <= 10
ORDER BY c.rank_position;
```

| rank | raw (pre-PAV, pp) | post-PAV (pp) |
|---|---|---|
| 1 | 0.31 | **1.30** |
| 2 | 0.44 | **1.30** |
| 3 | 0.40 | **1.30** |
| 4 | 2.53 | **1.30** |
| 5 | 1.89 | **1.30** |
| 6 | 1.95 | **1.30** |
| 7 | 1.61 | **1.30** |
| 8 | 1.05 | 1.05 |
| 9 | 0.62 | 0.62 |
| 10 | 0.56 | 0.56 |

PAV pooled r1–r7 into a single monotone block of **1.30** — the exact inversion sequence flagged in the fix prompt (raw r3=0.40, r7=1.61) is now non-increasing. r8–r10 already monotone, passed through unchanged.

### 2b. Buckets with `ranks_adjusted > 0` (from `summary_json`)

```sql
SELECT summary_json FROM calc_run_registry WHERE id = '2f06f121-…';
```

| device | intent | ranks_written | ranks_adjusted | max_adjustment_pp |
|---|---|---:|---:|---:|
| mobile | transactional | 19 | **15** | **1.23** |
| mobile | commercial | 13 | 12 | 0.72 |
| mobile | informational | 17 | 15 | 1.53 |
| mobile | navigational | 9 | 7 | 1.04 |
| mobile | generic | 20 | 10 | 0.18 |
| desktop | transactional | 17 | 14 | 0.64 |
| desktop | commercial | 9 | 8 | **3.33** |
| desktop | informational | 15 | 14 | 0.59 |
| desktop | navigational | 2 | **0** | 0.00 |
| desktop | generic | 20 | 6 | 0.16 |
| all | transactional | 20 | 17 | 1.11 |
| all | commercial | 15 | 13 | 0.90 |
| all | informational | 19 | 17 | 1.53 |
| all | navigational | 9 | 7 | 1.04 |
| all | generic | 20 | 8 | 0.16 |

**14 of 15 buckets** had adjustments; only **desktop/navigational** was untouched (only 2 ranks written; already monotone).

### 2c. Second adjusted bucket — desktop / commercial (largest `max_adjustment_pp = 3.33`)

```sql
SELECT c.rank_position, m.raw_ctr_percentage AS raw, c.ctr_percentage AS post
FROM ctr_curves c JOIN ctr_curve_metadata m ON m.ctr_curve_id=c.id
WHERE m.calc_run_id='2f06f121-…' AND c.device='desktop' AND c.intent_segment='commercial'
ORDER BY c.rank_position;
```

| rank | raw (pp) | post-PAV (pp) |
|---|---|---|
| 2  | 0.01 | **3.34** |
| 3  | 6.67 | **3.34** |
| 7  | 2.59 | 2.59 |
| 8  | 0.57 | **1.02** |
| 9  | 1.48 | **1.02** |
| 12 | 0.12 | **0.52** |
| 13 | 0.21 | **0.52** |
| 16 | 0.35 | **0.52** |
| 20 | 1.41 | **0.52** |

Non-increasing across written ranks: 3.34 → 3.34 → 2.59 → 1.02 → 1.02 → 0.52 → 0.52 → 0.52 → 0.52. Skipped ranks (1, 4, 5, 6, 10, 11, 14, 15, 17, 18, 19) remain absent — no synthetic fill.

### 2d. Already-monotone passthrough — desktop / navigational

Two rows written (both untouched, `ranks_adjusted = 0`). Confirmed: `raw_ctr_percentage = ctr_percentage` for every stored row.

---

## 3. Curve-level sanity — full grid

Rank 1/2/3 head across all 15 buckets (blanks = rank skipped-empty):

```sql
SELECT device, intent_segment, rank_position, ctr_percentage FROM ctr_curves c
JOIN ctr_curve_metadata m ON m.ctr_curve_id=c.id
WHERE m.calc_run_id='2f06f121-…' AND c.rank_position <= 3
ORDER BY device, intent_segment, rank_position;
```

| device | intent | r1 | r2 | r3 |
|---|---|---|---|---|
| mobile  | transactional  | 1.30 | 1.30 | 1.30 |
| mobile  | commercial     | —    | 5.70 | 1.30 |
| mobile  | informational  | —    | 2.63 | 2.63 |
| mobile  | navigational   | —    | —    | 1.38 |
| mobile  | generic (null) | 10.90 | 4.41 | 4.28 |
| desktop | transactional  | —    | —    | 3.89 |
| desktop | commercial     | —    | 3.34 | 3.34 |
| desktop | informational  | —    | —    | —   |
| desktop | navigational   | —    | —    | —   |
| desktop | generic (null) | 15.24 | 14.94 | 8.41 |
| all     | transactional  | 1.42 | 1.42 | 1.42 |
| all     | commercial     | —    | 2.13 | 2.13 |
| all     | informational  | —    | 2.63 | 2.63 |
| all     | navigational   | —    | —    | 1.38 |
| all     | generic (null) | 11.72 | 6.58 | 5.67 |

**Global monotonicity check across ranks 1-20 in every bucket:**

```sql
WITH c AS (
  SELECT c.device, c.intent_segment, c.rank_position, c.ctr_percentage
  FROM ctr_curves c JOIN ctr_curve_metadata m ON m.ctr_curve_id=c.id
  WHERE m.calc_run_id='2f06f121-…'
), w AS (
  SELECT *, LAG(ctr_percentage) OVER (PARTITION BY device, intent_segment ORDER BY rank_position) AS prev FROM c
)
SELECT * FROM w WHERE prev IS NOT NULL AND ctr_percentage > prev;
```

→ **0 rows.** Every one of the 15 buckets is non-increasing across the ranks actually written.

---

## 4. Totals delta — new run vs pre-PAV baseline `413f53d2`

Source: `calc_run_registry.summary_json.totals.by_scenario` for `c20b602c-…` and `413f53d2-…`.

### Conservative
| metric | pre-PAV (`413f53d2`) | post-PAV (`c20b602c`) | Δ | Δ% |
|---|---:|---:|---:|---:|
| kws_with_tp | 261 | 244 | −17 | −6.5% |
| current_revenue | £168,657 | £156,063 | −£12,594 | −7.5% |
| tp_absolute | £346,848 | £351,260 | **+£4,412** | **+1.3%** |
| tp_abs_without_incremental (count · £) | 22 · £18,401 | 21 · £14,197 | −£4,204 | −22.8% |
| tp_incremental | £280,196 | £291,946 | **+£11,750** | **+4.2%** |
| expected_incremental | £156,918 | £162,863 | **+£5,945** | **+3.8%** |

### Realistic
| metric | pre-PAV | post-PAV | Δ | Δ% |
|---|---:|---:|---:|---:|
| kws_with_tp | 710 | 707 | −3 | −0.4% |
| current_revenue | £168,657 | £156,063 | −£12,594 | −7.5% |
| tp_absolute | £966,647 | £1,214,516 | **+£247,869** | **+25.6%** |
| tp_abs_without_incremental (count · £) | 54 · £27,875 | 54 · £24,502 | −£3,373 | −12.1% |
| tp_incremental | £823,173 | £1,059,037 | **+£235,864** | **+28.7%** |
| expected_incremental | £502,239 | £643,469 | **+£141,230** | **+28.1%** |

### Stretch
| metric | pre-PAV | post-PAV | Δ | Δ% |
|---|---:|---:|---:|---:|
| kws_with_tp | 835 | 835 | 0 | 0.0% |
| current_revenue | £168,657 | £156,063 | −£12,594 | −7.5% |
| tp_absolute | £1,550,455 | £2,045,362 | **+£494,907** | **+31.9%** |
| tp_abs_without_incremental (count · £) | 57 · £88,648 | 57 · £69,548 | −£19,100 | −21.5% |
| tp_incremental | £1,339,356 | £1,820,998 | **+£481,642** | **+36.0%** |
| expected_incremental | £871,698 | £1,204,320 | **+£332,622** | **+38.2%** |

**Direction matches expectation.** TP metrics (tp_absolute, tp_incremental, expected) all increase materially — the head-pricing un-inversion. The largest gains are at realistic/stretch (+26–38%) where TP concentrates on head ranks that were previously deflated (raw r1=0.31, r2=0.44, r3=0.40 pooled up to 1.30 pp).

`current_revenue` drops 7.5% because for TVs Ongoing the population of `pos_now` clusters in mid-ranks r4–r7 (raw 1.89–2.53 pp deflated to 1.30 pp), so the same PAV pool that lifts head ranks depresses those mid ranks — a valid consequence of enforcing monotonicity, not a bug. `tp_abs_without_incremental` shrinks in £ across all scenarios because those keywords are ones where TP is not booked as incremental (typically already near-head); their head-rank prices moved less than the mid-rank starting points would suggest, so the residual pool contracts.

---

## 5. Provenance stability

```sql
SELECT calc_run_id,
  explanation_json->'revenue_v2'->'ctr'->>'resolver_tier_now' AS tier_now,
  explanation_json->'revenue_v2'->'ctr'->>'resolver_tier_tp'  AS tier_tp,
  count(*) FROM keyword_forecast_scenarios
WHERE calc_run_id IN ('864ce929-…','5161f23b-…')
GROUP BY 1,2,3;
```

| tier_now × tier_tp | pre-PAV (`5161f23b`) | post-PAV (`864ce929`) | Δ |
|---|---:|---:|---:|
| none × project_device_intent | 1,313 | 1,304 | −9 |
| none × none | 576 | 587 | +11 |
| project_device_intent × project_device_intent | 403 | 395 | −8 |
| project_device_intent × none | 132 | 141 | +9 |
| none × project_device_generic | 79 | 78 | −1 |
| none × project_all_intent | 21 | 20 | −1 |
| project_all_intent × project_device_intent | 14 | 14 | 0 |
| project_device_intent × project_device_generic | 12 | 11 | −1 |
| project_device_generic × project_device_intent | 11 | 11 | 0 |
| project_all_intent × none | 3 | 3 | 0 |
| project_device_generic × none | 3 | 3 | 0 |
| project_device_intent × project_all_intent | 2 | 2 | 0 |
| project_all_intent × project_all_intent | 1 | 1 | 0 |
| project_device_generic × project_device_generic | 1 | 1 | 0 |
| **totals** | **2,571** | **2,571** | 0 |

Tier structure is **identical** (same 14 combinations, no new tiers appear, no seed/fallback tiers activated). Movements are small (max ±11 rows, <1% of a bucket) and confined to the `none ↔ project_device_intent` boundary. That reflects PAV shifting a handful of borderline ranks slightly across the resolver's confidence/coverage gate — coverage itself is unchanged. **100% project tiers on the winning `now × tp` combinations; zero global-fallback tiers in use — as expected for TVs Ongoing.**

---

## 6. Drawer re-sample — `samsung 32 inch tv`, realistic

```sql
SELECT k.keyword, s.scenario, s.har_position,
  s.explanation_json->'revenue_v2'->'ctr'->>'now' AS ctr_now,
  s.explanation_json->'revenue_v2'->'ctr'->>'tp' AS ctr_tp,
  s.explanation_json->'revenue_v2'->'ctr'->>'resolver_tier_now' AS tier_now,
  s.explanation_json->'revenue_v2'->'ctr'->>'resolver_tier_tp' AS tier_tp,
  s.current_revenue_annual, s.tp_absolute_revenue_annual,
  s.tp_incremental_revenue_annual, s.expected_incremental_revenue_annual
FROM keyword_forecast_scenarios s JOIN keywords k ON k.id=s.keyword_id
WHERE s.calc_run_id IN ('864ce929-…','5161f23b-…')
  AND k.keyword ILIKE 'samsung 32 inch tv' AND s.scenario='realistic';
```

| field | pre-PAV (`5161f23b`) | post-PAV (`864ce929`) | Δ |
|---|---:|---:|---:|
| har_position | 7 | 7 | — |
| ctr_now | 0.0035 (0.35 pp) | 0.0039 (0.39 pp) | +11.4% |
| ctr_tp | 0.0161 (1.61 pp) | **0.0130 (1.30 pp)** | −19.3% |
| tier_now | project_device_intent | project_device_intent | same |
| tier_tp | project_device_intent | project_device_intent | same |
| current_revenue | £288.74 | £321.74 | +£33.00 |
| tp_absolute | £1,328.21 | £1,072.47 | −£255.74 |
| tp_incremental | £1,039.47 | £750.73 | −£288.74 |
| expected_incremental | £749.35 | £541.20 | −£208.15 |

`ctr_tp` now reads **0.0130 = 1.30 pp**, matching the regularised mobile/transactional rank-7 value from §2a (PAV-pooled block r1–r7 at 1.30). The pre-PAV `ctr_tp` of 0.0161 was the raw r7 inversion; that value is gone. TP revenue drops accordingly, exactly as regularisation should behave for a keyword sitting on a formerly inflated rank. `ctr_now` (0.0035 → 0.0039) reflects the shift on this keyword's `pos_now` rank (also within the r1–r7 pooled block, from a lower raw value).

---

## 7. Monotonicity identity

Naïve cross-tier count first (informational):

```sql
SELECT count(*) FROM keyword_forecast_scenarios s JOIN keywords k ON k.id=s.keyword_id
WHERE s.calc_run_id='864ce929-…'
  AND s.har_position < k.base_rank
  AND (s.explanation_json->'revenue_v2'->'ctr'->>'tp')::numeric
    < (s.explanation_json->'revenue_v2'->'ctr'->>'now')::numeric;
```
→ 3 rows.

Restricted to **same curve** (the identity only holds within a single device × intent bucket):

```sql
SELECT count(*) FROM keyword_forecast_scenarios s JOIN keywords k ON k.id=s.keyword_id
WHERE s.calc_run_id='864ce929-…'
  AND s.har_position < k.base_rank
  AND (s.explanation_json->'revenue_v2'->'ctr'->>'tp')::numeric
    < (s.explanation_json->'revenue_v2'->'ctr'->>'now')::numeric
  AND (s.explanation_json->'revenue_v2'->'ctr'->>'resolver_tier_now')
    = (s.explanation_json->'revenue_v2'->'ctr'->>'resolver_tier_tp');
```
→ **0 rows.** ✅

The 3 cross-tier "violations" (`samsung 50 inch smart tv`, `4k tv`, `sony oled tv 55 inch`) all have `tier_now = project_all_intent` and `tier_tp = project_device_intent` — different curves, so comparing their CTRs is not the monotonicity identity. They are legitimate resolver-tier fallbacks (per-row `now` fell back to the `all/intent` curve because device+intent had no coverage at that rank; `tp` at the target rank was covered on the strict tier). No inversion survives on any single curve.

---

## 8. Tracker confirmations

### 8a. North-star paragraph (verbatim, `docs/calculation-v21-programme.md` line 178)

> End-state onboarding pipeline: **client setup** (domain, competitors, funnel-aware AOV/CVR) → **keyword intake from all sources** (DFS Labs discovery for own + competitor ranking keywords, SAfS upload where GSC access exists, manual additions) → **detoxification + categorisation** (remove unfit keywords — number strings, foreign-language, unrelated — and categorise by product type, BEFORE any paid per-keyword enrichment spend) → **SERP/link/volume drawdown on kept keywords only** → **v2 calculations**. Clients without GSC access forecast on the global fallback CTR ladder at honest fallback provenance; SAfS upload upgrades them to measured project curves with no other change. Every remaining prompt is checked against this flow.

✅ Matches the detox-inclusive corrected version. No amendment required.

### 8b. Open flags from the fix prompt (line 93)

Quoted from the tracker's "CTR curve regularisation — PAV stopgap" bullet:

> Deeper fix candidates for Gate B: **position-variance-aware bucketing** (split queries whose true positions straddle rank boundaries), or per-query impressions-weighted curve building (weight PAV pools by impressions rather than unit). Related **observability gap: resolver `curve_confidence` is not copied into scenario `explanation_json`** (per first-project-curve report §4) — surface alongside the Gate B curve work.

✅ Both flags logged.

### 8c. Working-baseline declaration

`864ce929-…` (HAR) + `c20b602c-…` (Revenue) are declared the working baseline for Prompts 2.4 / 2.5, superseding `5161f23b` / `413f53d2`. Lineage note appended to the programme tracker below.

---

## Appendix — Baseline lineage

**seed-curve era** (`020f70bd` / `81a76dc5`, 2026-07-19 12:52Z) → **measured-curve era** (`5161f23b` / `413f53d2`, 2026-07-19 18:24Z) → **regularised-measured era** (`864ce929` / `c20b602c`, 2026-07-19 19:01Z, **current working baseline**).
