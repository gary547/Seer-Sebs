# Calibration Compute — Failure Report

**Date:** 2026-07-20
**Project:** TVs Ongoing (`5fd4df7e-45dd-40c0-b10e-86ea6dad9720`)
**Route:** `/admin/calculations?projectId=5fd4df7e-45dd-40c0-b10e-86ea6dad9720`
**Feature:** Prompt 2.5 — Calibration Card ("Run calibration" action)
**Impact:** Calibration snapshot cannot be produced for any project. Prompt 2.5 promotion gate is currently un-runnable.
**Severity:** High — blocks Gate B eligibility check. No data corruption; no impact to HAR/Revenue pipeline.

---

## 1. Symptom

Three consecutive attempts to run calibration from the CalibrationCard's "Run calibration" button all failed at the transport layer with `Error: Failed to fetch`. No snapshot was written, no server-side error surface was rendered in the UI, and no toast content was available to display beyond a generic error state.

Browser network log (verbatim, from the preview session at the time of the report):

```
POST https://xvkfuakwhujtjeaybtzu.supabase.co/functions/v1/calibration-compute
  Body: {"project_id":"5fd4df7e-45dd-40c0-b10e-86ea6dad9720"}
  Result: Error: Failed to fetch
  Timestamps (UTC): 13:46:39, 13:46:52, 13:46:58
  Origin: https://aa6e3472-962d-4327-9db1-493f2cbccf5a.lovableproject.com
  x-client-info: supabase-js-web/2.103.3
```

There is **no HTTP status code** on any of the three attempts — the browser never received a response. This is the tell.

---

## 2. Root Cause

**The `calibration-compute` edge function was never deployed to the Supabase edge runtime.**

`Failed to fetch` combined with **zero** server-side log entries is the platform-level signature of a POST to an unknown Edge Function URL. When a POST arrives for a function the edge router does not know about:

1. The router does not synthesise CORS response headers for unknown paths.
2. The browser's CORS preflight (or the actual POST) receives no `Access-Control-Allow-Origin` and aborts client-side.
3. `supabase-js` surfaces this as a `FunctionsFetchError` / `TypeError: Failed to fetch` with no status and no body.
4. Nothing is logged, because nothing booted.

Direct evidence that the function has never run in this project's runtime:

```
supabase--edge_function_logs("calibration-compute")
→ "No logs found for edge function 'calibration-compute'"
```

For contrast, peer functions logged in the same window all show `Boot` / `Listening on http://localhost:9999/` entries:

- `keyword-categorisation` — booting every ~200 ms during the observation window
- `har-calculation` — recent shutdowns
- `admin-list-users` — 7 boots in the 20-second window preceding the failure
- `categorisation-deferred-tick` — booted and shut down cleanly

`calibration-compute` produced none of these events — not a Boot, not a Listening, not a Shutdown, not an error stack. The runtime has no record of the function existing.

---

## 3. Contributing Factor

During Prompt 2.5 implementation the deploy step was **implicit** rather than executed. Writing `supabase/functions/calibration-compute/index.ts` does not by itself register a new function with the edge runtime — new functions require an explicit deploy (via `supabase--deploy_edge_functions`) the first time. Existing functions redeploy automatically on file save; new-function-first-deploy does not.

Supporting local-state observations:

- `supabase/functions/calibration-compute/index.ts` — present locally, 394 lines.
- `supabase/functions/_shared/calibration.ts` — present locally, 197 lines.
- Imports in `index.ts:15-39` resolve to files that exist in `_shared/` and to standard `deno.land/std@0.168.0` and `esm.sh/@supabase/supabase-js@2.49.1` specifiers used successfully by peer functions.
- `grep -n "calibration-compute" supabase/config.toml` — no match. Peer functions that ship successfully sometimes have no explicit block either, so the absence is not itself the fault, but adding one is available as a parity option.

There is no code defect in the file. The unit tests for `_shared/calibration.ts` (13 assertions covering 30-day normalisation, noise-floor exclusion, weighted aggregation, and band assignment) passed in the prior turn, before this failure was observed.

---

## 4. Why the UI Could Not Report More

The CalibrationCard invokes the function via `supabase.functions.invoke("calibration-compute", { body: ... })`. `supabase-js` maps a transport-level `TypeError: Failed to fetch` to `FunctionsFetchError`. There is no HTTP body to render, no `serializeErr` payload to display, and no correlation ID to log — because no server responded. The card's toast-based error path was designed for 4xx/5xx JSON responses with structured `code`/`error` fields, which is the correct behaviour when the function exists.

