# Seer — Data & Calculations Audit

**Purpose.** A read-only reference for the calculations team. Maps every data point Seer holds, how it flows through the database, and how it is used by the algorithms behind HAR, revenue forecasting, seasonality, link scoring, and downstream AI features.

**Scope.** Covers the live schema and edge functions as of this audit. Nothing here changes code, database, or visuals.

---

## 1. Data-point inventory

### 1.1 Manual inputs (from the app UI)

| Domain | Table.column | Origin |
|---|---|---|
| Client identity | `clients.company_name`, `clients.domain`, `clients.domain_normalized`, `clients.industry`, `clients.campaign_type`, `clients.own_brand_tokens`, `clients.competitor_brands` | Client onboarding form |
| Client keyword rules | `keyword_rules.rule_type` (`whitelist`/`blacklist`), `keyword_rules.match_text` | Onboarding + rules library |
| Project config | `navigator_projects.project_name`, `.category_focus`, `.aov`, `.conversion_rate`, `.seasonality_start`, `.seasonality_end`, `.competitor_urls` (via `competitors`), `.status` | Navigator project form |
| Keyword seed | `keywords.keyword`, `keywords.device` | Manual paste / upload |
| GSC ingestion | `gsc_uploads.*`, `gsc_upload_keywords.keyword/clicks/impressions/position/ctr` | User CSV upload |
| HAR overrides | `keyword_forecasts.har`, `keyword_forecasts.har_is_manual` | Analyst edit |
| Monitor targets | `monitor_campaigns.*`, `monitored_urls.url` | URL Monitor UI |

### 1.2 External-API pulls

| API | Consumer | Fields written |
|---|---|---|
| **DataForSEO — Keywords Data / Google Ads Volume** | `keyword-enrichment` (mode `enrich`) | `keywords.avg_monthly_volume`, `.keyword_difficulty`, `.competition`, `.search_intent`, `.intent_confidence`, `.intent_source`, `keyword_monthly_volumes(month, volume)` |
| **DataForSEO — SERP Live/Task Google Organic** | `har-calculation` (post_serp/poll_serp), `content-plan-generate.fetchSerpTop3` | `serp_results(rank_absolute, url, domain, title, description, breadcrumb)`, `serp_features`, `serp_feature_index`, `serp_rankings`, `serp_top3_cache` |
| **Ahrefs — Batch analysis (URL mode)** | `har-calculation` (seed_ahrefs/fetch_ahrefs) | `har_ahrefs_queue(target_url, url_rating, domain_rating, ahrefs_rank)`, denormalised onto `serp_results.url_rating/.domain_rating/.ahrefs_rank`, `client_domain_metrics(url_rating, domain_rating, ahrefs_rank, fetched_at)` |
| **DataForSEO — Backlinks Summary** | `har-calculation` (seed_backlinks/fetch_backlinks) | `har_backlinks_queue(target_url, referring_domains, backlinks)`, denormalised onto `serp_results.referring_domains/.backlinks` and `backlink_metrics` |
| **Own crawler (fetch + parse)** | `url-monitor-tick` | `url_check_snapshots(http_status, final_url, redirect_chain, page_title, canonical_url, response_time_ms, error_message, checked_at)`, `url_issues(*)`, `monitored_urls.current_http_status/.current_status/.last_checked_at` |

### 1.3 AI-generated fields (Anthropic / Lovable AI Gateway)

| Producer function | Model | Writes to |
|---|---|---|
| `keyword-detox` (Pass 1 + Pass 2) | `claude-sonnet-4-6` | `keywords.detox_status` (`keep`/`removed`), `.detox_reason`, `.detox_confidence`, `detox_audit(*)`, `detox_run_stats(*)` |
| `keyword-categorisation` | `claude-haiku-4-5` | `keywords.tag_1..tag_5`, `.search_intent`, `.intent_confidence`, `.intent_source`, `.categorisation_status/.tier/.attempts`, `categorisation_jobs(*)` |
| `categorisation-consolidate` | `claude-sonnet-4-5` | `keywords.tag_1` (renames applied) |
| `site-architecture` | `google/gemini-3-flash-preview` (Lovable AI Gateway) | `site_architecture(relevancy_score, content_status, tactical_rag_status, matched_url)` |
| `content-plan-generate` | `claude-sonnet-4-5` | `content_plan_items.page_title_h1/.meta_title/.meta_description/.synopsis/.internal_links/.notes` |
| `roadmap-to-success` | `claude-sonnet-4-6` | `project_roadmaps.roadmap_markdown` |
| `gsc-intent-enrichment` | inherits `keyword-categorisation` model | fills intent on GSC-only rows |

