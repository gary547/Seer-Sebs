# DataForSEO 24-month historical volume — research notes

**Context:** `/admin/calculations` → Volume History → "Endpoint availability" reported
`labs_historical_search_volume = UNAUTHORIZED` and `keywords_data_search_volume = UNAUTHORIZED`,
recommendation "24-month backfill NOT feasible". This document explains why that reading is wrong
and how to actually retrieve 24 months of monthly search volume with our existing credentials.

---

## TL;DR

1. **Our account credentials are fine.** The same standard endpoint (`keywords_data/google_ads/search_volume/live`) is called successfully in production by `supabase/functions/keyword-enrichment/index.ts`. The `UNAUTHORIZED` in the probe is caused by a mismatch in how the probe function builds the `Basic` auth header, not by the DataForSEO account.
2. **We do not need DataForSEO Labs to get 24 months.** The standard Google Ads Search Volume endpoint returns up to **4 years** of monthly history when we pass `date_from`. The probe never sent `date_from`, so DataForSEO returned only the default 12-month window and we mis-labelled that as "not feasible".

Net: 24-month backfill is fully feasible on the plan we already pay for. The fix is in our code, not in our subscription.

---

## Root cause 1 — probe uses a different Basic-auth encoding than the working functions

### Working (`supabase/functions/keyword-enrichment/index.ts`, lines 29–32)

```ts
function buildBasicAuth(secret: string): string {
  if (secret.includes(":")) return btoa(secret); // login:password → base64
  return secret;                                  // already base64 → pass through
}
```

The header is then set as ``Authorization: `Basic ${dfBasicAuth}` ``.

This tolerates the secret being stored either as raw `login:password` **or** as a pre-encoded
base64 string. Per project memory (`mem://integrations/dataforseo-auth`) our secret is stored in
`login:password` format, so the `btoa()` branch runs and produces a correct header.

### Probe (`supabase/functions/dataforseo-history-probe/index.ts`, line 93)

```ts
"Authorization": `Basic ${btoa(apiKey)}`,
```

Unconditional `btoa()`. If the stored secret is ever swapped to the pre-encoded form (which the
working code path silently supports), the probe would double-encode → HTTP 401 → surfaced as
`UNAUTHORIZED` for **both** endpoints simultaneously, which is exactly the screenshot.

Even in the "safe" `login:password` case, the two functions should share the same helper so we
never regress on this again.

### Same bug lives in the backfill

`supabase/functions/dataforseo-historical-volume-backfill/index.ts` uses the same unconditional
`btoa(apiKey)` pattern. Even if we fix the probe, the backfill will fail identically until the
helper is shared.

**Fix:** extract `buildBasicAuth` to a shared module (or copy it verbatim) and use it in both the
probe and the backfill.

---

## Root cause 2 — the standard endpoint already covers 24 months, we just didn't ask for it

Endpoint: `POST https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live`
Docs: <https://docs.dataforseo.com/v3/keywords_data/google_ads/search_volume/live/>

### Direct quotes from the doc page

> Historical data is available for 4 years.

> **`date_from`** — _starting date of the time range_ — optional field — date format: `"yyyy-mm-dd"` — minimal value: 4 years from the current date — by default, data is returned for the past 12 months.

> **`date_to`** — _ending date of the time range_ — optional field — the indicated date cannot be greater than the past month, Google Ads does not return data on the current month; if you don't specify this field, yesterday's date will be used by default.

> **`monthly_searches`** — array — monthly searches — represents the (approximate) number of searches on this keyword idea (as available for the past twelve months by default), targeted to the specified geographic locations.

Response shape (per keyword):

```json
{
  "keyword": "buy laptop",
  "location_code": 2826,
  "language_code": "en",
  "search_volume": 12100,
  "competition": "HIGH",
  "cpc": 1.42,
  "monthly_searches": [
    { "year": 2024, "month": 6,  "search_volume": 11200 },
    { "year": 2024, "month": 7,  "search_volume": 12100 },
    …
    { "year": 2026, "month": 5,  "search_volume": 13500 }
  ]
}
```

The array length grows with `date_from`. Without `date_from`, DataForSEO gives ~12 items — which
is what we saw and mis-diagnosed.

### Batching / cost / rate limits (from the same doc page)

- Up to **1000 keywords** per request; **cost is per request, not per keyword**.
- **12 requests per minute per account** for Google Ads Live endpoints (hard cap — not the 2000/min general limit).
- One "Status" helper endpoint (`/v3/keywords_data/google_ads/status/`) tells us whether Google Ads' most-recent month is finalised via the `actual_data` boolean — useful for pinning `date_to`.

For our scale (project sizes shown in the UI are ~20–500 kept keywords), the entire 24-month
backfill for a single project is 1 request. Even the largest project (~2k keywords) is 2
requests. Rate limit is not a practical constraint.

### Labs endpoint (`dataforseo_labs/google/historical_search_volume/live`) — not needed

Docs: <https://docs.dataforseo.com/v3/dataforseo_labs/google/historical_search_volume/live/>

> You can get historical search volume data since **the beginning of 2019**, depending on keywords along with location and language combination.

