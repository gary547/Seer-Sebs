# Incident report — HAR v2 failure, TVs Ongoing (Part 2)

**Date/time (UTC):** 2026-07-16, ~14:45  
**Project:** TVs Ongoing (`5fd4df7e-45dd-40c0-b10e-86ea6dad9720`)  
**Operator action:** Clicked *Run HAR v2 + Revenue v2* from `/admin/calculations`.  
**Outcome:** `har-calculation-v2` returned HTTP 500 → combo orchestrator aborted → `compute-forecasts-v2` never invoked.  
**Prior report:** `docs/incident-har-v2-tvs-ongoing-2026-07-16.md` (Part 1 — diagnosed error-serialization swallow).

---

## 1. What changed since Part 1

Between Part 1 and this re-run, both v2 edge functions were redeployed with a `serializeErr` helper and structured `console.error` before `closeRun`. The purpose was diagnostic only — to surface the real error that Part 1's `"[object Object]"` handler was swallowing.

The fix worked as intended: the underlying error is now readable in both the Deno console log and (would be) in `calc_run_registry.errors[]`. Nothing about HAR v2's calculation logic changed.

---

## 2. Captured error

From `har-calculation-v2` (`function_id cba59dfc-b99a-4806-ad9e-490b9610fbf5`), single `error`-level log line at Unix ms `1784213101983` (~825 ms after boot at `1784213101159`):

```
[har-calculation-v2] unhandled {
  "code": "",
  "message": "TypeError: error sending request from 10.32.112.84:47820 for https://xvkfuakwhujtjeaybtzu.supabase.co/rest/v1/keyword_forecasts?select=id,keyword_id,har,har_is_manual&keyword_id=in.(<~350+ UUIDs, log truncated at ~10 KB>)"
}
```

Key characteristics:

- **`code: ""`** — the thrown object has no `code`, `details`, or `hint`. This is **not** a PostgREST response error (RLS, missing column, permission). It is a **fetch-layer failure**: the request never completed a round-trip.
- **`TypeError: error sending request from <edge-runtime IP>:<port> for <URL>`** is the canonical Deno/edge-runtime error shape for an outbound `fetch()` that was aborted before receiving a response — typically caused by a URL/header size limit, a connection reset, or a request-body/URL that exceeds the client's or gateway's cap.
- **URL length**: the visible portion of the URL enumerates ≥180 UUIDs (the log line was truncated by the observability pipeline at ~10 KB); the full URL is materially longer. Each UUID + separator contributes ~40 bytes to the query string.
- No preceding info log, no partial success — the function opened the `calc_run_registry` row, ran prerequisite lookups, then threw on the first `keyword_forecasts` prefetch batch.

---

## 3. Root-cause hypothesis

`har-calculation-v2` prefetches manual HAR overrides for the project's full keyword set via a batched IN-list query at `supabase/functions/har-calculation-v2/index.ts:267–278`:

```ts
for (const ids of chunk(keywordIds, 500)) {
  const { data, error } = await sb
    .from("keyword_forecasts")
    .select("id, keyword_id, har, har_is_manual")
    .in("keyword_id", ids);
  ...
}
```

The batch size is **500 UUIDs**. Each UUID contributes ~38 bytes to the URL (36-char UUID + `%2C` separator), so a single batch produces a query string of roughly **19 KB** plus base URL, headers, and PostgREST framing. This is at or above the practical URL-length limits enforced by:

- Deno edge-runtime's outbound `fetch` client (which surfaces oversize URLs as `TypeError: error sending request …`), and/or
- The Supabase gateway / PostgREST front-end for GET query strings.

The failure mode — a `TypeError` from the client with no HTTP status, before any PostgREST response body is produced — matches this signature exactly. Other IN-list queries in the same function that use smaller chunk sizes (`KW_CHUNK = 100` for the main keyword loop, `chunk(ids, 100)` elsewhere) do not exhibit this failure.

TVs Ongoing carries a large keyword set (multiple hundreds), so the first `chunk(keywordIds, 500)` batch fills the URL well past whichever limit fires first. Smaller projects would land under the cap and succeed silently.

This is **not** a permissions, RLS, or data-shape problem. It is a request-size problem in one specific prefetch.

---

## 4. Corroborating evidence

- **Edge-function logs:**
  - `har-calculation-v2`: boot at `1784213100127`, listen at `1784213100143` (initial cold start), second boot at `1784213101096`, listen at `1784213101159`, single `error`-level `[har-calculation-v2] unhandled …` at `1784213101983`. No subsequent lines from this function.
  - `compute-forecasts-v2`: **no boot, no logs.** Revenue v2 was never called — confirming the combo orchestrator's short-circuit-on-HAR-failure path fired correctly.
  - `har-calculation` (v1), `keyword-categorisation`, `admin-list-users`, etc.: unrelated activity in the same window, no bearing on the failure.
- **Client network snapshot (2026-07-16T14:45:05Z–14:45:08Z):** all captured requests are `HEAD /rest/v1/serp_results?…&<metric>=not.is.null` counting queries from the LPS / SERP dashboards on the currently-open page. No `functions/v1/har-calculation-v2` or `functions/v1/compute-forecasts-v2` entries are present in the snapshot window (those invocations completed before capture).
- **`calc_run_registry`:** the just-closed run row for this project should now contain a populated `errors[0].message` matching the log above (the redeployed catch handler persists it) — advisor can verify with:
  ```sql
  select id, model_version, status, errors, summary_json
  from calc_run_registry
  where project_id = '5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
    and model_version like 'har_v2%'
  order by started_at desc
  limit 1;
  ```

---

## 5. Recommended remediation (not authorised in this task)

Two independent, low-risk changes for the advisor to authorise:

1. **Reduce the `keyword_forecasts` prefetch batch size in `har-calculation-v2`.** Change the loop at L267 from `chunk(keywordIds, 500)` to `chunk(keywordIds, 100)` (matches the `KW_CHUNK` constant already used for the main scenario loop). At 100 UUIDs per batch the URL stays under ~4 KB, well below any known cap.
2. **Shared safeguard.** Add a small helper in `supabase/functions/_shared/` (e.g. `pgrst-in.ts`) that wraps `.in(col, ids)` and internally chunks any list longer than a conservative threshold (e.g. 100), so future prefetches cannot regress into the same trap. Apply it to `compute-forecasts-v2` and other v2 functions on the same pass.

Neither change alters calculation semantics — both are purely transport-layer.

Once (1) is deployed, re-run HAR v2 for TVs Ongoing and confirm the combo action reaches Revenue v2. If Revenue v2 fails, its now-readable error will point at the next issue.

---

## 6. Out of scope for this report

- No code changes to `har-calculation-v2`, `compute-forecasts-v2`, `_shared/`, migrations, or the frontend.
- No re-run of TVs Ongoing.
- Broader HAR v2 correctness (TP position quality, SVM interaction, etc.) is unaffected by this incident.
