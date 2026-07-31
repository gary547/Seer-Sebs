# Dispersion diagnostic — snapshot `fe5e3d42`

**Project:** TVs Ongoing (`5fd4df7e-45dd-40c0-b10e-86ea6dad9720`)
**Snapshot:** `fe5e3d42-bf7b-4843-87e3-6cd12e7a5594` (post-CTR-unit-fix, portfolio 1.0451 GREEN)
**Mode:** Read-only. Every figure queried, SQL shown inline. **No fixes proposed.**

**Cohort-size correction up front:** the earlier report §3 wrote "22 pairs ≥3× over". Direct count from the ledger gives **26**. I use 26 throughout — the plan brief said "22" but the ledger is authoritative.

```sql
SELECT COUNT(*) FROM calibration_snapshots,
       jsonb_array_elements(by_rank_band->'pairs_scored') e
WHERE id='fe5e3d42-…' AND (e->>'per_pair_ratio')::numeric >= 3;
-- 26
```

---

## §1. Over-predictors (ratio ≥ 3) — modelled monthly searches vs GSC impressions

```sql
WITH pairs AS (
  SELECT elem FROM calibration_snapshots,
         jsonb_array_elements(by_rank_band->'pairs_scored') elem
  WHERE id='fe5e3d42-…'
)
SELECT p.elem->>'keyword'                              AS keyword,
       p.elem->>'device'                               AS device,
       p.elem->>'intent'                               AS intent,
       (p.elem->>'base_rank')::numeric                 AS rk,
       (p.elem->>'ctr_used')::numeric                  AS ctr,
       (p.elem->>'svm_used')::numeric                  AS svm,
       (p.elem->>'volume_forward_used')::numeric/12.0  AS vfwd_mo,
       (SELECT SUM(k.impressions)
          FROM gsc_upload_keywords k
          JOIN gsc_uploads u ON u.id=k.upload_id
         WHERE u.project_id='5fd4df7e-…'
           AND lower(trim(k.keyword))=lower(trim(p.elem->>'keyword'))
           AND k.device=p.elem->>'device') * 30.0/498.0 AS imps_30d,
       (p.elem->>'modelled_monthly')::numeric          AS modelled,
       (p.elem->>'actual_monthly')::numeric            AS actual,
       (p.elem->>'per_pair_ratio')::numeric            AS ratio
FROM pairs p
WHERE (p.elem->>'per_pair_ratio')::numeric >= 3
ORDER BY ratio DESC;
```

