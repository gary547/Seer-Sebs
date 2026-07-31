# Calculation v2 — Prompt Sequence Review

**Reviewer:** Lovable (Seer codebase agent)
**Source doc:** `seer_calculation_v2_lovable_prompt_sequence.md` (1,964 lines, 41 prompts, Phases 0–13, Appendices A/B/C)
**Prior context:** `docs/calculation-improvements-viability-review.md`, `docs/calculation-improvements-alignment-response.md`, `docs/calculation-improvements-followup-response.md`
**Verdict:** **GREEN-LIT to proceed** — with 6 minor "Ready with note" items to hold in memory during the build. No blocking issues.

---

## 1. Green-light verdict

The sequence is **fit for purpose** and internally consistent with the three previous alignment/follow-up docs. Every prompt:

- Restates its own guardrails (they don't rely on §1 memory only).
- Is single-scoped to one phase.
- Names the exact tables/edge functions we already verified exist in the codebase.
- Follows the additive, shadow-mode, versioned, manual-first, flag-gated model we agreed.
- Preserves `har_revenue_gain_annual` as the v1 field and never asks Lovable to rename it.
- Only touches v1 code in the two explicitly sanctioned places (Prompt 2.2 monthly-volume writer, Prompt 9.1 HAR UR hotfix).

No stop-condition (Appendix B) is triggered by anything in the codebase as it stands today. Recommendation: **fire Prompt 0.1**.

The 6 "Ready with note" items are watch-outs, not blockers — they are captured in §3 and again in the Stop-Condition Watchlist (§5) so they stay in front of us during the build.

---

## 2. Programme-wide guardrail audit (§1, 25 rules)

All 25 rules are internally consistent. Cross-checks:

| Rule | Check | Result |
|---|---|---|
| 1, 3, 4 | No v1 replacement/formula changes | Each prompt restates this; only 2.2 and 9.1 open narrow exceptions, both flagged in the prompt body. | ✅ |
| 2 | `har_revenue_gain_annual` never renamed | Confirmed in Prompt 10.2 which introduces `tp_incremental_revenue_annual` as a **new** column on `keyword_forecast_scenarios`. | ✅ |
| 5 | Early v1 changes limited to enrichment writer + HAR UR hotfix | Prompts 2.2 and 9.1 are the only ones that touch v1 edge functions. | ✅ |
| 6, 21 | No cron until Phase 13; DFS calls only in Phase 5 | Confirmed. Phase 13 (13.1) is the only cron prompt; Phase 5 is the only DFS-call phase. | ✅ |
| 8, 9 | `calc_run_id` + `project_id` on every v2 write | Every v2 table in Prompt 1.3 includes both; every compute prompt (5.2, 6.1, 7.1, 8.1, 9.2, 10.2) writes `calc_run_id`. | ✅ |
| 10 | RLS, grants, type regen | Restated in 1.1, 1.2, 1.3, 2.1, 3.1. | ✅ |
| 13, 14 | Visibility flag gating | Every user-facing prompt (11.x) restates `calculations_v2_visible_enabled`. | ✅ |
| 22 | 100-ID `.in()` chunks | Restated in 8.1; **not restated** in 6.1, 7.1, 9.2, 10.2 — see §3 note. | ⚠️ minor |
| 25 | Stop-and-report on schema conflict | Restated in most prompts; implicit in the rest via "if X, report". | ✅ |

**Guardrail gap flagged:** the 100-ID batch rule is only restated inside Prompt 8.1. Prompts 6.1, 6.2, 7.1, 9.2, 10.2 all iterate keywords and will need the same discipline. Not a blocker — Rule §1.22 is programme-wide, and each prompt tells Lovable to "batch safely" — but worth calling out at prompt-firing time.

---

## 3. Per-phase review

### Phase 0 — Preflight

| Prompt | Status | Note |
|---|---|---|
| 0.1 Baseline check | **Ready** | Read-only baseline probe. Ground truth: `keyword-enrichment` **does** delete-then-insert `keyword_monthly_volumes` (lines 408–409 of the current edge function); `har-calculation` **does** treat missing UR as 0 (lines 980 & 1031). Lovable's answer will confirm both. |

### Phase 1 — Scaffolding & inspector shell

| Prompt | Status | Note |
|---|---|---|
| 1.1 Flags + `calc_run_registry` | **Ready** | Direct boolean columns on `navigator_projects` matches our follow-up recommendation. |
| 1.2 Config tables | **Ready** | `serp_feature_ctr_adjustments` + `har_scoring_config` are net-new; seed values are conservative. |
| 1.3 v2 output tables | **Ready with note** | `keyword_forecast_scenarios` has no explicit unique key. Prompt 10.2 says "update existing rows for the same `calc_run_id` and scenario" — Lovable will need to add a `(calc_run_id, keyword_id, scenario)` unique index during 1.3 or during 10.2. Flag at 1.3 firing so it lands in the correct migration. |
| 1.4 `/admin/calculations` shell | **Ready** | Route restricted to `admin`/`super_admin`; consistent with `/admin/users` and `/admin/categories` pattern. |

### Phase 2 — Monthly-volume preservation

| Prompt | Status | Note |
|---|---|---|
| 2.1 Add `source` + `fetched_at`, unique `(keyword_id, month, source)` | **Ready with note** | Current `keyword_monthly_volumes` types don't expose an existing unique constraint. If a `(keyword_id, month)` unique exists at the DB level (added outside `types.ts`), Prompt 2.1 must drop-and-recreate rather than "safely migrate". Prompt already says "if an existing unique constraint conflicts, migrate safely without dropping data" — good enough. |
| 2.2 Upsert-preserve writer | **Ready** | Exact target lines: `keyword-enrichment/index.ts` 402–410. Prompt scope is correctly limited to this block only. |
| 2.3 Regression checks | **Ready** | Sensible; project has vitest but no edge-function harness — the prompt correctly says "manual SQL check instead" is acceptable. |

### Phase 3 — GSC workbook import

| Prompt | Status | Note |
|---|---|---|
| 3.1 `gsc_uploads` metadata | **Ready** | Confirmed: `gsc_uploads` has no `date_range_*` today — additive change is clean. `device` currently has no CHECK in the visible types, so accepting `'all'` should be a no-op. |
| 3.2 `gsc-workbook-import` edge fn | **Ready with note** | **SheetJS in Deno**: xlsx.js works via `https://esm.sh/xlsx@0.18.5` in Deno edge runtime, but with a memory footprint that can bite on very large workbooks. Guardrail addition to hold: reject workbooks >5 MB or >100k rows with a clear error. Not blocking. |
| 3.3 Upload UI | **Ready** | Additive next to existing CSV upload; matches Briefing OS primitives. |
| 3.4 Inspector provenance panel | **Ready** | Read-only. |

### Phase 4 — CTR from GSC

| Prompt | Status | Note |
|---|---|---|
| 4.1 `ctr-curves-from-gsc` | **Ready** | Writes to existing `ctr_curves` + new `ctr_curve_metadata`. The unique index on `ctr_curves(project_id, device, intent_segment, rank_position)` in Prompt 1.3.A is a prerequisite — Appendix A order (1.3 before 4.1) covers this. |
| 4.2 v2 resolver with all-device fallback | **Ready with note** | Existing v1 CTR consumers (`compute-forecasts`, `ctr-benchmark`) query `device` explicitly. Resolver must **only** be used by v2 code paths; if a v1 caller ever receives a `device='all'` row it may skew v1. Prompt is careful — worth restating on fire. |
| 4.3 Provenance chip | **Ready** | UI-only, admin-gated until 11.x. |

### Phase 5 — DataForSEO historical volume

| Prompt | Status | Note |
|---|---|---|
| 5.1 Capability check | **Ready** | Correctly gates 5.2 on positive endpoint confirmation. |
| 5.2 Backfill fn | **Ready** | Uses `source='dataforseo_historical_backfill'` — depends on 2.1/2.2 upsert-preserve landing first (Appendix A order is correct). |
| 5.3 Admin trigger panel | **Ready** | Explicit "may incur cost" confirmation is the right guardrail. |

### Phase 6 — Demand Intelligence

| Prompt | Status | Note |
|---|---|---|
| 6.1 Keyword-level compute | **Ready** | Doesn't mutate `keyword_forecasts`. Batch-limit reminder (see §2). |
| 6.2 Category-level rollup | **Ready** | Depends on `keywords.tag_1`/`tag_2` which exist in the taxonomy. |
| 6.3 Admin inspection | **Ready** | Read-only. |

### Phase 7 — SERP CTR deflators

| Prompt | Status | Note |
|---|---|---|
| 7.1 Helper | **Ready** | Uses `serp_features` (present) not `serp_landscape` (correctly deferred). |
| 7.2 Admin inspector | **Ready** | Read-only. |

### Phase 8 — Link Power Score

| Prompt | Status | Note |
|---|---|---|
| 8.1 LPS compute | **Ready** | Reads `serp_results` (UR/DR/ahrefs_rank/RDs/backlinks all present) + `client_domain_metrics`. Rule §1.20 (no new Ahrefs calls) respected. |
| 8.2 Inspector | **Ready** | Read-only. |
| 8.3 Hardening | **Ready** | Batching + duplicate handling. |

### Phase 9 — HAR

| Prompt | Status | Note |
|---|---|---|
| 9.1 v1 HAR missing-UR hotfix | **Ready with note** | Sanctioned v1 edit. Target: `har-calculation/index.ts` lines 980 & 1031 (and the `?? 0` on line 1043 aggregate). Prompt should specify **which mitigation** (median-of-known / floor / percentile) — currently open-ended. Recommend firing this prompt with an explicit instruction to use *median of known competitor UR in the same SERP* with a hard floor of 10. |
| 9.2 HAR v2 composite scenarios | **Ready** | Writes conservative/realistic/stretch to `keyword_forecast_scenarios`. Uses `har_scoring_config` from 1.2. Batch reminder. |
| 9.3 Admin comparison | **Ready** | Read-only. |

### Phase 10 — Revenue v2

| Prompt | Status | Note |
|---|---|---|
| 10.1 Conversion override UI | **Ready** | Creates `project_conversion_overrides` — used by 10.2. Sequencing correct. |
| 10.2 Revenue v2 compute | **Ready with note** | Depends on `keyword_forecast_scenarios` unique key (see 1.3 note). Also depends on v2 HAR scenarios being present — prompt already says "if v2 HAR is missing, do not fake revenue; record warning". |
| 10.3 Admin comparison | **Ready** | Divergence >30% warning is the agreed threshold from Appendix C. |
| 10.4 Server-side resolver | **Ready** | Wires roadmap-to-success, content-plan-generate, export-performance-slides — but **behind visibility flag only**. Correct. |

### Phase 11 — User-facing v2

| Prompt | Status | Note |
|---|---|---|
| 11.1 `useForecastResolver` hook | **Ready** | Default scenario realistic; fallback to v1 with dev warning. |
| 11.2 Overview + Forecast header | **Ready** | Uses existing Briefing OS primitives; no competing headlines. |
| 11.3 HAR explanation drawer | **Ready** | Pulls from `explanation_json` written by 9.2. |
| 11.4 Demand Intelligence chips | **Ready** | Low-coverage muted state matches follow-up doc guidance. |
| 11.5 Export/AI version-stamp | **Ready** | Keeps UI and AI numbers on the same model. |

### Phase 12 — Manual validation

| Prompt | Status | Note |
|---|---|---|
| 12.1 Manual validation workflow | **Ready** | Correct run order matches Appendix C. |
| 12.2 Project-level visibility controls | **Ready** | Admin-only visibility flip; sensible. |

### Phase 13 — Cron

| Prompt | Status | Note |
|---|---|---|
| 13.1 Cron for opted-in projects | **Ready** | Explicitly gated on manual validation success. |

---

## 4. Appendix A ordering check

The 41-step order is dependency-safe. Key dependencies verified:

- 1.1 (`calc_run_registry`) before every prompt that writes `calc_run_id` ✅
- 1.3 (`ctr_curves` unique index) before 4.1 ✅
- 2.1 (unique `(keyword_id, month, source)`) before 2.2 upsert ✅
- 2.2 before 5.2 (historical backfill relies on upsert-preserve) ✅
- 3.1 (`gsc_uploads` date cols) before 3.2 (parser writes them) ✅
- 5.1 (capability check) gates 5.2 explicitly ✅
- 8.x (LPS) before 9.2 (HAR v2 consumes LPS) ✅
- 9.2 (HAR v2 scenarios) before 10.2 (Revenue v2 reads scenarios) ✅
- 10.4 (server resolver) before 11.1 (hook) — and 11.5 (exports) last in Phase 11 ✅
- 12.x manual validation before 13.1 cron ✅

**No reorder recommended.**

---

## 5. Appendix B — Stop-Condition Watchlist (contextualised)

**Rule for the build:** re-check this list at the start of every prompt turn once the sequence begins. The moment Lovable's output shows a signal that matches any row, stop, report, and reconvene brainstorm — do **not** attempt an in-place fix inside the same prompt.

| # | Stop condition (verbatim) | Detection signals in Lovable output | Most likely trigger prompts | Resolution path |
|---|---|---|---|---|
| 1 | `keyword_monthly_volumes` cannot safely preserve multiple sources | Migration failure on unique `(keyword_id, month, source)`; upsert produces duplicates in 2.3 tests | 2.1, 2.2, 2.3 | Reconvene: choose between drop-and-recreate constraint vs. preferred-view helper. Do not proceed to Phase 5. |
| 2 | DataForSEO credentials cannot support any viable 24-month backfill route | Prompt 5.1 reports "no viable endpoint" or 401/403 on all attempted endpoints | 5.1, 5.2 | Skip 5.2/5.3. Continue with going-forward accumulation only via the fixed 2.2 writer. Note in doc that <24-month histories persist for weeks. |
| 3 | Standard GSC workbook parsing is unreliable | SheetJS memory errors; missing Chart/Queries sheets on real client uploads; wrong locale date parsing | 3.2, 3.3 | Reconvene: consider requiring analysts to pre-clean, or add a manual date-range override in 3.3. Do not proceed to Phase 4 until parser is stable. |
| 4 | `device = 'all'` breaks existing CTR assumptions | v1 forecast tests fail; `compute-forecasts` returns zero CTR for existing projects; `ctr-benchmark` errors | 3.1, 4.1, 4.2 | Reconvene: keep `device='all'` scoped strictly to v2 tables via a discriminator column. Roll back the `device` CHECK relaxation if any. |
| 5 | Supabase RLS becomes difficult for new v2 tables | Non-admin users see admin-only tables via PostgREST; `select` fails for legitimate project members; grants missing | 1.1, 1.2, 1.3 | Reconvene: audit RLS pattern against `user_roles` + `has_role()`. Never proceed to Phase 6+ with leaky v2 tables. |
| 6 | v2 run registry cannot cleanly cascade/delete run outputs | Orphan rows after `calc_run_registry` delete; CASCADE loops | 1.1, 1.3 | Reconvene: switch selected FKs from CASCADE to SET NULL, or add a scripted cleanup edge function. |
| 7 | Revenue v2 requires modifying v1 `compute-forecasts` | Prompt 10.2 output mentions any edit to `supabase/functions/compute-forecasts` | 10.2 | **Hard stop.** Roll back any such edit. Rework 10.2 to keep v2 fully in `compute-forecasts-v2`. |
| 8 | Roadmap/content-plan cannot share the same forecast resolver as the UI | Prompt 10.4/11.5 reports the edge functions can't consume the resolver without refactor | 10.4, 11.5 | Reconvene: consider a thin adapter, or defer roadmap/content-plan v2 wiring to Phase 13+. UI must not go v2-visible until AI outputs match. |
| 9 | v2 UI would require showing both v1 and v2 numbers side-by-side as competing headlines | Prompt 11.2 output includes dual headlines or "v1 vs v2" hero widgets | 11.2, 11.3 | Reconvene: enforce single-headline rule (v2 realistic when flag on, v1 otherwise). v1 numbers only in tooltips / admin inspector. |
| 10 | Any prompt would require GA4 API, GSC API, brand/non-brand split, or full keyword-universe ingestion | Prompt output mentions new GA4/GSC API integration, brand tagging, or bulk keyword crawl | Any prompt, most likely 4.x, 6.x, 10.x | **Hard stop.** Rule §1.16–1.19 is inviolable. Reject the change and re-scope the prompt. |

**Commitment:** the Lovable agent will restate the applicable subset of this table at the start of every build turn, and will refuse to auto-fix any triggered condition without user consent.

---

## 6. Appendix C decisions check

| Encoded default | Consistent with codebase / prior docs? |
|---|---|
| DataForSEO Labs access not assumed | ✅ Matches follow-up doc §Product Decisions. |
| Standard DataForSEO fallback attempted | ✅ Current `keyword-enrichment` already uses `google_ads/search_volume/live`. |
| Historical backfill manual-first | ✅ Matches Rule §1.7. |
| ~50 keyword test projects | ✅ Aligns with observed project sizes; SLICE_SIZE=200 in current enrichment easily covers this. |
| GSC workbook = 16-month standard export | ✅ Prompt 3.2 validates 90–500 day span accordingly. |
| GSC CTR curves = all-device | ✅ Matches Prompt 4.1 output shape. |
| Brand/non-brand deferred to v2.1 | ✅ Rule §1.18. |
| Divergence: revenue >30%, HAR >2 positions | ✅ Prompt 10.3 uses 30%; HAR ±2 positions matches follow-up doc. |
| Conversion override required for URL/category, optional for project/intent | ✅ Prompt 10.1 pattern. |
| Run order (CTR → volume → demand → SERP → LPS → HAR v2 → Revenue v2) | ✅ Prompt 12.1 workflow matches. |
| Inspector before user-facing v2 UI | ✅ Phase 1.4 lands well before Phase 11. |
| Cron deferred to Phase 13 | ✅ Rule §1.6. |

**All Appendix C defaults are self-consistent and match the earlier alignment work.** No product-decision drift.

---

## 7. Residual product decisions needed before Prompt 0.1

Only one small decision is worth pinning before firing Prompt 0.1:

1. **HAR v1 missing-UR mitigation strategy (Prompt 9.1).** Recommendation: **median of known competitor UR in the same SERP, floor 10, ceiling = client UR**. If you'd rather use a percentile (e.g. P25) or a hard site-wide floor (e.g. 20), tell me before Phase 9 fires. Not a blocker for Phase 0–8.

Nothing else needs a decision. Prompts 0.1 → 8.3 can run as written.

---

## 8. Recommendation

**Proceed.** Fire Prompt 0.1 when ready. During the build:

- I will keep §5 (Stop-Condition Watchlist) contextualised on every turn.
- I will restate the 100-ID batch rule on Prompts 6.1, 6.2, 7.1, 9.2, 10.2 when firing them.
- I will flag the `keyword_forecast_scenarios (calc_run_id, keyword_id, scenario)` unique key when Prompt 1.3 fires so it lands in the right migration.
- I will ask for your HAR mitigation strategy answer before firing Prompt 9.1.

Everything else in the sequence is ready to run as-is.
