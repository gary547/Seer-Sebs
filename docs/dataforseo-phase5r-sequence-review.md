# Phase 5R prompt sequence — sense-check review

**Reviewer:** Lovable agent
**Reviewed document:** `seer_phase5r_dataforseo_24mo_prompt_sequence.md`
**Scope:** Opinion only. No code, database, migration, or UI changes were made.

---

## 1. Headline verdict

**Green-light, with three amendments (A, B, C below).**

The diagnosis is correct, the guardrails are appropriately paranoid, and the phasing (5R inserted before Phase 6, with a readiness gate) is the right shape. Before running the sequence, three specific issues should be resolved so the implementation doesn't create quiet regressions.

---

## 2. Root-cause verification against current code

I re-checked the two root causes against the live repo. Both are present today; the prompt sequence's diagnosis is not theoretical.

### 2.1 Auth double-encoding — confirmed

- `supabase/functions/dataforseo-historical-volume-backfill/index.ts` (line ~58) sets
  `` `Authorization: Basic ${btoa(apiKey)}` `` unconditionally. Same pattern in
  `dataforseo-history-probe/index.ts`.
- Working reference: `keyword-enrichment/index.ts` uses `buildBasicAuth()` which
  branches on `secret.includes(":")`.
- Per `mem://integrations/dataforseo-auth`, the secret is stored `login:password`, so today
  the `btoa()` branch is coincidentally correct. **But** the moment the secret is rotated
  to a pre-encoded form (which the working code silently supports), both probe and backfill
  will 401. The fix in 5R.1 is not cosmetic — it removes a latent time-bomb.

### 2.2 Missing `date_from` / Labs-first bias — confirmed

- Backfill's feasibility check hardcodes Labs:
  `feasible24 = probe.endpoint === "labs_historical_search_volume" && probe.months >= 24`.
- The Standard endpoint path (`STANDARD_PATH`) exists in the file but is never called with
  `date_from`, so it can only ever return the default 12-month window — which then loses
  the ranking against Labs. Circular failure.

### 2.3 Storage semantics — already good

- `SOURCE = "dataforseo_historical_backfill"`
- Upsert on `(keyword_id, month, source)` with `fetched_at` timestamp.
- No delete-then-insert path was found.

This matches 5R.3's intent and means 5R.3's storage block is largely a validation exercise,
not a rewrite. **See Amendment A** below regarding the proposed source rename.

---

## 3. Prompt-by-prompt read

| Prompt | Verdict | Notes |
|---|---|---|
| 5R.0 Preflight audit | Green-light | Well-scoped no-code audit. Add explicit "report current `SOURCE` constant value" so Amendment A is surfaced before 5R.3 runs. |
| 5R.1 Shared auth helper | Green-light | Stop-condition is correct. Require the helper to live in `supabase/functions/_shared/dataforseo.ts` and note that `keyword-enrichment` migration is byte-equivalent only. |
| 5R.2 Probe fix | Green-light with Amendment B | Tighten wording so a Labs response can never flip `feasible=true` on its own. |
| 5R.3 Backfill fix | Green-light with Amendment A | Do not rename the `source` string without an explicit relabel migration. |
| 5R.4 Status endpoint | Green-light | Path in the doc is `/v3/keywords_data/google_ads/status` — current DataForSEO docs use `/status/live`. Confirm during 5R.0 rather than baking a guessed path into the prompt. |
| 5R.5 UI/copy correction | Green-light | Also render the resolved `source` name in run detail so future rename drift is visible to admins. |
| 5R.6 Validation + Phase 6 gate | Green-light with Amendment C | Readiness thresholds must be numeric constants, not adjectives. |
| 5R.7 Sign-off summary | Green-light | Fine as written. |

---

## 4. Amendments requested before running the sequence

### Amendment A — Do not rename the `source` string in 5R.3 / §5.3

**Problem.** §5.3 recommends the canonical source name become
`dataforseo_google_ads_search_volume_backfill`. Current production writes are labelled
`dataforseo_historical_backfill`, and the upsert unique key is `(keyword_id, month, source)`.
A rename without migration would:

1. Leave existing backfilled rows orphaned from dedup — future runs would insert parallel
   rows under the new name for the same `(keyword_id, month)`.
2. Break any downstream reader (Phase 6 coverage query, admin summary tiles) that filters
   on the old string.
3. Silently double the storage footprint for the same information.

**Recommendation.** Pick one:

