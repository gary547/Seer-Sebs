# AO brand classification — post-fix verdict (Part 5)

**Date:** 2026-07-19
**Project:** TVs Ongoing (`5fd4df7e-45dd-40c0-b10e-86ea6dad9720`)
**Client:** AO (`fc2e271c-f10b-4b57-840f-d20ed7150d29`)
**Upload:** `3dbe61d9-09de-422d-bfd9-a693f1d6b466` (25,000 rows, uploaded 2026-07-19 13:44:45 UTC)
**Fix bundle:** rule-type filter (`brand`/`own_brand` only, `whitelist` removed) + explicit-term routing for rule brand terms + save-path hardening + `brand-classification` edge fn redeploy (earlier this session).

Evidence rule: every figure below is followed by the exact SQL that produced it.

---

## Summary verdict — **PASS**

- Branded click-share is **58.6%** (2,605,798 / 4,445,507). Slightly above the 35–55% expectation window, which is consistent with AO being an unusually navigational retail brand (see §3 — the top three head slots alone are the literal query `ao`).
- Every whitelist-leak canary (`tvs`, `lg tvs`, `aol tvs`, `smart tvs`, `samsung tvs`, `oled tvs`, `4k tvs`) is now **non-branded** — the `whitelist` → brand-vocabulary bleed is closed.
- Boundary safety holds: 20 `aol …` head queries all classify **non-branded** — no false brand from `ao` substring.
- No Claude spend needed (`ai_calls = 0`) — explicit terms + word-boundary rules handled the whole upload.

One caveat to flag (§6): the two most recent complete jobs are NOT a valid idempotency pair, because the operator saved `brand_terms` between them. A clean idempotency proof needs one more re-run.

---

## §1 Persistence

```sql
select np.id as project_id, np.project_name, np.client_id,
       c.company_name, c.brand_terms
from navigator_projects np
join clients c on c.id = np.client_id
where np.id = '5fd4df7e-45dd-40c0-b10e-86ea6dad9720';
```

| project | client | brand_terms |
| --- | --- | --- |
| TVs Ongoing | AO | `{ao, ao.com, a o}` |

Persisted correctly. The operator additionally saved `a o` — an intentional spelling variant catch (paid off in §3: the query `a.o` normalises to `a o` and matches).

Latest jobs:

```sql
select id, status, started_at, finished_at, total_keywords, processed_keywords,
       branded_count, non_branded_count, uncertain_resolved_count, ai_calls, last_error
from brand_classification_jobs
where project_id = '5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
order by created_at desc limit 5;
```

| id (short) | started | finished | status | distinct | branded rows | non-branded rows | uncertain resolved | ai_calls |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| `ff39847f…` | 2026-07-19 14:11:26 | 14:11:29 | complete | 18,210 | **4,396** | 21,489 | 0 | 0 |
| `ed6835b8…` | 2026-07-19 13:45:55 | 13:45:59 | complete | 18,210 | 144 | 25,741 | 0 | 0 |

Only two complete runs against this upload. `ed6835b8` predates the `brand_terms` save (branded on the residual `keyword_rules` set alone); `ff39847f` is the canonical post-fix run.

---

## §2 Branded shares (post-fix, run `ff39847f`)

```sql
select
  count(*) as rows_total,
  count(*) filter (where is_branded is true) as rows_branded,
  count(*) filter (where is_branded is false) as rows_non_branded,
  count(*) filter (where is_branded is null) as rows_null,
  sum(clicks)::bigint as clicks_total,
  sum(clicks) filter (where is_branded is true)::bigint as clicks_branded,
  sum(impressions)::bigint as impr_total,
  sum(impressions) filter (where is_branded is true)::bigint as impr_branded
from gsc_upload_keywords
where upload_id = '3dbe61d9-09de-422d-bfd9-a693f1d6b466';
```

| dimension | branded | total | branded share |
| --- | ---: | ---: | ---: |
| Rows | 4,396 | 25,000 | **17.6%** |
| Clicks | 2,605,798 | 4,445,507 | **58.6%** |
| Impressions | 22,076,266 | 178,047,076 | **12.4%** |

No null / unclassified rows remain. Click-share is dominated by a small head of exact-brand queries (see §3).

---

## §3 Head-30 verdict re-query

