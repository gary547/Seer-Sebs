# DFS `core_keyword` endpoint investigation — 2026-07-20

Read-only investigation authorised for one live DFS call. Evidence rule: raw
response body captured from a live invocation, not inferred.

Method: a throwaway edge function `dfs-diag` (now deleted) called
`POST https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live`
with `{"keywords":["32 in tv"], "location_code":2826, "language_code":"en"}`
using the production `DATAFORSEO_API_KEY` via the shared `buildBasicAuth`
helper — identical auth path to `dfs-core-keyword-backfill`. HTTP 200,
`status_code=20000`.

---

## §1 — Raw response body from `search_volume/live`

Top-level response keys:

```
["version","status_code","status_message","time","cost","tasks_count","tasks_error","tasks"]
```

`tasks[0]` keys:

```
["id","status_code","status_message","time","cost","result_count","path","data","result"]
```

`tasks[0].result[0]` keys (the per-keyword payload) — **exhaustive**:

```
["keyword","spell","location_code","language_code","search_partners",
 "competition","competition_index","search_volume","low_top_of_page_bid",
 "high_top_of_page_bid","cpc","monthly_searches"]
```

Verbatim `tasks[0].result[0]` for `"32 in tv"`:

```json
{
  "keyword": "32 in tv",
  "spell": null,
  "location_code": 2826,
  "language_code": "en",
  "search_partners": false,
  "competition": "HIGH",
  "competition_index": 100,
  "search_volume": 27100,
  "low_top_of_page_bid": 0.2,
  "high_top_of_page_bid": 0.61,
  "cpc": 0.46,
  "monthly_searches": [
    {"year":2026,"month":6,"search_volume":22200},
    {"year":2026,"month":5,"search_volume":22200},
    {"year":2026,"month":4,"search_volume":22200},
    {"year":2026,"month":3,"search_volume":22200},
    {"year":2026,"month":2,"search_volume":22200},
    {"year":2026,"month":1,"search_volume":27100},
    {"year":2025,"month":12,"search_volume":40500},
    {"year":2025,"month":11,"search_volume":49500},
    {"year":2025,"month":10,"search_volume":33100},
    {"year":2025,"month":9,"search_volume":27100},
    {"year":2025,"month":8,"search_volume":27100},
    {"year":2025,"month":7,"search_volume":22200}
  ]
}
```

Reported cost for this call: `tasks[0].cost = 0.09`, top-level `cost = 0.09`.

**Does `keyword_properties` exist in this response? — NO.**

`Object.prototype.hasOwnProperty.call(result0, "keyword_properties")` returned
`false`. The field is simply not part of the Google Ads Search Volume schema.
No `core_keyword` field is present at any nesting level of `result0`.

---

## §2 — Endpoints that DO return `keyword_properties.core_keyword`

`keyword_properties` (with `core_keyword`, `synonym_clustering_algorithm`,
`keyword_difficulty`, `detected_language`, and `is_another_language`) is a
**DataForSEO Labs** construct, exposed on the Labs "Google" family of
endpoints. Documented occurrences (path = `.tasks[0].result[0].items[].keyword_properties.core_keyword`
unless noted):

| Endpoint | Doc URL | Cost/call | Notes |
|---|---|---|---|
| `dataforseo_labs/google/keyword_overview/live` | https://docs.dataforseo.com/v3/dataforseo_labs/google/keyword_overview/live/ | $0.0101 base + $0.0001/kw | Direct per-keyword lookup, up to 700 keywords/req. Path is `result[0].items[].keyword_properties.core_keyword`. Best fit for cluster-id backfill. |
| `dataforseo_labs/google/keyword_ideas/live` | https://docs.dataforseo.com/v3/dataforseo_labs/google/keyword_ideas/live/ | $0.0101 + $0.0001/returned kw | Seed-driven expansion; returns cluster info for each idea. |
| `dataforseo_labs/google/keyword_suggestions/live` | https://docs.dataforseo.com/v3/dataforseo_labs/google/keyword_suggestions/live/ | $0.0101 + $0.0001/returned kw | Single-seed variants; not a bulk lookup. |
| `dataforseo_labs/google/related_keywords/live` | https://docs.dataforseo.com/v3/dataforseo_labs/google/related_keywords/live/ | $0.01 + $0.0001/returned kw | Depth-limited related tree. |
| `dataforseo_labs/google/keywords_for_site/live` | https://docs.dataforseo.com/v3/dataforseo_labs/google/keywords_for_site/live/ | $0.011 + $0.0001/kw | Domain-scoped; wrong shape for our per-keyword backfill. |

