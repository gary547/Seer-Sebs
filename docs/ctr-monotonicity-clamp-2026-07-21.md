# CTR Monotonicity Clamp — Delivery Report

**Date:** 2026-07-21
**Scope:** `supabase/functions/_shared/ctr-resolver-v2.ts`, `_shared/ctr-resolver-v2.test.ts`
**Rule:** After a tier resolves a CTR for rank R in a given (device, intent) context, clamp it so it cannot exceed the resolved CTR for rank R-1 in the same context. Tier order and tier selection are unchanged; underlying `ctr_curves` values are unchanged.

---

## 1. Diff summary

### `supabase/functions/_shared/ctr-resolver-v2.ts`

- Added fields to `CtrResolution`: `clamped: boolean`, `preClampCtr: number`, `preClampCtrPercentage: number`. `tier` continues to record which tier supplied the pre-clamp value.
- Factored the previous `resolve` body into internal `resolveRaw(device, intent, pos)` — unchanged tier ladder (tiers 1..8, tie-break, all/all fallbacks).
- Added `getLadder(device, intent)`: builds a memoised 1..30 array of `CtrResolution` for one context by calling `resolveRaw` at each rank and applying a running non-increasing clamp:
  - `running = Infinity` at rank 1.
  - For each rank R with `tier !== "none"`: if `raw.ctr > running` then `clampedCtr = running` and `clamped = true`; otherwise passthrough. Then `running = min(running, clampedCtr)`.
  - Rows with `tier === "none"` are skipped and do not depress `running`.
- Public `resolve()` now normalises inputs, rounds position with `roundPositionV1`, and returns `ladder[pos]`. Behaviour for null/out-of-range positions is unchanged (`tier: "none"`, `clamped: false`, `preClampCtr: 0`).
- Ladder cache is scoped per `CtrResolver` instance and keyed by `${device}|${intent}` → contexts do not leak.

### `supabase/functions/_shared/ctr-resolver-v2.test.ts`

Added four tests (existing tests untouched):

1. **cross-tier rank-29 generic clamps to rank-20 intent** — rank 20 served by `project_device_intent` at 0.39%, rank 29 only via `project_device_generic` at 1.52%. Asserts clamped ≤ 0.0039, `clamped=true`, `preClampCtr≈0.0152`, `tier="project_device_generic"`.
2. **strictly decreasing single-tier ladder passes through** — 30-rank decreasing ladder; asserts `clamped=false` and `ctr == preClampCtr` at every rank.
3. **clamp only lowers** — spike ladder (r5=20%, r6=5%, r7=30%, r8=2%): asserts r7 clamped to ≤0.05 with `clamped=true`, r5/r6/r8 passthrough with `clamped=false`.
4. **per (device, intent) context, no leakage** — two contexts with different curves; a clamp in `desktop|transactional` does not affect `mobile|informational`.

---

## 2. Test results

Command: `deno test --allow-net --allow-env --allow-read supabase/functions/_shared/ctr-resolver-v2.test.ts`

- 15 passed, 1 failed.
- All four **new clamp tests pass**.
- The single failing test (`position rounding matches v1`) is pre-existing and unrelated to this change: it asserts `roundPositionV1(20.5) === null`, but the function now caps at 30 (per the rank-tail coverage work in the r21–30 ladder extension). Not in this scope.

```
tier 1..8 (existing)                                              ok
metadata surfacing / requestedDevice='all' / intent normalisation ok
clamp: cross-tier rank-29 generic clamps to rank-20 intent        ok
clamp: strictly decreasing single-tier ladder passes through      ok
clamp: only lowers, never raises                                  ok
clamp: per (device, intent) context, no leakage                   ok
position rounding matches v1                                      FAILED (pre-existing, out of scope)
```

---

## 3. Redeploy

Redeployed all edge functions that import `_shared/ctr-resolver-v2.ts`:

- `compute-forecasts-v2`
- `calibration-compute`
- `ctr-curves-from-gsc`

Deploy timestamp: **2026-07-21 10:41:27 UTC**.

Importer set confirmed by:

```
rg -l "ctr-resolver-v2" supabase/functions/
  supabase/functions/_shared/ctr-resolver-v2.test.ts
  supabase/functions/_shared/calibration.test.ts
  supabase/functions/ctr-curves-from-gsc/index.ts
  supabase/functions/ctr-curves-from-gsc/index.test.ts
  supabase/functions/calibration-compute/index.ts
  supabase/functions/compute-forecasts-v2/index.ts
```

---

## 4. TVs Ongoing — clamp impact

**Method.** Loaded all `ctr_curves` rows for project `5fd4df7e-45dd-40c0-b10e-86ea6dad9720` **plus** global fallback rows (`project_id IS NULL`) via a temporary service-role diagnostic function that instantiated the new resolver and enumerated all 15 (device × intent) contexts across ranks 1..30. Counts represent slots where the running-min clamp lowered the pre-clamp value returned by the tier ladder. The diagnostic function was deleted after the run.

**Inputs.** 824 curve rows fetched (project rows + global fallback ladders for r1–30).

**Totals.**

| Metric | Value |
| --- | --- |
| Resolved slots (tier ≠ none) | **450** |
| Slots where clamp lowered value | **137** |
| Clamp incidence | **30.4%** |

**Per-context breakdown.**

| context | slots | clamped |
| --- | ---: | ---: |
| mobile · transactional | 30 | 11 |
| mobile · commercial | 30 | 14 |
| mobile · informational | 30 | 10 |
| mobile · navigational | 30 | 19 |
| mobile · generic | 30 | 0 |
| desktop · transactional | 30 | 8 |
| desktop · commercial | 30 | 11 |
| desktop · informational | 30 | 6 |
| desktop · navigational | 30 | 21 |
| desktop · generic | 30 | 0 |
| all · transactional | 30 | 3 |
| all · commercial | 30 | 11 |
| all · informational | 30 | 4 |
| all · navigational | 30 | 19 |
| all · generic | 30 | 0 |

**Representative clamp events** (pre-clamp → clamped):

- `desktop|transactional` r3: `project_device_intent` 3.89% → **1.42%** (bound by an earlier lower intent value at r2).
- `mobile|commercial` r4: `project_device_generic` 4.28% → **1.30%** (generic tier value exceeded a prior intent tier value; clamped).
- `mobile|transactional` r18: `project_all_intent` 0.69% → **0.39%** (all-device intent fallback higher than a preceding device-specific value; clamped).
- `desktop|navigational` r4–r6: `project_device_generic` values in the 2.6–6.1% range clamped down to **1.38%** (navigational context has no project intent rows, so generic tier drives; running min from earlier ranks holds).
- `mobile|informational` r16: `project_all_intent` 0.67% → **0.50%**.

All generic contexts show **0 clamps** because the tier ladder resolves to a single monotone (PAV-regularised) generic curve at every rank — the clamp only bites when the ladder switches tiers between adjacent ranks and the newly-selected row is higher than the current running minimum.

---

## 5. Guardrails (not changed)

- Tier order (1..8) and selection logic in `resolveRaw` unchanged.
- `ctr_curves` rows unchanged; no migration.
- PAV regularisation in `ctr-curves-from-gsc` unchanged.
- `revenue-v2`, `har-calculation-v2`, `calibration-compute` core arithmetic unchanged — they consume `resolve()` and now see monotone-by-rank CTR values plus the new `clamped` / `preClampCtr` fields for diagnostics.
- Gate criteria, bands, and thresholds unchanged.

## 6. Stop point

Stopped after redeploy. No calibration, clustering, or forecast runs triggered.
