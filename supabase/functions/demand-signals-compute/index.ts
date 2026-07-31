// demand-signals-compute
// Phase 6 · Prompt 6.1 — Keyword-level Demand Intelligence v1.
// Admin-only. Manual invocation. Shadow mode: writes to keyword_demand_signals
// tagged by calc_run_id. Never mutates v1 keyword_forecasts, keywords.peak_month,
// keywords.seasonality_*, or any revenue table. No DataForSEO / external calls.
//
// Contract:
//   POST /functions/v1/demand-signals-compute
//   Body: { project_id: uuid, dry_run?: boolean, limit_keywords?: number }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { classifyReadiness, type CoverageSummary } from "../_shared/phase6-readiness.ts";
import {
  CALC_RUN_FAILED_STATUS,
  CALC_RUN_SUCCESS_STATUS,
  type CalcRunTerminalStatus,
} from "../_shared/calc-run-registry.ts";
import {
  computeDemandSignal,
  rollupCategorySignals,
  type CategoryRollupMember,
  type DemandSignalRow,
  type MonthlyPoint,
} from "../_shared/demand-signals.ts";
import { fetchAllRows, selectIn } from "../_shared/pgrst-in.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MODEL_VERSION = "demand_signals_v1.0.0";
const MAX_LIMIT = 5000;
const KW_ID_CHUNK = 100;         // Rule §1.22 — chunked .in()
const UPSERT_CHUNK = 500;

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