### 1.4 Derived / computed (no external call)

| Producer | Writes |
|---|---|
| `compute-forecasts` | `keyword_forecasts.*` (11 numeric outputs), `keyword_challenges(*)` |
| `har-calculation.runPhaseCompute` | `har_results(har_position, client_url_rating, har_competitor_ur, har_competitor_url, calculated_at)` |
| `keyword-enrichment` (mode `peaks`) | `keywords.peak_month` |
| `ranking-url-lookup` | `keywords.ranking_url` |
| `serp-feature-upsert` | `serp_landscape(*)`, `serp_feature_index` |
| `ctr-benchmark` | `ctr_estimate_cache` (interim generic model), plus per-project `ctr_curves` when populated |

---

## 2. Database handling

### 2.1 Row-Level Security & scoping

- Every project-owned table is filtered by `public.is_visible_project(project_id)`; every client-owned table by `public.is_visible_client(client_id)`. Both are `SECURITY DEFINER` and check `user_client_access` plus admin/super_admin membership through `has_role`.
- Recent hardening removed duplicate unscoped `ALL` policies on the HAR queue tables (`har_serp_tasks`, `har_ahrefs_queue`, `har_backlinks_queue`) and on the monitor stack (`monitor_campaigns`, `monitored_urls`, `url_check_snapshots`, `url_issues`, `monitor_alert_settings`). Only scoped policies remain.
- `user_roles` sits in a dedicated table (never on `profiles`), read via the `has_role(uuid, app_role)` security-definer function. Signup defaults come from `handle_new_user`; elevation is guarded by `guard_user_roles_insert`.
- Archival lifecycle (`archive_client`, `restore_client`, `archive_project`, `restore_project`, `hard_delete_*`) is fenced by `_require_admin()` and logged to `archive_audit`.

### 2.2 Freshness / staleness controls

- `handleStart` in `har-calculation` uses a 7-day staleness cutoff before requeuing SERP, Ahrefs, or backlinks work; already-fresh phases are skipped straight to `runPhaseCompute`.
- `keyword-enrichment` skips per-column refetch when `volume_fetched_at`, `difficulty_fetched_at`, or `intent_fetched_at` are inside the same 7-day window.
- Categorisation attempts are ratchets (`keywords.categorisation_attempts`, capped at 5) with a stalled-claim release via `release_stale_categorisation_claims` and the `claim_categorisation_batch` claim function.
- HAR / SERP claim functions (`claim_har_serp_post_batch`, `claim_har_serp_fetch_batch`, `claim_har_serp_fetch_by_dfs_ids`, `claim_har_ahrefs_batch`, `claim_har_backlinks_batch`) share the same `FOR UPDATE SKIP LOCKED` pattern; `release_stale_har_claims` releases claims older than 5 minutes.

### 2.3 Denormalisation

- Ahrefs metrics live in `har_ahrefs_queue` per job and are also copied onto `serp_results` and `client_domain_metrics` so the UI can render without cross-joining live jobs.
- SERP top-3 for content planning is cached in `serp_top3_cache` keyed by `keyword_id + fetched_at` window.
- `keyword_forecasts` is a wide row per keyword — recomputed in full every run of `compute-forecasts` and always used as the single source of truth for revenue numbers.

### 2.4 Background schedulers

- `pg_cron` posts the shared secret `HAR_CRON_SECRET` (or `SUPABASE_SERVICE_ROLE_KEY`) to the tick endpoints on `har-calculation`, `keyword-categorisation`, `keyword-detox`, `categorisation-deferred-tick`, `url-monitor-tick`. All tick paths reject anonymous callers with 401.
- Deferred categorisation runs nightly at 02:00 UTC (`categorisation-deferred-tick`).

---

## 3. Algorithms & calculations — pipeline overview

Order of operations for a typical project after a fresh keyword upload:

