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

function median(arr: number[]): number {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const DATAFORSEO_API_KEY = Deno.env.get("DATAFORSEO_API_KEY");
    if (!DATAFORSEO_API_KEY) throw new Error("DATAFORSEO_API_KEY not configured");

    // Validate the caller's Supabase JWT — the previous check only ensured a
    // header was present, which anyone could spoof.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const token = authHeader.slice("Bearer ".length);
    const authClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );
    const { data: claims, error: claimsErr } = await authClient.auth.getClaims(token);
    if (claimsErr || !claims?.claims?.sub) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }


    const { domain, device, location_code, intent_segment, target_path } = await req.json();
    if (!domain) throw new Error("domain is required");

    const loc = location_code || 2826; // UK default
    const dev = device || "desktop";

    // Use target_path if provided (supports subfolder like currys.co.uk/tvs/)
    const target = target_path || domain;

    const dfBasicAuth = buildBasicAuth(DATAFORSEO_API_KEY);
    const dfHeaders = {
      Authorization: `Basic ${dfBasicAuth}`,
      "Content-Type": "application/json",
    };

    // Call ranked_keywords/live
    const res = await fetch(
      `${DATAFORSEO_BASE}/v3/dataforseo_labs/google/ranked_keywords/live`,
      {
        method: "POST",
        headers: dfHeaders,
        body: JSON.stringify([
          {
            target,
            location_code: loc,
            language_code: "en",
            limit: 1000,
            order_by: ["keyword_data.keyword_info.search_volume,desc"],
            filters: [
              ["ranked_serp_element.serp_item.rank_group", "<=", 20],
              "and",
              ["keyword_data.keyword_info.search_volume", ">", 0],
            ],
          },
        ]),
      }
    );

    if (!res.ok) {
      throw new Error(`DataForSEO HTTP ${res.status}: ${await res.text()}`);
    }

    const json = await res.json();
    const tasks = json?.tasks;
    if (!Array.isArray(tasks) || !tasks.length || tasks[0].status_code !== 20000) {
      throw new Error(`DataForSEO task error: ${tasks?.[0]?.status_message || "unknown"}`);
    }

    const items = tasks[0].result?.[0]?.items || [];
    console.log(`ctr-benchmark: ${items.length} ranked keywords returned for ${target}`);

    // Filter by intent if specified
    let filteredItems = items;
    if (intent_segment) {
      filteredItems = items.filter((item: any) => {
        const mainIntent = item?.keyword_data?.search_intent_info?.main_intent;
        if (!mainIntent) return false;
        const intentLower = mainIntent.toLowerCase();
        const segmentLower = intent_segment.toLowerCase();
        if (segmentLower === "commercial") {
          return intentLower === "commercial" || intentLower.startsWith("commercial");
        }
        return intentLower === segmentLower;
      });
      console.log(`ctr-benchmark: ${filteredItems.length}/${items.length} keywords match intent "${intent_segment}"`);
    }

    // Group by rank position, compute implied CTR
    const byRank: Record<number, number[]> = {};
    for (const item of filteredItems) {
      const rankGroup = item?.ranked_serp_element?.serp_item?.rank_group;
      const etv = item?.ranked_serp_element?.serp_item?.etv;
      const searchVolume = item?.keyword_data?.keyword_info?.search_volume;

      if (!rankGroup || rankGroup < 1 || rankGroup > 20) continue;
      if (!searchVolume || searchVolume <= 0) continue;
      if (etv == null || etv < 0) continue;

      const impliedCtr = (etv / searchVolume) * 100;
      if (impliedCtr > 100) continue; // skip outliers

      if (!byRank[rankGroup]) byRank[rankGroup] = [];
      byRank[rankGroup].push(impliedCtr);
    }

    const result = [];
    for (let pos = 1; pos <= 20; pos++) {
      const values = byRank[pos] || [];
      result.push({
        rank_position: pos,
        ctr_percentage: values.length ? Math.round(median(values) * 100) / 100 : 0,
        device: dev,
      });
    }

    // Build top 100 keywords for the response
    const top_keywords = filteredItems.slice(0, 100).map((item: any) => {
      const sv = item?.keyword_data?.keyword_info?.search_volume || 0;
      const etv = item?.ranked_serp_element?.serp_item?.etv || 0;
      return {
        keyword: item?.keyword_data?.keyword || "",
        search_volume: sv,
        rank_position: item?.ranked_serp_element?.serp_item?.rank_group || null,
        etv: Math.round(etv * 100) / 100,
        implied_ctr: sv > 0 ? Math.round((etv / sv) * 10000) / 100 : 0,
        intent: item?.keyword_data?.search_intent_info?.main_intent || null,
      };
    });

    return new Response(JSON.stringify({ data: result, keywords_analyzed: filteredItems.length, intent_segment: intent_segment || null, top_keywords }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("ctr-benchmark error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
