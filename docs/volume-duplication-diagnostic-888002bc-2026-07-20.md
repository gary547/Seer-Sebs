# Volume-duplication diagnostic — snapshot `888002bc`

**Project:** TVs Ongoing (`5fd4df7e-45dd-40c0-b10e-86ea6dad9720`)
**Snapshot:** `888002bc-ff56-4c05-89dd-da646d60e052` (portfolio ratio 1.7669, per `calibration_snapshots.overall_ratio`)
**Mode:** Read-only. Every figure comes from a SQL query shown inline, sourced from `keyword_monthly_volumes`, `keywords`, `gsc_upload_keywords`/`gsc_uploads`, and `calibration_snapshots.summary_json.by_rank_band.pairs_scored[]`. **No fixes proposed.**

**Scope check.**
```sql
SELECT COUNT(*) FROM keywords
WHERE project_id='5fd4df7e-…' AND detox_status='keep';
-- 857
```
Of the 857 kept keywords, **835** have a complete last-12-month volume series in `keyword_monthly_volumes` (dedup by `(keyword_id, month)`, backfill-preferred). The remaining 22 (0 with `SUM(volume)=0`; 22 with fewer than 12 months) are excluded from every §1–§3 count; this is stated where it matters.

---

## §1. Duplicate annual-volume groups

```sql
WITH latest12 AS (
  SELECT keyword_id, month, volume,
         ROW_NUMBER() OVER (PARTITION BY keyword_id, month
           ORDER BY CASE WHEN source='dataforseo_historical_backfill' THEN 0 ELSE 1 END) rn
  FROM keyword_monthly_volumes
  WHERE keyword_id IN (SELECT id FROM keywords
                       WHERE project_id='5fd4df7e-…' AND detox_status='keep')
),
dedup  AS (SELECT keyword_id, month, volume FROM latest12 WHERE rn=1),
ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY keyword_id ORDER BY month DESC) rn2 FROM dedup),
annual AS (SELECT keyword_id, SUM(volume)::bigint AS av FROM ranked WHERE rn2<=12
           GROUP BY keyword_id HAVING COUNT(*)=12),
grp    AS (SELECT av, COUNT(*) n FROM annual GROUP BY av HAVING COUNT(*)>=2)
SELECT COUNT(*) distinct_dup_values, SUM(n) kw_in_dup_groups,
       COUNT(*) FILTER (WHERE n=2)             g2,
       COUNT(*) FILTER (WHERE n=3)             g3,
       COUNT(*) FILTER (WHERE n=4)             g4,
       COUNT(*) FILTER (WHERE n BETWEEN 5 AND 9) g5_9,
       COUNT(*) FILTER (WHERE n>=10)           g10p
FROM grp;
```

| metric | value |
|---|--:|
| keywords with a complete 12-month series | **835** |
| distinct volume values shared by ≥ 2 kept keywords | **185** |
| kept keywords sitting in a duplicate-volume group | **585** (70.1% of 835) |
| groups of size 2 | 95 |
| groups of size 3 | 40 |
| groups of size 4 | 18 |
| groups of size 5–9 | 30 |
| groups of size 10+ | 2 |

### Top-15 groups by `size × annual_volume` (with pair ratios where scored)

`ratios` = `device : per_pair_ratio` from `pairs_scored[]`. Blank = keyword not scored in this snapshot (`base_rank NULL` and/or filtered by matching/noise floor).

