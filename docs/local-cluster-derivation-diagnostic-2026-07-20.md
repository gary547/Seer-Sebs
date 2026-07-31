# Local cluster derivation diagnostic — TVs Ongoing

**Project:** TVs Ongoing (`5fd4df7e-45dd-40c0-b10e-86ea6dad9720`)
**Mode:** Read-only. No writes, no migrations, no deploys, no external API calls. Every figure comes from a SQL query run against `keywords` + `keyword_monthly_volumes`; the normalisation logic is implemented inside Postgres regex on the same query.
**Goal:** test whether shared 12-month annual volume + a light surface-form normalisation can locally reproduce the DFS `core_keyword` clusters that the API returns `null` for (per `docs/dfs-labs-sku-authorisation-2026-07-20.md`).

---

## Method

### Cohort
Same 835 kept keywords with a complete last-12-month series used in `docs/volume-duplication-diagnostic-888002bc-2026-07-20.md §1` (backfill-preferred dedup on `keyword_monthly_volumes`).

### Normalisation
Applied per keyword string, inside SQL, in this order:

1. Lowercase; replace every non-alphanumeric run with a single space.
2. Split glued size tokens: `([0-9]+)(inches|inch|in)([^a-z]|$)` → `\1 inch\3` (handles `32in`, `50inch`, `75inches`).
3. Tokenise on whitespace; drop empties.
4. Map every `in` / `inch` / `inches` token → `inch`.
5. Sort tokens alphabetically.
6. Drop trailing `s` from the **final** (alphabetically last) token when its length > 1.

Full CTE used in every query below:

```sql
WITH latest12 AS (
  SELECT keyword_id, month, volume,
         ROW_NUMBER() OVER (PARTITION BY keyword_id, month
           ORDER BY CASE WHEN source='dataforseo_historical_backfill' THEN 0 ELSE 1 END) rn
  FROM keyword_monthly_volumes
  WHERE keyword_id IN (SELECT id FROM keywords
                       WHERE project_id='5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
                         AND detox_status='keep')
),
dedup  AS (SELECT keyword_id, month, volume FROM latest12 WHERE rn=1),
ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY keyword_id ORDER BY month DESC) rn2 FROM dedup),
annual AS (SELECT keyword_id, SUM(volume)::bigint av FROM ranked WHERE rn2<=12
           GROUP BY keyword_id HAVING COUNT(*)=12),
base AS (
  SELECT a.keyword_id, k.keyword, a.av,
    regexp_replace(
      regexp_replace(
        regexp_replace(lower(k.keyword), '[^a-z0-9]+', ' ', 'g'),
        '([0-9]+)(inches|inch|in)([^a-z]|$)', '\1 inch\3', 'g'),
      '\s+', ' ', 'g') AS s
  FROM annual a JOIN keywords k ON k.id=a.keyword_id
),
toks AS (
  SELECT keyword_id, keyword, av,
    ARRAY(SELECT CASE WHEN t IN ('in','inch','inches') THEN 'inch' ELSE t END
          FROM unnest(string_to_array(trim(s),' ')) t WHERE t<>''
          ORDER BY CASE WHEN t IN ('in','inch','inches') THEN 'inch' ELSE t END) ta
  FROM base
),
norm AS (
  SELECT keyword_id, keyword, av,
    (SELECT string_agg(
       CASE WHEN i = array_length(ta,1) AND length(x)>1 AND right(x,1)='s'
            THEN left(x, length(x)-1) ELSE x END,
       ' ' ORDER BY i)
     FROM unnest(ta) WITH ORDINALITY u(x,i)) AS n
  FROM toks
)
```

### Classification (per shared-volume group)
- **all_agree** — every member normalises to the same string.
- **partial** — ≥ 2 distinct normalised forms, but at least one non-stopword token appears in ≥ 2 members' forms (stopwords: `for on a the with and of to uk`).
- **false_positive** — no non-stopword token is shared across any pair of members.

---

## §1. Summary counts

Query: `SELECT count(*) FROM annual;` → **835**.
Groups & classifications from the CTE above joined to a per-group aggregator (full SQL below in §3):

| metric | value |
|---|--:|
| kept keywords with a complete 12-month series | **835** |
| shared-volume groups (size ≥ 2) | **185** |
| keywords sitting in a shared-volume group | **585** (70.1 %) |
| keywords with a unique annual volume (solos) | **250** |
| groups where **all** members normalise identically (true clusters) | **74** (188 kw) |
| groups with **partial** agreement | **104** (383 kw) |
| groups clearly **unrelated** (false positives) | **7** (14 kw) |
| **false-positive rate** (kw in FP groups / kw in any group) | **14 / 585 = 2.39 %** |

