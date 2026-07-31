# Canonical selection mechanism — investigation report

- **Snapshot referenced:** `908ef33d-f5f6-44b1-b802-59a2fef8f8f9` (TVs Ongoing, `5fd4df7e-45dd-40c0-b10e-86ea6dad9720`)
- **Latest GSC upload for that project:** `3dbe61d9-09de-422d-bfd9-a693f1d6b466` (2026-07-19)
- **Scope:** read-only — code citations + SQL. No proposals.

Evidence rule: every figure is produced by a query in the section or the SQL appendix; every code claim carries a `file:line` reference.

---

## §1 Mechanism trace — how canonical is selected today

Aggregation and canonical write live in `supabase/functions/keyword-cluster-recompute/index.ts`. Fallback ladder lives in `supabase/functions/_shared/keyword-cluster.ts`.

### 1.1 GSC-click aggregation

`keyword-cluster-recompute/index.ts:122-149` — the latest GSC upload for the project is loaded, then non-branded rows are folded into a single `Map<clusterKey, clicks>`:

```ts
// 3. Load latest GSC upload for this project and aggregate non-branded
//    clicks by normaliseKeyword (form-based key, matches cluster_key).
const gscClicksByKey = new Map<string, number>();
{
  const { data: uploadRow } = await service
    .from("gsc_uploads")
    .select("id").eq("project_id", project_id)
    .order("uploaded_at", { ascending: false }).limit(1).maybeSingle();
  if (uploadRow?.id) {
    const gscRows = await fetchAllRows<{...}>(
      service, "gsc_upload_keywords", "keyword, clicks, is_branded",
      (q) => q.eq("upload_id", uploadRow.id),
    );
    for (const r of gscRows) {
      if (r.is_branded === true) continue;
      const key = normaliseKeyword(r.keyword ?? "");
      if (!key) continue;
      const c = Number(r.clicks ?? 0);
      if (!Number.isFinite(c) || c <= 0) continue;
      gscClicksByKey.set(key, (gscClicksByKey.get(key) ?? 0) + c);
    }
  }
}
```

The aggregation key is `normaliseKeyword(r.keyword)`. `normaliseKeyword` is the same function that produces `cluster_key` for curated keywords (`_shared/keyword-cluster.ts:20-48`). So every GSC surface form that normalises to the same cluster is summed into a single bucket keyed on the cluster.

### 1.2 Per-member enrichment

`keyword-cluster-recompute/index.ts:151-171` — every curated member is enriched with the cluster's total clicks by keying on its own `cluster_key`:

```ts
const enriched: Enriched[] = keywords.map((k) => {
  const sum = monthlySum.get(k.id);
  const annual = ...;
  const key = normaliseKeyword(k.keyword ?? "");
  return {
    ...k,
    cluster_key: key,
    annual_volume: annual,
    gsc_clicks: gscClicksByKey.get(key) ?? 0,   // ← cluster total, not exact form
  };
});
```

### 1.3 Tie-break ladder

`_shared/keyword-cluster.ts:105-143` (`pickCanonicalWithBasis`):

```ts
const maxClicks = Math.max(...members.map(clicks));
if (maxClicks > 0) {
  const pool = members.filter((m) => clicks(m) === maxClicks);
  return { member: pickCanonical(pool), basis: "gsc_clicks" };
}
// else volume → base_rank → alphabetical
```

`pickCanonical` (`_shared/keyword-cluster.ts:74-90`) sorts by `base_rank ASC (NULLs last) → annual_volume DESC → keyword ASC`.

### 1.4 Persist

`keyword-cluster-recompute/index.ts:194-244` — `cluster_canonical_keyword_id`, `cluster_member_count`, and `cluster_canonical_basis` are written per row:

```ts
for (const [key, members] of groups.entries()) {
  ...
  const picked = pickCanonicalWithBasis(members);
  basisCounts[picked.basis] += 1;
  for (const m of members) {
    canonicalById.set(m.id, { canonical_id: picked.member.id, count: members.length,
                              cluster_key: key, basis: picked.basis });
  }
}
```

### 1.5 Why every member ties on `gsc_clicks`

