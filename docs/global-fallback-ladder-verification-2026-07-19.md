# Global Fallback CTR Ladder — Verification Report
**Date:** 2026-07-19 (post-migration `20260719184301`)
**Scope:** Read-only. Every figure is queried; SQL is shown alongside.
**Files touched:** none (report + one append to `docs/calculation-v21-programme.md` §north star).

---

## 0. State — TVs Ongoing recent runs

```sql
SELECT id, model_version, status, started_at, finished_at
FROM calc_run_registry
WHERE project_id = '5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
ORDER BY started_at DESC
LIMIT 5;
```

| id | model_version | status | started_at | finished_at |
| --- | --- | --- | --- | --- |
| `413f53d2…` | revenue_v2.1.0 | partial   | 2026-07-19 18:24:54Z | 2026-07-19 18:25:14Z |
| `5161f23b…` | har_v2.1.0     | succeeded | 2026-07-19 18:24:43Z | 2026-07-19 18:24:51Z |
| `0dae210f…` | ctr_v2.0.0     | succeeded | 2026-07-19 17:51:42Z | 2026-07-19 17:52:01Z |
| `0111e73f…` | ctr_v2.0.0     | succeeded | 2026-07-19 15:49:53Z | 2026-07-19 15:50:12Z |
| `2ab7b5a4…` | ctr_v2.0.0     | failed    | 2026-07-19 15:26:29Z | 2026-07-19 15:26:48Z |

**Answer to the ordering question:** A HAR+Revenue pair (`5161f23b` + `413f53d2`) DID run after the CTR provenance-hotfix regeneration `0dae210f` — 33 minutes later. That pair is the successor baseline documented in `docs/first-project-curve-forecast-verification-2026-07-19.md`. No further HAR/Revenue pair has been submitted since the global fallback ladder migration (`20260719184301`, ~18:43Z). This is expected — the ladder change is a resolver-tier restoration; TVs Ongoing does not exercise tiers 5-7 because its project curves already cover the requested slots (see §4).

---

## 1. Resolver citation — tiers 5-7

`supabase/functions/_shared/ctr-resolver-v2.ts` is a **pure module**: it takes pre-fetched `ctr_curves` rows and partitions them into two maps by `is_fallback`. There are no Supabase queries inside the resolver — the tier predicates are in-memory map lookups.

Row partitioning (lines 158-176):
```ts
for (const row of input.curves ?? []) {
  …
  if (row.is_fallback) {
    put(fallbackMap, k, row);
    if (intent === "generic") { fallbackGenericAny.set(rank, row); }
  } else {
    put(projectMap, k, row);
  }
}
```

Tier 5 — `fallback_device_intent` (lines 297-307):
```ts
hit = fallbackMap.get(key(requestedDevice, requestedIntent, pos));
if (hit) {
  return resolutionFor(hit, "fallback_device_intent", …);
}
```

Tier 6 — `fallback_device_generic` (lines 309-321):
```ts
if (requestedIntent !== "generic") {
  hit = fallbackMap.get(key(requestedDevice, "generic", pos));
  if (hit) return resolutionFor(hit, "fallback_device_generic", …);
}
```

Tier 7 — `fallback_generic` (lines 323-333):
```ts
hit = fallbackGenericAny.get(pos);
if (hit) return resolutionFor(hit, "fallback_generic", …);
```

**Do these tiers match rows with `project_id IS NULL AND is_fallback = true`?** Yes — partitioning keys on `is_fallback` only, project_id is not consulted in the fallback branch, so a global row (`project_id IS NULL, is_fallback = true`) lands in `fallbackMap` / `fallbackGenericAny` and matches at tiers 5-7. The caller in `compute-forecasts-v2/index.ts` fetches the pool with `.or('project_id.eq.<id>,is_fallback.eq.true')`, which explicitly picks up global rows (PostgREST treats the second predicate independently of the project filter).

**Guardrail 6 — code change?** None. The resolver was already NULL-tolerant. No `_shared/ctr-resolver-v2.ts` edit; no edge-function redeploy tied to this hotfix (last redeploys were `ctr-curves-from-gsc` ~17:49Z for the provenance hotfix). The only change was the DB migration described in §2.

---

## 2. Migration evidence

**Migration file that inserted the global ladder:** `supabase/migrations/20260719184301_e6a9270b-b4e9-4728-a892-e704ea49e68f.sql`.

