# Curve Corruption Forensics — TVs Ongoing mobile/transactional (2026-07-20)

Investigating snapshot `744db4c6-aad4-46df-b4aa-793d755526a7` (Prompt 2.5 final,
overall_ratio = 0.007535 RED). Read-only forensics per the approved plan; a
fence + cleanup + redeploy is applied in the same message.

Project: `5fd4df7e-45dd-40c0-b10e-86ea6dad9720` (TVs Ongoing / AO).

---

## 1. `ctr_curves` timestamp reconstruction

`ctr_curves` has **no timestamp columns** (`id`, `project_id`, `device`,
`rank_position`, `ctr_percentage`, `is_fallback`, `intent_segment` only —
information_schema query). Provenance therefore comes exclusively from the
sibling table `ctr_curve_metadata`, which stamps `generated_at` on every row
the v2 writer emits.

Metadata rollup for the project:

```sql
SELECT c.device, COUNT(*) AS rows,
       COUNT(m.ctr_curve_id) AS with_metadata
  FROM ctr_curves c
  LEFT JOIN ctr_curve_metadata m ON m.ctr_curve_id = c.id
 WHERE c.project_id = '5fd4df7e-…' AND c.is_fallback = false
 GROUP BY 1 ORDER BY 1;
```

| device  | rows | with_metadata |
|---------|-----:|--------------:|
| all     |   83 |            83 |
| desktop |   83 |            83 |
| mobile  |   42 |             0 |

Every metadata row for the project stamps `generated_at = 2026-07-19
19:01:23+00`, `source ∈ { gsc_workbook_all_device, gsc_workbook_per_device }`,
`confidence = high`, sample_impressions 6.29 × 10⁷ (all-device) / 9.59 × 10⁶
(desktop). Not one metadata row exists for `device = 'mobile'`.

Mobile rows therefore did **not** come from `ctr-curves-from-gsc`. That writer
always inserts a `ctr_curve_metadata` companion (see
`supabase/functions/ctr-curves-from-gsc/index.ts` L417 write of curves, L436
write of metadata, in a single transaction).

Their **values** are the second signal: mobile / transactional rows are 0.01,
0.02, 0.10 at ranks 1–20; desktop / transactional rows at the same ranks are
3.89, 3.24, 1.44, 0.83. Two orders of magnitude apart. The mobile values are
consistent with a fraction (0.0094 = 0.94 %) being written into the
percentage-point column and 2-dp rounded to 0.01.

---

## 2. Writer inventory — every `ctr_curves` insert/upsert in the repo

| file:line | writer | unit convention | metadata companion | auto-fired? |
|---|---|---|---|---|
| `supabase/functions/ctr-curves-from-gsc/index.ts` L417 (delete), L436 (insert), L535 (metadata insert) | **v2 canonical.** Uses `STANDARD_CTR` array in percentage-point convention (file header L31, L45, L109). | pp | **yes** | manual only (from `src/pages/admin/CalculationsPage.tsx:490`, "Regenerate CTR curves" button) |
| `supabase/functions/gsc-intent-enrichment/index.ts` L182 (delete), L219 (insert) | **v1 legacy tail. Named as writer of the corrupted rows.** Reads `gsc_upload_keywords.ctr` (**fraction**, e.g. 0.0094) and inserts it as `ctr_percentage` (line 205: `Math.round(median(values) * 100) / 100` — this is 2-dp rounding, not fraction→pp conversion). Always `device='mobile'`. `is_fallback=false`. Never writes a `ctr_curve_metadata` row. | **fraction (bug)** | **no** | **yes** — invoked automatically from `src/components/GscUploadPanel.tsx:214` after every GSC upload, from `src/hooks/useNavigatorSync.ts:552` on nav-sync GSC path, and manually from `src/components/CtrCurveSection.tsx:1024` |
| `src/components/CtrCurveSection.tsx` L468 (copy-from-project insert) | Copies rows verbatim from a sibling project — preserves whatever unit the source used. Not a unit converter. | pass-through | no | no (admin action) |
| `src/components/CtrCurveSection.tsx` L544 (`insertRows`) | Admin-editor manual insertion (accepts values in pp per the `STANDARD_CTR` table displayed in the UI). | pp | no | no (admin action) |
| `src/components/CtrCurveSection.tsx` L400 (`handleClearAll`) | Delete only. | n/a | n/a | no |
| `src/components/CtrCurveSection.tsx` L512 (`deleteExisting`) | Delete only. | n/a | n/a | no |
| `supabase/functions/ctr-benchmark/index.ts` | No `ctr_curves` write. Reads only; used by `CtrCurveSection` L633 to fetch benchmarks. | — | — | — |