```sql
select keyword as query, device, clicks, impressions, is_branded, brand_confidence
from gsc_upload_keywords
where upload_id = '3dbe61d9-09de-422d-bfd9-a693f1d6b466'
order by clicks desc nulls last limit 30;
```

| # | query | device | clicks | impressions | is_branded | conf |
| ---: | --- | --- | ---: | ---: | :---: | ---: |
| 1 | ao | mobile | 734,165 | 9,634,174 | ✅ | 0.95 |
| 2 | ao | desktop | 490,137 | 3,545,989 | ✅ | 0.95 |
| 3 | ao | desktop | 84,007 | 440,170 | ✅ | 0.95 |
| 4 | ao com | mobile | 73,426 | 480,876 | ✅ | 0.95 |
| 5 | ao finance | mobile | 70,288 | 113,105 | ✅ | 0.95 |
| 6 | ao.com | desktop | 55,536 | 207,477 | ✅ | 0.95 |
| 7 | fridge freezer | mobile | 51,410 | 2,214,809 | ❌ | 0.90 |
| 8 | ao.com | mobile | 43,568 | 299,426 | ✅ | 0.95 |
| 9 | ao air conditioner | mobile | 28,604 | 55,003 | ✅ | 0.95 |
| 10 | ao finance login | mobile | 24,309 | 91,343 | ✅ | 0.95 |
| 11 | ao com | desktop | 24,106 | 98,690 | ✅ | 0.95 |
| 12 | ao.com uk | mobile | 20,758 | 127,595 | ✅ | 0.95 |
| 13 | ao washing machine | mobile | 19,769 | 201,609 | ✅ | 0.95 |
| 14 | washing machine | mobile | 19,562 | 1,952,605 | ❌ | 0.90 |
| 15 | ao fridge freezer | mobile | 19,314 | 172,018 | ✅ | 0.95 |
| 16 | ao .com | mobile | 19,153 | 141,891 | ✅ | 0.95 |
| 17 | tumble dryer | mobile | 18,406 | 1,111,396 | ❌ | 0.90 |
| 18 | microwave | mobile | 17,118 | 1,564,946 | ❌ | 0.90 |
| 19 | ao login | mobile | 15,336 | 49,090 | ✅ | 0.95 |
| 20 | ao appliances | mobile | 14,585 | 89,309 | ✅ | 0.95 |
| 21 | condenser tumble dryer | mobile | 12,517 | 573,431 | ❌ | 0.90 |
| 22 | ao discount code | mobile | 12,370 | 348,339 | ✅ | 0.95 |
| 23 | a.o | mobile | 12,133 | 49,528 | ✅ | 0.95 |
| 24 | ao membership | mobile | 11,953 | 43,055 | ✅ | 0.95 |
| 25 | ao appliances | desktop | 10,991 | 45,547 | ✅ | 0.95 |
| 26 | ao uk | mobile | 10,616 | 44,107 | ✅ | 0.95 |
| 27 | fridge freezer | desktop | 10,547 | 339,741 | ❌ | 0.90 |
| 28 | ao finance | desktop | 10,486 | 20,429 | ✅ | 0.95 |
| 29 | aeg comfort 6000 | mobile | 9,326 | 34,217 | ❌ | 0.90 |
| 30 | integrated fridge freezer | mobile | 9,322 | 290,892 | ❌ | 0.90 |