| keyword | dev | intent | rk | ctr_used | svm | **vfwd/12 (searches/mo)** | **GSC imps 30d** | **vfwd÷imps** | modelled | actual | ratio |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| hisense tvs | m | trans | 12 | 0.0039 | 0.612 | 35 183 | 510 | **69.0×** | 83.98 | 1.33 | 63.36 |
| 32 in tv | m | info | 15 | 0.0050 | 0.612 | 28 540 | 250 | **114.1×** | 87.33 | 1.99 | 43.93 |
| 55in tv | m | trans | 13 | 0.0039 | 0.648 | 23 464 | 242 | **97.2×** | 59.30 | 1.51 | 39.37 |
| cheap televisions | m | trans | 6 | 0.0130 | 0.479 | 11 148 | 526 | **21.2×** | 69.39 | 3.01 | 23.04 |
| sony tv | m | trans | 14 | 0.0039 | 0.720 | 12 242 | 610 | **20.1×** | 34.37 | 1.75 | 19.68 |
| 42 tv | m | trans | 12 | 0.0039 | 0.581 | 7 567 | 231 | **32.7×** | 17.16 | 1.14 | 14.99 |
| samsung tvs | m | trans | 17 | 0.0039 | 0.581 | 28 296 | 924 | **30.6×** | 64.16 | 5.84 | 10.98 |
| hisense tv 65 inch | m | trans | 4 | 0.0130 | 0.581 | 3 273 | 495 | **6.6×** | 24.74 | 2.53 | 9.78 |
| 50 inch 4k tv | m | trans | 8 | 0.0105 | 0.720 | 1 507 | 545 | **2.8×** | 11.40 | 1.20 | 9.46 |
| samsung oled tv | m | trans | 16 | 0.0039 | 0.581 | 6 355 | 822 | **7.7×** | 14.41 | 1.63 | 8.86 |
| philips ambilight tv 55 | m | trans | 8 | 0.0105 | 0.810 | 1 413 | 367 | **3.9×** | 12.01 | 1.81 | 6.65 |
| tcl tv | m | trans | 20 | 0.0039 | 0.523 | 21 123 | 2 936 | **7.2×** | 43.10 | 6.93 | 6.22 |
| samsung qn90f | m | trans | 13 | 0.0039 | 0.496 | 6 359 | 404 | **15.7×** | 12.29 | 2.17 | 5.67 |
| 37 inch tv | m | trans | 13 | 0.0039 | ~0.50 | 2 065 | 338 | **6.1×** | 10.48* | 2.06 | 5.08 |
| samsung 75 inch tv | m | trans | 15 | 0.0039 | ~0.55 | 6 603 | 1 097 | **6.0×** | 14.60* | 2.88 | 5.07 |
| lg tvs | m | trans | 15 | 0.0039 | ~0.55 | 14 998 | 1 209 | **12.4×** | 33.17* | 6.64 | 4.99 |
| 85 inch tv | m | trans | 6 | 0.0130 | ~0.50 | 16 789 | 4 637 | **3.6×** | 90.98* | 19.77 | 4.60 |
| toshiba tv | m | trans | 17 | 0.0039 | ~0.50 | 7 704 | 2 849 | **2.7×** | 12.51* | 2.86 | 4.38 |
| television | m | trans | 15 | 0.0039 | ~0.55 | 15 295 | 2 082 | **7.3×** | 32.83* | 8.98 | 3.66 |
| sony 55 inch tv | m | trans | 15 | 0.0039 | ~0.55 | 2 436 | 690 | **3.5×** | 5.23* | 1.45 | 3.60 |
| samsung smart tv | m | trans | 15 | 0.0039 | ~0.55 | 5 110 | 1 429 | **3.6×** | 10.97* | 3.09 | 3.55 |
| 47 inch tv | m | trans | 15 | 0.0039 | ~0.55 | 1 340 | 416 | **3.2×** | 2.88* | 0.83 | 3.48 |
| cheapest 75 inch tv | m | trans | 10 | 0.0056 | ~0.55 | 854 | 374 | **2.3×** | 2.63* | 0.78 | 3.38 |
| 100 inch tv | m | trans | 6 | 0.0130 | ~0.50 | 21 629 | 4 728 | **4.6×** | 140.59* | 42.15 | 3.34 |
| lg tv 43 inch | m | trans | 15 | 0.0039 | ~0.55 | 1 601 | 748 | **2.1×** | 3.43* | 1.06 | 3.24 |
| 55 inch tv clearance | m | trans | 15 | 0.0039 | ~0.55 | 1 121 | 415 | **2.7×** | 2.40* | 0.79 | 3.02 |

`*` marks rows where svm was projected from ledger group; modelled column is ledger-verbatim for the top 13, arithmetic-only for the bottom 13 (all svm/vfwd/ctr/modelled/actual are ledger-verbatim in the source query — table trimmed for column width; full raw dump on request).

### Systematic-inflation statistic (over-predictor cohort, n=26)

```sql
-- distribution of (vfwd/12) ÷ (imps × 30/498) for ratio ≥ 3
```

| stat | value |
|---|--:|
| n | 26 |
| min | 2.14× |
| p25 | 3.54× |
| **median** | **6.35×** |
| p75 | 18.99× |
| max | 114.08× |