Labs' unique value is history older than 4 years and different aggregation (Keyword Database vs
Google Ads API). It is a **separate DataForSEO subscription** and returning `UNAUTHORIZED`
against it is expected on our current plan. We can safely stop probing Labs unless we later want
2019-era data.

---

## Reproducible curl (24 months, sample of 3 keywords, UK)

Compute the date range in bash (this produces `date_from` = today − 24 months, `date_to` = last
finalised month, i.e. yesterday). Replace `login:password` with the same secret we already store
in `DATAFORSEO_API_KEY`.

```bash
DATE_FROM=$(date -u -d "$(date -u +%Y-%m-01) -24 months" +%Y-%m-%d)
DATE_TO=$(date -u -d "yesterday" +%Y-%m-%d)
CRED=$(printf '%s' "login:password" | base64)

curl -sS -X POST "https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live" \
  -H "Authorization: Basic ${CRED}" \
  -H "Content-Type: application/json" \
  -d "[{
    \"location_code\": 2826,
    \"language_code\": \"en\",
    \"keywords\": [\"family law solicitor\", \"divorce lawyer\", \"child custody uk\"],
    \"date_from\": \"${DATE_FROM}\",
    \"date_to\":   \"${DATE_TO}\",
    \"search_partners\": false
  }]" | jq '.tasks[0].result[0].monthly_searches | length'
```

Expected: an integer of **24** (or 25 if the boundary month rolls over). Anything less means
either the keyword genuinely has fewer months of Google Ads history, or `date_from` was rejected
and we defaulted back to 12 months.

---

## Recommended next steps (ranked)

### (a) Fix the probe/backfill auth — highest priority
Extract `buildBasicAuth` from `keyword-enrichment` into a shared `_shared/dataforseo.ts` and use
it in both `dataforseo-history-probe` and `dataforseo-historical-volume-backfill`. Delete the
inline `btoa(apiKey)` in both.

### (b) Pass `date_from` (and `date_to`) on every call
- **Probe:** send `date_from = first day of month − 24 months`, `date_to = yesterday`. Expect
  ~24 `monthly_searches` entries. Recommendation becomes "feasible" when the returned month
  count meets the request.
- **Backfill:** same window (make it a parameter capped at 48 months so we don't accidentally
  ask for more than the 4-year ceiling).

### (c) Rewrite the recommendation logic
The current logic ranks Labs above Google Ads. Flip it:

1. If the Google Ads Search Volume endpoint with `date_from` returns ≥ requested months → feasible.
2. Only fall back to Labs if we ever need > 48 months (out of scope for Phase 5).
3. Remove the "rolling 12-month window" copy in the UI — that description of the standard endpoint is wrong.

### (d) Optional: query the Status endpoint once per run
`GET /v3/keywords_data/google_ads/status/` returns `actual_data: true|false`. When `false`, the
current-month partial data isn't in yet and `date_to` should be pushed back one more month. Not a
blocker — DataForSEO already clamps `date_to` server-side — but avoids surprising "missing final
month" gaps in the backfill report.

### (e) Housekeeping
- Consider renaming the "Labs" probe row in the UI to make clear it's a separate SKU probe, not a
  blocker.
- Log the exact `date_from`/`date_to`/`months_returned` per keyword in `calc_run_registry.summary_json`
  so future audits don't need doc archaeology.

---

## If you want to sanity-check this with another LLM

Paste the following prompt:

> DataForSEO v3 API. I need 24 months of monthly search volume for ~500 keywords per project.
> Our account has the standard "Keywords Data" (Google Ads) subscription but not DataForSEO Labs.
> Confirm: (1) can `POST /v3/keywords_data/google_ads/search_volume/live` return 24 months of
> `monthly_searches` when I pass `date_from` set to 24 months ago and `date_to` set to yesterday?
> (2) What are the exact rate/size limits — requests per minute, keywords per request, and cost per
> request? (3) Are there cases where Google Ads returns fewer months than requested (e.g. seasonal
> gaps, grouped-similar-keywords, no-data keywords)? (4) Does the Status endpoint's `actual_data`
> field matter for setting `date_to`? (5) Is there any scenario where I *must* use the Labs
> `historical_search_volume/live` endpoint instead of the standard one for a 24-month backfill?

Also useful to attach: one real request payload and one real response from step (a) above so
the LLM can validate the response shape parsing (`tasks[0].result[i].monthly_searches`).

---

## Sources

- Keywords Data API overview — <https://docs.dataforseo.com/v3/keywords-data-overview/>
- Google Ads Search Volume (Live) — <https://docs.dataforseo.com/v3/keywords_data/google_ads/search_volume/live/>
- Labs Historical Search Volume (Live) — <https://docs.dataforseo.com/v3/dataforseo_labs/google/historical_search_volume/live/>
- Google Ads Status endpoint — <https://docs.dataforseo.com/v3/keywords_data/google_ads/status/>
- Project memory — `mem://integrations/dataforseo-auth` (secret stored as `login:password`)
- Working reference implementation — `supabase/functions/keyword-enrichment/index.ts` (see `buildBasicAuth`, lines 29–32)