1. **Detox** (`keyword-detox`): rules pre-pass → same-client cache → Sonnet Pass 1 batched → Sonnet Pass 2 adjudicator on uncertain / brand overlap / low-confidence / 2 % audit sample. Writes `detox_status`.
2. **Enrichment** (`keyword-enrichment` enrich): DataForSEO volume + difficulty + intent for kept keywords; monthly volumes stored per row.
3. **Peaks** (`keyword-enrichment` peaks): `keyword_monthly_volumes` → `keywords.peak_month` where peak ≥ 1.4 × mean and there are ≥ 6 months of data with mean ≥ 50.
4. **Ranking URL lookup** (`ranking-url-lookup`): populates `keywords.ranking_url` from SERP top-100 matches on the client domain.
5. **HAR** (`har-calculation`): SERP → Ahrefs → optional backlinks → `runPhaseCompute` → `har_results`. Auto-invokes `compute-forecasts` on completion.
6. **CTR curves**: interim generic model in `ctr_curves` (with `is_fallback=true`) resolved at forecast time; per-project overrides land here once GSC first-party CTR modelling ships.
7. **Forecasts** (`compute-forecasts`): revenue formula per row, cannibalisation "challenger" pass, seasonality flags. Writes `keyword_forecasts` + `keyword_challenges`.
8. **Site architecture** (`site-architecture`): batched Gemini call scoring keyword×URL fit.
9. **Categorisation** (`keyword-categorisation`): tier-routed Haiku calls with OTPM governor.
10. **Content plan** (`content-plan-generate`): cluster picker → SERP top-3 → single batched Sonnet call → `content_plan_items` with `publish_month`, `first_draft_deadline`.
11. **Roadmap** (`roadmap-to-success`): opportunity slice → Sonnet markdown roadmap; new row appended each run.
12. **URL monitor**: diff snapshots produce `url_issues` and update `monitored_urls.current_status`.
13. **Portfolio aggregates** (`useDashboardData`): rolls `keyword_forecasts`, `keyword_challenges`, seasonality, HAR into dashboard cards.

All calculation deep dives below reference this pipeline order.

---

## 4. Deep dive — HAR (Highest Achievable Rank)

### 4.1 Where it runs
`supabase/functions/har-calculation/index.ts` (1,161 lines). Job orchestration writes to `har_jobs`; work is split across `har_serp_tasks`, `har_ahrefs_queue`, `har_backlinks_queue`; final outputs land in `har_results` (per keyword), `client_domain_metrics` (per project), and denormalised columns on `serp_results`.

### 4.2 Job lifecycle

| Phase | Function step | Reads / writes |
|---|---|---|
| `handleStart` | Decides staleness (7 d), seeds `har_jobs`, enqueues per-keyword SERP tasks into `har_serp_tasks` (or skips straight to `fetch_ahrefs`). |
| `post_serp` | Claims batches via `claim_har_serp_post_batch(job_id, limit)`, posts DFS SERP tasks, stores `dfs_task_id` on `har_serp_tasks`. |
| `poll_serp` | Claims via `claim_har_serp_fetch_batch` / `claim_har_serp_fetch_by_dfs_ids`, pulls SERP payloads, writes `serp_results`, `serp_rankings`, `serp_features`, `serp_feature_index`. |
| `seed_ahrefs` | Collects distinct SERP URLs + client domain + configured competitor URLs into `har_ahrefs_queue`. |
| `fetch_ahrefs` | Claims via `claim_har_ahrefs_batch`, calls Ahrefs batch analysis (`target_mode` = `url` or `domain`), writes `url_rating`, `domain_rating`, `ahrefs_rank` back to the queue row. |
| `seed_backlinks` | (Optional; skipped if `job.backlinks_skipped`) queues DFS Backlinks Summary calls in `har_backlinks_queue`. |
| `fetch_backlinks` | Claims via `claim_har_backlinks_batch`, writes `referring_domains`, `backlinks`. |
| `compute` | `runPhaseCompute` (see below). |
| Post-compute | Calls `compute-forecasts` for the same project so revenue outputs refresh in the same run. |

Stale claims (>5 min) are released by `release_stale_har_claims` scheduled via cron.

### 4.3 `runPhaseCompute` — the actual HAR maths

Effective pseudo-code (mirrors lines 910–1053):

```text
ahrefsMap    = { url -> {url_rating, domain_rating, ahrefs_rank} }  # from har_ahrefs_queue
backlinksMap = { url -> {referring_domains, backlinks} }             # from har_backlinks_queue
serp_results = upsert metrics from ahrefsMap + backlinksMap onto every SERP row in the project
client_metrics = ahrefsMap[`https://<client_domain>`] or {0,0,0}
upsert client_domain_metrics for this project

