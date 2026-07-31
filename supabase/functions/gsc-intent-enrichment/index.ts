import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const DATAFORSEO_BASE = "https://api.dataforseo.com";
const BATCH_SIZE = 700;
const VALID_INTENTS = new Set(["transactional", "commercial", "informational", "navigational"]);

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

function extractItems(json: any): any[] {
  const tasks = json?.tasks;
  if (!Array.isArray(tasks) || !tasks.length) {
    console.error("DataForSEO response missing tasks");
    return [];
  }

  const task = tasks[0];
  if (task?.status_code !== 20000) {
    console.error("DataForSEO task error:", task?.status_message);
    return [];
  }

  const result = task?.result;
  if (!Array.isArray(result) || !result.length) return [];
  if (Array.isArray(result[0]?.items)) return result[0].items;
  return result;
}

function parseIntent(item: any): string | null {
  const rawIntent = item?.keyword_intent ?? item?.search_intent_info?.main_intent ?? item?.intent;
  if (!rawIntent) return null;

  let label: string | undefined;

  if (Array.isArray(rawIntent)) {
    const first = rawIntent[0];
    label = typeof first === "string" ? first : first?.label;
  } else if (typeof rawIntent === "string") {
    label = rawIntent;
  } else if (typeof rawIntent === "object") {
    label = rawIntent?.label;
  }

  const normalized = label?.toLowerCase().trim();
  return normalized && VALID_INTENTS.has(normalized) ? normalized : null;
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

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { upload_id, project_id } = await req.json();
    if (!upload_id) throw new Error("upload_id is required");
    if (!project_id) throw new Error("project_id is required");

    const { data: keywords, error: kwErr } = await supabase
      .from("gsc_upload_keywords")
      .select("id, keyword, clicks, impressions, ctr, position")
      .eq("upload_id", upload_id)
      .order("impressions", { ascending: false });

    if (kwErr) throw kwErr;
    if (!keywords?.length) throw new Error("No keywords found for this upload");

    console.log(`gsc-intent-enrichment: ${keywords.length} keywords to enrich`);

    const dfBasicAuth = buildBasicAuth(DATAFORSEO_API_KEY);
    const dfHeaders = {
      Authorization: `Basic ${dfBasicAuth}`,
      "Content-Type": "application/json",
    };

    const intentMap: Record<string, string> = {};
    const allKeywordTexts = keywords.map((k: any) => k.keyword);

    for (let i = 0; i < allKeywordTexts.length; i += BATCH_SIZE) {
      const batch = allKeywordTexts.slice(i, i + BATCH_SIZE);
      console.log(`gsc-intent-enrichment: processing batch ${Math.floor(i / BATCH_SIZE) + 1}, ${batch.length} keywords`);

      try {
        const res = await fetch(
          `${DATAFORSEO_BASE}/v3/dataforseo_labs/google/search_intent/live`,
          {
            method: "POST",
            headers: dfHeaders,
            body: JSON.stringify([
              {
                keywords: batch,
                language_code: "en",
              },
            ]),
          }
        );

        if (!res.ok) {
          const errText = await res.text();
          console.error(`DataForSEO HTTP ${res.status}: ${errText.substring(0, 500)}`);
          continue;
        }

        const json = await res.json();
        const items = extractItems(json);
        console.log(`gsc-intent-enrichment: batch returned ${items.length} items`);
        if (items.length > 0) {
          console.log(`gsc-intent-enrichment: sample item keys: ${JSON.stringify(Object.keys(items[0]))}`);
        }

        for (const item of items) {
          const kw = item?.keyword;
          if (!kw) continue;

          const intent = parseIntent(item);
          if (intent) {
            intentMap[kw.toLowerCase()] = intent;
          }
        }
      } catch (batchErr) {
        console.error("Batch error:", batchErr);
      }
    }

    console.log(`gsc-intent-enrichment: resolved intents for ${Object.keys(intentMap).length} keywords`);

    const intentCounts: Record<string, number> = {};
    for (const kw of keywords) {
      const intent = intentMap[kw.keyword.toLowerCase()] || "generic";
      intentCounts[intent] = (intentCounts[intent] || 0) + 1;
      await supabase
        .from("gsc_upload_keywords")
        .update({ search_intent: intent })
        .eq("id", kw.id);
    }

    // NOTE: Legacy CTR-curve writing tail removed 2026-07-20 (curve corruption
    // forensics). This function used to write per-intent, mobile-only rows into
    // `ctr_curves` using `gsc_upload_keywords.ctr` (a fraction) as if it were a
    // percentage-point value, producing ~100× under-scaled rows that competed
    // with the canonical v2 writer `ctr-curves-from-gsc`. Curves are now
    // exclusively written by that v2 path (invoked from the admin
    // /admin/calculations page). This function is intent enrichment only.

    return new Response(
      JSON.stringify({
        enriched: Object.keys(intentMap).length,
        total_keywords: keywords.length,
        intent_counts: intentCounts,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("gsc-intent-enrichment error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});