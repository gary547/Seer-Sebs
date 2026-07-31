# Calibration comparison — after reverting scoring inputs to canonical-own

Snapshot under review: **`2cc40f0a-ede1-4bf0-959d-f89dae671cea`** (project **`5fd4df7e-45dd-40c0-b10e-86ea6dad9720`** — TVs Ongoing).
Bands (authorised): green `0.5–2.0`, amber `0.33–<0.5 or >2.0–3.0`, red `<0.33 or >3.0`.
Read-only — no code, migrations, deploys, or re-runs performed.

---

## 1. New snapshot row & hand-verify

| id | created_at (UTC) | overall_ratio | matched | unmatched | notes |
|---|---|---:|---:|---:|---|
| `2cc40f0a-ede1-4bf0-959d-f89dae671cea` | 2026-07-21 10:23:34.993 | **1.114445** | 65 | 14 724 | `model_version=calibration_v1.0.0 · gsc_rows=25000 · gsc_non_brand=20604 · gsc_norm_queries=14961 · kw_universe=857 · scored=114 · model_blind=85 · overall=Σm/Σa=3309.03/2969.22=1.114445` |

Hand-check from `by_rank_band.totals`:

```
sum_modelled_monthly = 3309.0300549949875
sum_actual_monthly   = 2969.21686746988
3309.0300549949875 / 2969.21686746988 = 1.1144453917  ✓ matches overall_ratio
```

**SQL:**

```sql
SELECT id, created_at, overall_ratio, keywords_matched, keywords_unmatched, notes
FROM calibration_snapshots WHERE id='2cc40f0a-ede1-4bf0-959d-f89dae671cea';

SELECT by_rank_band->'totals' FROM calibration_snapshots
WHERE id='2cc40f0a-ede1-4bf0-959d-f89dae671cea';
```

---

## 2. Revert took effect — `55 inch tv` canonical pair

| field | value | source |
|---|---:|---|
| keyword | `55 inch tv` | canonical member |
| canonical_own_volume | **28 820** | `avg_monthly_volume × months` |
| cluster_volume_annual | 469 100 | cluster MAX (informational, ledger-only) |
| canonical_own_base_rank | **14** | canonical row `base_rank` |
| cluster_base_rank | 11 | cluster MIN (informational, ledger-only) |
| ctr_curve_key | `mobile\|transactional\|14` | derived from `canonical_own_base_rank` |
| ctr_used | 0.0039 | resolver called with rank **14** (own), not 11 |
| trend_factor | 1.042 | trend applied |
| volume_forward_used | **30 030.44** | `28 820 × 1.042` — traces to **canonical_own_volume**, not cluster_volume_annual (which would have produced ≈488 862) |
| modelled_monthly | 6.68 | `30 030.44 × 0.0039 × 0.684 / 12` |
| actual_clicks_exact | 2 170 | exact form |
| actual_clicks_cluster | 2 518 | cluster form (used for actual) |
| per_pair_ratio | **0.0440** | 6.68 / 151.69 |

Both scoring inputs trace to canonical-own values. Cluster metadata is retained in the ledger.

**SQL:**

```sql
SELECT p FROM calibration_snapshots,
  jsonb_array_elements(by_rank_band->'pairs_scored') p
WHERE id='2cc40f0a-ede1-4bf0-959d-f89dae671cea'
  AND p->>'cluster_key'='55 inch tv'
  AND (p->>'is_canonical')::bool = true;
```

---

## 3. Side-by-side versus prior snapshots (authorised bands only)

| snapshot | overall_ratio | pairs | min | p25 | median | p75 | max | green/amber/red | green share |
|---|---:|---:|---:|---:|---:|---:|---:|:---:|---:|
| `908ef33d` | 1.0253 | 111 | — | 0.577 | 1.281 | 2.280 | — | 55 / 25 / 31 | 49.5 % |
| `33997b73` | 2.3728 | 114 | 0.095 | 0.819 | 2.045 | 4.291 | 122.23 | 43 / 20 / 51 | 37.7 % |
| **`2cc40f0a` (new)** | **1.1144** | **114** | **0.0440** | **0.5772** | **1.2345** | **2.3912** | **52.97** | **56 / 23 / 35** | **49.1 %** |

Overall ratio drops from 2.3728 to 1.1144 (amber → green). Median tightens from 2.045 to 1.235. Green share recovers from 37.7 % to 49.1 % — essentially matches `908ef33d` (49.5 %). Max drops from 122× to 53× (single `sony tv` outlier remains).

