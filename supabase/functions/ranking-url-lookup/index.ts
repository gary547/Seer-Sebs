// Boot evidence (guardrail 6):
console.log(`[boot] ranking-url-lookup ${new Date().toISOString()}`);

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const DATAFORSEO_BASE = "https://api.dataforseo.com";

function buildBasicAuth(secret: string): string {
  if (secret.includes(":")) return btoa(secret);
  return secret;
}

function extractItems(json: any, endpoint: string): any[] {
  const tasks = json?.tasks;
  if (!Array.isArray(tasks) || !tasks.length) {
    console.error(`[${endpoint}] No tasks in response:`, JSON.stringify(json?.status_message || json));
    return [];
  }
  const task = tasks[0];
  if (task.status_code !== 20000) {
    console.error(`[${endpoint}] Task failed: ${task.status_code} ${task.status_message}`);
    return [];
  }
  const result = task.result;
  if (!Array.isArray(result) || !result.length) return [];
  if (result[0]?.items && Array.isArray(result[0].items)) {
    return result[0].items;
  }
  return result;
}

async function isCancelled(supabase: any, projectId: string): Promise<boolean> {
  const { data } = await supabase
    .from("navigator_projects")
    .select("ranking_lookup_status")
    .eq("id", projectId)
    .single();
  return data?.ranking_lookup_status === "stopping";
}

async function setStatus(supabase: any, projectId: string, status: string) {
  await supabase
    .from("navigator_projects")
    .update({ ranking_lookup_status: status })
    .eq("id", projectId);
}

/**
 * Background processing — filters DataForSEO by our keywords in batches
 */