In §1.1 the aggregation groups by `normaliseKeyword(gsc_row.keyword)` — the cluster key. In §1.2 every curated member of the same cluster looks up `gscClicksByKey.get(key)` using its **own** cluster key. Two curated members that share a cluster share a `cluster_key`, therefore look up the same map entry, therefore receive the identical aggregate. The `pickCanonicalWithBasis` ladder then finds `maxClicks` equal for all members, so every member is in the tie-break `pool`, and selection falls through to `pickCanonical` (base_rank → volume → alphabetical). `cluster_canonical_basis` is still stamped `'gsc_clicks'` because the branch was taken, but the actual differentiator is `base_rank`.

Exact-form GSC evidence per member is never joined; it is discarded at aggregation.

---

## §2 Top-10 multi-member clusters — full member dump (TVs Ongoing)

Ordered by member count DESC, then summed volume DESC. Exact-form GSC values are from upload `3dbe61d9-…`, non-branded. `av_annual = avg_monthly_volume × 12`.

### 2.1 `lg oled tv` (13 members)

| keyword | gsc_clicks | gsc_impr | annual_vol | base_rank | rank_source | ranking_url |
|---|---:|---:|---:|---:|---|---|
| oled lg television | 0 | 0 | 2 040 | 9 | serp_results | `/l/tvs-lg-oled_screen/...` |
| lg oled televisions | 0 | 0 | 118 800 | 10 | serp_results | `/l/tvs-lg-oled_screen/...` |
| **lg oled tv** | **188** | 60 356 | 118 800 | 11 | serp_results | `/l/tvs-lg-oled_screen/...` |
| tv lg oled | 0 | 0 | 2 040 | 11 | serp_results | `/l/tvs-lg-oled_screen/...` |
| oled lg tv | 0 | 0 | 118 800 | 11 | serp_results | `/l/tvs-lg-oled_screen/...` |
| lg tv oled | 0 | 0 | 2 040 | 12 | serp_results | `/l/tvs-lg-oled_screen/...` |
| oled tv lg | 0 | 0 | 5 760 | 15 | serp_results | `/l/tvs-lg-oled_screen/...` |
| lg oled television | 0 | 0 | 118 800 | 17 | serp_results | `/l/tvs-oled_screen/...` |
| lg oled tvs | 0 | 0 | 118 800 | 18 | serp_results | `/l/tvs-oled_screen/...` |
| television lg oled | 0 | 0 | 2 040 | 19 | serp_results | `/l/tvs-oled_screen/...` |
| lg television oled | 0 | 0 | 2 040 | — | — | — |
| oled television lg | 0 | 0 | 2 040 | — | — | — |
| oled lg tvs | 0 | 0 | 118 800 | — | — | — |

Only `lg oled tv` is present in GSC. Rank-first would pick `oled lg television` (rank 9); volume-first would pick any of six 118 800-volume rows; GSC-first (exact form) would pick `lg oled tv`.

### 2.2 `55 inch tv` (11 members)

| keyword | gsc_clicks | gsc_impr | annual_vol | base_rank | rank_source | ranking_url |
|---|---:|---:|---:|---:|---|---|
| 55in tv | 25 | 4 009 | 594 000 | 11 | serp_results | `/l/tvs-55_inches_to_64pt9_inches/...` |
| **55 inch tv** | **2 170** | 324 451 | 43 200 | 14 | dfs_labs | `/l/tvs-55_inches_and_above/...` |
| 55 inch television | 0 | 0 | 594 000 | 18 | serp_results | `/l/tvs-55_inches_to_64pt9_inches/...` |
| 55-in tvs | 0 | 0 | 594 000 | 20 | serp_results | `/l/tvs-55_inches_to_64pt9_inches/...` |
| 55 inches tv | 0 | 0 | 594 000 | — | — | — |
| 55inch tv | 188 | 31 179 | 594 000 | — | — | — |
| tv 55 inch | 105 | 17 275 | 43 200 | — | — | — |
| 55-in tv | 0 | 0 | 594 000 | — | — | — |
| 55 inch tvs | 30 | 5 407 | 594 000 | — | — | — |
| tv 55inch | 0 | 0 | 43 200 | — | — | — |
| 55 in tv | 0 | 0 | 594 000 | — | — | — |

Documented case study: current pipeline selects `55in tv` (basis stamped `gsc_clicks`, actual differentiator `base_rank`); exact-form GSC evidence points to `55 inch tv` (2 170 clicks).

### 2.3 `65 inch tv` (9 members), `55 hisense inch tv`, `55 inch samsung tv`, `65 inch samsung tv`, `55 lg oled tv`, `55 inch smart tv`, `65 inch lg tv`, `55 sony tv`