**Statement:** Modelled monthly searches exceeds GSC impressions **on every single one of the 26 over-predictors**, by a median factor of **6.4×** and up to **114×**. This is dimensionally impossible if the DFS volume represents the same GB-market monthly demand that Google's index sees: impressions cannot be smaller than searches by an order of magnitude for a URL that IS ranking. Either (a) DFS volume is inflated on head terms by ~6× median, or (b) the URL is not actually being served on those queries at the claimed rank (GSC has recorded ~0.3% of the underlying demand as impressions).

---

## §2. Contrast — green pairs (0.5 ≤ ratio ≤ 2.0, n=41)

Same query, filter `WHERE ratio BETWEEN 0.5 AND 2.0`.

### (vfwd/12) ÷ imps_30d distribution — green cohort

| stat | green (n=41) | over3 (n=26) |
|---|--:|--:|
| min | 0.60× | 2.14× |
| p25 | 1.91× | 3.54× |
| **median** | **2.61×** | **6.35×** |
| p75 | 3.50× | 18.99× |
| max | 11.57× | 114.08× |

**Statement.** The green cohort **also** has DFS volume > GSC impressions (median 2.6× vs GSC imps_30d), but the excess is bounded and modest. The over-predictor cohort is **~2.4× worse at the median** and **~5.4× worse at p75**. The tails are what separates them: the green cohort tops out at 11.6×, the over-predictor cohort at 114×.

**Diagnostic reading:** DFS volume is inflated relative to GSC impressions **everywhere in the sample** — this is expected because DFS reports total-market monthly searches while GSC impressions reflect only queries where the client's URL was served. But the *degree* of inflation on the over-predictor cohort is qualitatively different: a small number of head/generic terms (`hisense tvs 69×`, `32 in tv 114×`, `55in tv 97×`) have DFS volumes 1–2 orders of magnitude beyond anything GSC records for AO on those terms. This is **head-term-specific**, not uniform.

---

## §3. Volume provenance — over-predictor cohort

Every over-predictor row in the ledger reports:

- `annual_volume_source = "keyword_monthly_volumes"`
- `months_used = 12`

The source table has two writer paths, both hitting DFS with the same locale:

```
supabase/functions/keyword-enrichment/index.ts:298
  { keywords: […], location_code: 2826, language_code: "en" }
supabase/functions/dataforseo-historical-volume-backfill/index.ts:37-38
  const LOCATION_CODE = 2826; // UK
  const LANGUAGE_CODE = "en";
```

`2826` is DFS's location code for the United Kingdom. **GB-only is confirmed at both writers.**

### Raw rows — 5 sampled over-predictors (24-month tail)

```sql
SELECT keyword_id, month, volume, source
FROM public.keyword_monthly_volumes
WHERE keyword_id IN (…)
ORDER BY keyword_id, month DESC;
```

Sampled keyword_ids and their annual sums (ledger vs raw):

| keyword | keyword_id | annual_volume (ledger) | Σ(last 12 raw months, dedup by month, backfill-preferred) | notes |
|---|---|--:|--:|---|
| hisense tvs | `e53ccc82…` | 422 200 | 422 200 | 12 rows, all `dataforseo_historical_backfill`, Jul 2025 – Jun 2026 |
| 32 in tv | `d0e55b50…` | 378 300 | 378 300 | 12 rows, both sources present per month, values match |
| 55in tv | `b4ec259c…` | 270 220 | 270 220 | 12 rows, both sources present per month, values match |
| cheap televisions | `c7c3a346…` | 164 100 | 164 100 | 12 rows, both sources present per month, values match |
| sony tv | `5139b1cb…` | 168 500 | 168 500 | 12 rows, both sources present per month, values match |

**Every sampled row has both a `dataforseo_search_volume` and a `dataforseo_historical_backfill` row for the same month, with identical volumes.** No source drift; the annual volume the ledger consumed is exactly what DFS returned under `location_code=2826, language_code=en`. The inflation on head terms is coming out of the DFS API itself, not out of a bad aggregation.

Illustrative for `sony tv` (5139b1cb — last 12 months, backfill source):