Two additional call sites are pure readers, never writers, and are safe:
`compute-forecasts-v2/index.ts:249`, `compute-forecasts/index.ts:43`,
`calibration-compute/index.ts:212`, `CompetitorLandscapeReport.tsx:174`,
`GscUploadPanel.tsx:209` (query invalidation), `KeywordSetupCard.tsx:40`,
`admin/CtrCurvesCard.tsx:87`.

Sole automatic writer that produces metadata-less, fraction-scale rows:
`gsc-intent-enrichment`. `CtrCurveSection` writes are pp-scale and manual.

---

## 3. Timeline 18–20 Jul (project runs vs curve generation)

`calc_run_registry` for the project, `started_at > 2026-07-18`:

```
2026-07-18 23:51 lps_v2.0.0            38165377  ok
2026-07-18 23:52 demand_signals_v1     7851a537  ok
2026-07-18 23:52 har_v2.1.0            0b179746  ok
2026-07-18 23:53 revenue_v2.1.0        4c904f17  partial   ← pre-CTR-fix baseline
2026-07-19 12:34 har_v2.1.0            a8c84ef2  ok
2026-07-19 12:34 revenue_v2.1.0        23930e06  partial
2026-07-19 12:52 har_v2.1.0            020f70bd  ok
2026-07-19 12:53 revenue_v2.1.0        81a76dc5  partial
2026-07-19 15:26 ctr_v2.0.0            2ab7b5a4  FAILED
2026-07-19 15:49 ctr_v2.0.0            0111e73f  ok
2026-07-19 17:51 ctr_v2.0.0            0dae210f  ok
2026-07-19 18:24 har_v2.1.0            5161f23b  ok
2026-07-19 18:25 revenue_v2.1.0        413f53d2  partial   ← first-project-curve baseline
2026-07-19 19:01 ctr_v2.0.0            2f06f121  ok        ← last known-intact CTR write
2026-07-19 19:01 har_v2.1.0            864ce929  ok
2026-07-19 19:02 revenue_v2.1.0        c20b602c  partial   ← regularised-measured baseline
2026-07-20 13:21 har_v2.1.0            6ddacc39  ok
2026-07-20 13:22 revenue_v2.1.0        be83a5e7  partial   ← trend-adjusted baseline (still intact)
2026-07-20 15:26 lps_v2.0.0            5911cc5d  ok
2026-07-20 15:27 demand_signals_v1     2c65a6e8  ok
2026-07-20 15:27 har_v2.1.0            f5af34a7  ok
2026-07-20 15:28 revenue_v2.1.0        3733bf32  partial   ← run consumed CORRUPTED curves
2026-07-20 15:28 calibration snapshot  744db4c6  RED
```

`ctr_curve_metadata.generated_at` for every project curve = `2026-07-19
19:01:23+00`, matching `2f06f121`. No `ctr_v2.0.0` run exists after that
timestamp. Consequently every legitimate curve on the project is the one
written by `2f06f121`, and it covers only `device ∈ {all, desktop}`. The 42
mobile rows we now see were written by a **different** path some time between
19:01 on 2026-07-19 and 15:28 on 2026-07-20.

Edge-function logs for `gsc-intent-enrichment` returned "No logs found" — the
retention window has aged out (~24 h). The audit trail relies on: (a) rows
present, (b) unit convention matching only that writer, (c) no metadata rows
because that writer never writes them, (d) `device='mobile'` hard-coded in
that writer.

