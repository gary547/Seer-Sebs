// ctr-curves-from-gsc
// Admin-only. Reads a project's most recent (or specified) GSC workbook upload
// and writes per-intent CTR curves into ctr_curves + ctr_curve_metadata.
// Device-aware: when the upload carries per-row device (upload.device='mixed')
// the function builds curves for mobile, desktop AND an 'all' aggregate.
// Otherwise legacy behaviour: single 'all' curve set.
// Branded keywords (gsc_upload_keywords.is_branded=true) are excluded from
// aggregation; is_branded IS NULL rows are included and counted.
// Fallback curves (is_fallback=true) are never touched.
// Rank coverage: r1-r30 (extended from r1-r20 per rank-tail coverage prompt).
console.log(`[boot] ctr-curves-from-gsc ${new Date().toISOString()}`);

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MODEL_VERSION = "ctr_v2.0.0";
export const CTR_ELIGIBLE_SOURCES = ["gsc_csv_v2", "gsc_workbook_v1"] as const;
const SOURCE_ALL_DEVICE = "gsc_workbook_all_device";
const SOURCE_PER_DEVICE = "gsc_workbook_per_device";
const KEYWORD_PAGE = 1000;
const MIN_BUCKET_IMPR = 500;
const RANK_FULL_TRUST = 1000;
const CONF_HIGH = 5000;
const CONF_MED = 1000;

// STANDARD_CTR values are stored in the ctr_curves.ctr_percentage column in
// PERCENTAGE POINTS (e.g. 28 == 28%). The v2 resolver
// (_shared/ctr-resolver-v2.ts) reads ctr_percentage and divides by 100 to
// produce a fraction. Any measured value written to ctr_percentage must be in
// the same unit (percentage points, clamped to [0,100]).
// r21-r30 continue the STANDARD_CTR tail via geometric decay anchored at
// r10=2.0 -> r20=0.3 (per-step ratio ≈ 0.826), rounded to 2dp and enforced
// monotone-non-increasing. Matches the global fallback ladder migration.
const STANDARD_CTR: Record<number, number> = {
  1: 28, 2: 15, 3: 11, 4: 8, 5: 7, 6: 5, 7: 4, 8: 3, 9: 2.5, 10: 2,
  11: 1.5, 12: 1.2, 13: 1, 14: 0.9, 15: 0.8, 16: 0.7, 17: 0.6, 18: 0.5, 19: 0.4, 20: 0.3,
  21: 0.25, 22: 0.20, 23: 0.17, 24: 0.14, 25: 0.12,
  26: 0.10, 27: 0.08, 28: 0.07, 29: 0.06, 30: 0.05,
};

/**
 * Blend a measured (clicks, impressions) bucket with a fallback CTR seed and
 * return a value in PERCENTAGE POINTS, clamped to [0, 100] and rounded to 2dp.
 * Both `fallbackPct` and the return value are in percentage points, matching
 * the ctr_curves.ctr_percentage column convention.
 */
export function blendRankCtr(
  clicks: number,
  impressions: number,
  fallbackPct: number,
  rankFullTrust: number = RANK_FULL_TRUST,
): number {
  let ctrPct: number;
  if (impressions > 0) {
    const measured = clicks / impressions; // fraction
    const weight = Math.min(impressions / rankFullTrust, 1);
    const blended = weight * measured + (1 - weight) * (fallbackPct / 100); // fraction
    ctrPct = blended * 100; // percentage points
  } else {
    ctrPct = fallbackPct; // already percentage points
  }
  if (!isFinite(ctrPct) || ctrPct < 0) ctrPct = 0;
  if (ctrPct > 100) ctrPct = 100;
  return Math.round(ctrPct * 100) / 100;
}

/**
 * Pool-adjacent-violators (PAV) isotonic regression enforcing a non-increasing
 * sequence over the provided ranks. Operates only on the ranks actually
 * present in the input; skipped/absent ranks are neither interpolated nor
 * added. Unweighted (pool weight = 1 per present rank).
 *
 * Per-query CTR is monotone-decreasing in rank; head-bucket inversions are
 * GSC average-position dilution artifacts (high-impression queries with
 * scattered true positions rounding into low rank buckets). PAV regularisation
 * removes the artifact while preserving bucket-level click mass ordering.
 * Provisional — revisit against Gate B calibration.
 */