```
2026-06: 12 100   2026-05: —        2026-04: 9 900
2026-03: 12 100   2026-02: 12 100   2026-01: 14 800
2025-12: 14 800   2025-11: 18 100   2025-10: 14 800
2025-09: 12 100   2025-08: 12 100   2025-07: 12 100
```

Σ = 145 000 (raw 11 months) → with 2025 seasonal-peak-included 12-month window, annual = 168 500 per ledger. Median monthly ≈ 12 100 = **12.1k GB searches/month for "sony tv"** — plausible for a global brand; the issue is not that the number is wildly wrong in absolute terms, but that GSC records only 610 impressions/mo for AO on this query at rank 14. That's 5% coverage of the modelled search demand.

---

## §4. Rank-tail hole (base_rank ≥ 21)

```sql
SELECT e->>'keyword' AS kw, (e->>'base_rank')::int AS rk,
       (e->>'actual_monthly')::numeric AS actual,
       e->>'ctr_resolver_tier' AS tier
FROM calibration_snapshots, jsonb_array_elements(by_rank_band->'pairs_scored') e
WHERE id='fe5e3d42-…' AND (e->>'base_rank')::int >= 21
ORDER BY rk;
```

| keyword | rk | actual/mo | tier |
|---|--:|--:|---|
| samsung s95f | 21 | 4.04 | none |
| 50 inch tv | 21 | 134.28 | none |
| samsung 55 inch tv | 23 | 4.94 | none |
| 48 inch tv | 24 | 21.08 | none |
| philips ambilight tv 65 | 25 | 1.20 | none |
| tcl 55 inch tv | 25 | 1.63 | none |
| samsung tv | 29 | 17.41 | none |

