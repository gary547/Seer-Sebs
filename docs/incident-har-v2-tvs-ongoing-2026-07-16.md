# Incident Report — HAR v2 + Revenue v2 failure (TVs Ongoing)

**Date (UTC):** 2026-07-16
**Project:** TVs Ongoing (`navigator_projects.id = 5fd4df7e-45dd-40c0-b10e-86ea6dad9720`)
**Trigger:** Admin “Run HAR v2 + Revenue v2” combo button (`/admin/calculations`)
**Author:** Lovable agent (for technical advisor review)

---

## 1. Summary

The combined HAR v2 + Revenue v2 pipeline failed for TVs Ongoing.

- `har-calculation-v2` opened a `calc_run_registry` row, threw an unhandled error **~400 ms** after start, and closed the row `status = failed`.
- The stored error is `"[object Object]"` — the real Postgrest error object was stringified with the default `Object.prototype.toString`, discarding `message` / `code` / `details` / `hint`.
- Because HAR v2 threw, the combo orchestrator in `CalculationsPage.tsx` correctly aborted and **never invoked** `compute-forecasts-v2`. This matches the empty `compute-forecasts-v2` log.
- Direct upstream prerequisites (`lps_v2.0.0`, `demand_signals_v1.0.0`) had **succeeded** minutes earlier, so the failure is not a missing dependency.

The root cause of the run failure is inside `har-calculation-v2`, but the *reason we cannot yet name it* is that the catch handler in that function does not serialize non-`Error` throwables. Fixing the diagnostic before re-running is the recommended next step.

---

## 2. Timeline (UTC 2026-07-16)

| Time | Event |
| --- | --- |
| 14:12:22.xxx | `har-calculation-v2` cold boot (34 ms) — first invocation. |
| 14:12:23.xxx | `har-calculation-v2` cold boot (34 ms). |
| 14:12:41.207 | `demand-signals-compute` run opened. |
| 14:12:43.141 | `demand-signals-compute` succeeded. |
| 14:12:49.326 | `demand-signals-compute` run opened (second). |
| 14:12:50.724 | `demand-signals-compute` succeeded. |
| 14:13:18.664 | `link-power-score-compute` run opened. |
| 14:13:24.446 | `link-power-score-compute` **succeeded** (`lps_v2.0.0`, 8804 rows). |
| 14:13:46.xxx | `har-calculation-v2` cold boot (34 ms) — combo click. |
| 14:13:47.138 | `calc_run_registry` row `c2f2f07d-ca6f-44f2-9df6-8a72085fa58c` opened (`model_version = har_v2.1.0`, `trigger_source = admin_manual`). |
| 14:13:47.530 | Same row closed **`status = failed`** after ~392 ms; `errors = [{ code: "unhandled", message: "[object Object]" }]`, `summary_json = { "error": "[object Object]" }`. |
| — | `compute-forecasts-v2` never invoked (no boot, no logs, no `calc_run_registry` row). |

---

## 3. Edge Function logs

### 3.1 `har-calculation-v2`

```
2026-07-16T14:13:46Z INFO Listening on http://localhost:9999/
2026-07-16T14:13:46Z LOG  booted (time: 34ms)
2026-07-16T14:13:46Z INFO Listening on http://localhost:9999/
2026-07-16T14:13:46Z LOG  booted (time: 34ms)
2026-07-16T14:12:23Z INFO Listening on http://localhost:9999/
2026-07-16T14:12:23Z LOG  booted (time: 34ms)
2026-07-16T14:12:22Z INFO Listening on http://localhost:9999/
2026-07-16T14:12:22Z LOG  booted (time: 37ms)
```

Only cold-boot lines. There is **no `console.error` or stack trace** for the failure — the handler's `catch` block writes to `calc_run_registry` and returns without logging.

### 3.2 `compute-forecasts-v2`

> `No logs found for edge function 'compute-forecasts-v2'.`

Consistent with HAR v2 failing first and the combo orchestrator aborting.

### 3.3 Adjacent functions (context only)

- `link-power-score-compute` — full chunked persistence at 14:13:20–14:13:24 (856 keywords / 8804 rows). No errors.
- `categorisation-deferred-tick` — booted and shut down cleanly around the incident.
- `keyword-categorisation` — unrelated errors (`Error: Project not found or not accessible`) for a different project (auth propagation); **not** connected to this incident.

