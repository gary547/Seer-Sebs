// Content Planner — generate a 12-piece quarterly plan from selected keywords.
// Clusters → scores → assigns formats → fetches SERP top-3 → Claude enriches → writes plan.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const DFS_BASE = "https://api.dataforseo.com";
function buildBasicAuth(secret: string): string {
  if (secret.includes(":")) return btoa(secret);
  return secret;
}

type Mix = { hero: number; blog: number; page: number; category: number; product: number };
const DEFAULT_MIX: Mix = { hero: 2, blog: 6, page: 2, category: 1, product: 1 };

interface KeywordRow {
  id: string;
  keyword: string;
  search_intent: string | null;
  tag_1: string | null;
  tag_2: string | null;
  tag_3: string | null;
  peak_month: string | null;
  base_rank: number | null;
  ranking_url: string | null;
}

interface ForecastRow {
  keyword_id: string;
  yearly_revenue_gain_rank1: number | null;
  months_to_peak: number | null;
  seasonal_urgency: number | null;
}

interface SiteArchRow {
  keyword_id: string;
  recommended_url: string | null;
  status: string | null;
}

interface Cluster {
  primary: KeywordRow;
  secondaries: KeywordRow[];
  recommendedUrl: string | null;
  archStatus: string | null;
  intent: string;
  totalRevenue: number;
  primaryRevenue: number;
  monthsToPeak: number;
  peakMonth: string | null;
  score: number;
  format?: "hero" | "blog" | "page" | "category" | "product";
}

function intentWeight(i: string | null): number {
  switch ((i || "").toLowerCase()) {
    case "transactional": return 1.0;
    case "commercial": return 0.85;
    case "informational": return 0.6;
    case "navigational": return 0.4;
    default: return 0.5;
  }
}
function journeyStage(i: string | null): string {
  switch ((i || "").toLowerCase()) {
    case "transactional": return "Convert";
    case "commercial": return "Consider";
    case "informational": return "Attract";
    case "navigational": return "Retain";
    default: return "Consider";
  }
}
function urlLooksProduct(u: string | null): boolean {
  if (!u) return false;
  return /\/(product|products|p|item|items|sku)\//i.test(u);
}
function urlLooksCategory(u: string | null): boolean {
  if (!u) return false;
  return /\/(category|categories|collection|collections|c|shop|range|ranges)\//i.test(u);
}

// Subtract weeks from a date.
function isoMonthOffset(peakMonth: string | null, weeks: number): string | null {
  if (!peakMonth) return null;
  // peak_month is YYYY-MM or YYYY-MM-DD
  const ymd = peakMonth.length === 7 ? `${peakMonth}-01` : peakMonth;
  const d = new Date(ymd);
  if (isNaN(d.getTime())) return null;
  d.setDate(d.getDate() - weeks * 7);
  return d.toISOString().slice(0, 10);
}

async function fetchSerpTop3(
  supabase: any,
  dfBasicAuth: string,
  keyword: string
): Promise<any[]> {
  // 30-day cache
  const { data: cached } = await supabase
    .from("serp_top3_cache")
    .select("results, fetched_at")
    .eq("keyword_text", keyword)
    .eq("location_code", 2826)
    .eq("language_code", "en")
    .maybeSingle();

  if (cached?.results && cached.fetched_at) {
    const age = Date.now() - new Date(cached.fetched_at).getTime();
    if (age < 30 * 24 * 60 * 60 * 1000) return cached.results;
  }

  try {
    const r = await fetch(`${DFS_BASE}/v3/serp/google/organic/live/advanced`, {
      method: "POST",
      headers: { "Authorization": `Basic ${dfBasicAuth}`, "Content-Type": "application/json" },
      body: JSON.stringify([{
        keyword,
        location_code: 2826,
        language_code: "en",
        device: "desktop",
        depth: 10,
      }]),
    });
    const json = await r.json();
    const items = json?.tasks?.[0]?.result?.[0]?.items ?? [];
    const top3 = items
      .filter((it: any) => it.type === "organic")
      .slice(0, 3)
      .map((it: any, i: number) => ({
        rank: it.rank_absolute ?? (i + 1),
        url: it.url,
        title: it.title,
        snippet: it.description,
        domain: it.domain,
      }));

    await supabase.from("serp_top3_cache").upsert({
      keyword_text: keyword,
      location_code: 2826,
      language_code: "en",
      results: top3,
      fetched_at: new Date().toISOString(),
    }, { onConflict: "keyword_text,location_code,language_code" });

    return top3;
  } catch (e) {
    console.error("SERP fetch failed for", keyword, e);
    return [];
  }
}