for each kept keyword:
    kwClientUR = client_metrics.url_rating
    if keyword.ranking_url is set:
        u = normalise(keyword.ranking_url)
        kwClientUR = ahrefsMap[u]?.url_rating ?? client_metrics.url_rating

    serps = serp_results for this keyword, ordered by rank_absolute ASC

    har_position = null
    for c in serps:
        competitor_UR = ahrefsMap[c.url]?.url_rating ?? 0
        if kwClientUR >= competitor_UR:
            har_position       = c.rank_absolute
            har_competitor_ur  = competitor_UR
            har_competitor_url = c.url
            break

    upsert har_results { keyword_id, har_position, client_url_rating: kwClientUR,
                         har_competitor_ur, har_competitor_url, calculated_at: now() }
```

Key properties:

- The **only signal in the comparison is URL Rating**. Domain Rating and Ahrefs Rank are collected and stored on `serp_results` for display, but never fed into the ceiling decision.
- The client's UR is per-URL if a `ranking_url` is known; otherwise the client-domain UR is used as a proxy.
- Ties (`kwClientUR == competitor_UR`) win the position — the first competitor at or below the client wins the ceiling.
- If no competitor in the SERP satisfies the inequality, `har_position` is `NULL` and the row later gets `har_revenue_gain_annual = NULL` in `keyword_forecasts`.

### 4.4 Manual override path
`compute-forecasts` reads `keyword_forecasts.har_is_manual`. When true, the analyst-supplied `keyword_forecasts.har` wins; the automated `har_results.har_position` is ignored for that keyword. When false, `har_results.har_position` is preferred, falling back to any previous stored `har` if the compute pass hasn't run yet.

### 4.5 Assumptions to challenge

- **UR-only comparison.** No DR weighting, no referring-domain gap, no topical relevance, no anchor-text overlap, no historical stability. A keyword can flip its HAR by one point of UR movement on either side.
- **Static tie-breaking.** Ties resolve to whichever competitor appears first in the SERP order returned by DFS; there is no stability window across SERP volatility.
- **URL-level UR fallback.** When Ahrefs has no UR for the client's ranking URL, the domain-level UR is used. That inflates HAR for weak inner pages on strong domains and deflates it for strong inner pages on weak domains.
- **`kwClientUR = 0` guard.** Missing Ahrefs data collapses to zero, which almost always fails the inequality and produces `NULL` HAR. Root cause of most "empty TP revenue" reports.
- **No consideration of SERP feature blocking** (ads, PAA, video carousels) between rank 1 and the HAR position when applying CTR downstream.

### 4.6 Signals available for future improvement (HAR)

| Field already collected | Currently used? | Notes |
|---|---|---|
| `serp_results.domain_rating` | No (display only) | Candidate for a weighted score alongside UR. |
| `serp_results.referring_domains` / `.backlinks` | No | Available whenever backlinks phase is not skipped. |
| `backlink_metrics` (per ranking) | No | Historical view potentially usable for link-velocity. |
| `serp_features` / `serp_feature_index` | No | Could downgrade a "reachable" rank when the SERP is feature-heavy. |
| `client_domain_metrics.ahrefs_rank` | No | Available for a global authority baseline. |

---

## 5. Deep dive — Revenue formula

### 5.1 Where it runs
`supabase/functions/compute-forecasts/index.ts` (404 lines). Triggered from the app after HAR completes, and directly from various admin actions.

### 5.2 Inputs

| Input | Source |
|---|---|
| `volume` | `keywords.avg_monthly_volume` |
| `position` | `keywords.base_rank` |
| `device` | `keywords.device` (defaults to `mobile`) |
| `intent` | `keywords.search_intent` |
| `AOV` | `navigator_projects.aov` |
| `CVR` | `navigator_projects.conversion_rate / 100` |
| CTR table | `ctr_curves` filtered by `project_id` (interim generic model until GSC populates per-project rows) |
| HAR | `har_results.har_position` unless `keyword_forecasts.har_is_manual = true` |
| Ranking URL (for challenger pass) | `keywords.ranking_url` |
| Seasonality | `keywords.peak_month` (fallback: project seasonality window midpoint) |

### 5.3 Verbatim formulae

```text
currentCtr                = getCtr(device, intent, position)                # decimal, 0..1
ctrRank1                  = getCtr(device, intent, 1)
ctrAtHar                  = har != null ? getCtr(device, intent, har) : 0

