// har-calculation-v2
// Phase 9 · Prompt 9.2 — HAR v2 composite scenario computation.
// Admin-only. Manual invocation. Reads stored data only (no external calls).
// Writes 3 rows per keyword to keyword_forecast_scenarios tagged with a
// calc_run_registry row (model_version = HAR_V2_MODEL_VERSION from _shared/har-v2.ts). Revenue fields left NULL.
// HAR v1 (har-calculation, har_results, keyword_forecasts) is not modified.
//
// Contract:
//   POST /functions/v1/har-calculation-v2
//   Body: { project_id: uuid }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  CALC_RUN_FAILED_STATUS,
  CALC_RUN_PARTIAL_STATUS,
  CALC_RUN_SUCCESS_STATUS,
  type CalcRunTerminalStatus,
} from "../_shared/calc-run-registry.ts";
import {
  HAR_V2_MODEL_VERSION,
  SCENARIOS,
  canonicalUrl,
  computeScenario,
  resolveClientRankingUrl,
  type ClientLpsSource,
  type ClientLpsMatch,
  type CompetitorRow,
  type CompositeInputs,
  type OverrideInfo,
  type ScoringConfig,
} from "../_shared/har-v2.ts";
import {
  buildContextDivisors,
  computeLpsForRow,
  type ClientDomainRef,
  type SerpRowMetrics,
} from "../_shared/link-power-score.ts";
import { selectIn } from "../_shared/pgrst-in.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const KW_CHUNK = 100;
const INSERT_CHUNK = 500;
const LPS_MODEL_VERSION = "lps_v2.0.0";

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
function err(status: number, code: string, error: string, extra: Record<string, unknown> = {}) {
  return json(status, { code, error, ...extra });
}
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function serializeErr(e: unknown): { code?: string; message: string; details?: string; hint?: string } {
  if (e instanceof Error) return { message: e.message };
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    return {
      code: typeof o.code === "string" ? o.code : undefined,
      message: typeof o.message === "string" ? o.message : JSON.stringify(e),
      details: typeof o.details === "string" ? o.details : undefined,
      hint: typeof o.hint === "string" ? o.hint : undefined,
    };
  }
  return { message: String(e) };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return err(405, "method_not_allowed", "POST only.");

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return err(500, "misconfigured", "Missing Supabase env.");

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return err(401, "unauthorized", "Missing Authorization header.");

  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  let payload: { project_id?: string };
  try { payload = await req.json(); } catch { return err(400, "invalid_payload", "Body must be JSON."); }
  const projectId = payload?.project_id;
  if (!projectId || typeof projectId !== "string") {
    return err(400, "invalid_payload", "project_id is required.");
  }

  // ---- Auth + admin ----
  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData?.user) return err(401, "unauthorized", "Invalid or expired token.");
  const userId = userData.user.id;

  const { data: roles, error: roleErr } = await sb.from("user_roles").select("role").eq("user_id", userId);
  if (roleErr) return err(500, "db_error", roleErr.message);
  const isAdmin = (roles ?? []).some((r: { role: string }) => r.role === "admin" || r.role === "super_admin");
  if (!isAdmin) return err(403, "forbidden_admin_only", "Admin role required.");

  // ---- Project visibility ----
  const { data: proj, error: projErr } = await sb
    .from("navigator_projects")
    .select("id, client_id, archived_at")
    .eq("id", projectId)
    .maybeSingle();
  if (projErr) return err(500, "db_error", projErr.message);
  if (!proj) return err(403, "forbidden_project", "Project not visible.");
  if ((proj as { archived_at?: string | null }).archived_at) {
    return err(409, "project_archived", "Cannot compute HAR v2 for an archived project.");
  }

  // ---- Duplicate-run guard (15 min) ----
  const staleCutoffIso = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data: inflight, error: inflightErr } = await sb
    .from("calc_run_registry")
    .select("id, started_at")
    .eq("project_id", projectId)
    .eq("model_version", HAR_V2_MODEL_VERSION)
    .eq("status", "running")
    .is("finished_at", null)
    .gte("started_at", staleCutoffIso)
    .order("started_at", { ascending: false })
    .limit(1);
  if (inflightErr) return err(500, "db_error", inflightErr.message);
  if (inflight && inflight.length > 0) {
    const existing = inflight[0] as { id: string; started_at: string };
    return err(409, "har_v2_run_in_progress", "Another HAR v2 run is already in progress.", {
      calc_run_id: existing.id,
      started_at: existing.started_at,
    });
  }

  // ---- Client authority + domain (reference) ----
  const { data: cdmRows, error: cdmErr } = await sb
    .from("client_domain_metrics")
    .select("url_rating, domain_rating, ahrefs_rank, fetched_at, domain")
    .eq("project_id", projectId)
    .order("fetched_at", { ascending: false, nullsFirst: false })
    .limit(1);
  if (cdmErr) return err(500, "db_error", cdmErr.message);
  const clientAuth = (cdmRows ?? [])[0] as
    | { url_rating: number | null; domain_rating: number | null; ahrefs_rank: number | null; fetched_at: string | null; domain: string | null }
    | undefined;
  const clientUr = clientAuth?.url_rating ?? null;
  const clientDr = clientAuth?.domain_rating ?? null;
  const hasClientAuthority = clientUr != null || clientDr != null;

  const { data: clientRow, error: clientErr } = await sb
    .from("clients")
    .select("domain, domain_normalized")
    .eq("id", (proj as { client_id: string }).client_id)
    .maybeSingle();
  if (clientErr) return err(500, "db_error", clientErr.message);
  const clientDomain = (clientRow as { domain_normalized?: string | null; domain?: string | null } | null)?.domain_normalized
    ?? (clientRow as { domain?: string | null } | null)?.domain
    ?? clientAuth?.domain
    ?? null;
  const clientRef: ClientDomainRef | null = clientAuth
    ? {
        domain: clientAuth.domain ?? clientDomain,
        url_rating: clientAuth.url_rating,
        domain_rating: clientAuth.domain_rating,
        ahrefs_rank: clientAuth.ahrefs_rank,
        fetched_at: clientAuth.fetched_at,
      }
    : null;

  // ---- Latest successful LPS run (for client + competitor LPS lookup) ----
  const { data: lpsRunRow, error: lpsRunErr } = await sb
    .from("calc_run_registry")
    .select("id")
    .eq("project_id", projectId)
    .eq("model_version", LPS_MODEL_VERSION)
    .in("status", ["succeeded", "partial"])
    .order("started_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lpsRunErr) return err(500, "db_error", lpsRunErr.message);
  const latestLpsRunId = (lpsRunRow as { id: string } | null)?.id ?? null;
  const latestLpsRunExists = !!latestLpsRunId;

  // ---- Active HAR scoring config (Prompt 1.7) ---------------------------
  // Loaded once per run so operators can tune scenario knobs without a code
  // deploy. Falls back to hard-coded defaults inside computeScenario when a
  // key is missing from thresholds_json.
  const { data: scoringCfgRow, error: scoringCfgErr } = await sb
    .from("har_scoring_config")
    .select("id, version, thresholds_json")
    .eq("is_active", true)
    .maybeSingle();
  if (scoringCfgErr) return err(500, "db_error", scoringCfgErr.message);
  const thresholds = (scoringCfgRow?.thresholds_json ?? {}) as Record<string, unknown>;
  const asMap = (v: unknown): Record<string, number> | undefined => {
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, number>;
    return undefined;
  };
  const scoringConfig: ScoringConfig | undefined = scoringCfgRow
    ? {
        config_id: (scoringCfgRow as { id: string }).id,
        config_version: (scoringCfgRow as { version: string }).version,
        scenario_thresholds: asMap(thresholds.scenario_thresholds),
        scenario_temperatures: asMap(thresholds.scenario_temperatures),
        scenario_floor_multipliers: asMap(thresholds.scenario_floor_multipliers),
        scenario_prob_factors: asMap(thresholds.scenario_prob_factors),
        min_confidence: typeof thresholds.min_confidence === "number"
          ? (thresholds.min_confidence as number)
          : null,
      }
    : undefined;

  // ---- Open calc_run_registry ----
  const { data: runIns, error: runErr } = await sb
    .from("calc_run_registry")
    .insert({
      project_id: projectId,
      triggered_by: userId,
      trigger_source: "admin_manual",
      model_version: HAR_V2_MODEL_VERSION,
      scope: {
        kind: "har_v2",
        latest_lps_run_id: latestLpsRunId,
        scoring_config_id: scoringConfig?.config_id ?? null,
        scoring_config_version: scoringConfig?.config_version ?? null,
      },
      status: "running",
      warnings: [],
      errors: [],
      summary_json: {},
    })
    .select("id")
    .single();
  if (runErr || !runIns) return err(500, "db_error", runErr?.message ?? "Failed to open calc run.");
  const calcRunId = (runIns as { id: string }).id;

  const closeRun = async (
    status: CalcRunTerminalStatus,
    summary: Record<string, unknown>,
    warnings: unknown[],
    errors: unknown[],
  ) => {
    const { error: closeErr } = await sb.from("calc_run_registry").update({
      status,
      finished_at: new Date().toISOString(),
      summary_json: summary,
      warnings,
      errors,
    }).eq("id", calcRunId);
    if (closeErr) throw new Error(`calc_run_close_failed: ${closeErr.message}`);
  };

  try {
    // ---- Kept keywords (include ranking_url for client-LPS resolution) ----
    const keptKws: Array<{ id: string; base_rank: number | null; ranking_url: string | null }> = [];
    let offset = 0;
    while (true) {
      const { data, error } = await sb
        .from("keywords")
        .select("id, base_rank, ranking_url")
        .eq("project_id", projectId)
        .eq("detox_status", "keep")
        .range(offset, offset + 999);
      if (error) throw error;
      const rows = (data ?? []) as Array<{ id: string; base_rank: number | null; ranking_url: string | null }>;
      keptKws.push(...rows);
      if (rows.length < 1000) break;
      offset += 1000;
    }
    const keywordIds = keptKws.map((k) => String(k.id));
    const baseRankByKw = new Map<string, number | null>(keptKws.map((k) => [String(k.id), k.base_rank]));
    const clientResolvedUrlByKw = new Map<string, string | null>(
      keptKws.map((k) => [String(k.id), resolveClientRankingUrl(k.ranking_url, clientDomain)]),
    );

    const runWarnings: unknown[] = [];
    const dbErrors: unknown[] = [];

    if (keywordIds.length === 0) {
      const summary = {
        model_version: HAR_V2_MODEL_VERSION,
        keywords_total: 0, keywords_written: 0, scenarios_written: 0,
        skipped_reason: "no_kept_keywords",
      };
      await closeRun(CALC_RUN_SUCCESS_STATUS, summary, runWarnings, []);
      return json(200, { calc_run_id: calcRunId, summary });
    }

    // ---- Upfront maps: manual overrides, per-batch data loaded lazily ----
    const overrideByKw = new Map<string, OverrideInfo>();
    // Incident 2026-07-16-part2: previously `chunk(keywordIds, 500)` produced
    // ~19 KB URLs and aborted with `TypeError: error sending request`. Route
    // through selectIn (MAX_IN_CHUNK=100) to keep every URL well under caps.
    let keywordForecastsFetched = 0;
    {
      const rows = await selectIn<{ id: string; keyword_id: string; har: number | null; har_is_manual: boolean }>(
        sb,
        "keyword_forecasts",
        "id, keyword_id, har, har_is_manual",
        "keyword_id",
        keywordIds,
      );
      keywordForecastsFetched = rows.length;
      for (const r of rows) {
        if (r.har_is_manual && r.har != null) {
          overrideByKw.set(String(r.keyword_id), { har: Number(r.har), v1_forecast_id: r.id });
        }
      }
    }

    let keywordsWritten = 0;
    let keywordsSkipped = 0;
    let scenariosWritten = 0;
    let overrideCount = 0;
    let missingLpsCount = 0;
    let syntheticLpsCount = 0;
    let realClientLpsCount = 0;
    let domainFallbackLpsCount = 0;
    let missingSerpCount = 0;
    let missingContentFitCount = 0;
    const rowsFetched = {
      keywords: keptKws.length,
      keyword_forecasts: keywordForecastsFetched,
      serp_results: 0,
      link_power_scores: 0,
      site_architecture: 0,
      serp_features: 0,
      serp_features_distinct: 0,
    };

    const missingLpsSamples: string[] = [];
    const missingSerpSamples: string[] = [];
    const missingContentSamples: string[] = [];
    const pushSample = (arr: string[], v: string) => { if (arr.length < 10) arr.push(v); };

    const insertBuffer: Array<Record<string, unknown>> = [];
    const flush = async () => {
      if (!insertBuffer.length) return;
      const batch = insertBuffer.splice(0, insertBuffer.length);
      const { error } = await sb.from("keyword_forecast_scenarios").insert(batch);
      if (error) {
        dbErrors.push({ code: "insert_failed", message: error.message, chunk_size: batch.length });
      } else {
        scenariosWritten += batch.length;
      }
    };

    for (const kwBatch of chunk(keywordIds, KW_CHUNK)) {
      // SERP results for this batch — include rd/bl so we can build divisors
      // for synthetic client LPS computation.
      // Truncation-remediation 2026-07-18: route through selectIn(paginate)
      // so heavy batches never silently cap at the 1,000-row default.
      const serpRaw = await selectIn<Record<string, unknown>>(
        sb,
        "serp_results",
        "keyword_id, rank_absolute, url, domain, url_rating, domain_rating, referring_domains, backlinks",
        "keyword_id",
        kwBatch,
        { paginate: true },
      );
      rowsFetched.serp_results += serpRaw.length;
      const serpByKw = new Map<string, CompetitorRow[]>();
      const serpMetricsRows: SerpRowMetrics[] = [];
      for (const r of serpRaw) {
        const kid = String(r.keyword_id);
        if (!serpByKw.has(kid)) serpByKw.set(kid, []);
        serpByKw.get(kid)!.push({
          rank_absolute: r.rank_absolute == null ? null : Number(r.rank_absolute),
          url: (r.url as string | null) ?? null,
          domain: (r.domain as string | null) ?? null,
          url_rating: r.url_rating == null ? null : Number(r.url_rating),
          domain_rating: r.domain_rating == null ? null : Number(r.domain_rating),
          lps_score: null, // filled below
        });
        serpMetricsRows.push({
          keyword_id: kid,
          url_rating: r.url_rating == null ? null : Number(r.url_rating),
          domain_rating: r.domain_rating == null ? null : Number(r.domain_rating),
          referring_domains: r.referring_domains == null ? null : Number(r.referring_domains),
          backlinks: r.backlinks == null ? null : Number(r.backlinks),
        });
      }

      // Divisors for synthetic client LPS (per-keyword or project-p95 fallback).
      const lpsDivisors = buildContextDivisors(serpMetricsRows);

      // LPS rows for this batch (only from latest LPS run). Store by canonical
      // URL so the client's ranking_url can be matched directly. Also keep a
      // per-keyword best-scoring row whose domain matches the client — used as
      // a fallback when keywords.ranking_url is NULL but the client is
      // actually in the SERP.
      const lpsByKwCanonical = new Map<string, number>();
      const lpsByKwClientDomain = new Map<string, { lps_score: number; url: string }>();
      if (latestLpsRunId) {
        const lpsRaw = await selectIn<{ keyword_id: string; url: string; lps_score: number; domain: string | null }>(
          sb,
          "link_power_scores",
          "keyword_id, url, lps_score, domain",
          "keyword_id",
          kwBatch,
          { paginate: true, extraFilter: (q) => q.eq("calc_run_id", latestLpsRunId) },
        );
        rowsFetched.link_power_scores += lpsRaw.length;
        for (const r of lpsRaw) {
          const canon = canonicalUrl(r.url);
          if (canon) lpsByKwCanonical.set(`${r.keyword_id}::${canon}`, Number(r.lps_score));
          if (clientDomain) {
            let rowDomain = (r.domain ?? "").toLowerCase().replace(/^www\./, "");
            if (!rowDomain && canon) {
              try { rowDomain = new URL(canon).hostname; } catch { /* noop */ }
            }
            if (rowDomain && rowDomain === clientDomain) {
              const prev = lpsByKwClientDomain.get(String(r.keyword_id));
              if (!prev || Number(r.lps_score) > prev.lps_score) {
                lpsByKwClientDomain.set(String(r.keyword_id), {
                  lps_score: Number(r.lps_score),
                  url: canon ?? r.url,
                });
              }
            }
          }
        }
      }
      // Attach LPS to competitors by canonical URL.
      for (const [kid, rows] of serpByKw) {
        for (const r of rows) {
          const canon = canonicalUrl(r.url);
          if (!canon) continue;
          const key = `${kid}::${canon}`;
          if (lpsByKwCanonical.has(key)) r.lps_score = lpsByKwCanonical.get(key)!;
        }
      }

      // Site architecture (content fit).
      const { data: saRaw, error: saErr } = await sb
        .from("site_architecture")
        .select("keyword_id, relevancy_score")
        .in("keyword_id", kwBatch);
      if (saErr) throw saErr;
      rowsFetched.site_architecture += (saRaw ?? []).length;
      const contentByKw = new Map<string, number | null>();
      for (const r of (saRaw ?? []) as Array<{ keyword_id: string; relevancy_score: number | null }>) {
        contentByKw.set(String(r.keyword_id), r.relevancy_score);
      }

      // SERP features. This table accumulates rows per ingest with no
      // snapshot/created_at discriminator (~23 rows/kw observed on TVs Ongoing,
      // max 82). A 100-kw chunk therefore routinely exceeds the 1,000-row
      // PostgREST cap and the raw `.in(...)` call above silently truncated
      // (see docs/truncation-audit-2026-07-18.md follow-up). Route through
      // selectIn with paginate:true and dedupe by (keyword_id, result_type)
      // (first-wins) so the retained aggregate values are deterministic
      // regardless of ingest history.
      const sfRaw = await selectIn<Record<string, unknown>>(
        sb,
        "serp_features",
        "keyword_id, result_type, serp_feature_count, top_serp_feature, snippet_opportunity",
        "keyword_id",
        kwBatch,
        { paginate: true },
      );
      rowsFetched.serp_features += sfRaw.length;
      const sfByKw = new Map<string, { count: number | null; top: string | null; snippet: boolean | null }>();
      const seenSfPairs = new Set<string>();
      for (const r of sfRaw) {
        const kid = String(r.keyword_id);
        const rt = ((r.result_type as string | null) ?? "").toLowerCase().trim();
        const pairKey = `${kid}::${rt}`;
        if (rt && seenSfPairs.has(pairKey)) continue;
        if (rt) seenSfPairs.add(pairKey);
        // First-wins per (keyword_id, result_type). The per-keyword aggregate
        // (count/top/snippet) is set once from the first row for the keyword.
        if (!sfByKw.has(kid)) {
          sfByKw.set(kid, {
            count: r.serp_feature_count == null ? null : Number(r.serp_feature_count),
            top: (r.top_serp_feature as string | null) ?? null,
            snippet: r.snippet_opportunity == null ? null : Boolean(r.snippet_opportunity),
          });
        }
      }
      rowsFetched.serp_features_distinct += seenSfPairs.size;

      // Compute per keyword.
      for (const kid of kwBatch) {
        const competitors = serpByKw.get(kid) ?? [];
        if (!competitors.length) {
          missingSerpCount += 1;
          pushSample(missingSerpSamples, kid);
        }
        const contentFit = contentByKw.has(kid) ? contentByKw.get(kid)! : null;
        if (contentFit == null) {
          missingContentFitCount += 1;
          pushSample(missingContentSamples, kid);
        }
        const sf = sfByKw.get(kid) ?? { count: null, top: null, snippet: null };

        // Client LPS resolution:
        //  1. Match client's resolved ranking URL against LPS rows for this
        //     keyword (best signal — page-level LPS for the exact ranking URL).
        //  1b. If keywords.ranking_url is null/unmatched, fall back to any LPS
        //     row for this keyword whose domain equals the client's domain.
        //     Uses the actual observed SERP URL and is still real page-level
        //     LPS — just without a manually-set ranking_url.
        //  2. Otherwise, if we have UR/DR from client_domain_metrics, compute
        //     a synthetic client LPS in-memory using the shared LPS formula
        //     and per-keyword/project divisors from this keyword's SERP rows.
        //  3. Otherwise, leave null and apply the standard confidence penalty.
        const clientResolvedUrl = clientResolvedUrlByKw.get(kid) ?? null;
        let clientLps: number | null = null;
        let clientLpsSource: ClientLpsSource = "unavailable";
        let clientLpsMatch: ClientLpsMatch = "unavailable";
        let resolvedUrlForExplanation: string | null = clientResolvedUrl;
        if (clientResolvedUrl) {
          const key = `${kid}::${clientResolvedUrl}`;
          if (lpsByKwCanonical.has(key)) {
            clientLps = lpsByKwCanonical.get(key)!;
            clientLpsSource = "serp_row";
            clientLpsMatch = "ranking_url";
          }
        }
        if (clientLps == null && lpsByKwClientDomain.has(kid)) {
          const hit = lpsByKwClientDomain.get(kid)!;
          clientLps = hit.lps_score;
          clientLpsSource = "serp_row";
          clientLpsMatch = "domain_fallback";
          resolvedUrlForExplanation = hit.url;
          domainFallbackLpsCount += 1;
        }
        // Default fallback: synthesise client LPS from client_domain_metrics
        // whenever we have UR or DR, regardless of ranking-URL match. This keeps
        // per-competitor LPS-vs-LPS pBeat available instead of collapsing to
        // UR-vs-UR when the client SERP row is missing.
        if (clientLps == null && (clientUr != null || clientDr != null)) {
          const refForSynth: ClientDomainRef = clientRef ?? {
            domain: clientDomain,
            url_rating: clientUr,
            domain_rating: clientDr,
            ahrefs_rank: null,
            fetched_at: null,
          };
          const synth = computeLpsForRow(
            {
              keyword_id: kid,
              url_rating: clientUr,
              domain_rating: clientDr,
              referring_domains: null,
              backlinks: null,
            },
            lpsDivisors,
            { clientDomain, clientRef: refForSynth },
          );
          if (synth.lps_score > 0) {
            clientLps = synth.lps_score;
            clientLpsSource = "synthetic_client_domain";
            clientLpsMatch = "synthetic";
          }
        }


        const hasClientLpsRow = clientLpsSource !== "unavailable";
        if (clientLpsSource === "serp_row") realClientLpsCount += 1;
        else if (clientLpsSource === "synthetic_client_domain") syntheticLpsCount += 1;
        else if (latestLpsRunExists) {
          missingLpsCount += 1;
          pushSample(missingLpsSamples, kid);
        }

        const inputs: CompositeInputs = {
          client_lps: clientLps,
          client_ur: clientUr,
          client_dr: clientDr,
          client_lps_source: clientLpsSource,
          client_lps_match: clientLpsMatch,
          client_resolved_url: resolvedUrlForExplanation,
          competitors,
          content_fit_score: contentFit,
          serp_feature_count: sf.count,
          top_serp_feature: sf.top,
          snippet_opportunity: sf.snippet,
          base_rank: baseRankByKw.get(kid) ?? null,
          latest_lps_run_exists: latestLpsRunExists,
          has_client_lps_row: hasClientLpsRow,
          has_client_authority: hasClientAuthority,
        };

        const override = overrideByKw.get(kid) ?? null;
        if (override) overrideCount += 1;

        let wroteAny = false;
        for (const scenario of SCENARIOS) {
          const res = computeScenario(inputs, scenario, override, scoringConfig);
          insertBuffer.push({
            project_id: projectId,
            keyword_id: kid,
            calc_run_id: calcRunId,
            scenario,
            har_position: res.har_position,
            har_confidence: res.har_confidence,
            rank_attainment_probability: res.rank_attainment_probability,
            authority_score: res.authority_score,
            link_power_score: res.link_power_score,
            link_gap_score: res.link_gap_score,
            content_fit_score: res.content_fit_score,
            serp_visibility_multiplier: res.serp_visibility_multiplier,
            explanation_json: res.explanation_json,
            monthly_revenue_json: {},
            tp_absolute_revenue_annual: null,
            tp_incremental_revenue_annual: null,
            expected_incremental_revenue_annual: null,
            current_revenue_annual: null,
          });
          wroteAny = true;
          if (insertBuffer.length >= INSERT_CHUNK) await flush();
        }
        if (wroteAny) keywordsWritten += 1; else keywordsSkipped += 1;
      }
    }

    await flush();

    if (missingLpsCount > 0) runWarnings.push({ code: "missing_lps_row", count: missingLpsCount, samples: missingLpsSamples });
    if (missingSerpCount > 0) runWarnings.push({ code: "missing_serp_data", count: missingSerpCount, samples: missingSerpSamples });
    if (missingContentFitCount > 0) runWarnings.push({ code: "missing_content_fit", count: missingContentFitCount, samples: missingContentSamples });
    if (!latestLpsRunExists) runWarnings.push({ code: "no_lps_run", message: "No successful LPS run exists for this project; confidence penalised across all scenarios." });
    if (!hasClientAuthority) runWarnings.push({ code: "missing_client_authority", message: "client_domain_metrics has no UR/DR for this project." });

    if (syntheticLpsCount > 0) runWarnings.push({ code: "synthetic_client_lps", count: syntheticLpsCount, message: "Client LPS computed from client_domain_metrics UR/DR (no SERP match)." });

    const summary = {
      model_version: HAR_V2_MODEL_VERSION,
      keywords_total: keywordIds.length,
      keywords_written: keywordsWritten,
      keywords_skipped: keywordsSkipped,
      scenarios_written: scenariosWritten,
      override_count: overrideCount,
      real_client_lps_count: realClientLpsCount,
      domain_fallback_lps_count: domainFallbackLpsCount,
      synthetic_client_lps_count: syntheticLpsCount,
      missing_lps_count: missingLpsCount,
      missing_serp_count: missingSerpCount,
      missing_content_fit_count: missingContentFitCount,
      missing_client_authority: !hasClientAuthority,
      client_domain: clientDomain,
      latest_lps_run_id: latestLpsRunId,
      scoring_config_id: scoringConfig?.config_id ?? null,
      scoring_config_version: scoringConfig?.config_version ?? null,
      rows_fetched: rowsFetched,
    };

    let status: CalcRunTerminalStatus = CALC_RUN_SUCCESS_STATUS;
    if (dbErrors.length && scenariosWritten === 0) status = CALC_RUN_FAILED_STATUS;
    else if (dbErrors.length) status = CALC_RUN_PARTIAL_STATUS;

    await closeRun(status, summary, runWarnings, dbErrors);

    console.log(
      "[har-calculation-v2] project=%s kw_total=%d kw_written=%d scenarios=%d overrides=%d",
      projectId, keywordIds.length, keywordsWritten, scenariosWritten, overrideCount,
    );

    return json(200, { calc_run_id: calcRunId, summary });
  } catch (e) {
    const se = serializeErr(e);
    console.error("[har-calculation-v2] unhandled", JSON.stringify(se), e);
    try {
      await closeRun(
        CALC_RUN_FAILED_STATUS,
        { error: se },
        [],
        [{ code: se.code ?? "unhandled", message: se.message, details: se.details, hint: se.hint }],
      );
    } catch (closeErr) {
      console.error("[har-calculation-v2] close-on-error failed", closeErr);
    }
    return err(500, se.code ?? "unhandled", se.message);
  }
});
