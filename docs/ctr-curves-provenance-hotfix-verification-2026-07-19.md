# CTR curves — provenance hotfix verification

**Project:** TVs Ongoing (`5fd4df7e-45dd-40c0-b10e-86ea6dad9720`)
**Date:** 2026-07-19
**Scope:** Read-only verification of the post-hotfix regeneration run. No build changes.

---

## 1. Run summary — new `ctr_generation` run

```sql
SELECT id, model_version, status, started_at, finished_at, summary_json
  FROM calc_run_registry
 WHERE project_id = '5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
   AND model_version LIKE 'ctr_v%'
 ORDER BY started_at DESC
 LIMIT 3;
```

| Field | Value |
|---|---|
| Run id | `0dae210f-649c-4053-8be6-7ad40ac128ca` |
| Model version | `ctr_v2.0.0` |
| Status | `succeeded` |
| Started | 2026-07-19 17:51:42 UTC |
| Finished | 2026-07-19 17:52:01 UTC (19s) |
| Upload id | `3dbe61d9-09de-422d-bfd9-a693f1d6b466` |
| Upload source | `gsc_csv_v2` |
| Date range | 2025-03-06 → 2026-07-16 |
| `rows_considered` | 25,000 |
| `rows_used` | 20,269 |
| `branded_excluded_rows` | 4,396 |
| `unclassified_rows` | 0 |
| `devices_built` | `[mobile, desktop, all]` |
| `curves_written` | 15 (buckets), 224 rows total (see per-bucket below) |

Prior successful run `0111e73f-a420-4b73-a08c-3a722912e57b` (15:49 UTC) is the last pre-hotfix baseline retained for §5 comparison.

### 1a. Per-bucket ranks_written / ranks_skipped_empty

Extracted from `summary_json.buckets`.

| Device | Intent | Clicks | Impressions | Written | Skipped | Skipped ranks | Conf |
|---|---|---:|---:|---:|---:|---|---|
| mobile | transactional | 474,296 | 55,414,869 | 19 | 1 | [18] | high |
| mobile | commercial | 34,288 | 2,777,717 | 13 | 7 | [1,4,15,16,18,19,20] | high |
| mobile | informational | 102,690 | 16,326,350 | 17 | 3 | [1,16,20] | high |
| mobile | navigational | 7,948 | 1,277,319 | 9 | 11 | [1,2,4,5,6,15,16,17,18,19,20] | high |
| mobile | generic | 699,357 | 44,200,748 | 20 | 0 | [] | high |
| desktop | transactional | 90,668 | 9,586,140 | 17 | 3 | [1,2,4] | high |
| desktop | commercial | 7,949 | 847,425 | 9 | 11 | [1,4,5,6,10,11,14,15,17,18,19] | high |
| desktop | informational | 14,847 | 3,411,510 | 15 | 5 | [1,2,3,4,6] | high |
| desktop | navigational | 194 | 77,701 | 2 | 18 | [1,2,3,4,5,6,7,8,9,10,11,14,15,16,17,18,19,20] | high |
| desktop | generic | 381,654 | 18,691,577 | 20 | 0 | [] | high |
| all | transactional | 564,964 | 65,001,009 | 20 | 0 | [] | high |
| all | commercial | 42,237 | 3,625,142 | 15 | 5 | [1,4,15,18,19] | high |
| all | informational | 117,537 | 19,737,860 | 19 | 1 | [1] | high |
| all | navigational | 8,142 | 1,355,020 | 9 | 11 | [1,2,4,5,6,15,16,17,18,19,20] | high |
| all | generic | 1,081,011 | 62,892,325 | 20 | 0 | [] | high |

**Sum of ranks_written = 224.** Skipped-slot picture is intuitive: `desktop / navigational` (194 clicks total) is almost entirely empty; `mobile / navigational` and `commercial` are sparse at the head and long tail; the generic and `all / transactional` buckets are full.