// Prefer historical backfill on ties, then most recent fetched_at.
const SOURCE_PRIORITY: Record<string, number> = {
  dataforseo_historical_backfill: 3,
  dataforseo_search_volume: 2,
};
function sourceRank(s: string | null): number {
  return SOURCE_PRIORITY[s ?? ""] ?? 1;
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
  const isAdmin = (roles ?? []).some((r: any) => r.role === "admin" || r.role === "super_admin");
  if (!isAdmin) return err(403, "forbidden_admin_only", "Admin role required.");

  // ---- Project visibility + not archived ----
  const { data: proj, error: projErr } = await sb
    .from("navigator_projects")
    .select("id, archived_at")
    .eq("id", projectId)
    .maybeSingle();
  if (projErr) return err(500, "db_error", projErr.message);
  if (!proj) return err(403, "forbidden_project", "Project not visible.");
  if ((proj as any).archived_at) {
    return err(409, "project_archived", "Cannot compute demand signals for an archived project.");
  }

  // ---- Coverage + readiness gate ----
  let coverage: CoverageSummary | null = null;
  try {
    const { data: covRows, error: covErr } = await sb.rpc("project_monthly_coverage", {
      p_project_id: projectId,
    });
    if (covErr) throw covErr;
    const row: any = Array.isArray(covRows) ? covRows[0] : covRows;
    if (row) {
      coverage = {
        keywords_with_history: Number(row.keywords_with_history ?? 0),
        kept_keywords_total: Number(row.kept_keywords_total ?? 0),
        min_months: Number(row.min_months ?? 0),
        median_months: Number(row.median_months ?? 0),
        max_months: Number(row.max_months ?? 0),
        percent_keywords_at_or_above_24_months: Number(row.percent_keywords_at_or_above_24_months ?? 0),
        percent_keywords_at_or_above_12_months: Number(row.percent_keywords_at_or_above_12_months ?? 0),
      };
    }
  } catch (e) {
    return err(500, "coverage_rpc_failed", (e as Error).message);
  }
  if (!coverage) return err(500, "coverage_missing", "project_monthly_coverage returned no row.");

  const readiness = classifyReadiness(coverage);

  // Zero-keyword projects always classify no_history at project level;
  // exclude server-side and never open a compute row.
  if (coverage.kept_keywords_total === 0) {
    return json(200, {
      code: "skipped_no_kept_keywords",
      project_id: projectId,
      readiness,
      coverage,
    });
  }

  // ---- Open calc_run_registry row ----
  const scope: Record<string, unknown> = {
    kind: "demand_signals_v1",
    readiness_status: readiness.status,
    readiness_reason: readiness.reason,
    coverage,
    limit_keywords: limitKeywords,
    dry_run: dryRun,
  };
  const { data: runIns, error: runErr } = await sb
    .from("calc_run_registry")
    .insert({
      project_id: projectId,
      triggered_by: userId,
      trigger_source: "admin_manual",
      model_version: MODEL_VERSION,
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
    if (closeErr) {
      throw new Error(`calc_run_close_failed: ${closeErr.message}`);
    }
  };

  // If project-level readiness is no_history (but there ARE kept keywords —
  // meaning every keyword has zero monthly rows), skip compute cleanly.
  if (readiness.status === "no_history") {
    const summary = {
      readiness,
      coverage,
      keywords_seen: 0,
      rows_written: 0,
      skipped_reason: "project_no_history",
      dry_run: dryRun,
    };
    await closeRun(CALC_RUN_SUCCESS_STATUS, summary, [{ code: "project_no_history", message: readiness.reason }], []);
    return json(200, { calc_run_id: calcRunId, readiness, summary });
  }

  try {
    // ---- Load kept keywords (pageable) ----
    // When a caller-supplied limit is present, keep the explicit LIMIT semantics.
    // Otherwise use fetchAllRows so the default 1,000-row PostgREST cap
    // cannot silently truncate large projects.
    let kwRows: any[];
    if (limitKeywords) {
      const { data, error: kwErr } = await sb
        .from("keywords")
        .select("id, keyword, tag_1, tag_2, search_intent, avg_monthly_volume")
        .eq("project_id", projectId)
        .eq("detox_status", "keep")
        .order("created_at", { ascending: true })
        .limit(limitKeywords);
      if (kwErr) throw kwErr;
      kwRows = data ?? [];
    } else {
      kwRows = await fetchAllRows<any>(
        sb,
        "keywords",
        "id, keyword, tag_1, tag_2, search_intent, avg_monthly_volume",
        (q) => q.eq("project_id", projectId).eq("detox_status", "keep").order("created_at", { ascending: true }),
      );
    }
    const keywords = (kwRows ?? []).map((k: any) => ({
      id: String(k.id),
      keyword: String(k.keyword ?? ""),
      tag_1: (k.tag_1 ?? null) as string | null,
      tag_2: (k.tag_2 ?? null) as string | null,
      search_intent: (k.search_intent ?? null) as string | null,
      avg_monthly_volume: k.avg_monthly_volume == null ? null : Number(k.avg_monthly_volume),
    }));

    if (keywords.length === 0) {
      const summary = {
        readiness, coverage, keywords_seen: 0, rows_written: 0,
        skipped_reason: "no_kept_keywords_in_scope", dry_run: dryRun,
      };
      await closeRun(CALC_RUN_SUCCESS_STATUS, summary, [], []);
      return json(200, { calc_run_id: calcRunId, readiness, summary });
    }

    // ---- Load monthly volumes (chunked .in()) ----
    // Per-keyword best-source-per-month dedupe done in memory.
    type Cell = { volume: number; rank: number; fetched: number };
    const perKw = new Map<string, Map<string, Cell>>();
    for (const k of keywords) perKw.set(k.id, new Map());

    // Truncation-remediation 2026-07-18: was a manual chunked .in() loop,
    // now routed through selectIn({ paginate: true }).
    const vRows = await selectIn<Record<string, unknown>>(
      sb,
      "keyword_monthly_volumes",
      "keyword_id, month, volume, source, fetched_at",
      "keyword_id",
      keywords.map((k) => k.id),
      { paginate: true },
    );
    let volumesFetched = 0;
    for (const r of vRows) {
      volumesFetched += 1;
      const kid = String((r as any).keyword_id);
      const month = String((r as any).month).slice(0, 10); // YYYY-MM-DD
      const vol = Number((r as any).volume ?? 0);
      const src = (r as any).source as string | null;
      const fetched = Date.parse(String((r as any).fetched_at ?? "")) || 0;
      const bucket = perKw.get(kid);
      if (!bucket) continue;
      const rank = sourceRank(src);
      const existing = bucket.get(month);
      if (!existing || rank > existing.rank || (rank === existing.rank && fetched > existing.fetched)) {
        bucket.set(month, { volume: vol, rank, fetched });
      }
    }

    // ---- Compute + build upsert rows ----
    const nowIso = new Date().toISOString();
    const outRows: Array<Record<string, unknown>> = [];
    const byDirection = { growing: 0, stable: 0, declining: 0, volatile: 0, insufficient_data: 0 };
    const byConfidence = { high: 0, medium: 0, low: 0 };
    const byBranch = { high_confidence_24: 0, momentum_12: 0, insufficient: 0 };
    const warnCounts: Record<string, number> = {};

    // Retain per-keyword signal in memory (small) for the category rollup pass.
    const perKwSignal = new Map<
      string,
      { sig: DemandSignalRow; k: (typeof keywords)[number] }
    >();

    for (const k of keywords) {
      const bucket = perKw.get(k.id) ?? new Map();
      const points: MonthlyPoint[] = Array.from(bucket.entries()).map(([month, c]) => ({
        month,
        volume: c.volume,
      }));
      const sig = computeDemandSignal(points);
      perKwSignal.set(k.id, { sig, k });
      byDirection[sig.trend_direction] = (byDirection[sig.trend_direction] ?? 0) + 1;
      byConfidence[sig.trend_confidence] = (byConfidence[sig.trend_confidence] ?? 0) + 1;
      byBranch[sig.branch] = (byBranch[sig.branch] ?? 0) + 1;
      if (sig.demand_warning && sig.demand_warning_reason) {
        warnCounts[sig.demand_warning_reason] = (warnCounts[sig.demand_warning_reason] ?? 0) + 1;
      }
      outRows.push({
        project_id: projectId,
        keyword_id: k.id,
        calc_run_id: calcRunId,
        data_coverage_months: sig.data_coverage_months,
        trend_direction: sig.trend_direction,
        trend_pct: sig.trend_pct,
        trend_slope: sig.trend_slope,
        trend_confidence: sig.trend_confidence,
        volatility_score: sig.volatility_score,
        seasonality_strength: sig.seasonality_strength,
        peak_months_json: sig.peak_months_json,
        shoulder_months_json: sig.shoulder_months_json,
        demand_warning: sig.demand_warning,
        demand_warning_reason: sig.demand_warning_reason,
        calculated_at: nowIso,
      });
    }

    // ---- Persist keyword rows (unless dry_run) ----
    let rowsWritten = 0;
    const dbErrors: unknown[] = [];
    if (!dryRun && outRows.length) {
      for (const c of chunk(outRows, UPSERT_CHUNK)) {
        const { error: insErr } = await sb.from("keyword_demand_signals").insert(c as any);
        if (insErr) {
          dbErrors.push({ code: "insert_failed", message: insErr.message, chunk_size: c.length });
          continue;
        }
        rowsWritten += c.length;
      }
    } else if (dryRun) {
      rowsWritten = outRows.length;
    }

    // ---- Prompt 6.2 — Category rollups ----
    // Groupings: tag_1 | tag_1+tag_2 | search_intent. brand_type stays 'mixed'.
    const groupTag1 = new Map<string, CategoryRollupMember[]>();
    const groupTag12 = new Map<string, CategoryRollupMember[]>();
    const groupIntent = new Map<string, CategoryRollupMember[]>();
    const catSkipped = { missing_tag_1: 0, missing_intent: 0, empty_groups: 0 };

    const asMember = (
      sig: DemandSignalRow,
      avg: number | null,
    ): CategoryRollupMember => ({
      avg_monthly_volume: avg,
      signal: {
        trend_direction: sig.trend_direction,
        trend_pct: sig.trend_pct,
        trend_confidence: sig.trend_confidence,
        seasonality_strength: sig.seasonality_strength,
        peak_months_json: sig.peak_months_json,
      },
    });

    for (const { sig, k } of perKwSignal.values()) {
      const member = asMember(sig, k.avg_monthly_volume);
      if (!k.tag_1 || k.tag_1.trim() === "") {
        catSkipped.missing_tag_1 += 1;
      } else {
        const t1 = k.tag_1.trim();
        (groupTag1.get(t1) ?? groupTag1.set(t1, []).get(t1)!).push(member);
        if (k.tag_2 && k.tag_2.trim() !== "") {
          const key = `${t1}\u0001${k.tag_2.trim()}`;
          (groupTag12.get(key) ?? groupTag12.set(key, []).get(key)!).push(member);
        }
      }
      if (!k.search_intent || k.search_intent.trim() === "") {
        catSkipped.missing_intent += 1;
      } else {
        const intent = k.search_intent.trim();
        (groupIntent.get(intent) ?? groupIntent.set(intent, []).get(intent)!).push(member);
      }
    }

    type CatRow = Record<string, unknown>;
    const catRows: CatRow[] = [];
    const catConfidence = { high: 0, medium: 0, low: 0 };
    const push = (
      key: { tag_1: string | null; tag_2: string | null; intent: string | null },
      members: CategoryRollupMember[],
    ) => {
      if (members.length === 0) {
        catSkipped.empty_groups += 1;
        return;
      }
      const r = rollupCategorySignals(members);
      catConfidence[r.trend_confidence] += 1;
      catRows.push({
        project_id: projectId,
        calc_run_id: calcRunId,
        tag_1: key.tag_1,
        tag_2: key.tag_2,
        intent: key.intent,
        brand_type: "mixed",
        trend_direction: r.trend_direction,
        trend_pct: r.trend_pct,
        trend_confidence: r.trend_confidence,
        seasonality_strength: r.seasonality_strength,
        peak_months_json: r.peak_months_json,
        keyword_count: r.keyword_count,
        total_volume: r.total_volume,
        calculated_at: nowIso,
      });
    };

    for (const [t1, members] of groupTag1) push({ tag_1: t1, tag_2: null, intent: null }, members);
    for (const [key, members] of groupTag12) {
      const [t1, t2] = key.split("\u0001");
      push({ tag_1: t1, tag_2: t2, intent: null }, members);
    }
    for (const [intent, members] of groupIntent) push({ tag_1: null, tag_2: null, intent }, members);

    let categoryRowsWritten = 0;
    if (!dryRun && catRows.length) {
      for (const c of chunk(catRows, UPSERT_CHUNK)) {
        const { error: insErr } = await sb.from("category_demand_signals").insert(c as any);
        if (insErr) {
          dbErrors.push({ code: "category_insert_failed", message: insErr.message, chunk_size: c.length });
          continue;
        }
        categoryRowsWritten += c.length;
      }
    } else if (dryRun) {
      categoryRowsWritten = catRows.length;
    }

    const warnings = Object.entries(warnCounts).map(([code, count]) => ({ code, count }));
    if (catSkipped.missing_tag_1 > 0) {
      warnings.push({ code: "category_missing_tag_1", count: catSkipped.missing_tag_1 });
    }
    if (catSkipped.missing_intent > 0) {
      warnings.push({ code: "category_missing_intent", count: catSkipped.missing_intent });
    }

    const summary = {
      readiness,
      coverage,
      keywords_seen: keywords.length,
      rows_written: rowsWritten,
      by_direction: byDirection,
      by_confidence: byConfidence,
      by_branch: byBranch,
      warning_counts: warnCounts,
      category_rows_written: categoryRowsWritten,
      category_groups: {
        tag_1: groupTag1.size,
        tag_1_and_2: groupTag12.size,
        intent: groupIntent.size,
      },
      category_confidence: catConfidence,
      category_skipped: catSkipped,
      rows_fetched: {
        keywords: keywords.length,
        keyword_monthly_volumes: volumesFetched,
      },
      dry_run: dryRun,
    };

    const runStatus =
      !dryRun && rowsWritten === 0 && outRows.length > 0 && dbErrors.length > 0
        ? CALC_RUN_FAILED_STATUS
        : CALC_RUN_SUCCESS_STATUS;
    await closeRun(runStatus, summary, warnings, dbErrors);


    console.log(
      "[demand-signals-compute] project=%s readiness=%s kw=%d rows=%d cat_rows=%d dry=%s",
      projectId, readiness.status, keywords.length, rowsWritten, categoryRowsWritten, String(dryRun),
    );

    return json(200, {
      calc_run_id: calcRunId,
      readiness,
      summary,
      dry_run: dryRun,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      await closeRun(CALC_RUN_FAILED_STATUS, { readiness, coverage, error: msg, dry_run: dryRun }, [], [{ code: "unhandled", message: msg }]);
    } catch (closeErr) {
      console.error("[demand-signals-compute] failed to close failed run", closeErr);
    }
    return err(500, "compute_failed", msg, { calc_run_id: calcRunId });
  }
});
