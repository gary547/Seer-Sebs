// base-rank-backfill — apply the serp_results-authoritative derivation rule
// across a project's kept keywords using EXISTING data (no DFS API spend).
//
// Boot evidence (guardrail 6):
console.log(`[boot] base-rank-backfill ${new Date().toISOString()}`);

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { deriveBaseRank, normalizeHost, type ExistingKeyword, type SerpRow } from "../_shared/base-rank-derivation.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing authorization header");
    const body = await req.json().catch(() => ({}));
    const project_id: string | undefined = body?.project_id;
    if (!project_id) {
      return jsonResp(400, { error: "project_id required" });
    }

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

    // Load project + client domain
    const { data: project, error: projErr } = await service
      .from("navigator_projects")
      .select("client_id, clients(domain, domain_normalized)")
      .eq("id", project_id)
      .single();
    if (projErr || !project) return jsonResp(404, { error: "project not found" });

    const clientDomain =
      (project.clients as { domain_normalized?: string; domain?: string } | null)?.domain_normalized ??
      (project.clients as { domain?: string } | null)?.domain ?? null;
    const clientHost = normalizeHost(clientDomain);
    if (!clientHost) return jsonResp(400, { error: "client_domain_missing" });

    // Pull all kept keywords (paginated)
    type KwRow = { id: string } & ExistingKeyword;
    const keywords: KwRow[] = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await service
        .from("keywords")
        .select("id, base_rank, ranking_url, base_rank_source, base_rank_checked_at, ranking_lookup_checked_at")
        .eq("project_id", project_id)
        .eq("detox_status", "keep")
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`keywords: ${error.message}`);
      if (!data?.length) break;
      keywords.push(...(data as KwRow[]));
      if (data.length < PAGE) break;
    }

    // Pull every serp_results row for the project (paginated).
    // Group by keyword_id → keep rows from the latest fetched_at bucket per keyword.
    const serpByKw = new Map<string, SerpRow[]>();
    const latestByKw = new Map<string, number>();
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await service
        .from("serp_results")
        .select("keyword_id, rank_absolute, url, domain, fetched_at")
        .eq("project_id", project_id)
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`serp_results: ${error.message}`);
      if (!data?.length) break;
      for (const r of data as Array<{ keyword_id: string; rank_absolute: number | null; url: string | null; domain: string | null; fetched_at: string | null }>) {
        if (!r.keyword_id || !r.fetched_at) continue;
        const t = new Date(r.fetched_at).getTime();
        const cur = latestByKw.get(r.keyword_id) ?? -Infinity;
        if (t > cur) {
          latestByKw.set(r.keyword_id, t);
          serpByKw.set(r.keyword_id, [r]);
        } else if (t === cur) {
          serpByKw.get(r.keyword_id)!.push(r);
        }
      }
      if (data.length < PAGE) break;
    }

    // Derive + write
    let updated_null_to_ranked = 0;
    let updated_rank_changed = 0;
    let unchanged = 0;
    let source_serp = 0;
    let source_dfs = 0;
    const CHUNK = 50;

    for (let i = 0; i < keywords.length; i += CHUNK) {
      const chunk = keywords.slice(i, i + CHUNK);
      await Promise.all(chunk.map(async (kw) => {
        const rows = serpByKw.get(kw.id) ?? [];
        const res = deriveBaseRank(clientHost, rows, kw);
        // Only write when something changes on the row.
        const changed =
          res.base_rank !== kw.base_rank ||
          res.ranking_url !== kw.ranking_url ||
          res.base_rank_source !== kw.base_rank_source ||
          res.base_rank_checked_at !== kw.base_rank_checked_at;

        if (kw.base_rank === null && res.base_rank !== null) updated_null_to_ranked++;
        else if (kw.base_rank !== null && res.base_rank !== null && kw.base_rank !== res.base_rank) updated_rank_changed++;
        else if (!changed) unchanged++;

        if (res.base_rank_source === "serp_results") source_serp++;
        else if (res.base_rank_source === "dfs_labs") source_dfs++;

        if (!changed) return;
        const { error } = await service
          .from("keywords")
          .update({
            base_rank: res.base_rank,
            ranking_url: res.ranking_url,
            base_rank_source: res.base_rank_source,
            base_rank_checked_at: res.base_rank_checked_at,
          })
          .eq("id", kw.id);
        if (error) console.error(`[backfill] update ${kw.id}: ${error.message}`);
      }));
    }

    return jsonResp(200, {
      project_id,
      client_domain: clientHost,
      total_scanned: keywords.length,
      keywords_with_snapshot: serpByKw.size,
      updated_null_to_ranked,
      updated_rank_changed,
      unchanged,
      source_serp_results: source_serp,
      source_dfs_labs: source_dfs,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[base-rank-backfill] error:", msg);
    return jsonResp(500, { error: msg });
  }
});

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
