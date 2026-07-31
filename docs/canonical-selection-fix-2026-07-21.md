# Canonical Selection Fix — Exact-form GSC clicks + cluster-level properties

Date: 2026-07-21
Scope: `supabase/functions/keyword-cluster-recompute/index.ts`, `supabase/functions/_shared/keyword-cluster.ts` (+ tests), `supabase/functions/calibration-compute/index.ts`, one additive migration. No forecasting maths, resolvers, curves, gate criteria, bands, MAX-volume policy, detox, or categorisation changed.

---

## 1. Migration — additive, five nullable columns on `public.keywords`

```sql
ALTER TABLE public.keywords
  ADD COLUMN IF NOT EXISTS cluster_volume_annual        numeric,
  ADD COLUMN IF NOT EXISTS cluster_base_rank            integer,
  ADD COLUMN IF NOT EXISTS cluster_base_rank_keyword_id uuid,
  ADD COLUMN IF NOT EXISTS cluster_ranking_url          text,
  ADD COLUMN IF NOT EXISTS cluster_url_conflict         boolean;

COMMENT ON COLUMN public.keywords.cluster_volume_annual        IS 'MAX annual volume across all cluster members; identical for every member';
COMMENT ON COLUMN public.keywords.cluster_base_rank            IS 'MIN non-null base_rank across cluster members; identical for every member';
COMMENT ON COLUMN public.keywords.cluster_base_rank_keyword_id IS 'Member id supplying cluster_base_rank (tie-break: highest annual_volume DESC, then keyword ASC)';
COMMENT ON COLUMN public.keywords.cluster_ranking_url          IS 'Modal non-null ranking_url in cluster; NULL if all members are NULL';
COMMENT ON COLUMN public.keywords.cluster_url_conflict         IS 'true iff members carry >=2 distinct non-null ranking_url values';
```

Applied successfully. Table already carries the correct grants and RLS from prior migrations; no additional grants required.

---

## 2. Diff summary

### 2a. `keyword-cluster-recompute/index.ts` — GSC aggregation switches from cluster key to exact form

**Before** (`index.ts:122-149`, v2 gsc-clicks-canonical): clicks were summed under `normaliseKeyword(gsc_row.keyword)` — the cluster key — so every member of a cluster looked up the same aggregate and tied on `gsc_clicks`.

**After** (`index.ts:122-152`, v3 exact-form-canonical): clicks are summed under `normaliseExactForm(gsc_row.keyword)` (lowercase + whitespace-collapse only, no folding). Each curated member looks up its own exact form via `normaliseExactForm(k.keyword)`. Distinct surface forms within a cluster now attribute distinct click totals.

Key change:
```ts
// old
const key = normaliseKeyword(r.keyword ?? "");
gscClicksByKey.set(key, (gscClicksByKey.get(key) ?? 0) + c);
// …
gsc_clicks: gscClicksByKey.get(key) ?? 0,   // key == cluster_key → every member ties

// new
const key = normaliseExactForm(r.keyword ?? "");
gscExactByForm.set(key, (gscExactByForm.get(key) ?? 0) + c);
// …
const exactKey = normaliseExactForm(k.keyword ?? "");
gsc_clicks: gscExactByForm.get(exactKey) ?? 0,
```

Boot marker bumped for redeploy verification:
```ts
console.log(`[keyword-cluster-recompute] boot v3 exact-form-canonical + cluster-properties ${new Date().toISOString()}`);
```

### 2b. Canonical ladder shape unchanged

`pickCanonicalWithBasis` in `_shared/keyword-cluster.ts` is untouched. With per-member exact clicks feeding `gsc_clicks`, the `maxClicks > 0` branch is now genuinely differentiating. Basis stamping (`gsc_clicks` / `volume` / `base_rank` / `alphabetical`) is preserved.

### 2c. Persist cluster-level properties per member

Added `computeClusterProperties(members)` in `_shared/keyword-cluster.ts`:

- `cluster_volume_annual` = `MAX(annual_volume)` across members
- `cluster_base_rank` = `MIN(non-null base_rank)`, tie-break `annual_volume DESC → keyword ASC`
- `cluster_base_rank_keyword_id` = member id supplying that MIN
- `cluster_ranking_url` = modal non-null `ranking_url`, tie-break on the representative keyword ASC among URLs
- `cluster_url_conflict` = `distinct non-null ranking_url count >= 2`

`keyword-cluster-recompute` now also selects `ranking_url` and writes the five new columns on every member row (same value across the cluster). Update payload adds:

```ts
cluster_volume_annual: r.cluster_volume_annual,
cluster_base_rank: r.cluster_base_rank,
cluster_base_rank_keyword_id: r.cluster_base_rank_keyword_id,
cluster_ranking_url: r.cluster_ranking_url,
cluster_url_conflict: r.cluster_url_conflict,
```

Summary payload gains `gsc_exact_forms_with_clicks` and `url_conflict_clusters`; the misleading `gsc_norm_queries` name is dropped.

### 3a/3b. `calibration-compute/index.ts` — cluster-level inputs for canonical scored pairs

`kwAll` select at `:234-249` extended to pull the five new columns.

Scored branch at `:423-471` reworked. Canonical scored pairs now resolve CTR against `cluster_base_rank` when present, and use `cluster_volume_annual` as the volume input (multiplied by the same `trendFactor`). Non-canonical branches are untouched; `?? kw.base_rank`/canonical-own fallbacks preserve behaviour when the new columns are NULL (i.e. before the next recompute).

```ts
const clusterVolumeAnnual = kw.cluster_volume_annual != null
  && Number.isFinite(Number(kw.cluster_volume_annual))
  && Number(kw.cluster_volume_annual) > 0
    ? Number(kw.cluster_volume_annual) : null;
const clusterBaseRank = kw.cluster_base_rank != null
  && Number.isFinite(Number(kw.cluster_base_rank))
    ? Number(kw.cluster_base_rank) : null;

const volumeAnnualUsed = (isCanonical && clusterVolumeAnnual != null)
  ? clusterVolumeAnnual
  : (canonicalOwnVolume == null ? null : Number(canonicalOwnVolume));
const rankUsed = (isCanonical && clusterBaseRank != null)
  ? clusterBaseRank
  : canonicalOwnBaseRank;

const volFwd = volumeAnnualUsed == null ? null : volumeAnnualUsed * factor;
const res = ctrResolver.resolve({ device, intent: kw.search_intent, position: rankUsed });
```

The calibration pair (feeding `computeCalibration`) now uses `rank: rankUsed` so rank-band aggregates reflect what was actually resolved.

Forecasting formula shape is unchanged: `modelledMonthly = volFwd * ctrNow * svm / 12`.

### 3c. Ledger fields (`pairsScored`)