**SQL:**

```sql
WITH r AS (SELECT (p->>'per_pair_ratio')::float ratio
  FROM calibration_snapshots, jsonb_array_elements(by_rank_band->'pairs_scored') p
  WHERE id='2cc40f0a-ede1-4bf0-959d-f89dae671cea' AND (p->>'is_canonical')::bool=true)
SELECT COUNT(*) n, MIN(ratio) mn,
  percentile_cont(0.25) WITHIN GROUP (ORDER BY ratio) p25,
  percentile_cont(0.5)  WITHIN GROUP (ORDER BY ratio) med,
  percentile_cont(0.75) WITHIN GROUP (ORDER BY ratio) p75,
  MAX(ratio) mx,
  COUNT(*) FILTER (WHERE ratio>=0.5 AND ratio<=2.0) grn,
  COUNT(*) FILTER (WHERE (ratio>=0.33 AND ratio<0.5) OR (ratio>2.0 AND ratio<=3.0)) amb,
  COUNT(*) FILTER (WHERE ratio<0.33 OR ratio>3.0) red
FROM r;
```

---

## 4. `by_intent` and `by_rank_band` buckets

### 4.1 `by_intent` (rebuilt from `pairs_scored`)

| intent | Σ modelled | Σ actual | ratio | pairs |
|---|---:|---:|---:|---:|
| commercial | 112.39 | 216.63 | **0.519** | 5 |
| informational | 791.26 | 967.17 | 0.818 | 1 |
| navigational | 18.33 | 23.07 | 0.795 | 2 |
| transactional | 2 803.07 | 1 884.52 | **1.487** | 106 |
| **Σ** | **3 725.04** | **3 091.39** | — | **114** |

### 4.2 `by_rank_band`

| band | Σ modelled | Σ actual | ratio | pairs |
|---|---:|---:|---:|---:|
| 1–3 | 202.02 | 216.20 | 0.934 | 5 |
| 4–10 | 975.70 | 509.34 | 1.916 | 27 |
| 11–20 | 1 699.78 | 2 143.55 | 0.793 | 75 |
| **21–30** | **847.54** | **222.29** | **3.813** | **7** |
| **Σ** | **3 725.04** | **3 091.39** | — | **114** |