async function processRankingLookup(
  project_id: string,
  authHeader: string,
) {
  const DATAFORSEO_API_KEY = Deno.env.get("DATAFORSEO_API_KEY")!;
  const dfBasicAuth = buildBasicAuth(DATAFORSEO_API_KEY);
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const supabaseUser = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    await setStatus(supabase, project_id, "running");

    // Get project + client domain
    const { data: project, error: projErr } = await supabaseUser
      .from("navigator_projects")
      .select("client_id, clients(domain)")
      .eq("id", project_id)
      .single();
    if (projErr || !project) throw new Error("Project not found");

    const domain = (project.clients as any)?.domain;
    if (!domain) throw new Error("Client domain not set");

    const cleanDomain = domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    console.log(`[BG] Using domain: ${cleanDomain}`);

    // Fetch kept keywords that don't yet have a ranking_url AND haven't been
    // recently checked (or were last checked outside the freshness window).
    // This stops us re-paying DataForSEO for known no-matches every sync.
    const FRESHNESS_DAYS = 7;
    const stalenessCutoff = new Date(Date.now() - FRESHNESS_DAYS * 86400 * 1000).toISOString();
    const allKeywords: Array<{ id: string; keyword: string }> = [];
    let from = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await supabaseUser
        .from("keywords")
        .select("id, keyword, ranking_url, ranking_lookup_checked_at")
        .eq("project_id", project_id)
        .eq("detox_status", "keep")
        .is("ranking_url", null)
        .or(`ranking_lookup_checked_at.is.null,ranking_lookup_checked_at.lt.${stalenessCutoff}`)
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`Failed to fetch keywords: ${error.message}`);
      if (!data?.length) break;
      allKeywords.push(...data.map((d: any) => ({ id: d.id, keyword: d.keyword })));
      if (data.length < PAGE) break;
      from += PAGE;
    }

    if (!allKeywords.length) {
      console.log("[BG] No keywords to look up");
      await setStatus(supabase, project_id, "idle");
      return;
    }

    console.log(`[BG] Total keywords to look up: ${allKeywords.length}`);

    // Build keyword map for matching
    const kwMap = new Map<string, string>();
    for (const kw of allKeywords) {
      kwMap.set(kw.keyword.toLowerCase().trim(), kw.id);
    }

    const dfHeaders = {
      Authorization: `Basic ${dfBasicAuth}`,
      "Content-Type": "application/json",
    };

    // Process keywords in batches, filtering server-side via DataForSEO
    const BATCH_SIZE = 700; // Safe batch for filter "in" operator
    const kwList = Array.from(kwMap.keys());
    let matched = 0;
    let batchNum = 0;
    const matchedIds = new Set<string>();

    for (let i = 0; i < kwList.length; i += BATCH_SIZE) {
      batchNum++;
      const batch = kwList.slice(i, i + BATCH_SIZE);

      // Check for cancellation before each batch
      if (await isCancelled(supabase, project_id)) {
        console.log(`[BG] Cancelled at batch ${batchNum}, matched=${matched}`);
        await setStatus(supabase, project_id, "idle");
        return;
      }

      console.log(`[BG] Batch ${batchNum}: ${batch.length} keywords (offset ${i})`);

      // Paginate within this batch's filtered results
      let offset = 0;
      const LIMIT = 1000;

      while (true) {
        const res = await fetch(`${DATAFORSEO_BASE}/v3/dataforseo_labs/google/ranked_keywords/live`, {
          method: "POST",
          headers: dfHeaders,
          body: JSON.stringify([{
            target: cleanDomain,
            location_code: 2826,
            language_code: "en",
            ignore_synonyms: true,
            include_clickstream_data: false,
            load_rank_absolute: false,
            item_types: ["organic"],
            historical_serp_mode: "live",
            filters: ["keyword_data.keyword", "in", batch],
            order_by: ["keyword_data.keyword,asc"],
            limit: LIMIT,
            offset: offset,
          }]),
        });

        if (!res.ok) {
          const body = await res.text();
          throw new Error(`DataForSEO HTTP ${res.status}: ${body.slice(0, 300)}`);
        }

        const json = await res.json();
        const items = extractItems(json, "ranked_keywords");

        if (offset === 0) {
          const total = json?.tasks?.[0]?.result?.[0]?.total_count ?? 0;
          console.log(`[BG] Batch ${batchNum} matched ${total} keywords in DataForSEO`);
        }

        if (!items.length) break;

        // Collect updates from this page
        const updates: Array<{ id: string; ranking_url: string; base_rank: number }> = [];
        for (const item of items) {
          const kw = item?.keyword_data?.keyword;
          if (!kw) continue;

          const kwLower = kw.toLowerCase().trim();
          const kwId = kwMap.get(kwLower);
          if (!kwId) continue;

          const serpItem = item?.ranked_serp_element?.serp_item;
          const rankingUrl = serpItem?.relative_url || serpItem?.url || null;
          const rankPosition = serpItem?.rank_group ?? serpItem?.rank_absolute ?? null;

          if (rankingUrl && rankPosition != null) {
            updates.push({ id: kwId, ranking_url: rankingUrl, base_rank: rankPosition });
          }
        }

        // Batch DB updates in chunks of 50 concurrent requests
        const CHUNK = 50;
        const nowIso = new Date().toISOString();
        for (let c = 0; c < updates.length; c += CHUNK) {
          const chunk = updates.slice(c, c + CHUNK);
          const results = await Promise.all(
            chunk.map((u) =>
              supabase
                .from("keywords")
                .update({
                  ranking_url: u.ranking_url,
                  base_rank: u.base_rank,
                  base_rank_source: "dfs_labs",
                  base_rank_checked_at: nowIso,
                  ranking_lookup_checked_at: nowIso,
                  ranking_lookup_no_match: false,
                })
                .eq("id", u.id)
            )
          );
          results.forEach((r, idx) => {
            if (r.error) {
              console.error(`[BG] Batch update error: ${r.error.message}`);
            } else {
              matched++;
              matchedIds.add(chunk[idx].id);
            }
          });
        }

        offset += LIMIT;
        if (items.length < LIMIT) break;
      }
    }

    // Mark every keyword we tried but didn't match as "no match, checked now"
    // so the next sync skips them within the freshness window.
    const nowIso2 = new Date().toISOString();
    const unmatched = allKeywords.filter((k) => !matchedIds.has(k.id)).map((k) => k.id);
    const NM_CHUNK = 200;
    for (let i = 0; i < unmatched.length; i += NM_CHUNK) {
      const ids = unmatched.slice(i, i + NM_CHUNK);
      const { error } = await supabase
        .from("keywords")
        .update({ ranking_lookup_checked_at: nowIso2, ranking_lookup_no_match: true })
        .in("id", ids);
      if (error) console.error(`[BG] no-match stamp error: ${error.message}`);
    }

    console.log(`[BG] Complete: matched=${matched}, no_match=${unmatched.length}, total=${allKeywords.length}`);
    await setStatus(supabase, project_id, "idle");
  } catch (error) {
    console.error("[BG] ranking-url-lookup error:", error);
    await setStatus(supabase, project_id, "idle");
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const DATAFORSEO_API_KEY = Deno.env.get("DATAFORSEO_API_KEY");
    if (!DATAFORSEO_API_KEY) throw new Error("DATAFORSEO_API_KEY not configured");

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing authorization header");

    const { project_id, action } = await req.json();
    if (!project_id) throw new Error("project_id is required");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Handle stop action
    if (action === "stop") {
      await setStatus(supabase, project_id, "stopping");
      return new Response(
        JSON.stringify({ status: "stopping", message: "Stop signal sent" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Start background processing
    // @ts-ignore EdgeRuntime.waitUntil is a Supabase-specific API
    EdgeRuntime.waitUntil(
      processRankingLookup(project_id, authHeader).catch((err) => {
        console.error("[BG] Unhandled error:", err);
        setStatus(supabase, project_id, "idle");
      })
    );

    return new Response(
      JSON.stringify({ status: "processing", message: "Ranking URL lookup started in background" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("ranking-url-lookup error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