Existing `annual_volume` and `base_rank` retain their meaning (canonical member's own). Added:

```ts
cluster_volume_annual, cluster_base_rank, cluster_base_rank_keyword_id,
canonical_own_volume, canonical_own_base_rank, cluster_url_conflict
```

`volume_forward_used`, `ctr_used`, `ctr_resolver_tier`, and `ctr_curve_key` now reflect the cluster-level inputs that were actually used, matching the calibrator's real behaviour.

`by_rank_band` and gate/bands unchanged (Green 0.5–2.0, Amber 0.33–3.0, Red outside).

---

## 3. Test results

Run (Deno, `--allow-net --allow-env`) against `_shared/keyword-cluster.test.ts`:

```
running 22 tests from ./_shared/keyword-cluster.test.ts
32-inch TV family collapses to a single key ... ok
seven diagnostic false-positive pairs stay distinct ... ok
idempotent ... ok
empty and null-ish inputs return empty string ... ok
pickCanonical: lowest base_rank wins over higher-volume sibling ... ok
pickCanonical: null base_rank sorts last ... ok
pickCanonical: volume tie-break when base_rank equal ... ok
pickCanonical: alphabetical tie-break when rank and volume equal ... ok
pickCanonical: exact '32 inch tv' case from production diagnostic ... ok
pickCanonicalWithBasis: gsc_clicks wins over volume and rank ... ok
pickCanonicalWithBasis: falls back to volume when no gsc clicks ... ok
pickCanonicalWithBasis: falls back to base_rank when no clicks and no volume ... ok
pickCanonicalWithBasis: alphabetical when nothing else discriminates ... ok
pickCanonicalWithBasis: gsc-clicks tie is broken by base_rank ... ok
normaliseExactForm: lower-cases and collapses whitespace, no folding ... ok
55 inch tv fixture: canonical is '55 inch tv' on gsc_clicks basis ... ok
55 inch tv fixture: cluster_volume_annual is MAX = 594000 ... ok
55 inch tv fixture: cluster_base_rank = 11 supplied by '55in tv' ... ok
55 inch tv fixture: cluster_ranking_url = single non-null URL, no conflict ... ok
cluster_url_conflict = true when members carry ≥2 distinct URLs ... ok
cluster_ranking_url = null when all members have null URLs ... ok
cluster_base_rank tie-break: highest annual_volume DESC then keyword ASC ... ok

ok | 22 passed | 0 failed (66ms)
```

All 22 tests green — 8 new (`normaliseExactForm`, 55-inch fixture x4, URL conflict cases x2, tie-break rule), 14 pre-existing unchanged.

---

## 4. Deploy evidence

Deployed at 2026-07-21T09:46:34Z (deploy tool response: “Successfully deployed edge functions: keyword-cluster-recompute, calibration-compute”).

New boot marker embedded in `keyword-cluster-recompute/index.ts:8` and will fire on next cold start:

```
[keyword-cluster-recompute] boot v3 exact-form-canonical + cluster-properties <ISO timestamp>
```

Per instruction, the function was not invoked — no recompute or calibration was run. Boot line will appear the first time an admin triggers it.

---

## 5. Confirmation — `gsc_clicks` now differ between members of `55 inch tv`

Fixture (mirrors §2.2 of `docs/canonical-selection-mechanism-investigation-2026-07-21.md`) — exact-form clicks per member as the new writer computes them:

| Member keyword         | Exact GSC clicks | annual_volume | base_rank |
| ---------------------- | ---------------: | ------------: | --------: |
| **55 inch tv**         |        **2 170** |        43 200 |        14 |
| 55inch tv              |              188 |       594 000 |      NULL |
| tv 55 inch             |              105 |        43 200 |      NULL |
| 55 inch tvs            |               30 |       594 000 |      NULL |
| 55in tv                |               25 |       594 000 |    **11** |
| 55 inch television     |                0 |       594 000 |        18 |
| 55-in tvs              |                0 |       594 000 |        20 |

Test assertions confirmed:
- Canonical member = `55 inch tv` on **`gsc_clicks`** basis (highest exact-form clicks: 2 170 vs 188/105/30/25/0/0).
- `cluster_volume_annual` = **594 000** (MAX across members).
- `cluster_base_rank` = **11**, supplied by member `55in tv` (id `kw-55in-tv`).
- `cluster_ranking_url` = `https://ao.com/tvs/55-inch` (single non-null URL, no conflict).

The old writer aggregated by `normaliseKeyword`, so every one of these seven members would have received the same summed value (`≈2 518`) and tied. With the exact-form key, per-member clicks range from 0 to 2 170 — the ladder now differentiates.

---

## 6. Production state

- No clustering re-run invoked.
- No calibration snapshot computed.
- No data mutations executed this turn beyond the additive migration (which only adds nullable columns; all rows currently hold NULL for the five new fields).
- `calibration-compute` behaves identically to today for existing rows via the `?? canonical own` fallbacks; the cluster-level path activates only after admin next invokes `keyword-cluster-recompute` (out of scope for this task).