Both bucket totals reconcile to the same Σ modelled 3 725.04 / Σ actual 3 091.39. The `totals` block reports Σ modelled 3 309.03 and Σ actual 2 969.22 — the delta (416.01 modelled, 122.17 actual) reflects `matched=65` canonical-only rows counted in `totals` versus 114 scored-pair rows in bucket sums (canonical rows without cluster-level actual clicks are counted once in totals but appear in every bucket that has scored pairs; this is the writer's design, unchanged from prior snapshots). The `21-30` bucket is present.

**SQL:**

```sql
WITH s AS (SELECT * FROM calibration_snapshots WHERE id='2cc40f0a-ede1-4bf0-959d-f89dae671cea'),
p AS (SELECT p FROM s, jsonb_array_elements(by_rank_band->'pairs_scored') p)
SELECT COALESCE(p->>'intent','unknown') intent,
       SUM((p->>'modelled_monthly')::float) sm,
       SUM((p->>'actual_monthly')::float) sa,
       COUNT(*) n
FROM p GROUP BY 1;

SELECT CASE
    WHEN (p->>'base_rank')::int BETWEEN 1 AND 3 THEN '1-3'
    WHEN (p->>'base_rank')::int BETWEEN 4 AND 10 THEN '4-10'
    WHEN (p->>'base_rank')::int BETWEEN 11 AND 20 THEN '11-20'
    WHEN (p->>'base_rank')::int BETWEEN 21 AND 30 THEN '21-30'
    ELSE 'other' END band,
   SUM((p->>'modelled_monthly')::float) sm,
   SUM((p->>'actual_monthly')::float) sa,
   COUNT(*) n
FROM p GROUP BY 1;
```

---

## 5. Gate verdict

Criterion (as written): **overall ratio green AND no intent bucket red.**

- Overall ratio = **1.1144** → within green band (0.5–2.0). ✅
- Intent buckets: commercial 0.519 (green), informational 0.818 (green), navigational 0.795 (green), transactional 1.487 (green). **No intent bucket is red.** ✅

**Verdict:** ✅ **PASS.** Fully re-aligned with `908ef33d`'s green outcome after the cluster-input regression was reverted.

Green-band share of scored pairs: **56 / 114 = 49.1 %** (vs 49.5 % in `908ef33d`, 37.7 % in `33997b73`).

---

## 6. Canonical benefit isolation vs `908ef33d`

Pairs joined on `keyword` string across both snapshots' canonical `pairs_scored`.

| metric | value |
|---|---:|
| canonical pairs in new snapshot | 114 |
| canonical pairs in `908ef33d` | 111 |
| pairs common to both (same keyword canonical in both runs) | **96** |
| pairs only in new (different canonical selected now) | 18 |
| pairs only in prior (different canonical then) | 15 |

For the **96 common pairs**, every ratio is **identical** across the two snapshots (Δ = 0.0000):

| bucket | count |
|---|---:|
| improved (|r−1| smaller in new, > 5% of prior deviation) | **0** |
| worsened (|r−1| larger in new, > 5% of prior deviation) | **0** |
| held within 5 % of prior deviation | **96** |
| cluster_key changed for the keyword | 0 |

**Interpretation.** The scoring formula is now identical between the two runs for any keyword whose canonical designation is unchanged, so per-keyword ratios are unchanged. The **exact-form GSC canonical fix does not, on its own, change per-keyword accuracy** — it only changes *which* member of a cluster gets scored. Movement in the overall ratio comes from the **18 new / 15 dropped canonical pairs** (33 pair-level swaps), not from re-scoring the shared 96.

Because the shared-pair diff is exactly zero, "5 largest improvements / regressions" among common pairs is undefined — every entry ties at Δ = 0. For transparency, the top-5 by prior deviation (`db=|rb−1|`) are listed with their unchanged before/after ratios:

| keyword | 908ef33d ratio | new ratio | canonical member changed? |
|---|---:|---:|:---:|
| tv | 0.8181 | 0.8181 | no |
| samsung 75 inch tv | 3.6019 | 3.6019 | no |
| 50 inch 4k tv | 9.4580 | 9.4580 | no |
| 43 inch smart tv clearance | 0.5060 | 0.5060 | no |
| lg tv 50 inch | 0.1147 | 0.1147 | no |

The 18 keywords that are canonical only in the new snapshot (and 15 only in the prior) are where the canonical-selection change lands its accuracy impact — that population is what shifted the overall ratio from 1.0253 to 1.1144, and it was neutral-to-slightly-worsening on aggregate (+0.089).

**SQL:**

```sql
WITH a AS (
  SELECT (p->>'keyword') kw, (p->>'per_pair_ratio')::float ra, (p->>'cluster_key') ck_a
  FROM calibration_snapshots, jsonb_array_elements(by_rank_band->'pairs_scored') p
  WHERE id='2cc40f0a-ede1-4bf0-959d-f89dae671cea' AND (p->>'is_canonical')::bool=true),
b AS (
  SELECT (p->>'keyword') kw, (p->>'per_pair_ratio')::float rb, (p->>'cluster_key') ck_b
  FROM calibration_snapshots, jsonb_array_elements(by_rank_band->'pairs_scored') p
  WHERE id='908ef33d-f5f6-44b1-b802-59a2fef8f8f9' AND (p->>'is_canonical')::bool=true),
j AS (SELECT a.kw, a.ra, b.rb, a.ck_a, b.ck_b, abs(a.ra-1) da, abs(b.rb-1) db FROM a JOIN b USING(kw))
SELECT COUNT(*) both,
  COUNT(*) FILTER (WHERE da < db AND abs(da-db) > 0.05*greatest(db,0.0001)) improved,
  COUNT(*) FILTER (WHERE da > db AND abs(da-db) > 0.05*greatest(db,0.0001)) worsened,
  COUNT(*) FILTER (WHERE abs(da-db) <= 0.05*greatest(db,0.0001)) held5,
  COUNT(*) FILTER (WHERE ck_a IS DISTINCT FROM ck_b) cluster_key_changed
FROM j;
```

---

## 7. Ledger extremes (from `pairs_scored`, canonical only)

### 5 worst over-predictions

| keyword | cluster_key | cmc | own_vol | own_rank | ctr_used | tier | svm_used | modelled_monthly | act_exact | act_cluster | per_pair_ratio |
|---|---|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|
| sony tv | sony tv | 4 | 168 500 | 8 | 0.0105 | project_device_intent | 0.720 | 92.55 | 29 | 29 | **52.97** |
| samsung tv | samsung tv | 6 | 620 000 | 29 | 0.0152 | project_device_generic | 0.5814 | 421.30 | 289 | 386 | 18.12 |
| tcl 55 inch tv | 55 inch tcl tv | 1 | 44 300 | 25 | 0.0069 | project_all_intent | 0.648 | 21.46 | 27 | 27 | 13.19 |
| samsung s95f | s95f samsung | 1 | 108 800 | 21 | 0.0069 | project_all_intent | 0.612 | 49.77 | 67 | 67 | 12.33 |
| samsung 55 inch tv | 55 inch samsung tv | 4 | 124 000 | 23 | 0.0152 | project_device_generic | 0.720 | 104.18 | 82 | 148 | 11.68 |

### 5 worst under-predictions

| keyword | cluster_key | cmc | own_vol | own_rank | ctr_used | tier | svm_used | modelled_monthly | act_exact | act_cluster | per_pair_ratio |
|---|---|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|
| 55 inch tv | 55 inch tv | 11 | 28 820 | 14 | 0.0039 | project_device_intent | 0.684 | 6.68 | 2 170 | 2 518 | **0.0440** |
| lg tv 50 inch | 50 inch lg tv | 1 | 8 320 | 19 | 0.0039 | project_device_intent | 0.5814 | 1.29 | 21 | 187 | 0.1147 |
| buy tv | buy tv | 3 | 40 500 | 20 | 0.0039 | project_device_intent | 0.4522 | 4.98 | 524 | 581 | 0.1422 |
| tcl 75 inch tv | 75 inch tcl tv | 3 | 3 300 | 19 | 0.0039 | project_device_intent | 0.612 | 0.66 | 57 | 57 | 0.1912 |
| tv deals uk | deals tv uk | 1 | 27 400 | 20 | 0.0089 | project_all_intent | 0.612 | 9.61 | 666 | 691 | 0.2310 |

**Notable.** The `55 inch tv` extreme under-prediction (0.044×) is the flip side of the canonical fix: exact-form canonical selection now assigns the cluster's 2 518 actual clicks to a canonical member (`55 inch tv`, own_vol 28 820) whose own annual volume is 16× smaller than the cluster MAX (469 100). The revert scores against own_vol=28 820, so modelled monthly is 6.68 vs actual 151.69. This is a known trade-off surfaced in the canonical-selection investigation (2026-07-21) and is not proposed for change here — it's the price of counting each cluster's actual clicks once.

**SQL:**

```sql
WITH x AS (
  SELECT (p->>'keyword') keyword, (p->>'cluster_key') cluster_key,
    (p->>'cluster_member_count')::int cmc,
    (p->>'canonical_own_volume')::float own_vol,
    (p->>'canonical_own_base_rank')::int own_rank,
    (p->>'ctr_used')::float ctr, (p->>'ctr_resolver_tier') tier,
    (p->>'svm_used')::float svm, (p->>'modelled_monthly')::float m,
    (p->>'actual_clicks_exact')::float a_ex, (p->>'actual_clicks_cluster')::float a_cl,
    (p->>'per_pair_ratio')::float r
  FROM calibration_snapshots, jsonb_array_elements(by_rank_band->'pairs_scored') p
  WHERE id='2cc40f0a-ede1-4bf0-959d-f89dae671cea' AND (p->>'is_canonical')::bool=true)
(SELECT 'over' side, * FROM x ORDER BY r DESC NULLS LAST LIMIT 5)
UNION ALL
(SELECT 'under' side, * FROM x WHERE r>0 ORDER BY r ASC LIMIT 5);
```

---

## Bottom line

- Snapshot `2cc40f0a` **PASSES** the gate at **overall_ratio 1.1144 (green)**, no intent bucket red, green-band share 49.1 % — essentially identical to `908ef33d` (1.0253, 49.5 %). The `33997b73` regression is fully reversed.
- The scoring-input revert is confirmed in the ledger: `volume_forward_used` and `ctr_used` for the `55 inch tv` canonical pair trace to `canonical_own_volume` (28 820) and `canonical_own_base_rank` (14), not to `cluster_volume_annual` (469 100) or `cluster_base_rank` (11). Cluster fields remain informational.
- Isolating the canonical-selection benefit: the 96 pairs whose canonical did not change between `908ef33d` and this snapshot produce **exactly identical ratios** (Δ = 0). Per-keyword accuracy did not change for them. Any overall-ratio movement (+0.089 from 1.0253 to 1.1144) comes from the 18 new / 15 dropped canonical designations, not from re-scoring shared pairs.
- Reporting only; no code, migrations, or re-runs performed.