Full member dumps for clusters 3–10 are produced by Q1 in the appendix. Same shape as §2.1/§2.2: one or two forms carry meaningful GSC clicks, the remaining forms are curated variants at rank 10–20 with zero GSC evidence.

---

## §3 Ranking-URL uniformity and rank spread (all 159 multi-member clusters)

Query Q2:

| Metric | Value |
|---|---:|
| Multi-member clusters | 159 |
| Clusters where all non-null `ranking_url` values agree (or all null) | 128 (80.5 %) |
| Clusters with ≥2 distinct non-null `ranking_url` values | 31 (19.5 %) |
| Clusters with **no** `ranking_url` on any member | 29 |
| Mean `max_rank − min_rank` (clusters with ≥2 non-null ranks) | **4.97** |
| Max rank spread observed | **13** |
| Mean non-null `base_rank` per cluster | 1.53 |

Interpretation: 4 in 5 clusters agree on a single URL — members really are the same demand pool. On 1 in 5, at least two members rank on different URLs (e.g. `55 inch tv` — `/l/tvs-55_inches_to_64pt9_inches/…` vs `/l/tvs-55_inches_and_above/…`). Rank spread inside a cluster averages ~5 positions, up to 13.

---

## §4 Rule disagreement across 159 multi-member clusters

Query Q3 computes the winner per cluster under three rules using upload `3dbe61d9`:

- **(a) highest exact-form GSC clicks** (upload `3dbe61d9`, non-branded)
- **(b) highest annual volume** (`avg_monthly_volume × 12`)
- **(c) lowest non-null `base_rank`** (NULLs last)

Ties broken alphabetically by keyword for each rule so results are deterministic.

| Disagreement | Clusters |
|---|---:|
| (a) ≠ (b) | 55 |
| (a) ≠ (c) | 78 |
| (b) ≠ (c) | 76 |
| All three agree | 61 |
| All three disagree | **13** |

Only 38 % of clusters (61/159) have all three rules pointing at the same member. On the majority of clusters at least one rule diverges; on 13 clusters all three diverge.

### 5 clusters where all three rules pick different members (Q4)

| cluster_key | GSC-click pick (a) | (a) clicks | Volume pick (b) | (b) annual | Base-rank pick (c) | (c) rank |
|---|---|---:|---|---:|---|---:|
| 55 hisense inch tv | hisense 55 inch tv | 33 | 55 inch tv hisense | 52 800 | 55 inch hisense tv | — |
| 55 inch tv | 55 inch tv | 2 170 | 55 in tv | 594 000 | 55in tv | 11 |
| 55 lg oled tv | 55 lg oled tv | 0 | 55 lg oled tvs | 12 000 | lg oled tv 55 | 18 |
| 65 inch tv | 65 inch tv | 1 523 | 65 inch television | 594 000 | 65 in tv | 21 |
| 75 inch sony tv | 75 inch tv sony | 0 | sony 75 inch tv | 19 200 | sony tv 75 inch | 10 |

On `55 inch tv` and `65 inch tv` — the two largest by volume — the three rules land on three different members. This is the class of cluster where the choice materially changes what forecast rank/CTR gets applied.

---

## §5 Downstream consumers of the canonical fields

`rg` across `supabase/functions/**` and `src/**` (excluding generated `src/integrations/supabase/types.ts`):

| Consumer | file:line | Role |
|---|---|---|
| **Calibration scoring** | `supabase/functions/calibration-compute/index.ts:238-242` (SELECT), `:374-377` (canonical gate), `:417`, `:472-473`, `:518-524` (ledger fields) | Only canonical keywords enter `pairs_scored`; non-canonical members are moved to `pairs_cluster_excluded`. `cluster_canonical_keyword_id`, `cluster_member_count`, `cluster_query_count` are stamped on each ledger row. |
| **Writer** | `supabase/functions/keyword-cluster-recompute/index.ts:221-237` | Owns the write. |
| **Admin UI** | `src/components/admin/KeywordClusteringCard.tsx:59-78` | Reads `cluster_key, cluster_member_count` for the summary counts card. Does not read `cluster_canonical_keyword_id` or `_basis`. |