Notable head-of-curve skips (previously masked by copy-of-fallback rows):
- `mobile / commercial / r1`
- `mobile / informational / r1`
- `mobile / navigational / r1..r6`
- `desktop / transactional / r1, r2, r4`
- `desktop / commercial / r1`
- `desktop / informational / r1..r4, r6`
- `desktop / navigational / r1..r11, r14..r20`
- `all / commercial / r1`
- `all / informational / r1`
- `all / navigational / r1..r6`

The `desktop / transactional / r1` skip is the exact slot the prior report flagged as still fallback-seeded — now correctly recorded as absent.

---

## 2. Final `ctr_curves` state for TVs Ongoing

```sql
SELECT device, COALESCE(intent_segment,'(null/generic)') AS intent,
       is_fallback, COUNT(*) AS n
  FROM ctr_curves
 WHERE project_id = '5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
 GROUP BY 1,2,3 ORDER BY 1,2,3;
```

All 224 rows are `is_fallback = false`. Zero `is_fallback = true` rows remain. Counts match the per-bucket `ranks_written` totals in §1a exactly.

| Device | Intent | Rows |
|---|---|---:|
| mobile | transactional | 19 |
| mobile | commercial | 13 |
| mobile | informational | 17 |
| mobile | navigational | 9 |
| mobile | generic (null) | 20 |
| desktop | transactional | 17 |
| desktop | commercial | 9 |
| desktop | informational | 15 |
| desktop | navigational | 2 |
| desktop | generic (null) | 20 |
| all | transactional | 20 |
| all | commercial | 15 |
| all | informational | 19 |
| all | navigational | 9 |
| all | generic (null) | 20 |
| **Total** | | **224** |

Confirmation queries:

```sql
SELECT COUNT(*) FROM ctr_curves
 WHERE project_id = '5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
   AND is_fallback = true;
-- → 0   (the 20 v1 desktop/transactional r2=74.17 rows are gone)
```

Measured rows exist **only** where per-bucket impressions > 0 — verified by cross-referencing §1a. No 20-row rectangles; the desktop/navigational bucket has 2 rows because 18 rank slots have zero impressions.

---

## 3. Cross-project cleanup result

```sql
SELECT project_id IS NULL AS is_global, is_fallback, COUNT(*) FROM ctr_curves
GROUP BY 1,2 ORDER BY 1,2;
-- → (is_global=false, is_fallback=false, 256)
```

```sql
SELECT project_id, COUNT(*) FROM ctr_curves GROUP BY project_id ORDER BY 2 DESC;
-- → 5fd4df7e-… TVs Ongoing : 224
-- → ce1f52ba-2bc1-4877-8c08-c9d6f8f2e482 : 32
```

Post-migration state:

- `project_id IS NOT NULL AND is_fallback = true` — **0 rows** (previously 1,280 across 25 projects; all deleted by migration `20260719174843_f0d89e00`).
- `project_id IS NULL  AND is_fallback = true` — **0 rows** (see §4 — advisor-worthy finding).
- `project_id IS NULL  AND is_fallback = false` — 0 rows.

The migration used a `RAISE NOTICE` for the pre-delete count (not persisted to `archive_audit`); the audit query cited in the hotfix plan is the surviving record of "1,280 rows across 25 projects". The programme tracker should carry this figure forward.

---

## 4. Resolver spot-check for an empty slot — **advisor-blocking finding**

Pick `desktop / transactional / r1` — a bucket with 0 impressions on TVs Ongoing, listed as skipped in §1a.

```sql
SELECT * FROM ctr_curves
 WHERE project_id = '5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
   AND device = 'desktop' AND intent_segment = 'transactional'
   AND rank_position = 1;
-- → 0 rows (as expected)
```

Trace through `_shared/ctr-resolver-v2.ts` (lines 253-347):

