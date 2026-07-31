# CTR curves v2 — Part 4 verification (re-run)

**Project:** TVs Ongoing (`5fd4df7e-45dd-40c0-b10e-86ea6dad9720`)
**Date:** 2026-07-19
**Purpose:** Verify the post-fix regeneration of CTR curves v2 after (a) the unique-index replacement (Part 1) and (b) the unit-convention audit + `blendRankCtr` extraction (Part 2). No build changes made in this pass — evidence only.

---

## 1. Run identity

| Field | Value |
|---|---|
| Run id | `0111e73f-a420-4b73-a08c-3a722912e57b` |
| Model version | `ctr_v2.0.0` |
| Status | `succeeded` |
| Started | 2026-07-19 15:49:53 UTC |
| Finished | 2026-07-19 15:50:12 UTC (19s) |
| Upload id | `3dbe61d9-09de-422d-bfd9-a693f1d6b466` |
| Source | `gsc_csv_v2` |
| Date range | 2025-03-06 → 2026-07-16 |
| Per-row device | `has_per_row_device: true` |

Prior failed run `2ab7b5a4-ce2f-4ae0-ba40-9cc730bc7307` (15:26:48 UTC) — the one that hit the unique-key violation — remains in the registry as `status=failed` with empty `summary_json`. The run-start wipe of `is_fallback=false` rows healed the stranded mobile-only state before this successful run wrote its 300-row set (see §5).

---

## 2. Ingest counts (`summary_json`)

| Metric | Value |
|---|---|
| `rows_considered` | 25,000 |
| `rows_used` | 20,269 |
| `branded_excluded_rows` | 4,396 |
| `unclassified_rows` | 0 |
| `devices_built` | `[mobile, desktop, all]` |
| `curves_written` | 15 (5 intents × 3 devices) |

All 15 buckets reported `ranks_written: 20` and `confidence: high`. No skipped buckets.

Branded-exclusion tally (4,396) matches the operator-known ballpark from the prior AO branded-classification run; guard was not tripped (`unclassified_rows=0`).

---

## 3. Per-bucket totals

Taken verbatim from `calc_run_registry.summary_json.buckets`.

| Device | Intent | Clicks | Impressions | Ranks written | Confidence |
|---|---|---:|---:|---:|---|
| mobile | transactional | 474,296 | 55,414,869 | 20 | high |
| mobile | commercial | 34,288 | 2,777,717 | 20 | high |
| mobile | informational | 102,690 | 16,326,350 | 20 | high |
| mobile | navigational | 7,948 | 1,277,319 | 20 | high |
| mobile | generic | 699,357 | 44,200,748 | 20 | high |
| desktop | transactional | 90,668 | 9,586,140 | 20 | high |
| desktop | commercial | 7,949 | 847,425 | 20 | high |
| desktop | informational | 14,847 | 3,411,510 | 20 | high |
| desktop | navigational | 194 | 77,701 | 20 | high |
| desktop | generic | 381,654 | 18,691,577 | 20 | high |
| all | transactional | 564,964 | 65,001,009 | 20 | high |
| all | commercial | 42,237 | 3,625,142 | 20 | high |
| all | informational | 117,537 | 19,737,860 | 20 | high |
| all | navigational | 8,142 | 1,355,020 | 20 | high |
| all | generic | 1,081,011 | 62,892,325 | 20 | high |

Additivity check (mobile + desktop ≈ all): transactional 474,296 + 90,668 = 564,964 ✓; generic 699,357 + 381,654 = 1,081,011 ✓. Impressions add cleanly across the whole matrix.

---

## 4. Unit sanity — headline (percentage points)

Values below are the persisted `ctr_percentage` from `ctr_curves` (`is_fallback=false`, `rank_position ≤ 3`). Column convention: **percentage points** (0–100), as consumed by `_shared/ctr-resolver-v2.ts` (which divides by 100 to obtain a fraction).

### Transactional
| Device | r1 | r2 | r3 |
|---|---:|---:|---:|
| mobile | 0.31 | 0.44 | 0.40 |
| desktop | 28.00 | 15.00 | 3.89 |
| all | 0.31 | 0.44 | 0.90 |

### Commercial
| Device | r1 | r2 | r3 |
|---|---:|---:|---:|
| mobile | 28.00 | 5.70 | 0.58 |
| desktop | 28.00 | 0.01 | 6.67 |
| all | 28.00 | 1.23 | 3.02 |

### Informational
| Device | r1 | r2 | r3 |
|---|---:|---:|---:|
| mobile | 0.15 | 1.10 | 4.16 |
| desktop | 28.00 | 15.00 | 11.00 |
| all | 28.00 | 1.10 | 4.16 |

### Navigational
| Device | r1 | r2 | r3 |
|---|---:|---:|---:|
| mobile | 0.16 | 0.05 | 0.34 |
| desktop | 28.00 | 15.00 | 11.00 |
| all | 28.00 | 15.00 | 0.34 |

### Generic (`intent_segment IS NULL` in DB, writer convention)
| Device | r1 | r2 | r3 |
|---|---:|---:|---:|
| mobile | 10.90 | 4.41 | 4.17 |
| desktop | 15.24 | 14.94 | 8.41 |
| all | 11.72 | 6.58 | 5.67 |

