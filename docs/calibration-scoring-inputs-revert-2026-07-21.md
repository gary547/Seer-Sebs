# Calibration scoring inputs — revert to canonical-own volume and rank

**Date:** 2026-07-21
**File touched:** `supabase/functions/calibration-compute/index.ts` (only)
**Scope:** revert scoring inputs; keep canonical selection and cluster metadata unchanged.

---

## Why

Snapshot `33997b73-2b87-44d8-a235-2541428a433b` tested cluster-level MAX volume and MIN rank as calibration scoring inputs. It regressed:

| metric        | prior (`908ef33d`) | tested (`33997b73`) |
|---------------|-------------------:|--------------------:|
| overall_ratio | 1.0253 (green)     | 2.3728 (amber, FAIL)|
| green share   | 49.5 %             | 37.7 %              |

Canonical-own volume and base_rank are the empirically calibrated choice. Cluster-level fields remain informational in the `pairs_scored` ledger.

## Diff

`supabase/functions/calibration-compute/index.ts`, lines 433–454 (pre-edit):

```ts
// Cluster-level inputs for canonical scored pairs. When populated they
// describe the whole cluster's demand pool and best rank (see
// keyword-cluster-recompute v3). Non-canonical/model-blind branches
// never reach here (isCanonical guard below / rank-null continue above).
const canonicalOwnVolume = va.volume_annual;
const canonicalOwnBaseRank = Number(rank);
const clusterVolumeAnnual = kw.cluster_volume_annual != null
  && Number.isFinite(Number(kw.cluster_volume_annual))
  && Number(kw.cluster_volume_annual) > 0
    ? Number(kw.cluster_volume_annual)
    : null;
const clusterBaseRank = kw.cluster_base_rank != null
  && Number.isFinite(Number(kw.cluster_base_rank))
    ? Number(kw.cluster_base_rank)
    : null;

const volumeAnnualUsed = (isCanonical && clusterVolumeAnnual != null)
  ? clusterVolumeAnnual
  : (canonicalOwnVolume == null ? null : Number(canonicalOwnVolume));
const rankUsed = (isCanonical && clusterBaseRank != null)
  ? clusterBaseRank
  : canonicalOwnBaseRank;
```

Post-edit:

```ts
// Scoring inputs use canonical-own volume and base_rank. Cluster-level
// MAX volume / MIN rank were tested in snapshot 33997b73 and regressed
// calibration overall ratio 1.0253 → 2.3728, green share 49.5% → 37.7%.
// Canonical-own inputs are the empirically calibrated choice; cluster_*
// fields (cluster_volume_annual, cluster_base_rank, cluster_base_rank_keyword_id,
// cluster_url_conflict) remain informational in the pairs_scored ledger.
const canonicalOwnVolume = va.volume_annual;
const canonicalOwnBaseRank = Number(rank);

const volumeAnnualUsed = canonicalOwnVolume == null ? null : Number(canonicalOwnVolume);
const rankUsed = canonicalOwnBaseRank;
```

## Retained ledger fields (unchanged)

The `pairs_scored` writer still emits, per canonical pair: `cluster_volume_annual`, `cluster_base_rank`, `cluster_base_rank_keyword_id`, `canonical_own_volume`, `canonical_own_base_rank`, `cluster_url_conflict`. They stay informational.

## Not changed

`keyword-cluster-recompute`, `_shared/keyword-cluster.ts`, canonical selection ladder, normaliser, `cluster_*` column writes, forecasting maths, CTR/volume resolvers, curve building, gate criteria, band thresholds.

## Test results

`cd supabase/functions && deno test _shared/calibration.test.ts --allow-all`

```
running 23 tests from ./_shared/calibration.test.ts
... all 23 tests: ok
ok | 23 passed | 0 failed (44ms)
```

## Redeploy

- Function: `calibration-compute`
- Deploy result: `Successfully deployed edge functions: calibration-compute`
- Timestamp (UTC): **2026-07-21 10:20:39**

## Stop point

No clustering or calibration re-run performed. Awaiting operator instruction.
