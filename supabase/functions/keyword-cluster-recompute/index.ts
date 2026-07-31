// keyword-cluster-recompute — admin-only, per project.
// Groups kept keywords by form-based cluster_key (see _shared/keyword-cluster.ts)
// and marks a canonical member per cluster. Canonical selection is GSC-clicks
// first (surface form users actually click), with volume / base_rank /
// alphabetical fallbacks; the basis is persisted per keyword.
// Idempotent; forecasting values are untouched.

console.log(`[keyword-cluster-recompute] boot v3 exact-form-canonical + cluster-properties ${new Date().toISOString()}`);

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  computeClusterProperties,
  normaliseExactForm,
  normaliseKeyword,
  pickCanonicalWithBasis,
  type CanonicalBasis,
} from "../_shared/keyword-cluster.ts";
import { fetchAllRows, selectIn } from "../_shared/pgrst-in.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function jsonResp(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function serializeErr(e: unknown): Record<string, unknown> {
  if (e instanceof Error) return { message: e.message, stack: e.stack };
  if (e && typeof e === "object") return e as Record<string, unknown>;
  return { message: String(e) };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const started = Date.now();

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResp(401, { error: "unauthenticated" });
    const body = await req.json().catch(() => ({}));
    const project_id: string | undefined = body?.project_id;
    if (!project_id) return jsonResp(400, { error: "project_id required" });

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const service = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const asUser = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // AuthN + admin gate
    const { data: userRes } = await asUser.auth.getUser();
    const uid = userRes?.user?.id;
    if (!uid) return jsonResp(401, { error: "unauthenticated" });
    const { data: isAdmin } = await service.rpc("has_role", { _user_id: uid, _role: "admin" });
    const { data: isSuper } = await service.rpc("has_role", { _user_id: uid, _role: "super_admin" });
    if (!isAdmin && !isSuper) return jsonResp(403, { error: "forbidden" });

    // 1. Load kept keywords (paginated).
    type KwRow = {
      id: string;
      keyword: string;
      base_rank: number | null;
      avg_monthly_volume: number | null;
      ranking_url: string | null;
    };
    const keywords: KwRow[] = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await service
        .from("keywords")
        .select("id, keyword, base_rank, avg_monthly_volume, ranking_url")
        .eq("project_id", project_id)
        .eq("detox_status", "keep")
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`keywords: ${error.message}`);
      if (!data?.length) break;
      keywords.push(...(data as KwRow[]));
      if (data.length < PAGE) break;
    }

    if (keywords.length === 0) {
      return jsonResp(200, {
        summary: {
          keywords_scanned: 0,
          distinct_clusters: 0,
          multi_member_clusters: 0,
          largest_cluster_size: 0,
          duration_ms: Date.now() - started,
        },
      });
    }

    // 2. Fetch last-12-month monthly volumes; sum per keyword.
    const ids = keywords.map((k) => k.id);
    const now = new Date();
    const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 12, 1))
      .toISOString().slice(0, 10);

    const monthlyRows = await selectIn<{ keyword_id: string; volume: number | null; month: string }>(
      service,
      "keyword_monthly_volumes",
      "keyword_id, volume, month",
      "keyword_id",
      ids,
      { paginate: true },
    );
    const monthlySum = new Map<string, number>();
    for (const r of monthlyRows) {
      if (!r.month || r.month < cutoff) continue;
      const v = Number(r.volume ?? 0);
      if (!Number.isFinite(v)) continue;
      monthlySum.set(r.keyword_id, (monthlySum.get(r.keyword_id) ?? 0) + v);
    }

    // 3. Load latest GSC upload for this project and aggregate non-branded
    //    clicks by EXACT normalised form (space/case-only). Each curated
    //    member then attributes only its own form's clicks — this is what
    //    makes the canonical picker's gsc_clicks tier differentiate members.
    const gscExactByForm = new Map<string, number>();
    {
      const { data: uploadRow } = await service
        .from("gsc_uploads")
        .select("id")
        .eq("project_id", project_id)
        .order("uploaded_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (uploadRow?.id) {
        const gscRows = await fetchAllRows<{
          keyword: string; clicks: number | null; is_branded: boolean | null;
        }>(
          service, "gsc_upload_keywords", "keyword, clicks, is_branded",
          (q) => q.eq("upload_id", uploadRow.id),
        );
        for (const r of gscRows) {
          if (r.is_branded === true) continue;
          const key = normaliseExactForm(r.keyword ?? "");
          if (!key) continue;
          const c = Number(r.clicks ?? 0);
          if (!Number.isFinite(c) || c <= 0) continue;
          gscExactByForm.set(key, (gscExactByForm.get(key) ?? 0) + c);
        }
      }
    }

    // 4. Compute cluster_key and per-keyword annual_volume + exact-form gsc_clicks.
    type Enriched = KwRow & {
      cluster_key: string;
      annual_volume: number;
      gsc_clicks: number;
    };
    const enriched: Enriched[] = keywords.map((k) => {
      const sum = monthlySum.get(k.id);
      const annual = sum && sum > 0
        ? sum
        : (Number.isFinite(Number(k.avg_monthly_volume))
          ? Number(k.avg_monthly_volume) * 12
          : 0);
      const clusterKey = normaliseKeyword(k.keyword ?? "");
      const exactKey = normaliseExactForm(k.keyword ?? "");
      return {
        ...k,
        cluster_key: clusterKey,
        annual_volume: annual,
        gsc_clicks: gscExactByForm.get(exactKey) ?? 0,
      };
    });

    // 5. Group and pick canonical per cluster_key using the GSC-first ladder
    //    (see _shared/keyword-cluster.ts pickCanonicalWithBasis).
    const groups = new Map<string, Enriched[]>();
    for (const e of enriched) {
      if (!e.cluster_key) continue; // safety: skip empty keys
      const arr = groups.get(e.cluster_key) ?? [];
      arr.push(e);
      groups.set(e.cluster_key, arr);
    }

    const canonicalById = new Map<string, {
      canonical_id: string;
      count: number;
      cluster_key: string;
      basis: CanonicalBasis;
      cluster_volume_annual: number | null;
      cluster_base_rank: number | null;
      cluster_base_rank_keyword_id: string | null;
      cluster_ranking_url: string | null;
      cluster_url_conflict: boolean;
    }>();
    let multiMember = 0;
    let largest = 0;
    let urlConflictClusters = 0;
    const basisCounts: Record<CanonicalBasis, number> = {
      gsc_clicks: 0, volume: 0, base_rank: 0, alphabetical: 0,
    };
    for (const [key, members] of groups.entries()) {
      if (members.length > 1) multiMember += 1;
      if (members.length > largest) largest = members.length;
      const picked = pickCanonicalWithBasis(members);
      basisCounts[picked.basis] += 1;
      const props = computeClusterProperties(members);
      if (props.cluster_url_conflict) urlConflictClusters += 1;
      for (const m of members) {
        canonicalById.set(m.id, {
          canonical_id: picked.member.id,
          count: members.length,
          cluster_key: key,
          basis: picked.basis,
          cluster_volume_annual: props.cluster_volume_annual,
          cluster_base_rank: props.cluster_base_rank,
          cluster_base_rank_keyword_id: props.cluster_base_rank_keyword_id,
          cluster_ranking_url: props.cluster_ranking_url,
          cluster_url_conflict: props.cluster_url_conflict,
        });
      }
    }

    // 6. Persist. Update rows in chunks; each row keeps identical fields when
    //    inputs are stable (idempotent aside from cluster_computed_at).
    const computed_at = new Date().toISOString();
    const CHUNK = 200;
    let updated = 0;
    const rows = enriched
      .filter((e) => canonicalById.has(e.id))
      .map((e) => {
        const meta = canonicalById.get(e.id)!;
        return {
          id: e.id,
          cluster_key: meta.cluster_key,
          cluster_canonical_keyword_id: meta.canonical_id,
          cluster_member_count: meta.count,
          cluster_canonical_basis: meta.basis,
          cluster_computed_at: computed_at,
          cluster_volume_annual: meta.cluster_volume_annual,
          cluster_base_rank: meta.cluster_base_rank,
          cluster_base_rank_keyword_id: meta.cluster_base_rank_keyword_id,
          cluster_ranking_url: meta.cluster_ranking_url,
          cluster_url_conflict: meta.cluster_url_conflict,
        };
      });

    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      for (const r of chunk) {
        const { error } = await service
          .from("keywords")
          .update({
            cluster_key: r.cluster_key,
            cluster_canonical_keyword_id: r.cluster_canonical_keyword_id,
            cluster_member_count: r.cluster_member_count,
            cluster_canonical_basis: r.cluster_canonical_basis,
            cluster_computed_at: r.cluster_computed_at,
            cluster_volume_annual: r.cluster_volume_annual,
            cluster_base_rank: r.cluster_base_rank,
            cluster_base_rank_keyword_id: r.cluster_base_rank_keyword_id,
            cluster_ranking_url: r.cluster_ranking_url,
            cluster_url_conflict: r.cluster_url_conflict,
          })
          .eq("id", r.id);
        if (error) throw new Error(`update ${r.id}: ${error.message}`);
        updated += 1;
      }
    }

    return jsonResp(200, {
      summary: {
        keywords_scanned: keywords.length,
        distinct_clusters: groups.size,
        multi_member_clusters: multiMember,
        largest_cluster_size: largest,
        keywords_updated: updated,
        basis_counts: basisCounts,
        gsc_exact_forms_with_clicks: gscExactByForm.size,
        url_conflict_clusters: urlConflictClusters,
        duration_ms: Date.now() - started,
      },
    });
  } catch (e) {
    console.error("[keyword-cluster-recompute] error", serializeErr(e));
    return jsonResp(500, { error: (e as Error)?.message ?? "internal_error", details: serializeErr(e) });
  }
});