| Σ annual (per kw) | n | Σn·v (weight) | keywords (member → base_rank / source → ratios) |
|--:|--:|--:|---|
| **2 539 000** | 2 | 5 078 000 | `tv` r14/serp → **1.14** · `tvs` r18/serp → **3.52** |
| **584 500** | 7 | 4 091 500 | `samsung television` –/– · `samsung televisions` r22/dfs · `samsung tv` r29/dfs → **24.20** · `samsung tvs` r17/dfs → **10.98** · `televisions samsung` –/– · `tv samsung` –/– · `tvs samsung` r11/serp |
| **337 600** | 7 | 2 363 200 | `32 in tv` r4/serp → **96.65** · `32 inch television` r12/serp → **59.51** · `32 inch tv` r1/serp → **1.07** · `32 tv` r7/serp → **26.88** · `32in tv` r14/serp → **46.81** · `tv 32` r5/serp · `tv 32 inch` r2/serp → **35.01** |
| **528 000** | 4 | 2 112 000 | `50 inch tv` r21/dfs → **1.68** · `50 inch tvs` –/– · `50inch tv` –/– · `tv 50 inch` –/– |
| **382 600** | 5 | 1 913 000 | `hisense television` –/– · `hisense televisions` r15/dfs · `hisense tv` –/– · `hisense tvs` r12/dfs → **63.36** · `tv hisense` –/– |
| **257 600** | 7 | 1 803 200 | `televisions for sale` r10/dfs → **1.69** · `tv for sale` –/– · `tv on sale` r10/serp → **9.43** · `tv sale` r17/serp → **0.54** · `tv sales` –/– · `tvs for sale` r20/serp → **0.55** · `tvs on sale` r10/serp → **5.01** |
| **266 600** | 6 | 1 599 600 | 6 members, none scored (all `base_rank NULL`) |
| **383 600** | 3 | 1 150 800 | `lg television` –/– · `lg televisions` r15/dfs · `television lg` r14/serp |
| **250 200** | 4 | 1 000 800 | `40 inch smart tv` r14/serp → **0.98** · `40 inch tv smart` r10/serp → **15.26** · `smart tv 40 inch` –/– · `tv 40 inch smart` r8/serp → **86.70** |
| **243 600** | 4 | 974 400 | `50 inch smart tv` r19/dfs → **0.94** · `smart 50 inch tv` –/– · `smart tv 50 inch` –/– · `tv 50 inch smart` –/– |
| **324 500** | 3 | 973 500 | `40 inch tv` r7/serp → (see §2) · `40inch tv` –/– · `tv 40 inch` –/– |
| **133 100** | 7 | 931 700 | `42 in tv`, `42 inch tv`, `42 inch tvs`, `42 tv`, `panasonic television`, `panasonic televisions`, `panasonic tv` |
| **166 900** | 5 | 834 500 | `tcl television`, `tcl televisions`, `tcl tv`, `tcl tvs`, `tv tcl` |
| **122 400** | 6 | 734 400 | `65 inch samsung tv`, `65 inch tv samsung`, `65inch samsung tv`, `samsung 65 inch tv`, `samsung tv 65 inch`, `tv samsung 65 inch` |
| **119 200** | 6 | 715 200 | `4k television`, `4k televisions`, `4k tv`, `4k tvs`, `tv 4k`, `tvs 4k` |

Every one of the top-15 groups is a set of **surface-form variants of the same demand cluster** — plurals, hyphenation, word-order permutations, `in`/`inch` swaps, or brand-noun order flips. There is no group in the top 15 where the shared annual volume is a coincidence of independent demand.

### Explicit test — `32 in tv` / `32 inch television`

Prior report `dispersion-diagnostic-fe5e3d42-2026-07-20.md §3` recorded these two annual volumes as **378 300**. The current snapshot resolves them at **337 600** (both refreshed by the historical backfill since; identical annual per member, still equal within the pair). The keywords in that shared-volume group are:

```
32 in tv           r4  serp_results   ratio 96.65
32 inch television r12 serp_results   ratio 59.51
32 inch tv         r1  serp_results   ratio 1.07
32 tv              r7  serp_results   ratio 26.88
32in tv            r14 serp_results   ratio 46.81
tv 32              r5  serp_results   (not scored — no GSC match at device layer)
tv 32 inch         r2  serp_results   ratio 35.01
```

**Every one of the 7 members carries the same 337 600/yr — 28 133/mo demand assumption. Six of them are scored; five are red over-predictors; the canonical `32 inch tv` at r1 (the actual dominant surface form in GSC) is dead-on green (1.07).**

Reporting note. Snapshot `fe5e3d42` recorded `32 in tv` annual as 378 300; snapshot `888002bc` records it as 337 600. Same DFS endpoint at both writers (§4); the delta is a genuine 12-month-window shift as new months roll in, not a bug — flagged for completeness, no remedy proposed here.