export function pavNonIncreasing(
  points: Array<{ rank: number; ctr: number }>,
): Array<{ rank: number; ctr: number }> {
  if (points.length === 0) return [];
  // Sort by rank ascending (input is expected sorted, but be defensive).
  const sorted = [...points].sort((a, b) => a.rank - b.rank);
  // Pools: each pool has { sum, count, mean } and covers a contiguous slice.
  const pools: Array<{ sum: number; count: number; mean: number }> = [];
  for (const p of sorted) {
    pools.push({ sum: p.ctr, count: 1, mean: p.ctr });
    // Merge while the previous pool's mean is LESS than the current pool's
    // mean (violates non-increasing constraint).
    while (
      pools.length >= 2 &&
      pools[pools.length - 2].mean < pools[pools.length - 1].mean
    ) {
      const b = pools.pop()!;
      const a = pools.pop()!;
      const merged = {
        sum: a.sum + b.sum,
        count: a.count + b.count,
        mean: (a.sum + b.sum) / (a.count + b.count),
      };
      pools.push(merged);
    }
  }
  // Expand pools back to the per-rank output.
  const result: Array<{ rank: number; ctr: number }> = [];
  let idx = 0;
  for (const pool of pools) {
    // Round to 2dp to match ctr_curves.ctr_percentage convention.
    const rounded = Math.round(pool.mean * 100) / 100;
    for (let i = 0; i < pool.count; i++) {
      result.push({ rank: sorted[idx].rank, ctr: rounded });
      idx += 1;
    }
  }
  return result;
}



export const INTENT_KEYS = ["transactional", "commercial", "informational", "navigational", "generic"] as const;
export type Intent = typeof INTENT_KEYS[number];
export type DeviceBucket = "mobile" | "desktop" | "all";

