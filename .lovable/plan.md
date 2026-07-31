# V1 Forecast Path — 5,000-Keyword Feasibility Investigation

Read-only investigation mirroring the v2 feasibility dossier. No code, migrations, deploys, or job triggers. Deliverable is a single markdown file.

## Deliverable
`docs/v1-at-5k-feasibility-2026-07-21.md`

## Sections (matching the 7 DO items)

1. **Row Emission in `compute-forecasts`**
   - Cite the kept-keyword fetch loop and the forecast upsert in `supabase/functions/compute-forecasts/index.ts` (already partially visible: lines 78–99, 197–299).
   - Explicitly state what is written when: (a) `har_results` has no row, (b) `har_position` is null, (c) `base_rank` is null / client does not rank.
   - Query the DB for the most recent v1 forecast run on any project: kept keyword count vs `keyword_forecasts` rows produced; count of rows with `har IS NULL` and `har_revenue_gain_annual IS NULL`.

2. **Confirm No Content-Fit Dependency**
   - `rg site_architecture|relevancy_score` inside `supabase/functions/har-calculation/index.ts` and `compute-forecasts/index.ts`.
   - Report absent or cite occurrences.

3. **Compute Phase at Scale (`har-calculation`)**
   - Read `har-calculation/index.ts`, describe per-keyword compute work, batching, and TICK_BUDGET_MS=50s behaviour (retry / resume / fail).
   - Query `har_jobs` for the largest run on record (max keyword count), report observed compute-phase duration.

4. **compute-forecasts Timing & Memory**
   - Enumerate in-memory structures: `allKeywords`, `existingForecasts`, `harResultsMap`, `forecasts` batch, `forecastMap`, `urlGroups`, `challenges`, `ctrMap`.
   - Query `keyword_forecasts` / logs for wall-time on the largest run available; if wall time isn't persisted, state that and use inferred timing (row count × per-row work).
   - Linear-project to 5,000 kw vs 400s background ceiling and 256MB soft memory limit.

5. **"Project not found"**
   - Cite the exact `.from("navigator_projects").select(...).eq("id", project_id).single()` query at compute-forecasts/index.ts:31–36.
   - Explain why it fails (RLS + caller-authed client, archived project filter, `.single()` throws on 0 rows) — cross-reference the v2 auth-mismatch trace from the v2 dossier.
   - State the minimal change (e.g., `.maybeSingle()` + service role, or ensuring caller-visible project).

6. **CTR Curve Source**
   - Cite the `ctr_curves` select at lines 42–46 (project_id-scoped only).
   - State whether NULL-project fallback rows are read (they are not — filter is `.eq("project_id", project_id)`).
   - Compare with the writer path (`ctr-curves-from-gsc` + setup-page flow) to state which rows this actually consumes.

7. **Minimum V1 Autonomous Path for a GSC-sourced 5k Project**
   - Ordered stages: GSC upload → GSC intent enrichment → **GSC→keywords promotion (MISSING per Part 5)** → keyword-enrichment → base-rank → HAR v1 → compute-forecasts v1.
   - For each: autonomous today (yes/no) and specific blocker, reusing findings from `orchestration-dossier-part{4,5,6}` and `autonomous-pipeline-audit-2026-07-21.md`.

## Method
- File reads: `compute-forecasts/index.ts` (have most of it), `har-calculation/index.ts`, plus `rg` for site_architecture/relevancy_score.
- DB queries via `supabase--read_query`:
  - Latest v1 forecast run row counts + NULL har counts.
  - `har_jobs` largest run keyword_count + phase timestamps.
  - Any `keyword_forecasts.updated_at` distribution to bound wall time.
- Cross-reference existing dossiers (Parts 4–6, v2 feasibility) for shared findings; do not duplicate verbatim.

## Constraints
- Read-only. No edits, migrations, deploys, or fixes proposed beyond the single "minimal change" call-out required by item 5.
- Every quantitative claim backed by a cited query or file:line.