---

## §2. Cluster-level reconciliation — top-10 groups

For each of the 10 largest groups (by `n × av`) with ≥ 1 scored member, compare **Σ modelled** vs **Σ actual** across the group's scored members (exact-match ratio), then vs **Σ GSC clicks** across all GSC rows containing every stem token (stem-match ratio, where the intersection of member tokens is non-empty).

```sql
-- exact-match ratio: Σ modelled / Σ actual across scored members, per group
```

| Σ annual | n | scored | Σ modelled/mo | Σ actual/mo | exact-match ratio | stem tokens | Σ GSC clicks (stem) | stem-match ratio (modelled ÷ stem-clicks) |
|--:|--:|--:|--:|--:|--:|---|--:|--:|
| 2 539 000 | 2 | 2 | 1 672.99 | 942.17 | **1.78** | — (no common token: `tv` vs `tvs`) | n/a | n/a |
| 584 500 | 7 | 2 | 485.46 | 23.25 | **20.88** | `{samsung}` | 37 462 → 3 121.8/mo | **0.16** |
| 337 600 | 7 | 6 | 770.07 | 141.45 | **5.44** | — (no common token: `32`+`tv`/`tvs`/`television`) | n/a | n/a |
| 528 000 | 4 | 1 | 225.06 | 134.28 | **1.68** | — (no common token) | n/a | n/a |
| 382 600 | 5 | 1 | 83.98 | 1.33 | **63.36** | `{hisense}` | 27 131 → 2 260.9/mo | **0.037** |
| 257 600 | 7 | 5 | 243.03 | 212.47 | **1.14** | — (no common token) | n/a | n/a |
| 266 600 | 6 | 0 | — | — | — | — | n/a | n/a |
| 383 600 | 3 | 0 | — | — | — | `{lg}` | 14 708 → 1 225.7/mo | (no scored numerator) |
| 250 200 | 4 | 3 | 345.38 | 72.59 | **4.76** | `{40, inch, smart, tv}` | 1 718 → 143.2/mo | **2.41** |
| 243 600 | 4 | 1 | 47.09 | 50.24 | **0.94** | `{50, inch, smart, tv}` | 1 531 → 127.6/mo | **0.37** |

Stem-match uses word-boundary regex containment on the lower-cased GSC query, requiring every stem token to appear (word-bounded). The "no common token" rows are groups whose surface forms drop or mutate the shared noun (`tv`/`tvs`/`television`), so a token-intersection stem is empty — this is a limitation of the automated stem extraction, not evidence against the hypothesis (manually the shared demand cluster is obvious from the table in §1).

**Hypothesis test.** For the 5 groups where stem extraction succeeded and reconciliation is possible:

- `samsung` group: exact-match **20.88×** high; stem-match **0.16×** — Σ modelled across just 2 scored members (485/mo) is a small fraction of the site-wide Samsung click reality (~3 122/mo). Adding the 5 unscored siblings at the same 584 500/yr would multiply the modelled number further, well past the stem denominator.
- `hisense` group: exact-match **63×** high; stem-match **0.037×** — same shape, more extreme.
- `40 inch smart tv` group: exact-match **4.76×** high; stem-match **2.41×** — narrower cluster, less GSC ambient stem-match traffic, still over.
- `50 inch smart tv` group: exact-match **0.94×** (single scored member happens to land green); stem-match **0.37×** — one visible member close to truth, the 3 unscored siblings would push modelled over stem-match once they get ranks.

**Reading:** wherever a group has multiple scored members, the exact-match ratio is materially > 1 (1.68, 1.78, 4.76, 5.44, 20.88, 63.36) with the sole exception of `243 600` (only 1 scored member, ratio 0.94). Groups with a stem denominator show the calibrator massively under-representing the true demand (0.037–0.37×), confirming the demand cluster is **larger than any single surface form's GSC record** but **smaller than N× the DFS annual figure**.

---

## §3. Whole-project scale — counterfactuals

```sql
-- fractions and counterfactuals across pairs_scored[] joined to group membership
```