No hits for these identifiers in:
- HAR pipeline (`supabase/functions/compute-har-*`, `_shared/har-*`) — HAR does not filter or partition by canonical.
- Revenue pipeline (`supabase/functions/compute-forecasts-v2`, `_shared/revenue-v2.ts`) — revenue reads `keywords` rows directly; canonical fields are not consulted.
- Any UI page in `src/pages/**` outside the admin card above.
- Roadmap / content-plan / SERP / detox / categorisation flows.

### Risk if display canonical ≠ forecast-rank source

Only calibration consumes canonical today, but forecasting uses `keywords.base_rank` of every kept row regardless. If the display canonical (used in future UI, share-of-search, briefing narrative) diverged from the member whose `base_rank` and `annual_volume` drive the forecast:

- **Ledger mismatch.** `calibration-compute` scores using the canonical row's `base_rank`/`avg_monthly_volume`; if UI shows a different "canonical" keyword, calibration figures and UI attribution no longer describe the same object.
- **Forecast attribution drift.** Share-of-search and briefing surfaces would attribute the cluster's demand to a keyword whose rank was never the one modelled.
- **Sparkline / trend continuity.** Any UI trend anchored on the canonical `keyword_id` would jump when canonical flips, unrelated to real movement.

Nothing outside calibration and the admin card would fail today; the risks are dormant until additional consumers ship.

---

## §6 GSC availability across clustered projects

Query Q5:

| Metric | Count |
|---|---:|
| Projects with any clustered keywords (`cluster_key IS NOT NULL`) | 1 |
| …of those, with any `gsc_uploads` row | 1 |
| …of those, with `gsc_upload_keywords` rows (upload actually contains data) | 1 |

Clustering has only been run on TVs Ongoing so far, and TVs Ongoing has a live upload. Fleet-wide GSC coverage cannot be characterised from current production data because only one project is in-scope.

**Current fallback when no upload exists**, verbatim from `_shared/keyword-cluster.ts:105-143`:

```
1. highest gsc_clicks (>0)          → basis 'gsc_clicks'
2. else highest annual_volume (>0)  → basis 'volume'
3. else lowest non-null base_rank   → basis 'base_rank'
4. else alphabetical by keyword     → basis 'alphabetical'
```

If a project has no upload, `gscClicksByKey` is empty (guarded by the `if (uploadRow?.id)` block at `index.ts:133`), every member's `gsc_clicks` is `0`, `maxClicks === 0`, and the ladder falls through to the volume rung. In practice: no GSC upload ⇒ canonical is picked on annual volume, then base_rank, then alphabetical. Per-keyword GSC evidence is otherwise unavailable — `gsc_upload_keywords` is the only per-keyword clicks/impressions source in the schema.

---

## §7 Single-member curated / multi-form GSC clusters

From `by_rank_band->'pairs_scored'` in `908ef33d` (Q6):

- **Scored pairs with `cluster_member_count = 1` AND `cluster_query_count > 1`:** **11 / 111** (9.9 %).

### 7.1 Top 10 by `actual_clicks_cluster − actual_clicks_exact`

| curated keyword | annual_volume | query_count | act_exact | act_cluster | gap |
|---|---:|---:|---:|---:|---:|
| lg tv 50 inch | 8 320 | 3 | 21 | 187 | **166** |
| tv deals | 146 300 | 3 | 2 327 | 2 458 | 131 |
| 42 tv | 95 100 | 2 | 19 | 106 | 87 |
| 32 inch smart tv under 100 | 12 160 | 2 | 33 | 95 | 62 |
| 24 inch tv | 101 300 | 2 | 601 | 650 | 49 |
| 58 inch tv | 48 800 | 2 | 263 | 289 | 26 |
| silver tv | 4 230 | 2 | 135 | 161 | 26 |
| tv deals uk | 27 400 | 2 | 666 | 691 | 25 |
| cheap 50 inch tv | 26 100 | 2 | 163 | 188 | 25 |
| samsung 40 inch smart tv | 44 200 | 2 | 146 | 166 | 20 |

### 7.2 Per-cluster GSC constituents (from upload `3dbe61d9`, Q7)

Each block lists every non-branded GSC surface form whose normalised cluster key equals the curated cluster_key. Curated (in the categorised set) is bolded. `is highest?` = whether the curated keyword is the top-clicks form present in GSC.

**`50 inch lg tv`** — curated `lg tv 50 inch` — **not highest**