Once the function is deployed, any subsequent failure will produce a real response (either 200 with a snapshot, or 4xx/5xx with a `serializeErr` payload — the same pattern used by `har-calculation-v2` and `compute-forecasts-v2` after the Authorised Fix earlier this week).

---

## 5. What Is Healthy (Ruled Out)

Verified working during this investigation:

| Component | Evidence |
| --- | --- |
| `calibration_snapshots` table | REST probe `GET /rest/v1/calibration_snapshots?project_id=eq.5fd4df7e-…&limit=1` → **200 `[]`**. Table exists, RLS visible (empty for this project, not 403). |
| Migration | Table + RLS present per the 200 above. |
| `_shared/calibration.ts` logic | 13/13 unit tests passed prior turn. |
| Frontend wiring | Request body is the expected `{ project_id }` shape at the correct URL. |
| CORS declaration in source | `supabase/functions/calibration-compute/index.ts:41-46` sets `Access-Control-Allow-Origin: *` and includes all headers `supabase-js` transmits. |
| Auth token forwarding | `authorization` and `apikey` headers present on the failing POST — request is well-formed. |

None of these are the cause. The single missing element is the deploy.

---

## 6. Fix Path (for advisor sign-off, not executed in this report)

1. Deploy the function: `supabase--deploy_edge_functions(["calibration-compute"])`.
2. Confirm success by re-checking `supabase--edge_function_logs("calibration-compute")` — expect `booted (time: ~35ms)` and `Listening on http://localhost:9999/`.
3. Re-invoke from the CalibrationCard on TVs Ongoing.
4. Expect either:
   - **200** with `snapshot_id`, `overall_ratio`, `by_intent`, `by_rank_band`, `keywords_matched`, `keywords_unmatched` — proceed to Prompt 2.5 verification.
   - **4xx/5xx** with a JSON body containing `code`, `error`, and (on 5xx) a `serializeErr` block. This becomes a diagnostic surface, not a transport failure.
5. Optional hardening (not required for the fix): add a `[functions.calibration-compute]` block in `supabase/config.toml` for parity with peers, and consider extending the CalibrationCard's error handler to distinguish `FunctionsFetchError` ("function not deployed / network unreachable") from `FunctionsHttpError` ("function returned non-2xx"), so future first-deploy misses are self-diagnosing.

Expected time-to-fix once approved: under one minute (single deploy call), plus verification.

---

## 7. Evidence Appendix (verbatim)

### 7.1 Failing network entries

```
Request: POST https://xvkfuakwhujtjeaybtzu.supabase.co/functions/v1/calibration-compute
Time: 2026-07-20T13:46:39Z
Origin: https://aa6e3472-962d-4327-9db1-493f2cbccf5a.lovableproject.com
Headers:
  apikey: REDACTED
  authorization: REDACTED
  content-type: application/json
  x-client-info: supabase-js-web/2.103.3
Request Body: {"project_id":"5fd4df7e-45dd-40c0-b10e-86ea6dad9720"}
Error: Failed to fetch
```

(Two identical retries at 13:46:52Z and 13:46:58Z, same result.)

### 7.2 Successful sibling request (proves table + RLS healthy)

```
Request: GET https://xvkfuakwhujtjeaybtzu.supabase.co/rest/v1/calibration_snapshots
  ?select=*&project_id=eq.5fd4df7e-45dd-40c0-b10e-86ea6dad9720
  &order=created_at.desc&limit=1
Time: 2026-07-20T13:46:38Z
Status: 200
Response Body: []
```

### 7.3 Edge function log query

```
Tool: supabase--edge_function_logs
Args: { "function_name": "calibration-compute" }
Result: "No logs found for edge function 'calibration-compute'."
```

### 7.4 Local source inventory

```
supabase/functions/calibration-compute/index.ts   394 lines
supabase/functions/_shared/calibration.ts         197 lines
grep -n "calibration-compute" supabase/config.toml  (no matches)
```

### 7.5 Peer functions logging normally in the same window

`keyword-categorisation`, `categorisation-deferred-tick`, `har-calculation`, `admin-list-users` — all show recent `Boot` and `Listening` events between 13:45:33Z and 13:46:00Z. `calibration-compute` shows none in the same window.

---

**Prepared for:** Technical advisor
**Author role:** Lovable agent, read-only investigation
**No build, database, or config changes were made producing this report.**
