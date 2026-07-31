import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const currency = (value: number | null | undefined) =>
  value == null ? "unknown" : `£${Math.round(value).toLocaleString("en-GB")}`;

const priorityLabel = (priority: number | null | undefined) => {
  if (priority === 1) return "Primary";
  if (priority === 2) return "Secondary";
  if (priority === 3) return "Tertiary";
  return "Unassigned";
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
    if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not configured");

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing authorization header");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      {
        global: { headers: { Authorization: authHeader } },
        auth: { autoRefreshToken: false, persistSession: false },
      },
    );

    const { project_id } = await req.json();
    if (!project_id || typeof project_id !== "string") throw new Error("project_id is required");

    const { data: project, error: projectError } = await supabase
      .from("navigator_projects")
      .select("id, project_name, category_focus, last_synced_at, clients(company_name, domain)")
      .eq("id", project_id)
      .single();
    if (projectError || !project) throw new Error("Project not found");

    const { data: forecasts, error: forecastError } = await supabase
      .from("keyword_forecasts")
      .select(`
        keyword_id,
        har,
        har_revenue_gain_annual,
        yearly_revenue_gain_rank1,
        keywords!inner(keyword, keyword_priority, avg_monthly_volume, base_rank, ranking_url, search_intent, tag_1, project_id)
      `)
      .eq("keywords.project_id", project_id)
      .not("keywords.keyword_priority", "is", null)
      .order("har_revenue_gain_annual", { ascending: false, nullsFirst: false })
      .limit(40);
    if (forecastError) throw new Error(`Failed to fetch forecast data: ${forecastError.message}`);

    if (!forecasts?.length) {
      throw new Error("Assign keyword priorities and sync before generating a roadmap.");
    }

    const keywordIds = forecasts.map((f: any) => f.keyword_id);

    const [{ data: harRows }, { data: archRows }] = await Promise.all([
      supabase
        .from("har_results")
        .select("keyword_id, client_url_rating, har_competitor_ur, har_competitor_url")
        .eq("project_id", project_id)
        .in("keyword_id", keywordIds),
      supabase
        .from("site_architecture")
        .select("keyword_id, matched_url, relevancy_score, content_status, tactical_rag_status")
        .in("keyword_id", keywordIds),
    ]);

    const harByKeyword = new Map((harRows ?? []).map((row: any) => [row.keyword_id, row]));
    const archByKeyword = new Map((archRows ?? []).map((row: any) => [row.keyword_id, row]));

    const opportunityRows = forecasts.map((f: any) => {
      const kw = f.keywords;
      const har = harByKeyword.get(f.keyword_id) as any;
      const arch = archByKeyword.get(f.keyword_id) as any;
      const clientUr = har?.client_url_rating ?? null;
      const competitorUr = har?.har_competitor_ur ?? null;
      const linkGap = clientUr != null && competitorUr != null ? Math.round(competitorUr - clientUr) : null;
      return {
        priority: priorityLabel(kw?.keyword_priority),
        keyword: kw?.keyword,
        category: kw?.tag_1,
        intent: kw?.search_intent,
        volume: kw?.avg_monthly_volume,
        current_rank: kw?.base_rank,
        target_tp_rank: f.har,
        tp_revenue_uplift: currency(f.har_revenue_gain_annual),
        ranking_url: kw?.ranking_url,
        architecture_action: arch?.tactical_rag_status ?? "unknown",
        architecture_fit: arch?.relevancy_score == null ? "unknown" : `${Math.round(Number(arch.relevancy_score) * 100)}%`,
        architecture_status: arch?.content_status ?? "unknown",
        matched_url: arch?.matched_url,
        client_url_rating: clientUr,
        competitor_url_rating_at_tp: competitorUr,
        link_gap_points: linkGap,
        competitor_url_at_tp: har?.har_competitor_url,
      };
    });

    const system = `You are an SEO, content marketing, and digital PR strategist with 15 years of experience across complex ecommerce and B2B brands.
Create a practical roadmap to success using only the project data provided.
Prioritise commercially meaningful actions based on priority tier, TP revenue uplift, site architecture gaps, and link gaps.
Avoid generic advice. Every recommendation must cite the keyword/cluster, URL, evidence, action, and expected commercial impact.
Write concise markdown with 3-5 numbered actions. Include digital PR recommendations only when link-gap evidence supports it.`;

    const user = JSON.stringify({
      project: {
        name: project.project_name,
        category_focus: project.category_focus,
        client: (project.clients as any)?.company_name,
        domain: (project.clients as any)?.domain,
      },
      opportunities: opportunityRows,
    }, null, 2);

    const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1800,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });

    if (!claudeResponse.ok) {
      const errorText = await claudeResponse.text();
      console.error("Claude roadmap error:", claudeResponse.status, errorText);
      throw new Error(`Claude roadmap error: ${claudeResponse.status}`);
    }

    const claudeData = await claudeResponse.json();
    const roadmap = claudeData.content?.[0]?.text?.trim();
    if (!roadmap) throw new Error("Claude returned an empty roadmap");

    const now = new Date().toISOString();
    // Insert a new historical record on every generation (do not overwrite previous roadmaps).
    const { error: insertError } = await (supabase as any)
      .from("project_roadmaps")
      .insert({
        project_id,
        roadmap_markdown: roadmap,
        generated_at: now,
        synced_at: project.last_synced_at ?? null,
      });
    if (insertError) throw new Error(`Failed to save roadmap: ${insertError.message}`);

    return new Response(JSON.stringify({ roadmap, generated_at: now }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("roadmap-to-success error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