| gsc query | clicks | impressions |
|---|---:|---:|
| lg 50 inch tv | 137 | 17 835 |
| 50 inch lg tv | 29 | 4 375 |
| **lg tv 50 inch** | 21 | 4 659 |

**`deal tv`** — curated `tv deals` — **highest** (curated + duplicate rows collapse to 2 327 exact)

| gsc query | clicks | impressions |
|---|---:|---:|
| **tv deals** | 1 791 | 90 683 |
| **tv deals** (dup device row) | 472 | 60 386 |
| **tv deals** (dup device row) | 64 | 1 825 |
| tv deal | 64 | 3 483 |
| television deals | 46 | 9 373 |
| television deals | 21 | 6 036 |

**`42 tv`** — curated `42 tv` — **not highest**

| gsc query | clicks | impressions |
|---|---:|---:|
| 42" tv | 59 | 6 912 |
| 42" tv | 28 | 1 736 |
| **42 tv** | 19 | 3 836 |

**`100 32 inch smart tv under`** — curated `32 inch smart tv under 100` — **not highest**

| gsc query | clicks | impressions |
|---|---:|---:|
| 32 inch smart tv under £100 | 62 | 4 426 |
| **32 inch smart tv under 100** | 33 | 3 086 |

**`24 inch tv`** — curated `24 inch tv` — **highest**

| gsc query | clicks | impressions |
|---|---:|---:|
| **24 inch tv** | 439 | 46 732 |
| **24 inch tv** (dup device row) | 129 | 11 611 |
| 24inch tv | 49 | 5 739 |
| **24 inch tv** (dup device row) | 33 | 1 488 |

**`58 inch tv`** — curated `58 inch tv` — **highest**

| gsc query | clicks | impressions |
|---|---:|---:|
| **58 inch tv** | 210 | 19 095 |
| **58 inch tv** (dup device row) | 53 | 5 985 |
| 58inch tv | 26 | 1 336 |

**`silver tv`** — curated `silver tv` — **highest**

| gsc query | clicks | impressions |
|---|---:|---:|
| **silver tv** | 103 | 6 028 |
| **silver tv** (dup device row) | 32 | 2 885 |
| silver tvs | 26 | 82 |

**`deals tv uk`** — curated `tv deals uk` — **highest**

| gsc query | clicks | impressions |
|---|---:|---:|
| **tv deals uk** | 545 | 24 908 |
| **tv deals uk** (dup device row) | 96 | 7 412 |
| television deals uk | 25 | 2 410 |
| **tv deals uk** (dup device row) | 25 | 635 |

**`50 cheap inch tv`** — curated `cheap 50 inch tv` — **highest**

| gsc query | clicks | impressions |
|---|---:|---:|
| **cheap 50 inch tv** | 143 | 10 752 |
| cheap tv 50 inch | 25 | 849 |
| **cheap 50 inch tv** (dup) | 20 | 3 717 |

**`40 inch samsung smart tv`** — curated `samsung 40 inch smart tv` — **highest**

| gsc query | clicks | impressions |
|---|---:|---:|
| **samsung 40 inch smart tv** | 113 | 16 710 |
| **samsung 40 inch smart tv** (dup) | 33 | 5 774 |
| 40 inch samsung smart tv | 20 | 4 291 |

`avg_monthly_volume`-level volume signals per GSC surface form are unavailable for non-curated forms — those surface forms are not in the categorised keyword set and therefore have no `keyword_monthly_volumes` rows.

**Summary of §7.2:** Of the top 10 gap clusters, **7 already have the curated keyword as the top-clicks form** in GSC (the gap is duplicates / minor variants). **3** — `50 inch lg tv` (curated `lg tv 50 inch`), `42 tv` (curated `42 tv` vs `42" tv`), and `100 32 inch smart tv under` (curated `32 inch smart tv under 100` vs `£100`) — have a non-curated surface form outclicking the curated one.

---

## §A SQL appendix

### Q0. Ledger schema probe

```sql
SELECT jsonb_object_keys(by_rank_band)
FROM calibration_snapshots
WHERE id = '908ef33d-f5f6-44b1-b802-59a2fef8f8f9';

SELECT by_rank_band->'pairs_scored'->0
FROM calibration_snapshots WHERE id = '908ef33d-…';
```

### Q1. Top-10 multi-member clusters — member dump (§2)