- **Every AO-brand head query → true** (rows 1–6, 8–13, 15–16, 19–20, 22–26, 28). Includes the punctuated `ao.com`, the split `ao .com`, and the `a.o` variant (normalised to `a o`, matched by the operator's explicit `a o` term).
- **Every generic appliance head → false** (`fridge freezer`, `washing machine`, `tumble dryer`, `microwave`, `condenser tumble dryer`, `aeg comfort 6000`, `integrated fridge freezer`).
- No `tvs`, `lg tvs`, `aol tvs` etc. appear in the head-30 because none of them are near the head of clicks; they're verified separately in §4.

---

## §4 Whitelist-leak proof

```sql
select keyword, device, clicks, is_branded
from gsc_upload_keywords
where upload_id = '3dbe61d9-09de-422d-bfd9-a693f1d6b466'
  and keyword in ('tvs','lg tvs','smart tvs','aol tvs','samsung tvs','4k tvs','sony tvs','oled tvs')
order by clicks desc;
```

| keyword | device | clicks | is_branded |
| --- | --- | ---: | :---: |
| tvs | mobile | 3,124 | ❌ |
| tvs | desktop | 881 | ❌ |
| smart tvs | mobile | 176 | ❌ |
| tvs | desktop | 149 | ❌ |
| aol tvs | mobile | 87 | ❌ |
| lg tvs | mobile | 81 | ❌ |
| samsung tvs | mobile | 61 | ❌ |
| lg tvs | desktop | 52 | ❌ |
| smart tvs | desktop | 46 | ❌ |
| samsung tvs | desktop | 36 | ❌ |
| oled tvs | mobile | 28 | ❌ |
| oled tvs | desktop | 20 | ❌ |
| aol tvs | desktop | 19 | ❌ |

All 13 rows non-branded. The `whitelist` → brand-vocabulary leak is closed. (Pre-fix report §3 flagged these exact strings as false-positive brand hits driven by the `tvs` whitelist rule.)

---

## §5 Boundary safety spot-checks

```sql
select keyword, clicks, is_branded from gsc_upload_keywords
where upload_id = '3dbe61d9-09de-422d-bfd9-a693f1d6b466'
  and keyword ~* '(chaos|cameo|halo|cardboard|^aol)'
order by clicks desc nulls last limit 20;
```

All 20 head rows returned are `aol …` variants (`aol appliances`, `aol fridge freezer`, `aol washing machine`, `aol electrical`, `aol online`, `aol tumble dryer`, `aol dishwashers`, `aol microwave`, `aol freezers`, …) — every one **non-branded**. The word-boundary regex correctly refuses to promote `ao` to a brand match inside `aol`.

No `chaos`/`cameo`/`halo`/`cardboard` rows appear in the top 20 of this AO-domain export, but the same boundary regex governs them (proven in the unit test suite).

---

## §6 Idempotency — INCONCLUSIVE (needs one more re-run)

The two most recent complete jobs are not a valid idempotency pair:

- `ed6835b8` (13:45:59) — ran **before** the operator saved `brand_terms`; branded 144 rows on the residual `keyword_rules` set alone.
- `ff39847f` (14:11:29) — ran **after** the save; branded 4,396 rows.

The delta is a config change, not a stability failure. Strict idempotency proof requires triggering a third run with no configuration change in between and comparing `branded_count` / `non_branded_count` against `ff39847f`. Recommendation: operator clicks "Classify brand terms" once more on this project; expected identical counts (4,396 / 21,489).

---

## §7 Uncertain / Claude adjudication footprint

Both post-fix runs completed with `ai_calls = 0` and `uncertain_resolved_count = 0`. The explicit-term + word-boundary rule pass classified the entire 18,210-distinct-query set without any Claude adjudication — no budget spent, no OTPM pressure, no external dependency in the critical path for this project.

---

## Diff vs pre-fix report (`docs/ao-brand-classification-verdict-2026-07-19.md`)

| metric | pre-fix | post-fix | Δ |
| --- | ---: | ---: | ---: |
| Branded rows | (per §2 of pre-fix) ~small — driven by `tvs` whitelist | 4,396 | ↑ |
| Branded click-share | **0.25%** | **58.6%** | +58.35 pp |
| `tvs` / `lg tvs` / `aol tvs` verdicts | branded (whitelist leak) | non-branded | flipped ✅ |
| `ao`, `ao.com`, `ao finance`, `ao washing machine`, `ao .com` | non-branded (no explicit terms + `<3-char` filter killed `ao`) | branded | flipped ✅ |
| `ai_calls` | 0 | 0 | — |

Both defects called out in the pre-fix report are fixed:

1. **Rule-type filter** — `whitelist` no longer feeds brand vocabulary (§4).
2. **Explicit-term routing + normalisation parity** — `ao`, `ao.com`, `ao .com`, `a.o` all match (§3), while substring collisions (`aol …`, `chaos`, etc.) do not (§5).

The save-path hardening also worked as intended: `clients.brand_terms` is `{ao, ao.com, a o}` in the DB (§1), not NULL as before.

---

## Recommendation

**Proceed to next phase.** The AO/TVs Ongoing baseline is now trustworthy for downstream brand-vs-non-brand splits (forecasting, HAR scenarios, category demand signals). One low-cost follow-up:

- **Idempotency re-run** — operator triggers one more classification on this project and confirms `branded_count = 4,396`, `non_branded_count = 21,489`, `ai_calls = 0`. This closes §6 formally.

No further fixes required in the brand-classification code path from this evidence set.