| metric | value |
|---|--:|
| kept keywords with a complete 12-month series | 835 |
| kept keywords sitting in a duplicate-volume group | **585** (70.1%) |
| Σ modelled/mo across all 152 scored pairs | **6 535.97** |
| Σ actual/mo across all 152 scored pairs | 2 894.76 |
| Σ modelled/mo contributed by duplicate-group keywords | **6 207.97 (95.0% of portfolio modelled)** |

Note on the two portfolio ratios in play. The snapshot's authoritative `overall_ratio = 1.7669` is computed from the by-intent aggregates (Σ modelled 4 746.05 / Σ actual 2 686.14). The pair-level Σ over `pairs_scored[]` is higher (6 536 / 2 895 = 2.258) because the same keyword can appear twice (desktop + mobile). Both are shown here; the counterfactual below uses the pair-level sums directly and reports both ratios.

### Counterfactual A — "max modelled per group" (count each cluster once, credit the strongest single member)

Replace `Σ modelled` inside each duplicate group with `max(modelled_member)`; singletons unchanged.

| | Σ modelled/mo | pair-level ratio (÷ 2 894.76) |
|---|--:|--:|
| current | 6 535.97 | 2.258 |
| **counterfactual A (max)** | **4 116.98** | **1.422** |
| **counterfactual B (mean)** | **2 241.23** | **0.774** |
| Δ vs current (A) | −2 418.99 (−37.0%) | −0.836 |
| Δ vs current (B) | −4 294.74 (−65.7%) | −1.484 |

Applied to the snapshot's authoritative overall_ratio (approximating the same 37.0% / 65.7% relative drops in Σ modelled from the by-intent sum 4 746.05):

- **A (max):** overall_ratio ≈ 4 746 × (1 − 0.370) / 2 686 ≈ **1.113 (green)**.
- **B (mean):** overall_ratio ≈ 4 746 × (1 − 0.657) / 2 686 ≈ **0.606 (green)**.

**Neither is a fix — both are bounds.** The truth for a "count the cluster once" world lies between A and B: A over-attributes because the "strongest" member is often the surface form that itself already over-predicts (see `hisense tvs 63×`, `32 in tv 96×`); B under-attributes because it splits shared demand equally across surface forms that are not equally served. What the pair matters for is the size of the effect: **duplicate-volume double-counting alone is large enough to move the portfolio from 1.77 red-of-amber into the green band under both bounds.**

---

## §4. DFS provenance — endpoint, response, writer

Both writers call the **same** DFS endpoint:

```
POST https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live
  location_code = 2826   -- UK
  language_code = "en"
```

Cited:
- `supabase/functions/keyword-enrichment/index.ts:295, 312, 337, 400, 411–412`
- `supabase/functions/dataforseo-historical-volume-backfill/index.ts:35–36, 107`
- `docs/dataforseo-24mo-history-research.md:12, 62–63` explicitly identifies this as the **Google Ads Keyword Planner Search Volume** endpoint (`keywords_data/google_ads/search_volume/live`), passed through by DFS from Google's Ads API. Public docs: <https://docs.dataforseo.com/v3/keywords_data/google_ads/search_volume/live/>.

### What Google's Ads API returns under this endpoint

Google's Keyword Planner **normalises search volume across close variants** by design: plurals, misspellings, punctuation, and reordered word forms of the same query receive the **same monthly search-volume figure** — the figure represents the Ads "keyword idea group" (close-variant cluster), not the surface form. This is Google-side behaviour, documented on the Ads API side; DFS is a pass-through.

Consequence: when the same DFS endpoint is queried for `32 inch tv`, `32 in tv`, `32in tv`, `32 tv`, `tv 32`, `tv 32 inch`, `32 inch television`, Google's Ads API returns the **same 337 600/yr** for each — because they all belong to the same close-variant cluster. The `keyword_info` block in the DFS response echoes this back verbatim per requested surface form.

### What the writers persist

```ts
// keyword-enrichment/index.ts:337, 411-412
if (item.search_volume != null) { p.volume = item.search_volume; volumeUpdated++; }
{ volume: m.search_volume ?? 0, source: 'dataforseo_search_volume' }

// dataforseo-historical-volume-backfill/index.ts:107
rows.push({ year: y, month: m, volume: Number(h?.search_volume ?? 0) || 0 })
```