```sql
WITH gsc AS (
  SELECT lower(btrim(keyword)) nk,
         sum(clicks) clicks, sum(impressions) impressions
  FROM gsc_upload_keywords
  WHERE upload_id = '3dbe61d9-09de-422d-bfd9-a693f1d6b466'
    AND is_branded IS NOT TRUE
  GROUP BY 1
),
top_clusters AS (
  SELECT cluster_key, count(*) n,
         sum(coalesce(avg_monthly_volume,0)) totvol
  FROM keywords
  WHERE project_id = '5fd4df7e-…'
    AND detox_status = 'keep' AND cluster_key IS NOT NULL
  GROUP BY 1 HAVING count(*) > 1
  ORDER BY n DESC, totvol DESC LIMIT 10
)
SELECT k.cluster_key, k.keyword,
       coalesce(g.clicks,0) AS gsc_clicks,
       coalesce(g.impressions,0) AS gsc_impr,
       k.avg_monthly_volume * 12 AS annual_volume,
       k.base_rank, k.base_rank_source, k.ranking_url
FROM keywords k
JOIN top_clusters t USING (cluster_key)
LEFT JOIN gsc g ON g.nk = lower(btrim(k.keyword))
WHERE k.project_id = '5fd4df7e-…' AND k.detox_status = 'keep'
ORDER BY t.n DESC, t.totvol DESC, k.cluster_key, k.base_rank NULLS LAST;
```

### Q2. URL uniformity and rank spread (§3)

```sql
WITH members AS (
  SELECT cluster_key, ranking_url, base_rank
  FROM keywords
  WHERE project_id = '5fd4df7e-…'
    AND detox_status = 'keep' AND cluster_member_count > 1
),
per_cluster AS (
  SELECT cluster_key,
    count(*) members,
    count(DISTINCT ranking_url) FILTER (WHERE ranking_url IS NOT NULL) distinct_urls,
    min(base_rank) min_rank, max(base_rank) max_rank,
    count(base_rank) ranks_present
  FROM members GROUP BY 1
)
SELECT count(*) clusters_total,
       count(*) FILTER (WHERE distinct_urls <= 1) all_urls_agree_or_null,
       count(*) FILTER (WHERE distinct_urls >= 2) multi_url,
       count(*) FILTER (WHERE distinct_urls  = 0) no_url_data,
       avg(max_rank - min_rank) FILTER (WHERE ranks_present >= 2) avg_rank_spread,
       max(max_rank - min_rank) max_rank_spread,
       avg(ranks_present) avg_ranks_present
FROM per_cluster;
```

### Q3. Rule disagreement matrix (§4)

```sql
WITH gsc AS (
  SELECT lower(btrim(keyword)) nk, sum(clicks) clicks
  FROM gsc_upload_keywords
  WHERE upload_id = '3dbe61d9-…' AND is_branded IS NOT TRUE
  GROUP BY 1
),
m AS (
  SELECT k.cluster_key, k.keyword,
         coalesce(g.clicks,0) gsc_clicks,
         coalesce(k.avg_monthly_volume,0) * 12 av,
         k.base_rank
  FROM keywords k
  LEFT JOIN gsc g ON g.nk = lower(btrim(k.keyword))
  WHERE k.project_id = '5fd4df7e-…' AND k.detox_status = 'keep'
    AND k.cluster_member_count > 1
),
pa AS (SELECT DISTINCT ON (cluster_key) cluster_key, keyword a_kw
       FROM m ORDER BY cluster_key, gsc_clicks DESC, keyword),
pb AS (SELECT DISTINCT ON (cluster_key) cluster_key, keyword b_kw
       FROM m ORDER BY cluster_key, av DESC, keyword),
pc AS (SELECT DISTINCT ON (cluster_key) cluster_key, keyword c_kw
       FROM m ORDER BY cluster_key, base_rank NULLS LAST, keyword)
SELECT count(*) clusters,
       count(*) FILTER (WHERE a_kw <> b_kw) a_ne_b,
       count(*) FILTER (WHERE a_kw <> c_kw) a_ne_c,
       count(*) FILTER (WHERE b_kw <> c_kw) b_ne_c,
       count(*) FILTER (WHERE a_kw = b_kw AND b_kw = c_kw) all_agree,
       count(*) FILTER (WHERE a_kw <> b_kw AND a_kw <> c_kw AND b_kw <> c_kw) all_disagree
FROM pa JOIN pb USING (cluster_key) JOIN pc USING (cluster_key);
```

