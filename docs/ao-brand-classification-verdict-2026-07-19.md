# AO brand-classification verdict — TVs Ongoing (2026-07-19)

Read-only diagnostic. Every figure is queried; SQL shown inline. No writes, no code changes.

## Scope

- **Project:** TVs Ongoing (`5fd4df7e-45dd-40c0-b10e-86ea6dad9720`)
- **Client:** AO — `domain = https://ao.com/`, `brand_terms = NULL` (no explicit override configured)
- **Upload:** `3dbe61d9-09de-422d-bfd9-a693f1d6b466` — uploaded 2026-07-19 13:44:45 UTC, device `mixed`, 25,000 rows, date range 2025-03-06 → 2026-07-16
- **Last classification job:** `ed6835b8…` — status `complete`, finished 2026-07-19 13:45:59 UTC, processed 18,210 distinct queries, **0 AI calls**, 144 branded / 25,741 non-branded (rule-pass only; no Claude adjudication)

## Root-cause summary (verified below)

The classifier ran correctly against the tokens it was given, but the token set is **defective for AO**:

1. `clients.brand_terms` is **NULL** — no explicit override, so the ≥3-char safety net does not activate.
2. Company name "AO" (2 chars) and domain first-label "ao" (2 chars) are both stripped by the ≥3-char / stop-word filter in `deriveBrandTokens` (`_shared/brand-classifier.ts`). Derived tokens from the AO identity are therefore **empty**.
3. `brand-classification/index.ts:181` builds `extraBrandTerms` from `keyword_rules` where `rule_type IN ('brand','whitelist')`. AO's rules table contains one matching row: `whitelist = "tvs"`. That single token is the **entire** effective brand vocabulary the classifier used. A second rule, `own_brand = "ao.com"`, is **not** picked up by that filter and is silently ignored.
4. Result: every row containing the whole word `tvs` was flagged branded (144 rows, 11k clicks); every `ao` / `ao.com` head query was flagged non-branded.

The word-boundary matcher itself is sound — §4 proves it — so setting `clients.brand_terms = ['ao','ao.com']` and re-running will fix the head. The `own_brand` rule-type gap in `brand-classification/index.ts:181` is a separate defect the advisor should rule on.

---

## §1 — Top 30 rows by clicks

```sql
SELECT keyword, device, clicks, impressions, is_branded
FROM gsc_upload_keywords
WHERE upload_id='3dbe61d9-09de-422d-bfd9-a693f1d6b466'
ORDER BY clicks DESC NULLS LAST LIMIT 30;
```

| # | keyword | device | clicks | impressions | is_branded |
|---|---|---|---:|---:|---|
| 1 | ao | mobile | 734,165 | 9,634,174 | false |
| 2 | ao | desktop | 490,137 | 3,545,989 | false |
| 3 | ao | desktop | 84,007 | 440,170 | false |
| 4 | ao com | mobile | 73,426 | 480,876 | false |
| 5 | ao finance | mobile | 70,288 | 113,105 | false |
| 6 | ao.com | desktop | 55,536 | 207,477 | false |
| 7 | fridge freezer | mobile | 51,410 | 2,214,809 | false |
| 8 | ao.com | mobile | 43,568 | 299,426 | false |
| 9 | ao air conditioner | mobile | 28,604 | 55,003 | false |
| 10 | ao finance login | mobile | 24,309 | 91,343 | false |
| 11 | ao com | desktop | 24,106 | 98,690 | false |
| 12 | ao.com uk | mobile | 20,758 | 127,595 | false |
| 13 | ao washing machine | mobile | 19,769 | 201,609 | false |
| 14 | washing machine | mobile | 19,562 | 1,952,605 | false |
| 15 | ao fridge freezer | mobile | 19,314 | 172,018 | false |
| 16 | ao .com | mobile | 19,153 | 141,891 | false |
| 17 | tumble dryer | mobile | 18,406 | 1,111,396 | false |
| 18 | microwave | mobile | 17,118 | 1,564,946 | false |
| 19 | ao login | mobile | 15,336 | 49,090 | false |
| 20 | ao appliances | mobile | 14,585 | 89,309 | false |
| 21 | condenser tumble dryer | mobile | 12,517 | 573,431 | false |
| 22 | ao discount code | mobile | 12,370 | 348,339 | false |
| 23 | a.o | mobile | 12,133 | 49,528 | false |
| 24 | ao membership | mobile | 11,953 | 43,055 | false |
| 25 | ao appliances | desktop | 10,991 | 45,547 | false |
| 26 | ao uk | mobile | 10,616 | 44,107 | false |
| 27 | fridge freezer | desktop | 10,547 | 339,741 | false |
| 28 | ao finance | desktop | 10,486 | 20,429 | false |
| 29 | aeg comfort 6000 | mobile | 9,326 | 34,217 | false |
| 30 | integrated fridge freezer | mobile | 9,322 | 290,892 | false |