async function callClaude(anthropicKey: string, system: string, userMsg: string, maxTokens = 8000): Promise<string> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userMsg }],
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Claude ${r.status}: ${t.slice(0, 300)}`);
  }
  const j = await r.json();
  return j?.content?.[0]?.text ?? "";
}

function extractJson(text: string): any {
  const m = text.match(/```json\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  const raw = m ? m[1] || m[0] : text;
  return JSON.parse(raw);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
    const DATAFORSEO_API_KEY = Deno.env.get("DATAFORSEO_API_KEY")!;
    if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
    if (!DATAFORSEO_API_KEY) throw new Error("DATAFORSEO_API_KEY not set");

    const dfBasicAuth = buildBasicAuth(DATAFORSEO_API_KEY);

    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: userData, error: userErr } = await userClient.auth.getUser();
    const userId = userData?.user?.id ?? null;
    if (userErr || !userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const {
      clientId,
      projectId,
      name,
      keywordIds,
      mix = DEFAULT_MIX,
      defaultLeadWeeks = 12,
      heroLeadWeeks = 16,
      promotedHeroIds = [] as string[],
    } = body;

    if (!clientId || !projectId || !Array.isArray(keywordIds) || keywordIds.length === 0) {
      return new Response(JSON.stringify({ error: "clientId, projectId, keywordIds required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify caller can see this client + project via RLS-scoped helpers.
    const [{ data: canClient }, { data: canProject }] = await Promise.all([
      userClient.rpc("is_visible_client", { _client_id: clientId }),
      userClient.rpc("is_visible_project", { _project_id: projectId }),
    ]);
    if (!canClient || !canProject) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }


    // Create plan + job rows up front.
    const { data: plan, error: planErr } = await admin
      .from("content_plans")
      .insert({
        client_id: clientId,
        project_id: projectId,
        name: name || `Content plan · ${new Date().toISOString().slice(0, 10)}`,
        mix,
        default_lead_weeks: defaultLeadWeeks,
        hero_lead_weeks: heroLeadWeeks,
        status: "briefed",
        created_by: userId,
      })
      .select("*")
      .single();
    if (planErr || !plan) throw planErr ?? new Error("plan insert failed");

    const { data: job } = await admin.from("content_plan_jobs").insert({
      plan_id: plan.id, client_id: clientId, project_id: projectId,
      status: "running", total: 12, processed: 0, started_at: new Date().toISOString(),
    }).select("*").single();

    // Pull keywords + forecasts + site architecture for selected + siblings (same project).
    const { data: kws } = await admin
      .from("keywords")
      .select("id, keyword, search_intent, tag_1, tag_2, tag_3, peak_month, base_rank, ranking_url, project_id")
      .eq("project_id", projectId);
    const { data: forecasts } = await admin
      .from("keyword_forecasts")
      .select("keyword_id, yearly_revenue_gain_rank1, months_to_peak, seasonal_urgency")
      .in("keyword_id", (kws ?? []).map((k: any) => k.id));
    const { data: arch } = await admin
      .from("site_architecture")
      .select("keyword_id, recommended_url, status")
      .in("keyword_id", (kws ?? []).map((k: any) => k.id));

    const fMap = new Map<string, ForecastRow>();
    (forecasts ?? []).forEach((f: any) => fMap.set(f.keyword_id, f));
    const aMap = new Map<string, SiteArchRow>();
    (arch ?? []).forEach((a: any) => aMap.set(a.keyword_id, a));

    const selectedSet = new Set<string>(keywordIds);
    const selectedKws = (kws ?? []).filter((k: any) => selectedSet.has(k.id));

    // Cluster: by recommended_url first, else by tag_3 + intent.
    const clusterMap = new Map<string, KeywordRow[]>();
    for (const k of selectedKws) {
      const arch = aMap.get(k.id);
      const key = arch?.recommended_url
        ? `url:${arch.recommended_url}`
        : `topic:${(k.tag_3 ?? k.tag_2 ?? k.tag_1 ?? "uncat").toLowerCase()}|${(k.search_intent ?? "x").toLowerCase()}`;
      const arr = clusterMap.get(key) ?? [];
      arr.push(k);
      clusterMap.set(key, arr);
    }

    // Optionally pull siblings for richer secondaries
    const allByKey = new Map<string, KeywordRow[]>();
    for (const k of (kws ?? [])) {
      const arch = aMap.get(k.id);
      const key = arch?.recommended_url
        ? `url:${arch.recommended_url}`
        : `topic:${(k.tag_3 ?? k.tag_2 ?? k.tag_1 ?? "uncat").toLowerCase()}|${(k.search_intent ?? "x").toLowerCase()}`;
      const arr = allByKey.get(key) ?? [];
      arr.push(k);
      allByKey.set(key, arr);
    }

    const clusters: Cluster[] = [];
    for (const [key, members] of clusterMap.entries()) {
      // Sort by revenue desc to pick primary
      const enriched = members.map((m) => ({ k: m, rev: Number(fMap.get(m.id)?.yearly_revenue_gain_rank1 ?? 0) }));
      enriched.sort((a, b) => b.rev - a.rev);
      const primary = enriched[0].k;
      // Pull additional siblings from project (cap 8 total secondaries)
      const siblings = (allByKey.get(key) ?? []).filter((s) => s.id !== primary.id);
      const secondaries = siblings.slice(0, 8);
      const archInfo = aMap.get(primary.id);
      const totalRevenue = enriched.reduce((s, e) => s + e.rev, 0)
        + secondaries.filter((s) => !selectedSet.has(s.id)).reduce((s, k) => s + Number(fMap.get(k.id)?.yearly_revenue_gain_rank1 ?? 0), 0);
      const primaryF = fMap.get(primary.id);
      clusters.push({
        primary,
        secondaries,
        recommendedUrl: archInfo?.recommended_url ?? primary.ranking_url ?? null,
        archStatus: archInfo?.status ?? null,
        intent: primary.search_intent ?? "informational",
        totalRevenue,
        primaryRevenue: enriched[0].rev,
        monthsToPeak: Number(primaryF?.months_to_peak ?? 3),
        peakMonth: primary.peak_month ?? null,
        score: 0,
      });
    }

    // Score
    const maxRev = Math.max(1, ...clusters.map((c) => c.totalRevenue));
    const maxSize = Math.max(1, ...clusters.map((c) => 1 + c.secondaries.length));
    for (const c of clusters) {
      const rev = c.totalRevenue / maxRev;
      const size = (1 + c.secondaries.length) / maxSize;
      const intent = intentWeight(c.intent);
      const fresh = c.archStatus === "create" || c.archStatus === "gaps" ? 1 : c.archStatus === "optimise" ? 0.6 : 0.4;
      // No live competitor strength signal here → use base_rank inverse as a proxy
      const compStrength = c.primary.base_rank ? Math.max(0, 1 - Math.min(c.primary.base_rank, 100) / 100) * 0.5 + 0.5 : 0.7;
      c.score = rev * 0.4 + size * 0.15 + compStrength * 0.15 + intent * 0.15 + fresh * 0.15;
    }

    // Format assignment with promoted hero override
    clusters.sort((a, b) => b.score - a.score);
    const remaining = [...clusters];
    const taken: Cluster[] = [];

    function take(predicate: (c: Cluster) => boolean, max: number, format: Cluster["format"]) {
      let n = 0;
      for (let i = 0; i < remaining.length && n < max; i++) {
        const c = remaining[i];
        if (predicate(c)) {
          c.format = format;
          taken.push(c);
          remaining.splice(i, 1);
          i--;
          n++;
        }
      }
    }

    // 1. Promoted heroes first
    if (promotedHeroIds.length > 0) {
      take((c) => promotedHeroIds.includes(c.primary.id), Math.min(promotedHeroIds.length, mix.hero), "hero");
    }
    // 2. Hero — top remaining by score
    take(() => true, Math.max(0, mix.hero - taken.filter((t) => t.format === "hero").length), "hero");
    // 3. Product
    take((c) => urlLooksProduct(c.recommendedUrl), mix.product, "product");
    // 4. Category
    take((c) => urlLooksCategory(c.recommendedUrl), mix.category, "category");
    // 5. Page — optimise / transactional with URL
    take((c) => c.archStatus === "optimise" || (["transactional", "navigational"].includes((c.intent || "").toLowerCase()) && !!c.recommendedUrl), mix.page, "page");
    // 6. Blog — fill remainder
    take(() => true, mix.blog, "blog");

    // If short, top up blog with whatever's left (still capped at 12 total).
    while (taken.length < 12 && remaining.length > 0) {
      const c = remaining.shift()!;
      c.format = "blog";
      taken.push(c);
    }

    const finalItems = taken.slice(0, 12);

    // Fetch SERP top 3 in parallel (capped, already 12)
    const serpResults = await Promise.all(
      finalItems.map((c) => fetchSerpTop3(admin, dfBasicAuth, c.primary.keyword))
    );

    // Single batched Claude call
    const aiPayload = finalItems.map((c, idx) => ({
      idx,
      format: c.format,
      primary_keyword: c.primary.keyword,
      secondary_keywords: c.secondaries.slice(0, 5).map((s) => s.keyword),
      intent: c.intent,
      recommended_url: c.recommendedUrl,
      arch_status: c.archStatus,
      potential_revenue_gain: Math.round(c.totalRevenue),
      serp_top3: serpResults[idx],
    }));

    const system = `You are a senior SEO content strategist. For each item below, return a single JSON array with one object per idx with fields:
- idx (number)
- page_title_h1 (string, ≤70 chars)
- meta_title (string, ≤60 chars)
- meta_description (string, ≤160 chars)
- synopsis (string, 3 short paragraphs separated by \\n\\n. Para 1: who/why. Para 2: "Sections to include:" followed by a bullet list (use - prefix) of suggested H2/H3 sections derived from the SERP top 3 + cluster keywords. Para 3: "Content gaps:" bullet list of themes the SERP top 3 cover that we should match plus whitespace neither covers.)
- suggested_h2 (string[] of 4-7 items)
- internal_link_anchors (string[] of 3-5 likely anchor phrases for inbound internal links)

Respond with ONLY the JSON array. No prose, no code fences.`;

    const user = `Items:\n${JSON.stringify(aiPayload, null, 2)}`;

    let aiResults: any[] = [];
    try {
      const txt = await callClaude(ANTHROPIC_API_KEY, system, user, 12000);
      aiResults = extractJson(txt);
    } catch (e) {
      console.error("Claude enrichment failed:", e);
      aiResults = finalItems.map((_, idx) => ({ idx }));
    }
    const aiByIdx = new Map<number, any>();
    aiResults.forEach((r) => aiByIdx.set(r.idx, r));

    // Build inserts
    const totalRevenueGain = finalItems.reduce((s, c) => s + (c.totalRevenue || 0), 0);
    const itemRows = finalItems.map((c, idx) => {
      const isHero = c.format === "hero";
      const lead = isHero ? heroLeadWeeks : defaultLeadWeeks;
      const publishMonth = isoMonthOffset(c.peakMonth, 8);
      const draftDeadline = publishMonth
        ? (() => { const d = new Date(publishMonth); d.setDate(d.getDate() - lead * 7); return d.toISOString().slice(0, 10); })()
        : null;
      const ai = aiByIdx.get(idx) ?? {};
      const action: string = c.archStatus === "optimise" ? "optimise" : c.archStatus === "watch" ? "watch" : "create";
      return {
        plan_id: plan.id,
        position: idx + 1,
        content_format: c.format,
        content_action: action,
        primary_keyword_id: c.primary.id,
        secondary_keyword_ids: c.secondaries.map((s) => s.id),
        primary_keyword_text: c.primary.keyword,
        secondary_keyword_text: c.secondaries.map((s) => s.keyword),
        recommended_url: c.recommendedUrl,
        page_title_h1: ai.page_title_h1 ?? c.primary.keyword,
        synopsis: ai.synopsis ?? "",
        meta_title: ai.meta_title ?? null,
        meta_description: ai.meta_description ?? null,
        internal_links: ai.internal_link_anchors ?? [],
        inbound_links: [],
        serp_top3: serpResults[idx] ?? [],
        serp_fetched_at: new Date().toISOString(),
        potential_revenue_gain: c.totalRevenue || null,
        audience: null,
        journey_stage: journeyStage(c.intent),
        business_area: c.primary.tag_1 ?? null,
        campaign_tie_in: null,
        responsibility: null,
        first_draft_deadline: draftDeadline,
        publish_month: publishMonth,
        cluster_score: c.score,
        hero_promoted: isHero && promotedHeroIds.includes(c.primary.id),
        status: "queued",
        notes: ai.suggested_h2 ? `Suggested H2: ${(ai.suggested_h2 as string[]).join(" · ")}` : null,
      };
    });

    if (itemRows.length > 0) {
      const { error: insErr } = await admin.from("content_plan_items").insert(itemRows);
      if (insErr) throw insErr;
    }

    await admin.from("content_plans").update({ total_revenue_gain: totalRevenueGain }).eq("id", plan.id);
    await admin.from("content_plan_jobs").update({
      status: "done", processed: itemRows.length, finished_at: new Date().toISOString(),
    }).eq("id", job!.id);

    return new Response(JSON.stringify({ planId: plan.id, items: itemRows.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("content-plan-generate error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