---

## 4. Network report (client)

Snapshot taken after the failure. Observed traffic during the capture window:

- Multiple `HEAD https://xvkfuakwhujtjeaybtzu.supabase.co/rest/v1/serp_results?select=id&keyword_id=in.(…)&…=not.is.null` (Status **206**) — these are the LPS / SERP-completeness count queries the admin dashboard fires when the Calculations page renders. Unrelated to the failure.
- **No** `POST https://…/functions/v1/har-calculation-v2` entry.
- **No** `POST https://…/functions/v1/compute-forecasts-v2` entry.

Interpretation: the combo invocation happened *before* the current network snapshot window. The registry row is the authoritative evidence that HAR v2 was called and failed; the snapshot only captures the follow-up dashboard queries.

---

## 5. Registry evidence

Query used:

```sql
SELECT id, model_version, status, started_at, finished_at, trigger_source,
       jsonb_pretty(summary_json) AS summary, errors, warnings
FROM calc_run_registry
WHERE project_id = '5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
ORDER BY started_at DESC
LIMIT 8;
```

### 5.1 Failed HAR v2 run

| Field | Value |
| --- | --- |
| `id` | `c2f2f07d-ca6f-44f2-9df6-8a72085fa58c` |
| `model_version` | `har_v2.1.0` |
| `status` | `failed` |
| `started_at` | 2026-07-16 14:13:47.137774+00 |
| `finished_at` | 2026-07-16 14:13:47.530+00 |
| `trigger_source` | `admin_manual` |
| `summary_json` | `{ "error": "[object Object]" }` |
| `errors` | `[{ "code": "unhandled", "message": "[object Object]" }]` |
| `warnings` | `[]` |

### 5.2 Preceding successful prerequisites

- `01450eb2-067e-44eb-9ea7-dedf0a17ddc1` — `lps_v2.0.0`, `succeeded`, 14:13:18→14:13:24, `rows_written = 8804`, `keywords_seen = 857`.
- `4df920f9-00b4-4cbc-9c38-a55b7264e1c2` — `demand_signals_v1.0.0`, `succeeded`, 14:12:49→14:12:50, `rows_written = 857`, `kept_keywords_total = 857`.

Inputs required by HAR v2 (kept keywords, LPS run) were present and current at run time.

---

## 6. Root-cause analysis

### 6.1 The diagnostic swallow

`supabase/functions/har-calculation-v2/index.ts` (lines 574–581):

```ts
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  try {
    await closeRun(CALC_RUN_FAILED_STATUS, { error: msg }, [], [{ code: "unhandled", message: msg }]);
  } catch (closeErr) {
    console.error("[har-calculation-v2] close-on-error failed", closeErr);
  }
  return err(500, "unhandled", msg);
}
```

The stored value `"[object Object]"` means `e` is **not** an `instanceof Error` and its default `toString()` returned `"[object Object]"`. This is the classic shape of a Supabase / Postgrest error thrown from a `.select(...)` result:

```ts
{ message: "…", code: "…", details: "…", hint: "…" }
```

`compute-forecasts-v2` uses the same anti-pattern and would fail-log identically.

### 6.2 Where the throw likely came from

Sub-400 ms wall time means the failure is in the pre-loop section of the handler, before per-batch fan-out. The `throw error` sites inside the outer `try`, in order of execution:

| Line | Query / operation |
| --- | --- |
| 227 | Load kept keywords (`SELECT id, base_rank, ranking_url FROM keywords WHERE project_id = $ AND detox_status = 'keep'`) — paginated 1000/page. |
| 259 | Load manual HAR overrides (`SELECT id, keyword_id, har, har_is_manual FROM keyword_forecasts WHERE keyword_id IN (…)`) — chunked 500 IDs. |
| 302 | Per-batch SERP results (in-loop, chunk 200). |
| 341 | Per-batch LPS rows (in-loop). |
| 377 | Per-batch site architecture (in-loop). |
| 388 | Per-batch SERP features (in-loop). |