The `be83a5e7` (trend-adjusted) baseline ran at 13:22 on 2026-07-20 and read
CTR values from `ctr_curves`. Whether it was already reading corrupted mobile
rows is not directly recorded here (that snapshot's `explanation_json` was
not re-inspected in this report), but the calibration-time run `3733bf32` at
15:28 definitely did — worked pair `24 inch tv` in the prior verification
resolved `ctr.now = 0.0001` (0.01 %), which is exactly the corrupted value.

---

## 4. Named writer + convention

**Writer: `supabase/functions/gsc-intent-enrichment/index.ts` L164–L226.**

Cited defect at L204–L216:

```ts
for (let pos = 1; pos <= 20; pos++) {
  const values = byPos[pos] || [];
  const ctrPct = values.length ? Math.round(median(values) * 100) / 100 : 0;
  if (ctrPct > 0) {
    ctrRows.push({
      project_id,
      rank_position: pos,
      ctr_percentage: ctrPct,       // ← inserts fraction into pp column
      device: "mobile",
      intent_segment: intentSegment,
      is_fallback: false,           // ← competes with v2 project curves
    });
  }
}
```

The `values` array is populated at L165–L172 from `Number(kw.ctr)` where
`kw.ctr` is `gsc_upload_keywords.ctr` — GSC's native decimal fraction
(0.0094 for 0.94 %). The `* 100 / 100` is a 2-dp rounding idiom, not a
percentage-point conversion, so 0.0094 lands as **0.01** in a column read as
"0.01 %". Empirical mobile CTR for `24 inch tv` was 0.94 %; modelled CTR
resolved to 0.01 %. Magnitude match: 94× under-modelling per pair, 130×
overall shortfall.

Aggravating factors:

1. The writer scopes its delete/insert to `device = 'mobile'` and every
   intent segment on the project (L184, L219). Every run overwrites the
   previous mobile curve wholesale. No metadata companion is ever written,
   so the resolver cannot distinguish a corrupted from a healthy row by
   metadata presence — it just resolves the fraction into revenue.
2. The v2 canonical writer `ctr-curves-from-gsc` writes a metadata row for
   every project curve it emits. This is a reliable discriminator for
   orphan cleanup (see §5, applied this turn).

`CtrCurveSection.tsx` was audited: its manual `insertRows` path uses the
`STANDARD_CTR` table (percentage-point convention displayed in the UI) and
its `handleCopyFromProject` is a pass-through — neither introduces a
fraction-scale value on its own. It is not part of the corruption chain.

---

## 5. Orphan audit — every project, every device

```sql
SELECT c.project_id, c.device, COUNT(*) AS orphan_rows
  FROM ctr_curves c
  LEFT JOIN ctr_curve_metadata m ON m.ctr_curve_id = c.id
 WHERE c.is_fallback = false
   AND c.project_id IS NOT NULL
   AND m.ctr_curve_id IS NULL
 GROUP BY 1,2 ORDER BY orphan_rows DESC;
```

| project_id | device | orphan_rows |
|---|---|---:|
| `5fd4df7e-45dd-40c0-b10e-86ea6dad9720` (TVs Ongoing) | mobile | 42 |
| `ce1f52ba-2bc1-4877-8c08-c9d6f8f2e482` | mobile | 32 |

Only two projects carry orphan rows and both clusters are `device='mobile'`,
consistent with `gsc-intent-enrichment` being the sole writer of orphans.
No orphan rows on `desktop` or `all`. Total: 74 rows to delete.

Cleanup applied in the same commit (Part 2 of the plan).

---

## Conclusions

1. Named writer of the corrupted rows: `gsc-intent-enrichment` (evidence:
   fraction-scale values, mobile-only device, absent metadata, hard-coded
   `device='mobile'` and `is_fallback=false` at the insert site).
2. Timeline: corruption written between 2026-07-19 19:01 and 2026-07-20
   15:28; consumed by the `3733bf32` revenue run and by calibration snapshot
   `744db4c6`.
3. `CtrCurveSection.tsx` is not part of the corruption chain — its writes
   are pp-scale and manual. No `source` discriminator column is needed;
   Option A (strip the curve-writing tail from `gsc-intent-enrichment`) is
   viable.
4. All 74 orphan rows can be deleted safely by joining on
   `ctr_curve_metadata` absence, without touching any v2-written row.
