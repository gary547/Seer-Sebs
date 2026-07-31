# DataForSEO Labs SKU Authorisation — Diagnostic Report

**Date:** 2026-07-20
**Author:** Lovable agent (build-mode diagnostic)
**Scope:** Read-only investigation. No production code changes.
**Task reference:** "Determine whether this account is authorised for the DataForSEO Labs SKU."

---

## 1. Summary

| Question | Answer |
|---|---|
| Is the account authorised for the DataForSEO **Labs** SKU? | **Yes** |
| Does `keyword_overview/live` return `keyword_properties`? | **Yes** |
| Does `keyword_properties.core_keyword` carry a value for our test pair? | **No** — `null` for both keywords |
| Does `domain_intersection/live` (Labs) succeed with the same credentials? | **Yes** |
| Do the same credentials still succeed against `keywords_data` (control)? | **Yes** |

**Bottom line:** The Labs SKU is available on this account, but the specific clustering signal we hoped to persist (`keyword_properties.core_keyword`) is not being populated by DataForSEO for our target locale/keyword pair. Persisting `core_keyword` from Labs on a project-wide basis will not yield the demand-pool clustering we assumed.

---

## 2. Method

A temporary edge function `dfs-labs-diag` was deployed with Basic auth using the existing `DATAFORSEO_API_KEY` secret. It made three live calls in sequence, captured full responses, and was deleted immediately afterwards (function and filesystem entry both removed).

Test parameters:
- Keywords: `["32 in tv", "32 inch tv"]`
- `location_code`: `2826` (United Kingdom)
- `language_code`: `"en"`

---

## 3. Call-by-call results

### 3.1 `dataforseo_labs/google/keyword_overview/live`

- **HTTP status:** `200`
- **DFS `status_code` / `status_message`:** `20000` / `"Ok."`
- **Cost:** `$0.01224`
- **`keyword_properties` present:** Yes, on every item
- **`core_keyword` value:** `null` for both `"32 in tv"` and `"32 inch tv"`
- **Related fields observed:**
  - `synonym_clustering_algorithm`: `"text_processing"`
  - `keyword_difficulty`: `0` (both items)
  - `detected_language`, `is_another_language`: populated
  - `serp_info`, `search_intent_info`: populated

Because both keywords returned `core_keyword: null`, we cannot demonstrate cluster co-membership from this endpoint for the requested pair. This does not prove Labs is unauthorised — the account clearly receives Labs data — it demonstrates that the clustering field is simply not filled for these inputs.

### 3.2 `dataforseo_labs/google/domain_intersection/live`

- **HTTP status:** `200`
- **DFS `status_code` / `status_message`:** `20000` / `"Ok."`
- **Cost:** `$0.01212`
- **Notes:** Confirms Labs SKU authorisation independently of `keyword_overview`.

### 3.3 Control: `keywords_data/google_ads/search_volume/live`

- **HTTP status:** `200`
- **DFS `status_code` / `status_message`:** `20000` / `"Ok."`
- **Cost:** `$0.09`
- **Notes:** The credentials continue to work against the production Search Volume endpoint used by the current pipeline.

---

## 4. Interpretation

1. **SKU authorisation is not the blocker.** Two independent Labs endpoints returned `20000` with the production credentials.
2. **`core_keyword` is not a reliable clustering signal for our workload.** For the specific UK/`en` test pair, DFS populated the `keyword_properties` object but left `core_keyword` `null`. Persisting a `null` field project-wide would offer no clustering benefit.
3. **Prior discovery stands.** `core_keyword` is a Labs-family field, not a Google Ads Search Volume field. Earlier confusion between the two endpoints was corrected in the previous investigation report (`docs/dfs-core-keyword-endpoint-investigation-2026-07-20.md`).
4. **`synonym_clustering_algorithm: "text_processing"`** suggests DFS is falling back to text-based clustering for this locale/keyword pair rather than the richer SERP-based clustering that produces populated `core_keyword` values in higher-volume English-US contexts.

---

## 5. Implications for the clustering roadmap

- The additive migration adding `keywords.core_keyword` and `keywords.keyword_cluster_id`, and the writer changes in `keyword-enrichment` and `dataforseo-historical-volume-backfill`, remain **safe and inert** — they will simply record `null` for locales/pairs where DFS does not populate the field.
- The **`dfs-core-keyword-backfill`** admin trigger is unlikely to produce meaningful cluster IDs at scale under the current locale mix. Recommend gating any large-scale invocation on a pilot batch that measures the non-null rate before spending on a full backfill.
- If clustering is a strategic requirement, evaluate:
  - `dataforseo_labs/google/related_keywords/live` (explicit cluster/depth model), or
  - `dataforseo_labs/google/keyword_ideas/live` with post-hoc SERP-overlap clustering.
- Either alternative should be scoped as a separate diagnostic before code changes.

---

## 6. Housekeeping

- Temporary edge function `dfs-labs-diag`: **deployed → invoked → deleted**.
- No migrations, no schema changes, no writes to production tables.
- Secrets untouched. `DATAFORSEO_API_KEY` was read via env only.

---

## 7. Recommendation to advisor

1. Accept "Labs SKU authorised" as settled.
2. Treat `core_keyword` as **available but sparse** for UK English — not a general-purpose clustering key.
3. Before authorising any large backfill of `keyword_cluster_id`, request a pilot diagnostic across a representative sample (locales × head/torso/tail) to quantify the populated-rate.
4. Consider commissioning a follow-up investigation into `related_keywords/live` as a stronger clustering source.