export type AggRow = {
  clicks: number;
  impressions: number;
  position: number;
  search_intent: string | null;
  device: string | null;
  is_branded: boolean | null;
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
function err(status: number, code: string, error: string) {
  return json(status, { code, error });
}

function clampRank(pos: number): number {
  const r = Math.round(pos);
  if (r < 1) return 1;
  if (r > 30) return 30;
  return r;
}

export function normalizeIntent(v: string | null | undefined): Intent {
  const s = (v ?? "").toLowerCase().trim();
  if (s === "transactional" || s === "commercial" || s === "informational" || s === "navigational") {
    return s;
  }
  return "generic";
}

function intentSegmentValue(intent: Intent): string | null {
  return intent === "generic" ? null : intent;
}

function confidenceFor(bucketImpr: number): "low" | "medium" | "high" {
  if (bucketImpr >= CONF_HIGH) return "high";
  if (bucketImpr >= CONF_MED) return "medium";
  return "low";
}

export function pickDevicesToBuild(upload: { device: string | null }): {
  devices: DeviceBucket[];
  hasPerRowDevice: boolean;
} {
  const hasPerRowDevice = (upload.device ?? "").toLowerCase() === "mixed";
  return {
    devices: hasPerRowDevice ? ["mobile", "desktop", "all"] : ["all"],
    hasPerRowDevice,
  };
}

export type BucketAgg = { clicks: number; impressions: number };
export type DeviceIntentAgg = Record<DeviceBucket, Record<Intent, Map<number, BucketAgg>>>;

export type AggregationResult = {
  agg: DeviceIntentAgg;
  rowsConsidered: number;
  rowsUsed: number;
  brandedExcludedRows: number;
  unclassifiedRows: number;
  unknownDeviceRows: number;
};

function emptyDeviceIntentAgg(devices: DeviceBucket[]): DeviceIntentAgg {
  const out = {} as DeviceIntentAgg;
  for (const d of devices) {
    out[d] = {
      transactional: new Map(), commercial: new Map(), informational: new Map(),
      navigational: new Map(), generic: new Map(),
    };
  }
  return out;
}

export function buildAggregations(
  rows: AggRow[],
  hasPerRowDevice: boolean,
): AggregationResult {
  const devices: DeviceBucket[] = hasPerRowDevice ? ["mobile", "desktop", "all"] : ["all"];
  const agg = emptyDeviceIntentAgg(devices);
  let rowsConsidered = 0;
  let rowsUsed = 0;
  let brandedExcludedRows = 0;
  let unclassifiedRows = 0;
  let unknownDeviceRows = 0;

  for (const r of rows) {
    rowsConsidered += 1;
    if (r.is_branded === true) { brandedExcludedRows += 1; continue; }
    if (r.is_branded === null || r.is_branded === undefined) unclassifiedRows += 1;
    const pos = Number(r.position);
    if (!isFinite(pos) || pos <= 0 || pos > 30.5) continue;
    rowsUsed += 1;
    const intent = normalizeIntent(r.search_intent);
    const rank = clampRank(pos);
    const clicks = Number(r.clicks) || 0;
    const impressions = Number(r.impressions) || 0;

    const contribute = (device: DeviceBucket) => {
      const cur = agg[device][intent].get(rank) ?? { clicks: 0, impressions: 0 };
      cur.clicks += clicks;
      cur.impressions += impressions;
      agg[device][intent].set(rank, cur);
    };

    if (hasPerRowDevice) {
      const dev = (r.device ?? "").toLowerCase();
      if (dev === "mobile" || dev === "desktop") {
        contribute(dev as DeviceBucket);
        contribute("all");
      } else {
        unknownDeviceRows += 1;
        contribute("all");
      }
    } else {
      contribute("all");
    }
  }

  return { agg, rowsConsidered, rowsUsed, brandedExcludedRows, unclassifiedRows, unknownDeviceRows };
}

async function loadAllKeywords(sb: SupabaseClient, uploadId: string): Promise<AggRow[]> {
  const rows: AggRow[] = [];
  let from = 0;
  for (;;) {
    const to = from + KEYWORD_PAGE - 1;
    const { data, error } = await sb
      .from("gsc_upload_keywords")
      .select("clicks, impressions, position, search_intent, device, is_branded")
      .eq("upload_id", uploadId)
      .range(from, to);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...(data as AggRow[]));
    if (data.length < KEYWORD_PAGE) break;
    from += KEYWORD_PAGE;
  }
  return rows;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return err(405, "method_not_allowed", "POST only.");

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return err(500, "misconfigured", "Missing Supabase env vars.");
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return err(401, "unauthorized", "Missing Authorization header.");

  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  let payload: { project_id?: string; upload_id?: string };
  try {
    payload = await req.json();
  } catch {
    return err(400, "invalid_payload", "Body must be JSON.");
  }
  const projectId = payload?.project_id;
  const pinnedUploadId = payload?.upload_id;
  if (!projectId || typeof projectId !== "string") {
    return err(400, "invalid_payload", "project_id is required.");
  }

  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData?.user) return err(401, "unauthorized", "Invalid or expired token.");
  const userId = userData.user.id;

  const { data: roles, error: roleErr } = await sb
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  if (roleErr) return err(500, "db_error", roleErr.message);
  const isAdmin = (roles ?? []).some((r: any) => r.role === "admin" || r.role === "super_admin");
  if (!isAdmin) return err(403, "forbidden_admin_only", "Admin role required.");

  const { data: proj, error: projErr } = await sb
    .from("navigator_projects")
    .select("id")
    .eq("id", projectId)
    .maybeSingle();
  if (projErr) return err(500, "db_error", projErr.message);
  if (!proj) return err(403, "forbidden_project", "Project not visible.");

  // Select upload first (need device to shape scope + summary)
  let uploadQuery = sb
    .from("gsc_uploads")
    .select("id, source, device, date_range_start, date_range_end, uploaded_at, row_count")
    .eq("project_id", projectId)
    .in("source", CTR_ELIGIBLE_SOURCES as unknown as string[])
    .not("date_range_start", "is", null)
    .not("date_range_end", "is", null);
  if (pinnedUploadId) uploadQuery = uploadQuery.eq("id", pinnedUploadId);
  const { data: uploads, error: upErr } = await uploadQuery
    .order("uploaded_at", { ascending: false })
    .limit(1);
  if (upErr) return err(500, "db_error", upErr.message);
  const upload = uploads?.[0] as
    | { id: string; source: string; device: string | null; date_range_start: string; date_range_end: string; row_count: number }
    | undefined;
  if (!upload) return err(404, "no_valid_upload", "No eligible GSC upload found.");

  const { devices: devicesToBuild, hasPerRowDevice } = pickDevicesToBuild(upload);

  // Open calc run
  const { data: runIns, error: runErr } = await sb
    .from("calc_run_registry")
    .insert({
      project_id: projectId,
      triggered_by: userId,
      trigger_source: "admin_manual",
      model_version: MODEL_VERSION,
      scope: {
        kind: "ctr_generation",
        source: hasPerRowDevice ? SOURCE_PER_DEVICE : SOURCE_ALL_DEVICE,
        device: hasPerRowDevice ? "per_device" : "all",
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

  const failRun = async (code: string, message: string, status: number) => {
    await sb
      .from("calc_run_registry")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        errors: [{ code, message }],
      })
      .eq("id", calcRunId);
    return err(status, code, message);
  };

  try {
    // Load rows
    const rows = await loadAllKeywords(sb, upload.id);

    // Data-quality guards (BEFORE snapshot + wipe so nothing destructive fires on failure)
    if (rows.length > 0) {
      if (hasPerRowDevice) {
        const anyDevice = rows.some((r) => {
          const d = (r.device ?? "").toString().toLowerCase().trim();
          return d.length > 0;
        });
        if (!anyDevice) {
          return await failRun(
            "mixed_upload_missing_row_devices",
            "Upload declared device='mixed' but no rows carry a per-row device value; importer did not populate gsc_upload_keywords.device.",
            422,
          );
        }
      }
      const anyClassified = rows.some((r) => r.is_branded === true || r.is_branded === false);
      if (!anyClassified) {
        return await failRun(
          "upload_unclassified",
          "All rows are unclassified (is_branded is null); run brand classification before generating CTR curves.",
          422,
        );
      }
    }

    const {
      agg, rowsConsidered, rowsUsed, brandedExcludedRows, unclassifiedRows, unknownDeviceRows,
    } = buildAggregations(rows, hasPerRowDevice);
    if (!rowsUsed) return await failRun("no_valid_rows", "Upload has no non-branded rows with position ≤ 30.", 400);

    // Snapshot existing non-fallback rows per (device × intent) BEFORE deletion,
    // so blending can prefer the device-matched prior curve when present.
    const priorLadders = new Map<string, Record<number, number>>();
    const ladderKey = (device: DeviceBucket, intent: Intent) => `${device}::${intent}`;
    for (const device of devicesToBuild) {
      for (const intent of INTENT_KEYS) {
        const segValue = intentSegmentValue(intent);
        let q = sb
          .from("ctr_curves")
          .select("rank_position, ctr_percentage")
          .eq("project_id", projectId)
          .eq("device", device)
          .eq("is_fallback", false);
        q = segValue === null ? q.is("intent_segment", null) : q.eq("intent_segment", segValue);
        const { data: existingRows, error: exErr } = await q;
        if (exErr) return await failRun("db_error", exErr.message, 500);
        const ladder: Record<number, number> = { ...STANDARD_CTR };
        for (const row of (existingRows ?? []) as Array<{ rank_position: number; ctr_percentage: number }>) {
          ladder[row.rank_position] = Number(row.ctr_percentage);
        }
        priorLadders.set(ladderKey(device, intent), ladder);
      }
    }

    // Single upfront wipe across ALL devices and intents (clears any legacy
    // device='all' rows from prior builds too). Fallback rows untouched.
    const { error: delErr } = await sb
      .from("ctr_curves")
      .delete()
      .eq("project_id", projectId)
      .eq("is_fallback", false);
    if (delErr) return await failRun("db_error", delErr.message, 500);

    const warnings: Array<Record<string, unknown>> = [];
    if (hasPerRowDevice && unknownDeviceRows > 0) {
      warnings.push({ unknown_device_rows: unknownDeviceRows });
    }
    const bucketsSummary: Array<Record<string, unknown>> = [];
    let curvesWritten = 0;

    for (const device of devicesToBuild) {
      const sourceLabel = device === "all" && !hasPerRowDevice
        ? SOURCE_ALL_DEVICE
        : device === "all"
          ? SOURCE_ALL_DEVICE
          : SOURCE_PER_DEVICE;

      for (const intent of INTENT_KEYS) {
        const rankMap = agg[device][intent];
        let bucketImpr = 0;
        let bucketClicks = 0;
        for (const v of rankMap.values()) {
          bucketImpr += v.impressions;
          bucketClicks += v.clicks;
        }
        if (bucketImpr === 0) continue;
        if (bucketImpr < MIN_BUCKET_IMPR) {
          warnings.push({
            device, intent, skipped: true,
            reason: `Only ${bucketImpr} impressions (min ${MIN_BUCKET_IMPR}).`,
          });
          continue;
        }

        const segValue = intentSegmentValue(intent);
        const fallbackLadder = priorLadders.get(ladderKey(device, intent)) ?? { ...STANDARD_CTR };

        const curveRows: Array<Record<string, unknown>> = [];
        const ranksSkippedEmpty: number[] = [];
        for (let rank = 1; rank <= 30; rank++) {
          const bucket = rankMap.get(rank) ?? { clicks: 0, impressions: 0 };
          // Honest provenance: skip ranks with zero impressions rather than
          // persist a copied fallback disguised as measured (is_fallback=false).
          // The resolver falls back through global seed tiers for empty slots.
          if (bucket.impressions <= 0) {
            ranksSkippedEmpty.push(rank);
            continue;
          }
          const fallback = fallbackLadder[rank] ?? STANDARD_CTR[rank];
          const ctrPct = blendRankCtr(bucket.clicks, bucket.impressions, fallback);

          curveRows.push({
            project_id: projectId,
            device,
            rank_position: rank,
            ctr_percentage: ctrPct,
            is_fallback: false,
            intent_segment: segValue,
          });
        }

        if (curveRows.length === 0) {
          warnings.push({
            device, intent, skipped: true,
            reason: "All 30 ranks had zero impressions.",
          });
          continue;
        }

        // Snapshot pre-PAV blended CTRs, then apply monotone-decreasing
        // regularisation. See pavNonIncreasing() for rationale.
        const rawByRank = new Map<number, number>();
        for (const row of curveRows) {
          rawByRank.set(row.rank_position as number, row.ctr_percentage as number);
        }
        const regularised = pavNonIncreasing(
          curveRows.map((r) => ({
            rank: r.rank_position as number,
            ctr: r.ctr_percentage as number,
          })),
        );
        let ranksAdjusted = 0;
        let maxAdjustmentPp = 0;
        for (let i = 0; i < curveRows.length; i++) {
          const raw = curveRows[i].ctr_percentage as number;
          const reg = regularised[i].ctr;
          const delta = Math.abs(raw - reg);
          if (delta > 1e-9) {
            ranksAdjusted += 1;
            if (delta > maxAdjustmentPp) maxAdjustmentPp = delta;
          }
          curveRows[i].ctr_percentage = reg;
        }
        maxAdjustmentPp = Math.round(maxAdjustmentPp * 100) / 100;

        const { data: inserted, error: insErr } = await sb
          .from("ctr_curves")
          .insert(curveRows)
          .select("id, rank_position");
        if (insErr) return await failRun("db_error", `Insert curves failed: ${insErr.message}`, 500);
        if (!inserted || inserted.length !== curveRows.length) {
          return await failRun("db_error", "Curve insert returned unexpected row count.", 500);
        }

        const confidence = confidenceFor(bucketImpr);
        const metaRows = (inserted as Array<{ id: string; rank_position: number }>).map((r) => ({
          project_id: projectId,
          ctr_curve_id: r.id,
          calc_run_id: calcRunId,
          source: sourceLabel,
          sample_impressions: bucketImpr,
          sample_clicks: bucketClicks,
          confidence,
          date_range_start: upload.date_range_start,
          date_range_end: upload.date_range_end,
          raw_ctr_percentage: rawByRank.get(r.rank_position) ?? null,
        }));
        const { error: metaErr } = await sb.from("ctr_curve_metadata").insert(metaRows);
        if (metaErr) return await failRun("db_error", `Insert metadata failed: ${metaErr.message}`, 500);

        curvesWritten += 1;
        bucketsSummary.push({
          device, intent,
          impressions: bucketImpr,
          clicks: bucketClicks,
          confidence,
          ranks_written: curveRows.length,
          ranks_skipped_empty: ranksSkippedEmpty.length,
          ranks_skipped_empty_list: ranksSkippedEmpty,
          ranks_adjusted: ranksAdjusted,
          max_adjustment_pp: maxAdjustmentPp,
        });
        if (confidence === "low") {
          warnings.push({ device, intent, low_confidence: true, impressions: bucketImpr });
        }
      }
    }

    if (curvesWritten === 0) {
      return await failRun(
        "no_valid_rows",
        "No intent bucket met the minimum impression threshold.",
        400,
      );
    }

    const summary = {
      upload_id: upload.id,
      upload_source: upload.source,
      date_range_start: upload.date_range_start,
      date_range_end: upload.date_range_end,
      rows_considered: rowsConsidered,
      rows_used: rowsUsed,
      branded_excluded_rows: brandedExcludedRows,
      unclassified_rows: unclassifiedRows,
      has_per_row_device: hasPerRowDevice,
      devices_built: devicesToBuild,
      curves_written: curvesWritten,
      buckets: bucketsSummary,
    };

    await sb
      .from("calc_run_registry")
      .update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        warnings,
        errors: [],
        summary_json: summary,
      })
      .eq("id", calcRunId);

    return json(200, {
      calc_run_id: calcRunId,
      ...summary,
      warnings,
    });
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    return await failRun("db_error", msg, 500);
  }
});