- **Preferred:** Keep `dataforseo_historical_backfill` as canonical. Update §5.3 accordingly.
- Or: Add an explicit relabel migration in 5R.3 that updates existing rows in-place
  (`UPDATE keyword_monthly_volumes SET source = 'new_name' WHERE source = 'dataforseo_historical_backfill'`) inside a transaction, then flips the constant. This is more work
  for zero user-visible benefit.

Either way, 5R.0 should output the current `SOURCE` constant so this decision is made
before 5R.3 runs.

### Amendment B — Make Labs demotion explicit in 5R.2

**Problem.** The current text "Labs should be shown as optional only; do not rank Labs
above standard endpoint" leaves room for the same Labs-first bug to reappear (e.g. "if
Labs returns 36 months, prefer it").

**Recommendation.** Add an explicit rule to 5R.2's recommendation logic:

> Labs is probed **read-only for informational display**. A Labs response — successful or
> not — MUST NOT influence the `feasible` boolean, the primary `recommendation` string,
> or the endpoint selected by the backfill. The only signal that sets `feasible=true` is
> the Standard Google Ads Search Volume Live endpoint returning `months_returned >=
> requested_months - 1` for at least one sample keyword.

### Amendment C — Define the Phase 6 readiness thresholds numerically in 5R.6

**Problem.** "Reasonable threshold of kept keywords has >= 24 months" cannot be
implemented as-is; two engineers will pick different numbers.

**Recommendation.** Bake concrete defaults into the code as named constants, admin-visible
in the run summary and overridable per run:

| State | Default rule |
|---|---|
| `ready_24_month` | `percent_keywords_at_or_above_24_months >= 80` |
| `partial_24_month` | `percent_keywords_at_or_above_24_months >= 40` (and not ready) |
| `fallback_12_month` | at least 12 months exists for `>= 50%` of kept keywords |
| `no_history` | none of the above |

Record the threshold values used in `calc_run_registry.summary_json.readiness_thresholds`
so a Phase 6 run always knows which rule produced its state.

---

## 5. Minor observations (non-blocking)

- **5R.1 placement.** Put the helper at `supabase/functions/_shared/dataforseo.ts` and
  export `buildBasicAuth` and (optionally) a typed `callDataForSeo(path, body)` wrapper.
  The wrapper is a nice-to-have — the auth helper is the must-have.
- **5R.3 delete-guard.** Guardrail #9 forbids deletes from `keyword_monthly_volumes`.
  Make this enforceable by adding a `deletes_performed: 0` field to the run summary and
  asserting on it in tests, not just asking the AI to be careful.
- **5R.4 Status endpoint path.** The doc says `/v3/keywords_data/google_ads/status`.
  Current DataForSEO reference is `/v3/keywords_data/google_ads/status/live`. Confirm
  the exact path during 5R.0 rather than shipping a 404 into production.
- **5R.5 UI.** Add a small "Data source" line on the run detail row showing the actual
  `source` string written — cheap insurance against Amendment A drift.
- **Rate limit note.** §5.5 says "12 requests/minute for Google Ads Live endpoints". Our
  project sizes (typically 20–500 kept keywords, occasionally ~2k) fit in 1–2 requests
  per project, so the rate cap is not a practical blocker. Worth stating explicitly in
  5R.3 so the AI doesn't over-engineer a token-bucket.

---

## 6. Phase 6 dependency — agreed

The four-state readiness model (`ready_24_month` / `partial_24_month` / `fallback_12_month`
/ `no_history`) is the correct shape and is consistent with how `calc_run_registry` is
already used elsewhere. With Amendment C attached, this is safe to gate Phase 6 on.

---

## 7. Recommendation

Proceed with **5R.0 as written**. Before running:

- **5R.3** — apply Amendment A (source-name stability).
- **5R.2** — apply Amendment B (Labs demotion wording).
- **5R.6** — apply Amendment C (numeric readiness thresholds).

The rest of the sequence can run unchanged. Nothing in Phase 5R conflicts with Phase 6
or later — it strictly de-risks them.

---

## 8. Sources consulted

- `supabase/functions/dataforseo-history-probe/index.ts`
- `supabase/functions/dataforseo-historical-volume-backfill/index.ts`
- `supabase/functions/keyword-enrichment/index.ts` (`buildBasicAuth`)
- `docs/dataforseo-24mo-history-research.md` (prior Lovable research)
- `mem://integrations/dataforseo-auth`
- Uploaded prompt sequence: `seer_phase5r_dataforseo_24mo_prompt_sequence.md`