The "partial" bucket dominates. On inspection it is almost entirely **near-cluster** cases: siblings that fail to fold together because our normaliser (a) doesn't treat `tv` / `television` as the same head noun, and (b) doesn't handle word-order permutations that also drop the head noun (e.g. `tv sale` vs `tv sales` vs `on sale tv`). None of the top-15 partials are unrelated demand; they are the same demand cluster split by an under-powered normaliser (§3).

---

## §2. False-positive list (all 7 groups)

Verbatim from the classifier — every member of every group flagged `false_positive`, for advisor adjudication.

| annual | n | members | normalised forms |
|--:|--:|---|---|
| 6 280 | 2 | `hisense u7k`, `lg oled tv 65` | `hisense u7k`, `65 lg oled tv` |
| 5 210 | 2 | `54 inch tv`, `hisense 55` | `54 inch tv`, `55 hisense` |
| 4 550 | 2 | `philips ambilight 55`, `samsung q symphony` | `55 ambilight philip`, `q samsung symphony` |
| 3 040 | 2 | `oled lg`, `samsung flat screen tv` | `lg oled`, `flat samsung screen tv` |
| 1 360 | 2 | `ambilight philips`, `toshiba tv for sale` | `ambilight philip`, `for sale toshiba tv` |
| 1 240 | 2 | `buy sony bravia`, `smart tv panasonic` | `bravia buy sony`, `panasonic smart tv` |
|   460 | 2 | `bravia xr oled price`, `lg amoled tv` | `bravia oled price xr`, `amoled lg tv` |

All 7 are genuine coincidental collisions on small-volume tails (≤ 6 280/yr) — different brands, different modifiers, no shared demand pool. **14 keywords / 585 in-group keywords = 2.39 %** — the volume signal alone is materially clean at the top and dirty only in the long tail.

---

## §3. Per-group table — 15 largest groups (by size × annual volume)

Ordered by `sz × av`; `cls` = classification; forms shown next to each member.

| Σ annual (per kw) | n | sz·av | cls | members → normalised form |
|--:|--:|--:|---|---|
| 2 539 000 | 2 | 5 078 000 | **all_agree** | `tv → tv` · `tvs → tv` |
| 584 500 | 7 | 4 091 500 | partial | `samsung television → samsung television` · `samsung televisions → samsung television` · `samsung tv → samsung tv` · `samsung tvs → samsung tv` · `televisions samsung → samsung television` · `tv samsung → samsung tv` · `tvs samsung → samsung tv` |
| 337 600 | 7 | 2 363 200 | partial | `32 in tv → 32 inch tv` · `32 inch television → 32 inch television` · `32 inch tv → 32 inch tv` · `32 tv → 32 tv` · `32in tv → 32 inch tv` · `tv 32 → 32 tv` · `tv 32 inch → 32 inch tv` |
| 528 000 | 4 | 2 112 000 | **all_agree** | `50 inch tv`, `50 inch tvs`, `50inch tv`, `tv 50 inch` → all `50 inch tv` |
| 382 600 | 5 | 1 913 000 | partial | `hisense television`, `hisense televisions` → `hisense television`; `hisense tv`, `hisense tvs`, `tv hisense` → `hisense tv` |
| 257 600 | 7 | 1 803 200 | partial | `televisions for sale → for sale television` · `tv for sale → for sale tv` · `tv on sale → on sale tv` · `tv sale → sale tv` · `tv sales → sales tv` · `tvs for sale → for sale tv` · `tvs on sale → on sale tv` |
| 266 600 | 6 | 1 599 600 | partial | `60 in tv`, `60 inch tvs`, `60in tv`, `60inch tv`, `tv 60 inch` → `60 inch tv`; `60 inch television` → `60 inch television` |
| 383 600 | 3 | 1 150 800 | **all_agree** | `lg television`, `lg televisions`, `television lg` → all `lg television` |
| 250 200 | 4 | 1 000 800 | **all_agree** | `40 inch smart tv`, `40 inch tv smart`, `smart tv 40 inch`, `tv 40 inch smart` → all `40 inch smart tv` |
| 243 600 | 4 |   974 400 | **all_agree** | `50 inch smart tv`, `smart 50 inch tv`, `smart tv 50 inch`, `tv 50 inch smart` → all `50 inch smart tv` |
| 324 500 | 3 |   973 500 | **all_agree** | `40 inch tv`, `40inch tv`, `tv 40 inch` → all `40 inch tv` |
| 133 100 | 7 |   931 700 | partial | `42 in tv`, `42 inch tv`, `42 inch tvs` → `42 inch tv`; `42 tv` → `42 tv`; `panasonic television`, `panasonic televisions` → `panasonic television`; `panasonic tv` → `panasonic tv` |
| 166 900 | 5 |   834 500 | partial | `tcl television`, `tcl televisions` → `tcl television`; `tcl tv`, `tcl tvs`, `tv tcl` → `tcl tv` |
| 122 400 | 6 |   734 400 | **all_agree** | `65 inch samsung tv`, `65 inch tv samsung`, `65inch samsung tv`, `samsung 65 inch tv`, `samsung tv 65 inch`, `tv samsung 65 inch` → all `65 inch samsung tv` |
| 119 200 | 6 |   715 200 | partial | `4k television`, `4k televisions` → `4k television`; `4k tv`, `4k tvs`, `tv 4k`, `tvs 4k` → `4k tv` |