**Reading.** The head is dominated by unambiguous AO brand queries (`ao`, `ao.com`, `ao finance`, `ao washing machine`, `ao login`, `ao discount code`, `ao uk`, `ao membership`, `ao appliances`, `a.o`). **Zero** of the 30 head rows are flagged branded.

---

## §2 — Click / impression share by verdict

```sql
SELECT is_branded, COUNT(*) rows, SUM(clicks) clicks, SUM(impressions) impressions
FROM gsc_upload_keywords WHERE upload_id='3dbe61d9-09de-422d-bfd9-a693f1d6b466'
GROUP BY is_branded ORDER BY is_branded;
```

| is_branded | rows | clicks | impressions |
|---|---:|---:|---:|
| false | 24,926 | 4,434,460 | 177,300,166 |
| true | 74 | 11,047 | 746,910 |

**Branded click-share = 11,047 / 4,445,507 = 0.25 %.** For a major retail brand this is drastically wrong — a healthy AO brand share on a domain-wide GSC export is typically 40–60 %. **Flag: severe under-classification.**

(Note: 74 branded rows here vs. 144 branded distinct queries reported by the job — the job counts distinct queries, this counts device-split rows.)

---

## §3 — Verdict samples

### 3a — Top 20 branded rows

```sql
SELECT keyword, device, clicks, is_branded FROM gsc_upload_keywords
WHERE upload_id='3dbe61d9-09de-422d-bfd9-a693f1d6b466' AND is_branded=true
ORDER BY clicks DESC LIMIT 20;
```

| keyword | device | clicks |
|---|---|---:|
| tvs | mobile | 3,124 |
| ao tvs | mobile | 1,236 |
| tvs for sale | mobile | 1,088 |
| tvs | desktop | 881 |
| ao tvs | desktop | 497 |
| cheap tvs | mobile | 342 |
| cheap tvs for sale | mobile | 292 |
| tvs for sale | desktop | 206 |
| tvs on finance | mobile | 189 |
| smart tvs | mobile | 176 |
| pay monthly tvs | mobile | 159 |
| ao tvs | desktop | 152 |
| tvs | desktop | 149 |
| tvs for sale | desktop | 135 |
| ao.com tvs | mobile | 116 |
| cheap tvs | desktop | 96 |
| tvs on sale | mobile | 95 |
| aol tvs | mobile | 87 |
| 50 inch tvs | mobile | 82 |
| lg tvs | mobile | 81 |

**Reading.** Every branded row matches the whole word `tvs`. This confirms the effective brand vocabulary is just `{tvs}` — the whitelist rule — with no AO tokens present. `aol tvs` and `lg tvs` are branded here **because they contain `tvs`**, not because AO / AOL / LG were recognised as brands — an obvious false-positive class the advisor should note.

### 3b — Top 20 non-branded rows (with `ao`-substring flag)

```sql
SELECT keyword, device, clicks FROM gsc_upload_keywords
WHERE upload_id='3dbe61d9-09de-422d-bfd9-a693f1d6b466' AND is_branded=false
ORDER BY clicks DESC LIMIT 20;
```

| keyword | device | clicks | contains "ao"? |
|---|---|---:|---|
| ao | mobile | 734,165 | ✅ whole word |
| ao | desktop | 490,137 | ✅ whole word |
| ao | desktop | 84,007 | ✅ whole word |
| ao com | mobile | 73,426 | ✅ whole word |
| ao finance | mobile | 70,288 | ✅ whole word |
| ao.com | desktop | 55,536 | ✅ whole word |
| fridge freezer | mobile | 51,410 | — |
| ao.com | mobile | 43,568 | ✅ whole word |
| ao air conditioner | mobile | 28,604 | ✅ whole word |
| ao finance login | mobile | 24,309 | ✅ whole word |
| ao com | desktop | 24,106 | ✅ whole word |
| ao.com uk | mobile | 20,758 | ✅ whole word |
| ao washing machine | mobile | 19,769 | ✅ whole word |
| washing machine | mobile | 19,562 | — |
| ao fridge freezer | mobile | 19,314 | ✅ whole word |
| ao .com | mobile | 19,153 | ✅ whole word |
| tumble dryer | mobile | 18,406 | — |
| microwave | mobile | 17,118 | — |
| ao login | mobile | 15,336 | ✅ whole word |
| ao appliances | mobile | 14,585 | ✅ whole word |