Header + representative rows (verbatim from the file):
```sql
-- global fallback ladder — replaces the deleted per-project seed copies;
-- single source, resolver tiers 5-7.
ALTER TABLE public.ctr_curves ALTER COLUMN project_id DROP NOT NULL;
DROP INDEX IF EXISTS public.ctr_curves_project_device_intent_rank_fallback_uq;
CREATE UNIQUE INDEX ctr_curves_project_device_intent_rank_fallback_uq
  ON public.ctr_curves (
    COALESCE(project_id::text, ''), device,
    COALESCE(intent_segment, ''), rank_position, is_fallback
  );

WITH ranks(rank_position, ctr_percentage) AS (
  VALUES (1, 28.0), (2, 15.0), (3, 11.0), …, (20, 0.3)
), devices(device) AS (VALUES ('mobile'), ('desktop'), ('all')),
   intents(intent_segment) AS (
     VALUES ('transactional'), ('commercial'), ('informational'),
            ('navigational'), ('generic'), (NULL))
INSERT INTO public.ctr_curves (project_id, device, intent_segment,
                               rank_position, ctr_percentage, is_fallback)
SELECT NULL, d.device, i.intent_segment, r.rank_position,
       r.ctr_percentage, true
FROM devices d CROSS JOIN intents i CROSS JOIN ranks r
ON CONFLICT DO NOTHING;
```

**Source of the seed values — honest citation.** The plan phrased this as "recover them from the earliest ctr_curves seed migration". The earliest migration (`20260319154448_c19634ae…`, `CREATE TABLE public.ctr_curves` lines 33-40) **does not seed any rows** — it only creates the table. The only in-repo source of a canonical fallback ladder is the `STANDARD_CTR` constant in `supabase/functions/ctr-curves-from-gsc/index.ts` (lines 31-56), which the writer already uses when a bucket has zero measured impressions. Those values (28.0 / 15.0 / 11.0 … 0.3) were reproduced verbatim into the migration; the migration comment names that file as the source of record. No numbers were invented.

**Row counts by device × intent for the global ladder:**
```sql
SELECT device, intent_segment, count(*) AS ranks
FROM ctr_curves
WHERE project_id IS NULL AND is_fallback = true
GROUP BY 1,2 ORDER BY 1,2;
```
Result: 18 buckets × 20 ranks = **360 rows**.

| device  | intent_segment | ranks |
| ------- | -------------- | ----: |
| all     | commercial     | 20 |
| all     | generic        | 20 |
| all     | informational  | 20 |
| all     | navigational   | 20 |
| all     | transactional  | 20 |
| all     | *NULL*         | 20 |
| desktop | (all 6 slots)  | 20 each |
| mobile  | (all 6 slots)  | 20 each |

Sample values — transactional r1-3 (matches `STANDARD_CTR` verbatim):
```sql
SELECT device, rank_position, ctr_percentage FROM ctr_curves
WHERE project_id IS NULL AND is_fallback=true
  AND intent_segment='transactional' AND rank_position IN (1,2,3)
ORDER BY device, rank_position;
```
mobile/desktop/all all read: r1 = **28.0**, r2 = **15.0**, r3 = **11.0**.

**Project-scoped fallback rows across the estate:**
```sql
SELECT count(*) FROM ctr_curves
WHERE project_id IS NOT NULL AND is_fallback = true;
```
Result: **0**. The single global ladder is the only fallback source in the table.

---

## 3. Estate trace — tier `none` unreachable

### Project A — Health And Wellbeing (`09964df8-648d-4976-8f1a-483002f6a5ca`)

```sql
SELECT count(*) FROM ctr_curves
WHERE project_id='09964df8-648d-4976-8f1a-483002f6a5ca';
```
Result: **0** measured/project rows.

Sample keyword (transactional, ranked r3):
```sql
SELECT id, keyword, search_intent, base_rank
FROM keywords WHERE project_id='09964df8-648d-4976-8f1a-483002f6a5ca'
  AND search_intent='transactional' AND base_rank BETWEEN 1 AND 10 LIMIT 1;
```
→ `0d1447d6…` "hydration powder" · intent=transactional · base_rank=3.

Resolver trace (device=`mobile`, intent=`transactional`, position=3):
- Tier 1 project mobile/transactional/r3 — miss (projectMap empty).
- Tier 2 project all/transactional/r3 — miss.
- Tier 3 project mobile/generic/r3 — miss.
- Tier 4 project all/generic/r3 — miss.
- **Tier 5 fallback mobile/transactional/r3 — HIT. `ctr_percentage = 11.0`, tier = `fallback_device_intent`, source = `fallback_static`.**

### Project B — DVD/Bluray (Music Magpie, `e9ff6889-f4dd-46a1-bf57-bd39f713c0ee`)