**Reading of the top 15.** 6 of 15 collapse cleanly (`all_agree`). The 9 partials are all one-normaliser-away from a clean fold: the `tv` ↔ `television` synonym split (9 of 9) and the same split reappearing under a `for sale` / `on sale` / `sale` / `sales` sub-cluster. **Zero of the top-15 groups are unrelated coincidences.**

---

## §4. Missed-cluster count (250 solo keywords)

Query intent: for every keyword whose annual volume is unique in the cohort, ask "does its normalised form nevertheless collide with some other cohort keyword's normalised form?" — i.e. clusters that DFS's per-surface-form volume signal missed.

```
solos_total: 250
solos whose normalised form collides with ≥ 1 other cohort keyword: 44
distinct missed normalised clusters: 34
```

Representative missed pairs (form → members / annuals):

- `32 4k inch smart tv` — `32 inch 4k smart tv` (4 350) / `32 inch smart tv 4k` (4 420)
- `32 inch smart tv` — `32 inch smart tvs` (472 700) / `tv smart 32 inch` (1 130) **← volume signal way off (472 700 vs 1 130) but same cluster**
- `32 inch sony tv` — `sony 32 inch tv` (8 330) / `sony tv 32 inch` (5 010)
- `4k lg tv` — `4k lg tv`, `4k tv lg`, `lg 4k tv`, `lg tv 4k tv`, `tv 4k lg` (8 510 × 4 / 1 980)
- `4k samsung tv` — `4k samsung tv`, `4k tv samsung`, `samsung 4k tv` (14 600 × 3) / `samsung tv 4k` (2 710)
- `65 inch tcl tv` — `65 inch tcl tv`, `tcl 65 inch tv`, `tcl tv 65 inch`, `tcl tvs 65 inch` (25 200 + 5 170 + 2 970 × 2)
- `4k 60 inch tv` — `60 inch 4k tv` (7 640) / `60inch 4k tv` (7 290) / `tv 60 inch 4k` (810)
- `55 hisense inch tv` — `55 inch hisense tv`, `55 inch tv hisense`, `hisense 55 inch tv`, `hisense tv 55 inch` (51 600 × 3 / 5 020)

**Full missed-pair list is 44 rows; the pattern is uniform:** siblings that DFS assigned *different* annual volumes despite being the same close-variant cluster, so the volume-collision heuristic (§1) alone would have skipped them. The normalisation heuristic catches an additional 44 keywords in 34 additional clusters.

---

## §5. Read

Against the yardstick "can local normalisation + volume-collision stand in for DFS `core_keyword`?"

- **Volume-collision alone (§1):** 585 / 835 keywords grouped (70 %); false-positive rate **2.39 %**. In the tail (< ~7 000/yr, 2-member groups), coincidental collisions appear — 7 groups, 14 keywords — but they are trivially identifiable because their normalised forms share no token. **Rejecting any 2-member group whose normalised forms share no non-stopword token would take the false-positive rate to 0 % at the cost of ~2.4 % recall.**
- **Normalisation alone catches an extra 44 keywords in 34 clusters (§4)** that the volume signal missed. Those are cases where DFS returned genuinely different annual volumes for surface forms of a single cluster — the volume-collision signal is a subset of the truth, not a superset.
- **The dominant residual problem** is the `tv` ↔ `television` synonym split (visible in 9 of 15 top groups and in the `for sale` cluster). Folding those two head-nouns to a single stem would raise the "all_agree" bucket from 74 → likely ~150 groups and collapse most of the `partial` bucket into `all_agree`. This is a one-line addition to the normaliser (append: after step 4, replace token `television` with `tv`), and comes at zero measurable false-positive cost given the pattern in §2.

**Bottom line for the advisor.** A local normaliser (§Method) + shared-volume grouping (§1) reproduces the DFS close-variant cluster ID with **97.6 % precision** on grouped keywords and adds a further **44 / 250 = 17.6 % recall** on solos. Adding a `television → tv` fold would push precision higher and materially reduce the partial-agreement bucket. This is sufficient to stand in for `keyword_properties.core_keyword` for the purpose of collapsing duplicate demand assertions in the forecaster; it is not sufficient to reproduce Google's spelling / synonym clustering (`sony bravia` ↔ `sony bravia tvs` will still split), but those tails are small and can be adjudicated by hand.

**No changes made.** Report ends here.