**Plan authorisation.** The prior probe surfaced in
`docs/dataforseo-24mo-history-research.md` recorded
`labs_historical_search_volume = UNAUTHORIZED` and
`keywords_data_search_volume = UNAUTHORIZED`. That doc concluded the Labs
`UNAUTHORIZED` is genuine (Labs is a separate DataForSEO SKU) while the
Keywords-Data `UNAUTHORIZED` was a client-side auth-header bug in the probe.
No production Labs call has succeeded from this project. **Conclusion:
authorisation against the Labs SKU is unconfirmed. A one-shot Labs
`keyword_overview/live` probe (~$0.02) is required before any Labs-based
cluster backfill design can proceed.** Do not commit to a Labs path until that
probe returns `20000`.

---

## §3 — Why the earlier backfill returned 0/857 with 2 API calls / $0.18

Code path in `supabase/functions/dfs-core-keyword-backfill/index.ts`:

- Calls `POST /v3/keywords_data/google_ads/search_volume/live` in batches of
  `KW_PER_BATCH = 700` (line 37). 857 kept keywords ⇒ **2 batches** — matches
  the reported `api_calls = 2`.
- Cost per call from §1 = **$0.09** ⇒ 2 × $0.09 = **$0.18** — matches
  `cost_reported = 0.18`.
- Read logic (lines 181–189):

  ```ts
  const result: any[] = body?.tasks?.[0]?.result ?? [];
  for (const r of result) {
    ...
    const ck = r?.keyword_properties?.core_keyword;
    if (typeof ck === "string" && ck.trim().length) perKeywordCore.set(id, ck);
  }
  ```

  Given §1 evidence that `result[]` items have no `keyword_properties` field,
  `r?.keyword_properties` is `undefined` on every iteration, `ck` is
  `undefined`, the guard fails, `perKeywordCore` stays empty ⇒
  `keywords_with_core_keyword = 0`, `keywords_updated = 0`.

The DFS calls succeeded (`status_code=20000`, cost billed) and the volumes,
CPCs, and monthly histories were all present — the writer just asked for a
field the endpoint never returns. **Zero recovery is a schema mismatch, not a
transport or auth failure.**

---

## §4 — Was the earlier claim verified against a real response?

Claim under review, `docs/volume-duplication-diagnostic-888002bc-2026-07-20.md`
§4:

> "the response carries an explicit cluster identifier core_keyword … discarded
> by both writers"

**Direct answer: NO — the claim was not verified against a real response body.
It was inferred from DataForSEO documentation.**

Grounds:

1. Neither `keyword-enrichment/index.ts` nor
   `dataforseo-historical-volume-backfill/index.ts` (the two writers the
   claim names) ever read `keyword_properties.*`. There is no captured
   response body in any doc, log, or code path that shows this field on the
   Search Volume endpoint prior to today's investigation.
2. The §4 citation reads "DataForSEO `search_volume/live` returns Google
   Ads' close-variant-normalised volume. The pipeline currently discards the
   `keyword_properties.core_keyword` identifier." Both sentences describe
   documentation semantics, not observed response fields — and the second is
   now demonstrably wrong for the Search Volume endpoint.
3. `dfs-core-keyword-backfill` was written on the strength of that
   inference; its 0/857 run (§3) is the first empirical test, and it
   falsifies the inference.

**Correction required.** Two documents carry the incorrect claim and must be
amended in a follow-up:

- `docs/volume-duplication-diagnostic-888002bc-2026-07-20.md` §4 — retract
  the "carries an explicit cluster identifier" wording and mark the DFS
  provenance line as documentation-inferred and now falsified for Search
  Volume; the close-variant clustering behaviour of Google Ads is still true,
  it just isn't exposed via this endpoint.
- `docs/calculation-v21-programme.md` open-flags entry for DFS cluster
  double-counting — retain the flag (the duplication itself is real; see 585
  of 835 kept keywords in duplicate-volume groups), but strike the
  "just persist `core_keyword`" implementation hint until the Labs probe in
  §2 confirms availability and cost.

---

## Summary

| Question | Answer |
|---|---|
| §1 raw body | Captured verbatim above; 12 top-level result keys, no `keyword_properties`. |
| §2 endpoint that returns `core_keyword` | DataForSEO **Labs** family (best fit: `dataforseo_labs/google/keyword_overview/live`, ~$0.0101 + $0.0001/kw). Plan authorisation **unconfirmed** — Labs SKU must be probed separately. |
| §3 zero-recovery cause | Writer reads `keyword_properties.core_keyword` from a Google-Ads Search Volume response that never contains that field; 2 batches × $0.09 = $0.18, all successful, all missing the field. |
| §4 earlier claim verified? | **No — inferred from docs, not from a real response. Falsified by §1.** |

No code, migration, or config was changed beyond the temporary diagnostic
function `supabase/functions/dfs-diag/` which was created, invoked once, and
deleted (both filesystem and deployed function removed). `dfs-core-keyword-backfill`
is byte-identical to its state before this investigation.