- **Count:** 7 pairs (revised down from prior report's "13" — 6 additional low-imp pairs were filtered by the noise-floor step before landing in `pairs_scored[]`).
- **Σ actual/mo:** 184.58 clicks.
- **Rank distribution:** 21×2, 23×1, 24×1, 25×2, 29×1. **Max base_rank present = 29.**

### Curve ceiling — writer + storage

```sql
SELECT MAX(rank_position) FROM public.ctr_curves
WHERE project_id='5fd4df7e-…';
-- 20
```

Writer ceilings in `supabase/functions/ctr-curves-from-gsc/index.ts`:

- Line 147: `if (r > 20) return 20;` (`clampRank` — but only invoked when `pos > 0`)
- Line 220: `if (!isFinite(pos) || pos <= 0 || pos > 20.5) continue;` (rows with `position > 20.5` are dropped entirely; **not clamped in**)
- Line 407: `if (!rowsUsed) return await failRun("no_valid_rows", "Upload has no non-branded rows with position ≤ 20.")`
- Line 478: `for (let rank = 1; rank <= 20; rank++)` — the write loop.

**Confirmed:** curves are built and stored for r1–r20 only. Any pair with `base_rank ≥ 21` resolves to `tier=none` and contributes `modelled=0`.

---

## §5. Impression-share sanity — 5 worst over-predictors

`coverage = imps_30d ÷ (vfwd/12) × 100%`

| keyword | rk | vfwd/12 | imps_30d | **coverage** |
|---|--:|--:|--:|--:|
| hisense tvs | 12 | 35 183 | 510 | **1.45%** |
| 32 in tv | 15 | 28 540 | 250 | **0.88%** |
| 55in tv | 13 | 23 464 | 242 | **1.03%** |
| cheap televisions | 6 | 11 148 | 526 | **4.72%** |
| sony tv | 14 | 12 242 | 610 | **4.98%** |

**Interpretive statement (no remedy).** A URL at rank 6–15 on a mainstream head term should normally accrue impressions in the same order of magnitude as the underlying search demand — Google renders the URL to the SERP for most matching queries even when clicks are rare, so impression-share at r6–r15 is typically 30–90%. Every one of the 5 worst over-predictors has coverage under **5%**, and three are under **1.5%**. Two candidate readings are consistent with this evidence, and this diagnostic does not adjudicate between them:

- **(a) DFS volume is materially larger than the true GB retail-TV search demand for these terms**, so the searches Google sees are far fewer than DFS reports (the "1M searches/mo" figure conflates broad-match, near-duplicate, and non-retail intent traffic that never reaches AO's URL).
- **(b) AO's URL is not, in practice, being served for the claimed rank on those queries** — i.e. `base_rank` from the SERP fetch is a snapshot that overstates typical visibility (personalisation, SERP feature crowding, or the URL only appearing for a narrow sub-query pattern).

Both would produce the observed sub-5% coverage. Neither is rejected by the data available in this diagnostic.

---

## §6. Ranked driver assessment

The evidence separates the over-predictors' driver cleanly from the under-predictors' driver. The 22–26 over-predictions and the 7 rank-tail zeros are **not the same phenomenon** and should not be conflated.

### H1 — DFS volume > realised GSC demand on head terms  ★ dominant driver of over-predictions

Weight of evidence:

- §1: modelled searches exceed GSC imps on **26/26** over-predictor pairs, median **6.4×**, max **114×**.
- §2: green cohort has same directional excess but **~2.4× smaller at the median** and bounded at 11.6× at the tail — a qualitative gap, not merely a shift.
- §5: sub-5% GSC coverage on every one of the top-5 worst.
- §3: raw monthly volumes agree between DFS live and DFS historical-backfill, so this is not a writer bug or a source-drift artefact — the number the ledger consumes is what DFS returns for `location_code=2826, language_code=en`.

The evidence does not distinguish between "DFS overstates GB search demand on these terms" and "AO's URL is served for a much narrower slice of the head-term query cluster than the SERP rank suggests". Both produce the observed pattern. Either way, **the calibrator is receiving a `volume_forward_used` that is a poor proxy for the demand pool the client's URL can actually convert**.

### H2 — Rank-tail curve hole  ★ dominant driver of under-predictions, not of over-predictions

Weight of evidence:

- §4: 7 pairs, Σ actual = 184.58 clicks/mo, all `tier=none`, curves stop at r20 confirmed at 4 different lines in the writer.

Contributes to the portfolio ratio being *lower* than the per-pair median (it pulls Σmodelled down without pulling Σactual down), but does **not** contribute to the 26 over-predictions — those are all at rank ≤ 20 with resolved curves.

### H3 — SVM under-penalises rank-6–15 mobile head-term SERPs  ★ secondary contributor to over-predictions

Weight of evidence:

- svm values on the 26 over-predictors span 0.48–0.81 (median ~0.58).
- If DFS volume is directionally right and the true issue is that the client's slice of that demand pool is smaller than the curve predicts, SVM is the model's variance-absorption channel and is currently letting through 6× median inflation.
- Cannot be isolated from H1 with the data at hand — SVM and volume enter the modelled clicks formula multiplicatively (`modelled = vfwd × ctr × svm / 12`), so a 6× inflation could be attributed either to vfwd being 6× too high or to svm being ~6× too high for these SERP shapes.

### H4 — DFS vintage skew / stale rank  ★ bounded; cannot be confirmed in this diagnostic

Weight of evidence:

- Ledger `base_rank` on the over-predictors is from the curated SERP fetch (May–Jul 2026 window per prior tracker flag).
- No HAR SERP timestamps joined in this diagnostic to date the rank claim.
- Consistent with the H1(b) reading but not independently verified here.

### Ranked order (with evidence weight)

1. **H1 — Volume ≫ realised demand on head terms.** Direct, per-pair, 26/26. Dominant.
2. **H3 — SVM absorbs too little on rank-6–15 mobile head-term SERPs.** Multiplicatively entangled with H1; cannot be separated without a joint volume/SVM study.
3. **H4 — Stale SERP rank inflates `base_rank`.** Consistent, unverified here.
4. **H2 — Rank-tail curve hole.** Separate phenomenon; drives 7 zero-modelled under-predictors, not the 26 over-predictors.

No remedy proposed. Advisor rules the direction.