weightedSum               = position ? volume * position : null

estCurrentClicksAnnual        = volume * currentCtr * 12
estCurrentRevenueAnnual       = estCurrentClicksAnnual * cvr * aov

expectedTrafficRank1Annual    = volume * ctrRank1 * 12
yearlyTrafficGainRank1        = max(expectedTrafficRank1Annual - estCurrentClicksAnnual, 0)
yearlyRevenueGainRank1        = yearlyTrafficGainRank1 * cvr * aov

if har != null:
    harTrafficAnnual          = volume * ctrAtHar * 12
    harTrafficGainAnnual      = max(harTrafficAnnual - estCurrentClicksAnnual, 0)
    harRevenueGainAnnual      = harTrafficAnnual * cvr * aov      # ABSOLUTE, not delta
```

Notes:

- `har_revenue_gain_annual` is deliberately the **absolute** annual revenue at the HAR position — the UI label "TP Revenue" reflects that. The column name is kept for backwards compatibility.
- `har_traffic_gain_annual` remains a *delta* (uplift over current).
- Annualisation is a flat ×12 of monthly volume; there is no seasonal weighting in the revenue numbers themselves — seasonality is expressed via urgency + capture-window flags only.
- No leakage / attribution factor is applied. `CVR` is treated as an aggregate site conversion rate, not intent-specific.
- Difficulty (`keyword_difficulty`) is not used anywhere in the revenue formula.

### 5.4 Opportunity tag rule

```text
!position || position >= 101  -> "opportunity"
position <= 3                 -> "maintain"
position <= 10                -> "improve"
otherwise                     -> "grow"
```

Surfaced on `keyword_forecasts.opportunity`, consumed by dashboard breakdowns and the roadmap prompt.

### 5.5 CTR resolver fallback order

`getCtr(device, intent, position)` walks this order and returns the first non-null match (all divided by 100 to return a decimal):

1. `device | intent | position`
2. `device | generic | position`
3. `device | transactional | position`
4. `device | commercial | position`
5. `device | informational | position`
6. `device | navigational | position`
7. Any curve at `device | * | position`
8. `0` (position > 20 or nothing available)

Positions are `Math.round(position)`. Anything past position 20 collapses to zero CTR.

### 5.6 Cannibalisation ("Challenger") pass

- Groups kept keywords by lowercased trimmed `ranking_url`.
- For each URL with ≥ 2 keywords, the row with the highest `est_current_revenue_annual` becomes the *current* keyword; every other keyword on the same URL is a *challenger*.
- For each challenger, writes to `keyword_challenges`:

```text
challenge_revenue_gain = challenger.yearly_revenue_gain_rank1   # what it would earn at #1 on its own page
revenue_uplift_pct     = challenge_revenue_gain / current.est_current_revenue_annual * 100
```

- Old challenges for the project are deleted first, then the new batch is inserted.

### 5.7 CTR-curve modelling — current interim state

- `ctr_curves` currently ships with a generic industry-standard curve per device × generic-intent × position, flagged via `is_fallback=true`.
- The resolver already prefers intent-specific curves; per-project overrides simply need to be inserted with `is_fallback=false` to take precedence.
- `ctr_estimate_cache` holds median-based per-position estimates for the CTR Benchmark tool. `gsc_upload_keywords` provides the raw first-party CTR that a project-scoped model can be trained on when the GSC integration lands.

### 5.8 Assumptions to challenge

- **Flat annualisation.** `× 12` ignores seasonality entirely for the revenue figure. Seasonal urgency is a separate signal that never re-weights revenue.
- **Uniform AOV + CVR.** No intent-based conversion adjustment (transactional vs informational).
- **CTR beyond position 20 = 0.** This is a hard cliff; volume from ranks 21–100 is worth exactly nothing in the model.
- **No SERP-feature deflator** on CTR (PAA, featured snippet, shopping unit).
- **Cannibalisation "wasted revenue" is not modelled** — only the upside of separating the challenger onto its own page.
- **Interim CTR model is generic.** All projects share the same fallback curves until GSC-driven per-project curves are populated.
- **Difficulty ignored.** `keyword_difficulty` never dampens forecasts; every keyword is assumed to be reachable at HAR.

### 5.9 Signals available for future improvement (Revenue)

- `gsc_upload_keywords.clicks/impressions/position/ctr` → per-project weighted-mean CTR curves.
- `keyword_monthly_volumes` → distribute annual clicks/revenue across months.
- `keyword_difficulty` → dampening factor on the probability of reaching HAR.
- `serp_features` / `serp_feature_index` → device- and intent-aware CTR deflators.
- `site_architecture.relevancy_score` → confidence weight on the current-position CTR (poor architectural fit likely under-earns even at the same rank).

---

## 6. Deep dive — Seasonality

### 6.1 Producer — `keyword-enrichment` (mode = `peaks`)

Lines 111–160. For every kept keyword slice:

```text
rows = keyword_monthly_volumes for keyword (month, volume)
if rows.length < 6: skip
avg = sum(volume) / rows.length
if avg < 50: skip
peak = row with max volume
peak_month = peak.month (as "MM") ONLY IF peak.volume >= avg * 1.4
```

Written to `keywords.peak_month` as a two-digit string. Non-seasonal rows keep `peak_month = NULL`.

### 6.2 Consumer — `compute-forecasts`

```text
fallbackPeakMonth = midpoint of navigator_projects.seasonality_start/.seasonality_end   # cyclic
nowMonth          = current calendar month (1..12)

