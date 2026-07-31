// link-power-score-compute
// Phase 8 · Prompt 8.1 — Link Power Score v2 shadow compute.
// Admin-only. Manual invocation. Reads stored serp_results +
// client_domain_metrics. Writes rows to link_power_scores tagged with a
// calc_run_registry id (model_version = lps_v2.0.0). No external API calls,
// no changes to v1 HAR / forecasts / revenue.
//
// Contract:
//   POST /functions/v1/link-power-score-compute
//   Body: { project_id: uuid, dry_run?: boolean, limit_keywords?: number }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  CALC_RUN_FAILED_STATUS,
  CALC_RUN_SUCCESS_STATUS,
  type CalcRunTerminalStatus,
} from "../_shared/calc-run-registry.ts";
import {
  buildContextDivisors,
  computeLpsForRow,
  LPS_MODEL_VERSION,
  normUrl,
  scoreDistribution,
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

const MAX_LIMIT = 5000;
const KW_ID_CHUNK = 100;
const INSERT_CHUNK = 500;

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
function normDomain(d: string | null | undefined): string | null {
  if (!d) return null;
  const s = String(d).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  return s || null;
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

  let payload: { project_id?: string; dry_run?: boolean; limit_keywords?: number };
  try { payload = await req.json(); } catch { return err(400, "invalid_payload", "Body must be JSON."); }

  const projectId = payload?.project_id;
  if (!projectId || typeof projectId !== "string") {
    return err(400, "invalid_payload", "project_id is required.");
  }
  const dryRun = !!payload?.dry_run;
  const rawLimit = Number(payload?.limit_keywords ?? 0);
  const limitKeywords =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(MAX_LIMIT, Math.floor(rawLimit))
      : null;

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
    return err(409, "project_archived", "Cannot compute LPS for an archived project.");
  }

  const clientId = (proj as { client_id?: string | null }).client_id ?? null;

  // ---- Client domain reference ----
  let clientDomain: string | null = null;
  let clientRef: ClientDomainRef | null = null;
  if (clientId) {
    const { data: clientRow, error: cErr } = await sb
      .from("clients")
      .select("domain_normalized, domain")
      .eq("id", clientId)
      .maybeSingle();
    if (cErr) return err(500, "db_error", cErr.message);
    clientDomain = normDomain(
      (clientRow as { domain_normalized?: string | null; domain?: string | null } | null)?.domain_normalized
      ?? (clientRow as { domain?: string | null } | null)?.domain
      ?? null,
    );
  }
  if (clientDomain) {
    const { data: cdmRows, error: cdmErr } = await sb
      .from("client_domain_metrics")
      .select("domain, url_rating, domain_rating, ahrefs_rank, fetched_at")
      .eq("project_id", projectId)
      .eq("domain", clientDomain)
      .order("fetched_at", { ascending: false, nullsFirst: false })
      .limit(1);
    if (cdmErr) return err(500, "db_error", cdmErr.message);
    const row = (cdmRows ?? [])[0] as ClientDomainRef | undefined;
    if (row) clientRef = { ...row, domain: normDomain(row.domain) };
  }

  // ---- Duplicate-run guard: block if another LPS run is still `running`
  // for this project within the last 15 minutes. Older running rows are
  // treated as stale and ignored (they can be reaped separately).
  const staleCutoffIso = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data: inflight, error: inflightErr } = await sb
    .from("calc_run_registry")
    .select("id, started_at")
    .eq("project_id", projectId)
    .eq("model_version", LPS_MODEL_VERSION)
    .eq("status", "running")
    .is("finished_at", null)
    .gte("started_at", staleCutoffIso)
    .order("started_at", { ascending: false })
    .limit(1);
  if (inflightErr) return err(500, "db_error", inflightErr.message);
  if (inflight && inflight.length > 0) {
    const existing = inflight[0] as { id: string; started_at: string };
    return err(409, "lps_run_in_progress", "Another LPS run is already in progress.", {
      calc_run_id: existing.id,
      started_at: existing.started_at,
    });
  }

  // ---- Open calc_run_registry ----
  const scope: Record<string, unknown> = {
    kind: "link_power_score_v2",
    limit_keywords: limitKeywords,
    dry_run: dryRun,
    client_domain: clientDomain,
  };
  const { data: runIns, error: runErr } = await sb
    .from("calc_run_registry")
    .insert({
      project_id: projectId,
      triggered_by: userId,
      trigger_source: "admin_manual",
      model_version: LPS_MODEL_VERSION,
      scope,
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
    // ---- Kept keywords (always capped at MAX_LIMIT even without caller limit) ----
    const effectiveLimit = limitKeywords ?? MAX_LIMIT;
    const { data: kwRows, error: kwErr } = await sb
      .from("keywords")
      .select("id")
      .eq("project_id", projectId)
      .eq("detox_status", "keep")
      .order("created_at", { ascending: true })
      .limit(effectiveLimit + 1);
    if (kwErr) throw kwErr;
    const allIds = (kwRows ?? []).map((k) => String((k as { id: string }).id));
    const capApplied = allIds.length > effectiveLimit;
    const keywordIds = capApplied ? allIds.slice(0, effectiveLimit) : allIds;
    const runWarnings: unknown[] = [];
    if (capApplied) {
      runWarnings.push({
        code: "keyword_cap_applied",
        cap: effectiveLimit,
        total_kept_seen: allIds.length,
        message: `Kept-keyword count exceeded ${effectiveLimit}; only the first ${effectiveLimit} were scored.`,
      });
    }

    if (keywordIds.length === 0) {
      const summary = {
        model_version: LPS_MODEL_VERSION,
        keywords_seen: 0, serp_rows_seen: 0, rows_written: 0,
        rows_fetched: { keywords: 0, serp_results: 0 },
        skipped_reason: "no_kept_keywords",
        client_reference_authority: clientRef,
        dry_run: dryRun,
      };
      await closeRun(CALC_RUN_SUCCESS_STATUS, summary, runWarnings, []);
      return json(200, { calc_run_id: calcRunId, summary });
    }

    // ---- Load SERP results (chunked .in()) ----
    type Serp = SerpRowMetrics & {
      id: string;
      url: string | null;
      domain: string | null;
      rank_absolute: number | null;
    };
    const allSerp: Serp[] = [];
    // Truncation-remediation 2026-07-18: was a chunked loop with bare `.in()`,
    // which caps at PostgREST's 1,000-row default per chunk. Route through
    // selectIn({ paginate: true }) so each 100-id chunk pages fully.
    {
      const sRows = await selectIn<Record<string, unknown>>(
        sb,
        "serp_results",
        "id, keyword_id, rank_absolute, url, domain, url_rating, domain_rating, referring_domains, backlinks",
        "keyword_id",
        keywordIds,
        { paginate: true },
      );
      for (const rr of sRows) {
        allSerp.push({
          id: String(rr.id),
          keyword_id: String(rr.keyword_id),
          rank_absolute: rr.rank_absolute == null ? null : Number(rr.rank_absolute),
          url: (rr.url as string | null) ?? null,
          domain: (rr.domain as string | null) ?? null,
          url_rating: rr.url_rating == null ? null : Number(rr.url_rating),
          domain_rating: rr.domain_rating == null ? null : Number(rr.domain_rating),
          referring_domains: rr.referring_domains == null ? null : Number(rr.referring_domains),
          backlinks: rr.backlinks == null ? null : Number(rr.backlinks),
        });
      }
    }

    if (allSerp.length === 0) {
      const summary = {
        model_version: LPS_MODEL_VERSION,
        keywords_seen: keywordIds.length,
        serp_rows_seen: 0,
        rows_written: 0,
        rows_fetched: { keywords: keywordIds.length, serp_results: 0 },
        skipped_reason: "no_serp_data",
        client_reference_authority: clientRef,
        dry_run: dryRun,
      };
      runWarnings.push({ code: "no_serp_data", count: 1 });
      await closeRun(CALC_RUN_SUCCESS_STATUS, summary, runWarnings, []);
      return json(200, { calc_run_id: calcRunId, summary });
    }

    // ---- Compute + insert in streamed batches ----
    const ctx = buildContextDivisors(allSerp);
    const nowIso = new Date().toISOString();
    const confidenceDist = { high: 0, medium: 0, low: 0 };
    const missingCounts: Record<string, number> = { ur: 0, dr: 0, rd: 0, bl: 0 };
    const scores: number[] = [];
    let rowsWritten = 0;
    let rowsFailed = 0;
    let rowsSkippedInvalidUrl = 0;
    const invalidUrlSamples: Array<{ serp_result_id: string; url: string | null }> = [];
    const dbErrors: unknown[] = [];

    for (const batch of chunk(allSerp, INSERT_CHUNK)) {
      const outRows: Array<Record<string, unknown>> = [];
      for (const s of batch) {
        // Prefer the row's stored domain, but fall back to URL-derived host so
        // rows with a URL but no domain aren't downgraded to missing.
        const normalized = normUrl(s.url);
        if (!normalized) {
          rowsSkippedInvalidUrl += 1;
          if (invalidUrlSamples.length < 10) {
            invalidUrlSamples.push({ serp_result_id: s.id, url: s.url });
          }
          continue;
        }
        const rowDomain = normDomain(s.domain) ?? normalized.domain;
        const useClientRef =
          clientRef && clientDomain && rowDomain && rowDomain === clientDomain
            ? clientRef
            : null;
        const res = computeLpsForRow(s, ctx, {
          clientDomain: useClientRef ? clientDomain : null,
          clientRef: useClientRef,
        });
        confidenceDist[res.confidence] += 1;
        for (const m of res.missing) missingCounts[m] += 1;
        scores.push(res.lps_score);
        outRows.push({
          project_id: projectId,
          calc_run_id: calcRunId,
          serp_result_id: s.id,
          keyword_id: s.keyword_id,
          url: normalized.url,
          domain: rowDomain,
          rank_absolute: s.rank_absolute,
          lps_score: res.lps_score,
          confidence: res.confidence,
          components_json: {
            model_version: LPS_MODEL_VERSION,
            weights: { ur: 0.35, dr: 0.30, rd: 0.20, bl: 0.15 },
            components: res.components,
            missing: res.missing,
            imputations: res.imputations,
            reason: res.reason ?? null,
            context: {
              rd_divisor_source: res.components.rd.divisor_source ?? null,
              bl_divisor_source: res.components.bl.divisor_source ?? null,
              project_rd_p95: ctx.projectRd,
              project_bl_p95: ctx.projectBl,
            },
          },
          created_at: nowIso,
        });
      }

      if (!outRows.length) continue;
      if (dryRun) {
        rowsWritten += outRows.length;
        continue;
      }
      const { error: insErr } = await sb.from("link_power_scores").insert(outRows);
      if (insErr) {
        dbErrors.push({ code: "insert_failed", message: insErr.message, chunk_size: outRows.length });
        rowsFailed += outRows.length;
        continue;
      }
      rowsWritten += outRows.length;
      console.log(
        "[link-power-score-compute] chunk_persisted project=%s rows=%d cumulative=%d",
        projectId, outRows.length, rowsWritten,
      );
    }

    if (rowsSkippedInvalidUrl > 0) {
      runWarnings.push({
        code: "rows_skipped_invalid_url",
        count: rowsSkippedInvalidUrl,
        samples: invalidUrlSamples,
        message: `${rowsSkippedInvalidUrl} SERP rows had missing/invalid URLs and were skipped.`,
      });
    }

    const summary = {
      model_version: LPS_MODEL_VERSION,
      keywords_seen: keywordIds.length,
      serp_rows_seen: allSerp.length,
      rows_written: rowsWritten,
      rows_failed: rowsFailed,
      rows_skipped_invalid_url: rowsSkippedInvalidUrl,
      rows_fetched: {
        keywords: keywordIds.length,
        serp_results: allSerp.length,
      },
      confidence_distribution: confidenceDist,
      score_distribution: scoreDistribution(scores),
      missing_component_counts: missingCounts,
      client_reference_authority: clientRef,
      dry_run: dryRun,
    };

    const runStatus =
      !dryRun && rowsFailed > 0 && rowsWritten === 0
        ? CALC_RUN_FAILED_STATUS
        : CALC_RUN_SUCCESS_STATUS;
    await closeRun(runStatus, summary, runWarnings, dbErrors);

    console.log(
      "[link-power-score-compute] project=%s kw=%d serp=%d rows=%d dry=%s",
      projectId, keywordIds.length, allSerp.length, rowsWritten, String(dryRun),
    );

    return json(200, { calc_run_id: calcRunId, summary, dry_run: dryRun });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      await closeRun(CALC_RUN_FAILED_STATUS, { error: msg, dry_run: dryRun }, [], [{ code: "unhandled", message: msg }]);
    } catch (closeErr) {
      console.error("[link-power-score-compute] close-on-error failed", closeErr);
    }
    return err(500, "unhandled", msg);
  }
});