1. `project_device_intent` (`desktop|transactional|1`) — miss.
2. `project_all_intent` (`all|transactional|1`) — **hit** if `all/transactional/r1` measured row exists. Per §1a, that bucket has 20 written rows, so this tier will resolve first.

For a slot that is empty on *all three* device slices — e.g. `mobile / commercial / r1` (skipped) and `all / commercial / r1` (also skipped per §1a):

1-4. All project tiers miss (both requested intent and generic on the requested device *and* on `all` — but `mobile / generic / r1` is written, so tier 3 (`project_device_generic`) actually **hits** the generic curve. That is by design.

For a slot with no measured coverage anywhere — e.g. `desktop / navigational / r10`:

1-4. All project tiers miss on both `navigational` and `generic` for `desktop` and `all` (both `desktop / generic / r10` and `all / generic / r10` are written — actually generic has full 20 rows for both devices, so tier 3 or 4 **hits** the generic curve).

**In practice, because generic is fully populated on both `mobile` and `desktop`, every empty (device, intent, rank) slot resolves to the project's own generic curve at tiers 3-4 — never reaching the DB-backed fallback tiers 5-7.**

```sql
SELECT COUNT(*) FROM ctr_curves
 WHERE project_id IS NULL AND is_fallback = true;
-- → 0
```

**There are no global fallback seed rows in `ctr_curves`.** Tiers 5-7 of the resolver (`fallback_device_intent`, `fallback_device_generic`, `fallback_generic`) will never fire because the DB has nothing for them to fire on — any slot that gets past tier 4 lands in tier 8 (`none`) with `ctr = 0`.

For TVs Ongoing this is currently benign: project generic curves cover every requested rank. But the hotfix plan assumed a global seed ladder exists. It does not. Consumers other than the writer see fallbacks only via the in-code `STANDARD_CTR` inside the writer; nothing seeds them into the DB for the resolver.

Recommended follow-up for the advisor to rule on:
- Seed `ctr_curves` with a global fallback ladder (`project_id IS NULL, is_fallback = true`) mirroring `STANDARD_CTR` per device / intent / rank, so the resolver's tier ladder has a true safety net for projects whose generic curve is also empty. Not required for TVs Ongoing given full generic coverage, but currently the whole `fallback_*` tier is dead code at read time.

---

## 5. Sanity headline — values unchanged for retained ranks

```sql
SELECT device, COALESCE(intent_segment,'(null)') AS intent, rank_position, ctr_percentage
  FROM ctr_curves
 WHERE project_id = '5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
   AND ((device = 'mobile' AND intent_segment = 'transactional')
     OR (device = 'all'    AND intent_segment IS NULL))
   AND rank_position <= 3
 ORDER BY device, intent, rank_position;
```

| Device | Intent | Rank | This run | Prior run (15:49) |
|---|---|---:|---:|---:|
| mobile | transactional | 1 | 0.31 | 0.31 |
| mobile | transactional | 2 | 0.44 | 0.44 |
| mobile | transactional | 3 | 0.40 | 0.40 |
| all | generic (null) | 1 | 11.72 | 11.72 |
| all | generic (null) | 2 | 6.58 | 6.58 |
| all | generic (null) | 3 | 5.67 | 5.67 |

Exact match. Part 1 changed only which rows are written, not their arithmetic — confirmed for the retained ranks.

---

## Verdict

- Hotfix Part 1 (writer honesty) delivered: empty-bucket ranks are no longer persisted; per-bucket `ranks_written` / `ranks_skipped_empty` are populated in `summary_json`.
- Hotfix Part 2 (junk cleanup) delivered: 0 project-scoped fallback rows remain anywhere in the table.
- Retained measured values are identical to the pre-hotfix run — no arithmetic regressions.
- **Open question flagged in §4:** no global fallback seed rows exist in `ctr_curves`, so the resolver's `fallback_*` tiers are unreachable at read time. Currently masked by full project-generic coverage on TVs Ongoing; needs an advisor ruling on whether to seed the global ladder.