ownPeak = parseInt(keywords.peak_month)
peak    = isFinite(ownPeak) ? ownPeak : fallbackPeakMonth
peakSource = ownPeak ? "keyword_volume" : "project_window"

monthsToPeak = (peak - nowMonth + 12) % 12
weeks        = monthsToPeak * 4.345
isInCaptureWindow = 8 <= weeks <= 16

urgency(weeks) =
     weeks < 0    -> 0.05
     weeks <= 4   -> 0.25
     weeks <= 8   -> 0.55
     weeks < 12   -> 0.85
     weeks <= 16  -> 1.00
     weeks <= 24  -> 0.70
     otherwise    -> 0.10
```

Written per keyword to `keyword_forecasts.months_to_peak`, `.seasonal_urgency`, `.is_in_capture_window`, `.peak_source`.

### 6.3 Portfolio aggregation
`useDashboardData.seasonalityMonthly` bins `keywords.peak_month` counts by month for the seasonality strip. `SeasonalityBadge` renders `is_in_capture_window` + `seasonal_urgency` on keyword rows and dashboard cards.

### 6.4 Content-plan consumer

In `content-plan-generate`:

```text
publish_month           = isoMonthOffset(peakMonth, -8 weeks)         # publish ~8 weeks before peak
lead_weeks              = hero ? 16 : 12
first_draft_deadline    = publish_month - lead_weeks * 7 days
```

`hero_lead_weeks=16`, `default_lead_weeks=12` are hard-coded constants.

### 6.5 Assumptions to challenge

- **Single-peak model.** Only one peak month per keyword; multi-peak keywords (e.g. Black Friday + January sales) collapse to whichever month has the maximum volume.
- **1.4 × mean threshold.** Fixed; ignores volatility of the series (e.g. flat-ish keywords with one noisy spike).
- **`avg >= 50` gate.** Long-tail seasonal keywords with genuinely low but predictable peaks are excluded from seasonality entirely.
- **Fallback = project-window midpoint.** Very coarse; every keyword without its own peak inherits the same synthetic date.
- **Urgency curve is a manual step function.** Not learned from historical performance data.
- **Publish offset is fixed 8 weeks.** Ignores content type, historical time-to-rank, or difficulty.

### 6.6 Signals available for future improvement (Seasonality)

- `keyword_monthly_volumes` full time series → multi-peak detection, volatility scoring, per-keyword shoulder-window.
- `keyword_difficulty` → variable publish lead time.
- `har_results.har_position` → factor into urgency (near-HAR keywords have shorter time-to-capture).
- Actual GSC click history → validation of the 8-week publish rule.

---

## 7. Deep dive — Link scoring & authority

### 7.1 Signals collected

| Signal | API | Storage |
|---|---|---|
| URL Rating (UR) | Ahrefs Batch Analysis (url mode) | `har_ahrefs_queue.url_rating` → denormalised onto `serp_results.url_rating` |
| Domain Rating (DR) | Ahrefs Batch Analysis (url/domain mode) | `har_ahrefs_queue.domain_rating` → `serp_results.domain_rating`, `client_domain_metrics.domain_rating` |
| Ahrefs Rank | Ahrefs | `har_ahrefs_queue.ahrefs_rank` → `serp_results.ahrefs_rank`, `client_domain_metrics.ahrefs_rank` |
| Referring domains | DataForSEO Backlinks Summary | `har_backlinks_queue.referring_domains` → `serp_results.referring_domains`, `backlink_metrics.referring_domains` |
| Total backlinks | DataForSEO Backlinks Summary | `har_backlinks_queue.backlinks` → `serp_results.backlinks`, `backlink_metrics.backlinks` |

### 7.2 Algorithmic consumers

- **HAR only.** `runPhaseCompute` uses UR (URL-level or, when unknown, domain-level) as the sole authority signal.
- Everything else is display-only.

### 7.3 Display-only consumers

- `HarAnalysisSection` — shows client UR vs competitor UR at HAR and the gap.
- `CompetitorBacklinkLandscape` and `CompetitorLandscapeReport` — rank competitors by DR / referring domains within a project.
- `roadmap-to-success` prompt payload — supplies `client_url_rating`, `competitor_url_rating_at_tp`, `link_gap_points`, `competitor_url_at_tp` to the LLM, but never computes a numeric recommendation from them.

### 7.4 Not currently modelled

- Composite authority score (UR + DR + link volume + trust).
- Topical authority (link relevance to the client's Tag 1 clusters).
- Link velocity (new referring domains per month).
- Trust / spam signals.
- Referring-domain gap thresholds (e.g. "need +N referring domains to reach TP").
- Anchor-text overlap.
- Historical stability of the top-N SERP link profile.

### 7.5 Levers for a stronger link-scoring model

- Extend `har_ahrefs_queue` writes to expose `serp_results.domain_rating`, `.referring_domains`, `.backlinks` in the HAR compute step as weighted factors alongside UR.
- Use `backlink_metrics` snapshotting (already keyed per ranking) as a velocity signal.
- Persist per-domain historical UR/DR — currently `client_domain_metrics` is one row per project, overwritten each run.

---

## 8. AI touch-points that overlap HAR / forecasts / seasonality

Detailed prompts, models, tool schemas and I/O contracts for every AI call are in the companion doc `docs/ai-prompt-companion.md`. The prompts that touch calculation data are:

- **Roadmap to Success** — reads `keyword_forecasts`, `har_results`, `site_architecture` and the client authority values to build the opportunity payload sent to Claude. Consumes the numbers but does not modify them.
- **Content Plan Briefing** — reads `keyword_forecasts.est_current_revenue_annual`, `.har_revenue_gain_annual`, seasonality (`peak_month`), and `site_architecture.tactical_rag_status` to select clusters, then uses Claude to generate H1/meta/synopsis. The cluster picker and revenue totals are code, not AI.

Detox, categorisation, categorisation-consolidate and site-architecture are pre-processing layers: they set the data on which calculations run (which keywords stay, what intent to bucket them by, which URL to compare against) but do not compute revenue, HAR, or seasonality numbers themselves.

---

## 9. Signals available for future improvement — consolidated

Grouped by the calculation you'd revise.

**HAR**
- `serp_results.domain_rating`, `.referring_domains`, `.backlinks` (collected, unused).
- `client_domain_metrics.ahrefs_rank`.
- `serp_features` / `serp_feature_index` — SERP composition-aware ceilings.
- `backlink_metrics` — historical velocity.

**Revenue / CTR**
- `gsc_upload_keywords` — per-project weighted-mean CTR curves.
- `keyword_difficulty` — dampening factor.
- `keyword_monthly_volumes` — replace flat ×12 with month-by-month distribution.
- `serp_features` — CTR deflators.
- `site_architecture.relevancy_score` — confidence weight on current-position CTR.

**Seasonality**
- Full `keyword_monthly_volumes` time series — multi-peak, volatility, shoulder windows.
- `keyword_difficulty` — variable publish lead time.
- Historical GSC clicks — validate publish offset.

**Link scoring**
- Composite UR + DR + link-volume score in HAR.
- `backlink_metrics` snapshots — velocity signal.
- Persist historical `client_domain_metrics` for trend.

---

*End of document. Prompt/model reference lives in `docs/ai-prompt-companion.md`.*