(There is no project literally named "Music Magpie"; DVD/Bluray is one of Music Magpie's product categories and also has zero `ctr_curves` rows.)

Sample keyword: `d6353048…` "second hand dvds" · transactional · base_rank=1.

Trace (device=`mobile`, intent=`transactional`, position=1):
- Tiers 1-4 all miss (projectMap empty).
- **Tier 5 fallback mobile/transactional/r1 — HIT. `ctr_percentage = 28.0`, tier = `fallback_device_intent`, source = `fallback_static`.**

Tier `none` (tier 8) is unreachable on both projects: the fallback partition is fully populated for every (device × intent × rank ∈ 1..20) triple, so the tier-7 sweep (`fallbackGenericAny.get(pos)`) — and in practice tier 5 before it — always returns a row.

---

## 4. TVs Ongoing non-interference

**(a) Slot with a measured project row — mobile/transactional/r3.**
```sql
SELECT project_id, device, intent_segment, rank_position, ctr_percentage, is_fallback
FROM ctr_curves WHERE project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
  AND device='mobile' AND intent_segment='transactional' AND rank_position=3;
```
Result: `ctr_percentage=0.40`, `is_fallback=false`.

Resolver: tier 1 (`project_device_intent`) hits with **0.40** — the project row. The global seed at mobile/transactional/r3 = 11.0 is never consulted (tier 5 only fires if tiers 1-4 all miss). Non-interference confirmed.

**(b) Slot skipped as empty on TVs Ongoing — desktop/navigational/r10.**

Project's desktop/navigational + desktop/generic rows at any rank:
```sql
SELECT device, intent_segment, rank_position, ctr_percentage
FROM ctr_curves WHERE project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
  AND device='desktop' AND intent_segment IN ('navigational','generic') AND is_fallback=false;
```
Result: only two rows — desktop/navigational r12 (0.54) and r13 (0.08). **No desktop project row at r10; no desktop/generic project rows at any rank.**

Project rows at r10 for `all`-device navigational/generic:
```sql
SELECT device, intent_segment, ctr_percentage
FROM ctr_curves WHERE project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
  AND rank_position=10 AND is_fallback=false
  AND (device='all' AND intent_segment IN ('navigational','generic'));
```
Result: `all / navigational / r10 = 0.06`.

Resolver walk (desktop, navigational, position=10):
- Tier 1 project desktop/navigational r10 — miss.
- **Tier 2 project all/navigational r10 — HIT at 0.06 (`project_all_intent`, `usedAllDeviceFallback = true`).**

Global fallback desktop/navigational r10 = 2.0 (queried) is **not** reached — tier 2 wins first per the ladder order. This is the intended behaviour: the writer skipped desktop/navigational r10 because no measured desktop impressions landed there, but the project's `all`-device curve (which absorbs mixed-device uploads) still provides an honest measured value.

---

## 5. Tracker + Programme north star

The step-4 tracker entry from the ladder migration was written to `docs/calculation-v21-programme.md` under **"Global CTR fallback ladder restored (2026-07-19)"**. Verbatim:

> Cleanup of v1 junk fallbacks in migration `20260719174843` also removed the per-project seed ladders (1,280 rows across 25 projects, pre-delete count logged via `RAISE NOTICE`). Replaced by a single global ladder at `project_id IS NULL, is_fallback = true` (**360 rows**: 3 devices × 6 intent slots × 20 ranks, values sourced verbatim from `STANDARD_CTR` in `supabase/functions/ctr-curves-from-gsc/index.ts`). Per-project fallback copies are retired as an architecture; resolver tiers 5-7 in `_shared/ctr-resolver-v2.ts` are now backed by the global ladder as intended. Caller query (`compute-forecasts-v2` line ~250) already fetches these via `is_fallback.eq.true`; no code change required. Unique index rebuilt on `COALESCE(project_id::text,'')` so global rows cannot duplicate.

The **Programme north star** paragraph has been appended to the same tracker (see §north star at end of file). Every remaining prompt should be measured against that end-state onboarding flow.

---

## Verdict

- Global ladder: **360 rows live** at `project_id IS NULL, is_fallback=true`; per-project fallback rows = **0**.
- Resolver tiers 5-7: **reachable** without code change; NULL-tolerant partitioning confirmed by citation.
- Tier `none` (tier 8): **unreachable** across estate — both zero-curve sample projects resolve at tier 5 with honest seed provenance.
- TVs Ongoing: measured slots still win; empty slots resolve to the closest project curve (tier 2 in the checked sample), not the global seed — confirming the ladder is a genuine floor, not an override.