The elapsed 392 ms includes auth, project visibility check, in-flight guard, client-domain lookup, LPS run lookup, and `calc_run_registry` insert — plus the failing query. Reaching lines 302+ (per-batch loops on 857 keywords with 5 chunks of 200) would normally take longer, so the most likely culprits are **L227** or **L259**.

Nothing in the elapsed time contradicts a fast Postgrest error (permission-denied, missing column, JSON coercion, or transient 5xx) on one of those two calls.

### 6.3 What this is *not*

- Not the Revenue v2 pipeline — it was never invoked (empty logs, no registry row).
- Not a missing HAR v2 prerequisite — LPS and demand signals succeeded minutes before.
- Not the combo button — its abort-on-HAR-error path fired as designed.
- Not the recent frontend hotfix — `CalculationsPage.tsx` only orchestrates and inspects; it does not run the HAR v2 SQL.

---

## 7. What we cannot tell from current evidence

- Which specific query threw.
- The Postgrest `code`, `details`, and `hint` of the underlying error.
- Whether the cause is:
  - permissions / RLS regression on `keywords` or `keyword_forecasts` under the caller JWT,
  - a schema drift (renamed / dropped column referenced in the select),
  - a transient database error (statement timeout, connection reset),
  - or upstream data (e.g. an unexpected `keyword_forecasts` row shape).

Anything more specific than "an early pre-loop `throw error`" is speculation until the catch handler is fixed and the run repeats.

---

## 8. Recommended next steps

Sequenced from lowest to highest risk. All require advisor authorisation before we touch edge-function code.

1. **Fix the diagnostic swallow.** In both `supabase/functions/har-calculation-v2/index.ts` and `supabase/functions/compute-forecasts-v2/index.ts`, replace the `catch`:

   ```ts
   } catch (e) {
     const msg =
       e instanceof Error ? e.message
       : (e && typeof e === "object" && "message" in e) ? String((e as { message: unknown }).message)
       : JSON.stringify(e);
     console.error("[har-calculation-v2] unhandled", e);
     …
   }
   ```

   Also persist the full serialized error object (not just the message) into `calc_run_registry.errors[]`, e.g. `{ code: (e as any)?.code, message: msg, details: (e as any)?.details, hint: (e as any)?.hint }`.

2. **Redeploy and re-run** HAR v2 for TVs Ongoing (Revenue v2 will chain automatically via the combo button). Capture the true error from the registry row.

3. **Surface failures in the UI.** Optionally, have the combo orchestrator in `CalculationsPage.tsx` read `calc_run_registry.errors[0].message` for the just-finished run and put it in the toast, so future failures are visible without a DB round-trip.

4. **Post-mortem the underlying cause** once step 2 yields a real error, and decide on a durable fix (RLS grant, schema alignment, retry-with-backoff, etc.).

---

## 9. Appendix

### 9.1 SQL used

```sql
-- Locate the project
SELECT id, project_name, archived_at
FROM navigator_projects
WHERE project_name ILIKE '%tv%ongoing%'
   OR project_name ILIKE '%ongoing%tv%'
LIMIT 10;

-- Pull recent calc runs
SELECT id, model_version, status, started_at, finished_at, trigger_source,
       jsonb_pretty(summary_json) AS summary, errors, warnings
FROM calc_run_registry
WHERE project_id = '5fd4df7e-45dd-40c0-b10e-86ea6dad9720'
ORDER BY started_at DESC
LIMIT 8;
```

### 9.2 Failed catch handler as it stands today

`supabase/functions/har-calculation-v2/index.ts` L574–L581:

```ts
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  try {
    await closeRun(CALC_RUN_FAILED_STATUS, { error: msg }, [], [{ code: "unhandled", message: msg }]);
  } catch (closeErr) {
    console.error("[har-calculation-v2] close-on-error failed", closeErr);
  }
  return err(500, "unhandled", msg);
}
```

### 9.3 Combo orchestration in the UI

Located in `src/pages/admin/CalculationsPage.tsx`. On HAR v2 failure the combo sets `comboPhase` back to `"idle"`, shows a `toast.error`, and does **not** call `compute-forecasts-v2`. This is why Revenue v2 shows no boot / log / registry evidence for this incident.