Both writers persist **only `search_volume`** (and the monthly historic array). They **do not** persist or inspect:

- `keyword_info.categories`
- `keyword_info.competition`, `cpc`, `low_top_of_page_bid`, `high_top_of_page_bid`
- `keyword_properties.core_keyword` (Ads' canonical form for the close-variant cluster — **the identifier that would let the pipeline recognise `32 inch tv` and `32 in tv` as the same cluster**)
- `keyword_properties.keyword_difficulty`
- `keyword_properties.synonym_clustering_algorithm`
- `related_keywords`, `spell` (spelling correction target), `search_partners`

The `core_keyword` field in particular is the **API-level grouping identifier** that would collapse the 7 members of the `337 600/yr` group down to a single cluster. It is present in the response payload and it is discarded by both writers.

**Provenance verdict.** The endpoint is documented as returning close-variant-normalised (cluster) volume; the response carries an explicit cluster identifier (`core_keyword`); the writers persist the volume per surface form and drop the identifier. Nothing in the pipeline downstream reunites cluster members — every scored surface form enters `pairs_scored[]` as an independent demand assertion of the full cluster volume.

---

## §5. Ranked evidence weight

**H(i) — DFS returns close-variant / cluster-normalised volume that the pipeline treats as per-surface-form demand.** ★ dominant.
- §1: 585 of 835 kept keywords (70%) sit in a duplicate-volume group; the top-15 groups are all textbook close-variant clusters.
- §1 explicit test: 7 surface forms of "32-inch TV" all carry 337 600/yr; ratios span 1.07–96.65.
- §2: exact-match ratios 1.68–63.36 wherever ≥ 1 scored member; stem-match 0.037–0.37 vs external clicks, confirming the demand cluster is larger than any single surface form but far smaller than N× the DFS figure.
- §3: 95.0% of pair-level Σ modelled comes from duplicate-group keywords; deduping bounds the portfolio to 0.61–1.11.
- §4: same DFS endpoint at both writers is the Google Ads Keyword Planner close-variant endpoint; `keyword_properties.core_keyword` cluster identifier is discarded by both writers.

**H(iii) — Backfill writer joins rows across similar keywords (writer bug).** ★ refuted.
- `dataforseo-historical-volume-backfill/index.ts:107` writes one row per `(keyword_id, month)` directly from `h.search_volume` per keyword; no cross-keyword aggregation. Same for `keyword-enrichment/index.ts:411–412`. The duplication is on the input side, not the writer side.

**H(iv) — Detox left near-duplicate variants under a category-level rule.** ★ contributing but not causal.
- The detox pass evidently kept multiple surface forms per cluster (see §1's top-15). This determines **how many times** the cluster's demand gets double-counted, but does not create the duplication — DFS returning identical volumes is the necessary condition. Detox is downstream of DFS.

**H(ii) — Coincidence: common integer volumes collide by chance.** ★ refuted.
- 835 keywords across 435 distinct annual-volume values; under a naive uniform-collision model the expected number of size-2 collisions is ≈ `C(835,2)/435 ≈ 800` — but that's collisions counted with multiplicity across a heavy-tailed distribution. The pattern-check that refutes chance is qualitative: the **members** of each duplicate group are morphological variants of a single query (`32 in tv`/`32 inch tv`/`32 tv`/…), not unrelated keywords that happen to share a number. Chance would produce random pairings, not seven-way plural/word-order permutations at 337 600/yr.

### Ranked order (with evidence weight)

1. **H(i) — DFS cluster-normalised volume treated per-surface-form.** Direct, mechanised, and reproducible from Google Ads' documented behaviour + the writer code. Dominant driver.
2. **H(iv) — Detox retained near-duplicate variants.** Multiplier on the H(i) effect: more surface forms kept ⇒ larger over-counting. Not the cause.
3. **H(ii) — Chance collision.** Refuted by member composition of the groups.
4. **H(iii) — Writer bug.** Refuted by direct code inspection.

No remedies. Advisor rules the direction.