### Q4. All-three-disagree cluster examples (§4)

Same CTEs as Q3, then:

```sql
SELECT pa.cluster_key, a_kw, a_clicks, b_kw, b_vol, c_kw, c_rank
FROM pa JOIN pb USING (cluster_key) JOIN pc USING (cluster_key)
WHERE a_kw <> b_kw AND a_kw <> c_kw AND b_kw <> c_kw
LIMIT 5;
```

### Q5. Cross-project GSC availability (§6)

```sql
WITH clustered AS (SELECT DISTINCT project_id FROM keywords WHERE cluster_key IS NOT NULL),
     uploads   AS (SELECT DISTINCT project_id FROM gsc_uploads),
     uploads_with_data AS (
       SELECT DISTINCT u.project_id FROM gsc_uploads u
       WHERE EXISTS (SELECT 1 FROM gsc_upload_keywords k WHERE k.upload_id = u.id)
     )
SELECT (SELECT count(*) FROM clustered) AS clustered_projects,
       (SELECT count(*) FROM clustered c WHERE c.project_id IN (SELECT project_id FROM uploads))          AS with_any_upload,
       (SELECT count(*) FROM clustered c WHERE c.project_id IN (SELECT project_id FROM uploads_with_data)) AS with_upload_data;
```

### Q6. Single-member curated / multi-form GSC pairs (§7.1)

```sql
WITH p AS (SELECT jsonb_array_elements(by_rank_band->'pairs_scored') r
           FROM calibration_snapshots WHERE id = '908ef33d-…')
SELECT r->>'keyword' kw, r->>'cluster_key' ck,
       (r->>'annual_volume')::numeric av,
       (r->>'cluster_query_count')::int qc,
       (r->>'actual_clicks_exact')::numeric   act_ex,
       (r->>'actual_clicks_cluster')::numeric act_cl,
       ((r->>'actual_clicks_cluster')::numeric - (r->>'actual_clicks_exact')::numeric) gap
FROM p
WHERE (r->>'cluster_member_count')::int = 1 AND (r->>'cluster_query_count')::int > 1
ORDER BY gap DESC LIMIT 10;
```

### Q7. GSC constituents per cluster (§7.2)

Replicates `normaliseKeyword` in SQL — lowercase → split glued size tokens → non-alnum to spaces → tokenise → fold `in|inch|inches → inch`, `television|televisions → tv` → drop trailing "s" on the last token (pre-sort) → alphabetical sort → join. Filters on the 10 cluster keys from Q6.

```sql
WITH src AS (
  SELECT keyword, clicks, impressions
  FROM gsc_upload_keywords
  WHERE upload_id = '3dbe61d9-…' AND is_branded IS NOT TRUE
),
tok AS (
  SELECT keyword, clicks, impressions,
    string_to_array(
      trim(regexp_replace(
        regexp_replace(
          regexp_replace(lower(keyword),
            '([0-9]+)(inches|inch|in)\M', '\1 \2', 'g'),
          '[^a-z0-9]+', ' ', 'g'),
        '\s+', ' ', 'g')),
      ' ') AS toks
  FROM src
),
folded AS (
  SELECT keyword, clicks, impressions,
    ARRAY(SELECT CASE
      WHEN t IN ('in','inch','inches') THEN 'inch'
      WHEN t IN ('television','televisions') THEN 'tv'
      ELSE t END FROM unnest(toks) t) AS toks
  FROM tok
),
depl AS (
  SELECT keyword, clicks, impressions,
    CASE WHEN cardinality(toks) > 0
              AND length(toks[cardinality(toks)]) > 1
              AND right(toks[cardinality(toks)], 1) = 's'
      THEN toks[1:cardinality(toks)-1]
           || left(toks[cardinality(toks)], length(toks[cardinality(toks)]) - 1)
      ELSE toks END AS toks
  FROM folded
),
normed AS (
  SELECT keyword, clicks, impressions,
    (SELECT string_agg(t, ' ' ORDER BY t) FROM unnest(toks) t) AS ck
  FROM depl
)
SELECT ck, keyword, clicks, impressions
FROM normed
WHERE ck IN (
  '50 inch lg tv','deal tv','42 tv','100 32 inch smart tv under',
  '24 inch tv','58 inch tv','silver tv','deals tv uk',
  '50 cheap inch tv','40 inch samsung smart tv'
)
ORDER BY ck, clicks DESC;
```