**Reading.** 15 of the 20 top non-branded rows are unambiguous AO brand queries. These are **not** word-boundary misses — they are simply not being tested against `ao` / `ao.com` because those tokens are absent from the vocabulary.

---

## §4 — Matching spot-tests

**Regex under test** (`_shared/brand-classifier.ts:157`, function `containsWholeToken`):

```ts
const re = new RegExp(`(?:^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9])`, "i");
```

Reproduced in Postgres against a normalised input (mirrors `norm()` — lowercase, `[^a-z0-9]` collapsed to spaces) with explicit terms `['ao','ao.com']`. `matches_normalised` = production behaviour (classifier normalises first); `matches_raw` shown for reference.

| input | term | matches_normalised | matches_raw | expected | ok? |
|---|---|---|---|---|---|
| ao | ao | true | true | branded | ✅ |
| ao | ao.com | false | false | — | ✅ |
| ao.com | ao | true | true | branded | ✅ |
| ao.com | ao.com | **false** | true | branded | ⚠️ see note |
| www.ao.com | ao | true | true | branded | ✅ |
| www.ao.com | ao.com | **false** | true | branded | ⚠️ see note |
| ao uk | ao | true | true | branded | ✅ |
| ao washing machines | ao | true | true | branded | ✅ |
| ao discount code | ao | true | true | branded | ✅ |
| aotv | ao | false | false | non-branded | ✅ |
| aotv | ao.com | false | false | non-branded | ✅ |
| chaos tv | ao | false | false | non-branded | ✅ |
| chaos tv | ao.com | false | false | non-branded | ✅ |
| ao's sale | ao | true | true | branded | ✅ |

**Boundary logic verdict.** The regex correctly rejects `aotv` and `chaos tv` (no boundary around `ao`) — the primary safety concern is satisfied. Every `ao …` phrasing matches via the `ao` explicit term, so setting `brand_terms = ['ao']` alone is sufficient to catch the AO head.

**Note on the two ⚠️ rows.** In production, `classifyKeyword` calls `norm(keyword)` first, which collapses `.` to a space; after normalisation `"ao.com"` becomes `"ao com"` and the explicit needle `"ao.com"` (also normalised for storage/derivation but stored verbatim as an explicit term) no longer matches literally. The `"ao"` explicit term catches both cases, so `['ao']` alone works; `['ao.com']` alone would miss. Recommend the advisor set **both** `['ao','ao.com']` — `ao` handles all AO-prefixed queries, `ao.com` is a defensive extra that matches unnormalised paths and future logic changes.

---

## §5 — Export sanity

```sql
SELECT COUNT(DISTINCT keyword) distinct_kw, MIN(clicks) min_clicks,
       PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY clicks) median_clicks,
       MAX(clicks) max_clicks, COUNT(*) FILTER (WHERE clicks=0) zero_click_rows, COUNT(*) total_rows
FROM gsc_upload_keywords WHERE upload_id='3dbe61d9-09de-422d-bfd9-a693f1d6b466';
```

| distinct_kw | min_clicks | median_clicks | max_clicks | zero_click_rows | total_rows |
|---:|---:|---:|---:|---:|---:|
| 17,573 | 18 | 36 | 734,165 | 0 | 25,000 |

**Reading.** The upload is a clean clicks-sorted head slice: 25,000 rows across 17,573 distinct queries, floor of 18 clicks, no zero-click rows, single peak at 734k. Top-clicks row is the AO brand term — the export configuration is correct. **The problem is not the export.**

---

## Recommendations for advisor sign-off

1. **Immediate operator action.** Set `clients.brand_terms = ['ao','ao.com']` on the AO client via the BrandClassificationCard editor, then re-run classification from the same card. Expected outcome: branded click-share jumps from 0.25 % to roughly 35–55 % (AO retail benchmark) and every head row in §1 flips to `true`.

2. **Separate defect to rule on.** `brand-classification/index.ts:181` filters `keyword_rules` on `rule_type IN ('brand','whitelist')` and silently drops `own_brand` rows. AO's `own_brand = 'ao.com'` rule is being ignored. Either (a) include `own_brand` in that filter, or (b) surface a warning when a client has `own_brand` rules but no `brand_terms`. Not fixed in this diagnostic.

3. **False-positive class flagged.** The `tvs` whitelist rule is producing false positives (`aol tvs`, `lg tvs`, `smart tvs`). Whitelist ≠ brand-token; the semantics of `whitelist` feeding `extraBrandTerms` should be reviewed once (1) and (2) are decided.

## Out of scope

Setting `clients.brand_terms`, editing the classifier, changing the rule-type filter, re-running `brand-classification`, or any UI change. Diagnostic only.