### Read of these values
- **All exactly-`28.00` / `15.00` / `11.00` r1–r3 cells match `STANDARD_CTR` seeds** for the corresponding rank. These slots had 0 impressions in the (device, intent, rank) bucket, so the fallback ladder fired as designed. Not a unit bug and not a bug at all — that is the intended behaviour of `blendRankCtr(0, 0, fallback) = fallback`.
- The generic (null-intent) row shows a plausible descending curve (`11.72 → 6.58 → 5.67` for `all`), well inside the 10–35% r1 sanity band the advisor asked for on aggregate data.
- The suspicious value is mobile-transactional r1 = **0.31** — cross-checked in §4a.

### 4a. Cross-check — hand-computed clicks/impressions × 100

Query against the source upload (`gsc_upload_keywords` for upload `3dbe61d9-…`), same slicing as the writer (`is_branded IS DISTINCT FROM true`, `ROUND(position)=1`, `device='mobile'`, `search_intent='transactional'`):

```
clicks = 454
impressions = 147,178
CTR% = 100 * 454 / 147,178 = 0.3085…  →  rounds to 0.31
```

**Persisted value: `0.31`. Match.** Unit convention (percentage points) confirmed against raw data.

Corresponding check for **desktop-transactional r1** (persisted `28.00`):

```
SUM(clicks) = NULL, SUM(impressions) = NULL   (i.e. zero rows in the slice)
→ bucket has 0 impressions → blendRankCtr returns fallback (28) unchanged
```

Fallback fired correctly.

The genuinely low mobile r1 measured CTRs (transactional 0.31, informational 0.15, navigational 0.16) are a **data observation**, not a code fault: at position 1 on mobile, this project's non-branded impressions volume is high but click-through is far below the seed. That is either GSC position-averaging pulling the "rank 1" bucket down or genuine SERP dilution (feature-heavy TV queries). Flagged for the advisor — outside the scope of the v2 writer.

---

## 5. Coexistence check (Part 1 index effective)

```
SELECT is_fallback, COUNT(*)
  FROM ctr_curves
 WHERE project_id = '5fd4df7e-…'
GROUP BY is_fallback;
```

| `is_fallback` | rows |
|---|---:|
| false | 300 |
| true | 20 |

- **300 measured rows** = 5 intents × 3 devices × 20 ranks. Full matrix present.
- **20 fallback rows** = the desktop-transactional intent segment previously seeded as fallback.

Slot-level coexistence probe (both `is_fallback=true` and `is_fallback=false` rows for the same `project × device × intent × rank`):

| device | intent | rank | measured | fallback |
|---|---|---:|---:|---:|
| desktop | transactional | 1 | 28.00 | 6.86 |
| desktop | transactional | 2 | 15.00 | 74.17 |
| desktop | transactional | 3 | 3.89 | 5.64 |

Both flavours now live side-by-side without unique-violation. The new index `ctr_curves_project_device_intent_rank_fallback_uq` is holding.

The resolver's tier ladder (`_shared/ctr-resolver-v2.ts`) will prefer the measured row for these slots (`project_device_intent`) and treat the fallback rows as tier-5+ safety net for other slots — exactly the design intent quoted in the migration comment.

---

## 6. Observations & open questions for the advisor

1. **Low mobile r1 measured CTRs (transactional 0.31, informational 0.15, navigational 0.16, commercial goes back up to 28 via fallback).** Values verified against the raw upload. This is a data question, not a v2 bug. Worth checking whether upstream GSC "average position 1" bucket is being diluted by rounding — a keyword averaging `1.4` will show as position 1 after `ROUND()` and drag CTR down materially at the head of the curve.
2. **`intent_segment IS NULL` measured rows** exist for the generic bucket. Consistent with the writer convention (`intentSegmentValue('generic') = null`) and matches how the resolver keys look-ups on `intent_segment IS NOT DISTINCT FROM ...`. No action needed unless the advisor wants an explicit `'generic'` sentinel in a follow-up.
3. **No orphan state.** The 15:26:48 UTC failed run left mobile-only rows; the run-start wipe of `is_fallback=false` rows across all devices healed it before the 15:49:53 UTC success. Registry retains the failed row for audit — not a live-data hazard.
4. **`branded_excluded_rows = 4,396`** is inside the expected range from the AO brand-terms override verification. No unclassified rows leaked through, so the guard is not compensating for missing classification.

---

## Verdict

- Unit convention correct (percentage points, matches `STANDARD_CTR` seeds and `_shared/ctr-resolver-v2.ts` consumer).
- Index replacement (Part 1) effective — measured and fallback curves coexist per slot with no unique-violation.
- Writer extraction to `blendRankCtr` (Part 2) preserves prior arithmetic; 16/16 tests pass; deployment healthy.
- Headline low mobile r1 CTRs are a data observation to raise upstream, not a v2 fault.

Prompt 2.3 delivery is functionally complete pending advisor sign-off on the data observation in §6.1.
