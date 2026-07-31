import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { reserveOTPM } from "../_shared/ai-rate-window.ts";
import {
  categorisationRetryDisposition,
  emptyCategorisationClaimDisposition,
} from "../_shared/categorisation-retry.ts";

// ---- Intent-tier routing ----------------------------------------------------
// Decide whether an uncategorised keyword should be processed live (during
// "Build my forecast") or deferred to the overnight cron run.
//
// Live tier (high-revenue): transactional / commercial intent (any length),
// or short-tail (≤4 words) where we don't yet know the intent.
// Deferred tier: long-tail (≥5 words) with informational/navigational/unknown
// intent — these are the bulk of volume but smallest revenue contributors.
const TRANSACTIONAL_RE = /\b(buy|order|price|prices|cost|cheap|deal|deals|discount|delivery|deliver|near me|book|booking|hire|rent|shop|for sale|coupon|promo|same day|next day)\b/;
const COMMERCIAL_RE = /\b(best|top|review|reviews|vs|versus|compare|comparison|alternative|alternatives|cheapest)\b/;

function decideTier(keyword: string, intent: string | null): "live" | "deferred" {
  const kw = (keyword ?? "").toLowerCase().trim();
  const wc = kw ? kw.split(/\s+/).length : 0;
  if (intent === "transactional" || intent === "commercial") return "live";
  if (TRANSACTIONAL_RE.test(kw) || COMMERCIAL_RE.test(kw)) return "live";
  if (wc <= 4) return "live";
  if (intent === "informational" || intent === "navigational") return "deferred";
  return "deferred"; // long-tail, unknown intent → overnight
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type CategorisationResult = {
  keyword: string;
  tag_1: string;
  tag_2: string;
  tag_3: string;
  tag_4: string;
  tag_5: string;
  search_intent: string;
  intent_confidence: string;
};

type UpdatePayload = {
  tag_1: string | null;
  tag_2: string | null;
  tag_3: string | null;
  tag_4: string | null;
  tag_5: string | null;
  kw_cluster: string | null;
  search_intent: string | null;
  intent_source: string;
  intent_confidence: string | null;
};

function extractJsonArray(raw: string): unknown {
  const cleaned = raw
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON array found in Claude response");
  }
  const json = cleaned.slice(start, end + 1).replace(/,\s*}/g, "}").replace(/,\s*]/g, "]");
  return JSON.parse(json);
}

function normaliseResults(value: unknown): CategorisationResult[] {
  if (!Array.isArray(value)) throw new Error("Claude JSON response was not an array");
  return value
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => ({
      keyword: String(item.keyword ?? "").trim(),
      tag_1: String(item.tag_1 ?? "").trim(),
      tag_2: String(item.tag_2 ?? "").trim(),
      tag_3: String(item.tag_3 ?? "").trim(),
      tag_4: String(item.tag_4 ?? "").trim(),
      tag_5: String(item.tag_5 ?? "").trim(),
      search_intent: String(item.search_intent ?? "").trim().toLowerCase(),
      intent_confidence: String(item.intent_confidence ?? "").trim().toLowerCase(),
    }))
    .filter((item) => item.keyword && item.tag_1);
}

function buildClusterFromTags(tags: (string | null)[]): string | null {
  const joined = tags.filter(Boolean).join(" > ");
  return joined || null;
}

/**
 * Deterministic taxonomy fast-path. Runs only when the project's
 * `category_focus` is recognised. For TV/AV projects this resolves the vast
 * majority of structured keywords (size + brand + tech + promo modifiers)
 * with zero AI cost. Returns null when the keyword does not look like it
 * belongs to the focus taxonomy — those rows defer to AI as before.
 */

function extractKeywordToken(keyword: string): string {
  const kw = keyword.toLowerCase().replace(/[“”"']/g, " ").trim();
  if (!kw) return "";
  const servicePhrases: Array<[RegExp, string]> = [
    [/\b(search engine optimisation|search engine optimization|seo)\b/, "SEO"],
    [/\b(pay per click|ppc|paid search|google ads|adwords)\b/, "PPC"],
    [/\b(paid social|social media|facebook ads|instagram ads|linkedin ads)\b/, "Paid Social"],
    [/\b(digital pr|online pr|public relations)\b/, "Digital PR"],
    [/\b(content marketing|content creation|copywriting|content writer|content agency|content agencies)\b/, "Content Marketing"],
    [/\b(conversion rate optimisation|conversion rate optimization|cro|conversion optimisation|conversion optimization)\b/, "Conversion Rate Optimisation"],
    [/\b(email marketing|marketing emails|newsletter)\b/, "Email Marketing"],
    [/\b(affiliate marketing)\b/, "Affiliate Marketing"],
    [/\b(influencer marketing|creator monetization|creator monetisation)\b/, "Influencer Marketing"],
    [/\b(keyword rank tracker|keyword tracking|rank tracker|serp tracker)\b/, "Rank Tracking Software"],
    [/\b(keyword research|keyword strategy|keyword planner)\b/, "Keyword Strategy"],
    [/\b(competitor research|competitive research|competitor analysis)\b/, "Competitor Research"],
    [/\b(analytics|data studio|looker studio|ga4|google analytics)\b/, "Analytics"],
    [/\b(technical seo|canonical|canonicalise|canonicalize|404|redirect|schema markup)\b/, "Technical SEO"],
    [/\b(link building|backlinks?|digital citations|citations seo)\b/, "Link Building"],
    [/\b(digital marketing|performance marketing|marketing strategy|growth marketing|advertising|ad agency|marketing agency|digital agency|creative agency)\b/, "Digital Marketing"],
  ];
  for (const [re, label] of servicePhrases) if (re.test(kw)) return label;
  return "";
}

function serviceTaxonomyFastPath(
  keyword: string,
  intentHint: string | null,
): { tag_1: string; tag_2: string | null; tag_3: string | null; tag_4: string | null; tag_5: string | null; intent: string } | null {
  const kw = keyword.toLowerCase();
  const service = extractKeywordToken(keyword);
  if (!service) return null;
  let tag2: string | null = null;
  if (/\b(agency|agencies|firm|firms|company|companies|consultant|consultants|services?)\b/.test(kw)) tag2 = "Services";
  else if (/\b(tool|tools|software|tracker|platform)\b/.test(kw)) tag2 = "Software";
  else if (/\b(example|examples|guide|glossary|quotes|facts|insights|strategy|tutorial|how|what|why)\b/.test(kw)) tag2 = "Resources";
  let tag3: string | null = null;
  const location = kw.match(/\b(london|manchester|nottingham|uk|united kingdom|birmingham|leeds|bristol|edinburgh|glasgow)\b/);
  if (location) tag3 = location[1] === "uk" ? "UK" : location[1].replace(/\b\w/g, (c) => c.toUpperCase());
  const intent = intentHint ?? (tag2 === "Resources" ? "informational" : tag2 === "Software" ? "commercial" : "commercial");
  return { tag_1: service, tag_2: tag2, tag_3: tag3, tag_4: null, tag_5: null, intent };
}

function taxonomyFastPath(
  keyword: string,
  categoryFocus: string,
  intentHint: string | null,
): { tag_1: string; tag_2: string; tag_3: string | null; tag_4: string | null; tag_5: string | null } | null {
  const focus = (categoryFocus ?? "").toLowerCase().trim();
  const kw = keyword.toLowerCase();

  const isTvFocus =
    focus === "av" ||
    focus === "audio visual" ||
    focus === "audio/visual" ||
    focus === "tv" ||
    focus === "tvs" ||
    focus === "television" ||
    focus === "televisions" ||
    focus.includes("tv") ||
    focus.includes("television") ||
    focus.includes("audio visual");

  if (!isTvFocus) return null;

  // Must look like a TV keyword to qualify
  const looksTv =
    /\btv(s)?\b/.test(kw) ||
    /\btelevisions?\b/.test(kw) ||
    /\boled\b/.test(kw) ||
    /\bqled\b/.test(kw) ||
    /\bbravia\b/.test(kw) ||
    /\bambilight\b/.test(kw);
  if (!looksTv) return null;

  // Brand
  const brandMatch = kw.match(
    /\b(samsung|lg|sony|philips|hisense|panasonic|toshiba|tcl|sharp|jvc|techwood|bush|cello|polaroid)\b/,
  );
  const brand = brandMatch
    ? brandMatch[1].replace(/\b\w/g, (c) => c.toUpperCase())
    : null;

  // Display/tech
  let tech: string | null = null;
  if (/\boled\b/.test(kw)) tech = "OLED";
  else if (/\bqled\b/.test(kw)) tech = "QLED";
  else if (/\b4k\b|\buhd\b/.test(kw)) tech = "4K";
  else if (/\b8k\b/.test(kw)) tech = "8K";
  else if (/\bled\b/.test(kw)) tech = "LED";
  else if (/\bsmart\b/.test(kw)) tech = "Smart TV";
  else if (/\bambilight\b/.test(kw)) tech = "Ambilight";
  else if (/\bbravia\b/.test(kw)) tech = "Bravia";

  // Size
  const sizeMatch = kw.match(/\b(\d{2,3})\s*(?:in|inch|inches|"|''|”|in\.)\b/) || kw.match(/\b(\d{2,3})\s*tv\b/);
  const size = sizeMatch ? `${sizeMatch[1]} Inch` : null;

  // Promo modifier (deeper tag, never tag_1)
  const isPromo = /\b(deal|deals|sale|cheap|offer|offers|discount|price|prices|for sale)\b/.test(kw);

  // Build hierarchy: Electronics > Television > tech/size/brand > promo
  const deeper: string[] = [];
  if (tech) deeper.push(tech);
  if (size) deeper.push(size);
  if (brand) deeper.push(brand);
  if (isPromo) deeper.push("Offers");
  // Need at least one deeper signal to feel confident
  if (deeper.length === 0) return null;

  const [t3 = null, t4 = null, t5 = null] = deeper;
  return {
    tag_1: "Electronics",
    tag_2: "Television",
    tag_3: t3,
    tag_4: t4,
    tag_5: t5,
  };
}

/**
 * Deterministic pre-classifier — handles obvious patterns with zero AI cost.
 * Returns a payload only when we are confident; otherwise null (defer to Claude).
 */
function ruleClassify(
  keyword: string,
  brandTokens: string[],
  competitorTokens: { token: string; name: string }[],
): UpdatePayload | null {
  const kw = keyword.toLowerCase().trim();
  if (!kw) return null;

  // Own brand → navigational, tag_1 = "Brand"
  for (const brand of brandTokens) {
    if (brand && kw.includes(brand)) {
      return {
        tag_1: "Brand",
        tag_2: null,
        tag_3: null,
        tag_4: null,
        tag_5: null,
        kw_cluster: "Brand",
        search_intent: "navigational",
        intent_source: "rule",
        intent_confidence: "high",
      };
    }
  }

  // Competitor brand → tag_1 = "Competitor", tag_2 = competitor display name
  for (const c of competitorTokens) {
    if (c.token && kw.includes(c.token)) {
      return {
        tag_1: "Competitor",
        tag_2: c.name,
        tag_3: null,
        tag_4: null,
        tag_5: null,
        kw_cluster: `Competitor > ${c.name}`,
        search_intent: "navigational",
        intent_source: "rule",
        intent_confidence: "high",
      };
    }
  }

  // Transactional / Commercial / Informational rules now ONLY assign
  // search_intent — they no longer pollute `tag_1` with the intent label.
  // Tag 1 is a TOPIC and stays NULL here so the AI (or vocabulary-snap) can
  // assign a real category. This keeps existing forecast/opportunity logic
  // working unchanged: it only reads `search_intent`, never the old
  // intent-as-Tag-1 string.

  if (
    /\b(buy|order|price|prices|cost|cheap|deal|deals|discount|delivery|deliver|near me|book|booking|hire|rent|shop|for sale|coupon|promo|same day|next day)\b/
      .test(kw)
  ) {
    return {
      tag_1: null,
      tag_2: null,
      tag_3: null,
      tag_4: null,
      tag_5: null,
      kw_cluster: null,
      search_intent: "transactional",
      intent_source: "rule",
      intent_confidence: "high",
    };
  }

  if (
    /\b(best|top|review|reviews|vs|versus|compare|comparison|alternative|alternatives|cheapest)\b/
      .test(kw)
  ) {
    return {
      tag_1: null,
      tag_2: null,
      tag_3: null,
      tag_4: null,
      tag_5: null,
      kw_cluster: null,
      search_intent: "commercial",
      intent_source: "rule",
      intent_confidence: "high",
    };
  }

  if (
    /^(how|what|why|when|where|who|can|do|does|is|are)\b/.test(kw) ||
    /\b(guide|tutorial|tips|meaning|definition|symptoms|causes)\b/.test(kw)
  ) {
    return {
      tag_1: null,
      tag_2: null,
      tag_3: null,
      tag_4: null,
      tag_5: null,
      kw_cluster: null,
      search_intent: "informational",
      intent_source: "rule",
      intent_confidence: "high",
    };
  }

  return null;
}

// ---- Vocabulary-snap helpers ------------------------------------------------
// We never want the model to spawn near-duplicate Tag 1 values like
// "Weight Loss" and "Weightloss" or "Health & Beauty" vs "Health". Snap any
// new Tag 1 against the existing client vocabulary using a cheap token-set
// Jaccard similarity. If similarity ≥ 0.6, snap to the canonical casing.

const STOP_TAG_TOKENS = new Set([
  "and", "&", "the", "of", "for", "in", "on", "to", "a", "an",
]);

function singularise(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.endsWith("ses") || word.endsWith("xes") || word.endsWith("zes")) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function tagTokens(label: string): string[] {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((t) => t && !STOP_TAG_TOKENS.has(t))
    .map(singularise);
}

function jaccard(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Snap a candidate Tag 1 to an existing client vocabulary entry when they are
 * close enough that they should be the same category. Returns the snapped
 * value (canonical casing), or the original when no good match exists.
 *
 * The brand category and intent labels are intentionally excluded from the
 * snap target list — they have their own dedicated paths.
 */
function snapToVocabulary(candidate: string, vocab: string[]): string {
  if (!candidate) return candidate;
  // NEW: prefix means the model is explicitly asking us to mint a new tag.
  // Strip the prefix but still try to snap — sometimes the model adds NEW:
  // to a trivially-different rephrasing of an existing tag.
  const cleaned = candidate.replace(/^NEW:\s*/i, "").trim();
  if (!cleaned) return candidate;

  const candTokens = tagTokens(cleaned);
  if (!candTokens.length) return cleaned;

  let best: { value: string; score: number } | null = null;
  for (const v of vocab) {
    const vTokens = tagTokens(v);
    if (!vTokens.length) continue;
    const score = jaccard(candTokens, vTokens);
    if (!best || score > best.score) best = { value: v, score };
  }
  if (best && best.score >= 0.6) return best.value;
  return cleaned;
}


type KeywordRow = {
  id: string;
  keyword: string;
  search_intent: string | null;
  categorisation_tier: "live" | "deferred" | null;
  categorisation_attempts?: number | null;
};

type JobRow = {
  id: string;
  project_id: string;
  tier: "live" | "deferred";
  status: string;
  total: number;
  processed: number;
  from_rules?: number;
  from_cache?: number;
  from_fast_path?: number;
  from_fallback?: number;
  from_ai?: number;
  rate_limited_count?: number;
  attempts?: number;
  next_run_at?: string | null;
  heartbeat_at?: string | null;
  started_at?: string | null;
};

const intEnv = (name: string, fallback: number) => {
  const v = parseInt(Deno.env.get(name) ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const CLAIM_LIMIT = intEnv("CAT_CLAIM_LIMIT", 120);
const AI_BATCH_SIZE = intEnv("CAT_AI_BATCH_SIZE", 15);
const MAX_AI_BATCHES_PER_TICK = intEnv("CAT_MAX_AI_BATCHES_PER_TICK", 5);
const WORKER_BUDGET_MS = intEnv("CAT_WORKER_BUDGET_MS", 95_000);
const VOCAB_CAP_DEFAULT = intEnv("CAT_VOCAB_CAP", 80);
const MODEL = "claude-haiku-4-5";

function jsonResponse(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function resultKeywordKey(keyword: string): string {
  return keyword.toLowerCase().replace(/\s+\[intent=.*?\]\s*$/i, "").trim();
}

function fallbackPayload(keyword: string, project: any, intentHint: string | null): UpdatePayload {
  const service = serviceTaxonomyFastPath(keyword, intentHint);
  if (service) {
    const tags = [service.tag_1, service.tag_2, service.tag_3, service.tag_4, service.tag_5];
    return {
      tag_1: service.tag_1,
      tag_2: service.tag_2,
      tag_3: service.tag_3,
      tag_4: service.tag_4,
      tag_5: service.tag_5,
      kw_cluster: buildClusterFromTags(tags),
      search_intent: service.intent,
      intent_source: "fallback+taxonomy",
      intent_confidence: "low",
    };
  }
  const focus = String(project?.category_focus ?? "").trim();
  const tag_1 = focus || "General";
  return {
    tag_1,
    tag_2: null,
    tag_3: null,
    tag_4: null,
    tag_5: null,
    kw_cluster: tag_1,
    search_intent: intentHint ?? "informational",
    intent_source: "fallback",
    intent_confidence: "low",
  };
}

async function updateKeywordIds(supabase: any, ids: string[], payload: UpdatePayload, status = "done") {
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const { error } = await supabase
      .from("keywords")
      .update({
        ...payload,
        categorisation_status: status,
        categorisation_locked_at: null,
        categorisation_last_error: null,
      })
      .in("id", chunk);
    if (error) throw new Error(`Keyword update failed: ${error.message}`);
  }
}

async function releaseKeywordIds(
  supabase: any,
  ids: string[],
  errorMessage: string | null = null,
  consumeAttempt = true,
) {
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const { error } = await supabase.rpc("release_categorisation_batch_v2", {
      _ids: chunk,
      _error: errorMessage,
      _consume_attempt: consumeAttempt,
    });
    if (error) throw new Error(`Keyword release failed: ${error.message}`);
  }
}

async function backfillTiers(supabase: any, projectId: string) {
  while (true) {
    const { data: rows, error } = await supabase
      .from("keywords")
      .select("id, keyword, search_intent")
      .eq("project_id", projectId)
      .eq("detox_status", "keep")
      .is("tag_1", null)
      .is("categorisation_tier", null)
      .limit(1000);
    if (error) throw new Error(`Tier backfill failed: ${error.message}`);
    if (!rows?.length) break;
    const byTier: Record<"live" | "deferred", string[]> = { live: [], deferred: [] };
    for (const r of rows) byTier[decideTier((r as any).keyword, (r as any).search_intent ?? null)].push((r as any).id);
    for (const [tier, ids] of Object.entries(byTier)) {
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        const { error: updateError } = await supabase
          .from("keywords")
          .update({ categorisation_tier: tier })
          .in("id", chunk);
        if (updateError) throw new Error(`Tier backfill write failed: ${updateError.message}`);
      }
    }
    if (rows.length < 1000) break;
  }
}

async function countRemaining(supabase: any, projectId: string, tier: "live" | "deferred") {
  const { count, error } = await supabase
    .from("keywords")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("detox_status", "keep")
    .is("tag_1", null)
    .neq("categorisation_status", "skipped")
    .or(`categorisation_tier.eq.${tier},categorisation_tier.is.null`);
  if (error) throw new Error(`Remaining count failed: ${error.message}`);
  return count ?? 0;
}

async function countProcessing(supabase: any, projectId: string, tier: "live" | "deferred") {
  const { count, error } = await supabase
    .from("keywords")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("detox_status", "keep")
    .is("tag_1", null)
    .eq("categorisation_status", "processing")
    .or(`categorisation_tier.eq.${tier},categorisation_tier.is.null`);
  if (error) throw new Error(`Processing count failed: ${error.message}`);
  return count ?? 0;
}

async function countBacklog(supabase: any, projectId: string, tier: "live" | "deferred") {
  const { count, error } = await supabase
    .from("keywords")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("detox_status", "keep")
    .is("tag_1", null)
    .or(`categorisation_tier.eq.${tier},categorisation_tier.is.null`);
  if (error) throw new Error(`Backlog count failed: ${error.message}`);
  return count ?? 0;
}

async function getActiveJob(supabase: any, projectId: string, tier: "live" | "deferred") {
  const { data } = await supabase
    .from("categorisation_jobs")
    .select("*")
    .eq("project_id", projectId)
    .eq("tier", tier)
    .in("status", ["queued", "running", "rate_limited"])
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data as JobRow | null;
}

async function startJob(supabase: any, projectId: string, tier: "live" | "deferred") {
  await backfillTiers(supabase, projectId);
  const total = await countBacklog(supabase, projectId, tier);
  if (total === 0) return { job: null as JobRow | null, total };

  const existing = await getActiveJob(supabase, projectId, tier);
  if (existing) {
    const { data } = await supabase
      .from("categorisation_jobs")
      .update({
        status: existing.status === "rate_limited" ? "rate_limited" : "queued",
        total: Math.max(existing.total ?? 0, total),
        next_run_at: existing.next_run_at ?? new Date().toISOString(),
        last_error: null,
      })
      .eq("id", existing.id)
      .select("*")
      .single();
    return { job: data as JobRow, total };
  }

  const { data, error } = await supabase
    .from("categorisation_jobs")
    .insert({ project_id: projectId, tier, total, status: "queued", next_run_at: new Date().toISOString() })
    .select("*")
    .single();
  if (error) {
    const current = await getActiveJob(supabase, projectId, tier);
    if (current) return { job: current, total };
    throw new Error(`Could not create categorisation job: ${error.message}`);
  }
  return { job: data as JobRow, total };
}

async function loadContext(supabase: any, projectId: string) {
  const { data: project, error: projErr } = await supabase
    .from("navigator_projects")
    .select("client_id, category_focus, clients(company_name, industry)")
    .eq("id", projectId)
    .single();
  if (projErr || !project) throw new Error(`Project not found: ${projErr?.message}`);
  const client = (project as any).clients;
  const clientId = (project as any).client_id as string;

  const { data: rules } = await supabase
    .from("keyword_rules")
    .select("rule_type, keyword_categorisation")
    .eq("client_id", clientId);
  const rulesByType = (type: string) =>
    (rules || [])
      .filter((r: any) => r.rule_type === type)
      .map((r: any) => String(r.keyword_categorisation ?? "").trim())
      .filter(Boolean);

  const whitelistTopics = rulesByType("whitelist");
  const blacklistTopics = rulesByType("blacklist");
  const ownBrandRules = rulesByType("own_brand");
  const competitorBrandRules = rulesByType("competitor_brand");
  const brandTokens = [client?.company_name, ...ownBrandRules].filter(Boolean).map((s: string) => s.toLowerCase().trim()).filter(Boolean);

  const { data: competitorRows } = await supabase
    .from("competitors")
    .select("competitor_name")
    .eq("client_id", clientId);
  const competitorNames = [
    ...competitorBrandRules,
    ...((competitorRows ?? []).map((c: any) => String(c.competitor_name ?? "").trim()).filter(Boolean)),
  ];
  const competitorTokens: { token: string; name: string }[] = [];
  const seenComp = new Set<string>();
  for (const name of competitorNames) {
    const tok = name.toLowerCase().trim();
    if (!tok || seenComp.has(tok)) continue;
    seenComp.add(tok);
    competitorTokens.push({ token: tok, name });
  }

  const { data: clientProjectIds } = await supabase.from("navigator_projects").select("id").eq("client_id", clientId);
  const clientProjectIdList = (clientProjectIds ?? []).map((p: any) => p.id);
  const { data: vocabRows } = clientProjectIdList.length
    ? await supabase
        .from("keywords")
        .select("tag_1")
        .in("project_id", clientProjectIdList)
        .not("tag_1", "is", null)
    : { data: [] as any[] };

  const INTENT_LABELS_LOCAL = new Set(["transactional", "commercial", "informational", "navigational"]);
  const vocabSet = new Set<string>();
  for (const row of vocabRows ?? []) {
    const v = String((row as any).tag_1 ?? "").trim();
    if (!v) continue;
    if (INTENT_LABELS_LOCAL.has(v.toLowerCase())) continue;
    if (v.toLowerCase() === "brand") continue;
    vocabSet.add(v);
  }
  for (const wl of whitelistTopics) {
    if (wl && !INTENT_LABELS_LOCAL.has(wl.toLowerCase()) && wl.toLowerCase() !== "brand") vocabSet.add(wl);
  }

  return {
    project,
    client,
    clientId,
    clientProjectIdList,
    whitelistTopics,
    blacklistTopics,
    brandTokens,
    competitorTokens,
    tagVocabulary: Array.from(vocabSet).sort(),
    vocabSet,
  };
}

async function runAiBatch(args: {
  supabase: any;
  apiKey: string;
  aiBatch: string[];
  perKwBudget: number;
  ctx: Awaited<ReturnType<typeof loadContext>>;
  intentHintByKw: Map<string, { intent: string; confidence: string | null }>;
}) {
  const { supabase, apiKey, aiBatch, perKwBudget, ctx, intentHintByKw } = args;
  const dynamicMaxTokens = Math.min(3000, aiBatch.length * perKwBudget + 500);
  const reservation = await reserveOTPM(supabase, MODEL, dynamicMaxTokens);
  if (!reservation.reserved) {
    return { parsed: [] as CategorisationResult[], rateLimited: true, retryAfter: Math.ceil(reservation.waitMs / 1000), stopReason: null as string | null, error: null as string | null };
  }

  const vocabForPrompt = ctx.tagVocabulary.slice(0, VOCAB_CAP_DEFAULT);
  const vocabBlock = vocabForPrompt.length ? vocabForPrompt.map((v) => `  - ${v}`).join("\n") : "  (no existing categories yet — mint sensible Google Product Taxonomy-style categories with NEW: prefix)";
  const whitelistBlock = ctx.whitelistTopics.length ? ctx.whitelistTopics.map((v) => `  - ${v}`).join("\n") : "  (none)";
  const blacklistBlock = ctx.blacklistTopics.length ? ctx.blacklistTopics.map((v) => `  - ${v}`).join("\n") : "  (none)";

  const systemPrompt = `You are an SEO keyword categoriser. For each keyword, assign a category hierarchy and classify search intent.

CATEGORY RULES:
- Tag 1 is a TOPIC, never an intent label. Do NOT use Transactional, Commercial, Informational or Navigational as Tag 1.
- Prefer EXISTING CATEGORIES and PRIORITY TOPICS where the keyword reasonably fits.
- Never use an AVOID TOPIC as Tag 1.
- Reserved Tag 1 values Brand and Competitor are assigned upstream; do not use them.
- Only invent a new Tag 1 with prefix NEW: when nothing fits.
- Use Google Product Taxonomy as fallback guidance. Singular form, Title Case.

EXISTING CATEGORIES:
${vocabBlock}

PRIORITY TOPICS (whitelist):
${whitelistBlock}

AVOID TOPICS (blacklist):
${blacklistBlock}

Intent must be exactly transactional, commercial, informational, or navigational. Use low confidence only when genuinely ambiguous.`;

  const keywordListWithHints = aiBatch.map((kw) => {
    const hint = intentHintByKw.get(kw);
    return hint ? `${kw} [intent=${hint.intent}]` : kw;
  }).join("\n");

  const userPrompt = `CLIENT CONTEXT:
- Client: ${ctx.client?.company_name ?? "not specified"}
- Industry: ${ctx.client?.industry || "not specified"}
- Category focus: ${(ctx.project as any).category_focus || "not specified"}

KEYWORDS:
${keywordListWithHints}

Use the categorise_keywords tool. Return one item per keyword.`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: dynamicMaxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      tools: [{
        name: "categorise_keywords",
        description: "Return keyword category hierarchy and search intent.",
        input_schema: {
          type: "object",
          properties: {
            results: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  keyword: { type: "string" },
                  tag_1: { type: "string" },
                  tag_2: { type: "string" },
                  tag_3: { type: "string" },
                  tag_4: { type: "string" },
                  tag_5: { type: "string" },
                  search_intent: { type: "string", enum: ["transactional", "commercial", "informational", "navigational"] },
                  intent_confidence: { type: "string", enum: ["high", "low"] },
                },
                required: ["keyword", "tag_1", "search_intent", "intent_confidence"],
              },
            },
          },
          required: ["results"],
        },
      }],
      tool_choice: { type: "tool", name: "categorise_keywords" },
    }),
  });

  if (resp.status === 429) {
    const retryHeader = resp.headers.get("retry-after");
    const ra = retryHeader ? Math.max(5, parseInt(retryHeader, 10) || 60) : 60;
    return { parsed: [] as CategorisationResult[], rateLimited: true, retryAfter: ra, stopReason: null, error: null };
  }
  if (!resp.ok) {
    const errText = await resp.text();
    console.error("Anthropic categorisation error", resp.status, errText.slice(0, 500));
    return { parsed: [] as CategorisationResult[], rateLimited: false, retryAfter: 0, stopReason: null, error: `Anthropic API error: ${resp.status}` };
  }

  const data = await resp.json();
  const stopReason = data.stop_reason ?? null;
  const toolUse = (data.content || []).find((p: any) => p?.type === "tool_use" && p?.name === "categorise_keywords");
  const text = (data.content || []).map((p: any) => (p?.type === "text" || p?.text ? p.text : "")).join("\n");
  try {
    const parsed = normaliseResults(toolUse?.input?.results ?? extractJsonArray(text));
    return { parsed, rateLimited: false, retryAfter: 0, stopReason, error: null };
  } catch (e) {
    console.error("Categorisation parse failed", e, { stopReason, dynamicMaxTokens, sample: text.slice(0, 300) });
    return { parsed: [] as CategorisationResult[], rateLimited: false, retryAfter: 0, stopReason, error: stopReason === "max_tokens" ? "AI output hit max_tokens" : "AI response parse failed" };
  }
}

async function processJobTick(jobId: string) {
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  await supabase.rpc("release_stale_categorisation_claims");

  const { data: jobRow } = await supabase.from("categorisation_jobs").select("*").eq("id", jobId).maybeSingle();
  const job = jobRow as JobRow | null;
  if (!job || job.status === "done") return { done: true, job_id: jobId };
  if (job.status === "error") return { error: jobRow.last_error ?? "job errored", job_id: jobId };
  if (job.next_run_at && new Date(job.next_run_at).getTime() > Date.now()) {
    return { rateLimited: true, retryAfterSeconds: Math.ceil((new Date(job.next_run_at).getTime() - Date.now()) / 1000), job_id: jobId };
  }

  const projectId = job.project_id;
  const tier = job.tier;
  const startedAt = Date.now();
  await supabase.from("categorisation_jobs").update({
    status: "running",
    started_at: job.started_at ?? new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    attempts: (job.attempts ?? 0) + 1,
    last_error: null,
  }).eq("id", jobId);

  await backfillTiers(supabase, projectId);
  const ctx = await loadContext(supabase, projectId);
  const total = Math.max(job.total ?? 0, await countBacklog(supabase, projectId, tier));

  const { data: claimedRows, error: claimErr } = await supabase.rpc("claim_categorisation_batch_v2", {
    _project_id: projectId,
    _tier: tier,
    _limit: CLAIM_LIMIT,
  });
  if (claimErr) throw new Error(`Claim failed: ${claimErr.message}`);
  const claimed = (claimedRows ?? []) as KeywordRow[];

  if (!claimed.length) {
    const remaining = await countRemaining(supabase, projectId, tier);
    const processing = remaining > 0 ? await countProcessing(supabase, projectId, tier) : 0;
    const disposition = emptyCategorisationClaimDisposition(remaining, processing);
    const done = disposition === "done";
    const blocked = disposition === "error";
    const lastError = blocked
      ? `${remaining} keyword(s) remain but none are claimable; retry state requires operator review`
      : null;
    await supabase.from("categorisation_jobs").update({
      status: done ? "done" : blocked ? "error" : "queued",
      total,
      processed: Math.max(0, total - remaining),
      finished_at: done || blocked ? new Date().toISOString() : null,
      heartbeat_at: new Date().toISOString(),
      next_run_at: done || blocked ? new Date().toISOString() : new Date(Date.now() + 10_000).toISOString(),
      last_error: lastError,
    }).eq("id", jobId);
    return {
      done,
      error: lastError,
      job_id: jobId,
      total,
      remaining,
      processing,
      processed: Math.max(0, total - remaining),
    };
  }

  const rowsByKeyword = new Map<string, KeywordRow[]>();
  for (const r of claimed) {
    const key = r.keyword.toLowerCase().trim();
    if (!rowsByKeyword.has(key)) rowsByKeyword.set(key, []);
    rowsByKeyword.get(key)!.push(r);
  }

  const distinctTexts = Array.from(rowsByKeyword.keys());
  const { data: cacheRows } = ctx.clientProjectIdList.length
    ? await supabase
        .from("keywords")
        .select("keyword, tag_1, tag_2, tag_3, tag_4, tag_5, kw_cluster, search_intent, intent_confidence")
        .in("keyword", distinctTexts)
        .not("tag_1", "is", null)
        .in("project_id", ctx.clientProjectIdList)
    : { data: [] as any[] };
  const cache = new Map<string, UpdatePayload>();
  for (const c of cacheRows ?? []) {
    const key = (c as any).keyword.toLowerCase().trim();
    if (cache.has(key)) continue;
    cache.set(key, {
      tag_1: (c as any).tag_1 ?? null,
      tag_2: (c as any).tag_2 ?? null,
      tag_3: (c as any).tag_3 ?? null,
      tag_4: (c as any).tag_4 ?? null,
      tag_5: (c as any).tag_5 ?? null,
      kw_cluster: (c as any).kw_cluster ?? null,
      search_intent: (c as any).search_intent ?? null,
      intent_source: "cache_client",
      intent_confidence: (c as any).intent_confidence ?? null,
    });
  }

  let fromRules = 0;
  let fromCache = 0;
  let fromFastPath = 0;
  let fromFallback = 0;
  let fromAi = 0;
  const completedIds = new Set<string>();
  const intentHintByKw = new Map<string, { intent: string; confidence: string | null }>();
  const remainingForAi: string[] = [];

  for (const [kwText, kwRows] of rowsByKeyword) {
    const cached = cache.get(kwText);
    if (cached?.tag_1) {
      await updateKeywordIds(supabase, kwRows.map((r) => r.id), cached);
      kwRows.forEach((r) => completedIds.add(r.id));
      fromCache += kwRows.length;
      continue;
    }

    const ruled = ruleClassify(kwText, ctx.brandTokens, ctx.competitorTokens);
    let intentForFastPath: string | null = null;
    if (ruled?.tag_1) {
      await updateKeywordIds(supabase, kwRows.map((r) => r.id), ruled);
      kwRows.forEach((r) => completedIds.add(r.id));
      fromRules += kwRows.length;
      continue;
    }
    if (ruled?.search_intent) {
      intentForFastPath = ruled.search_intent;
      intentHintByKw.set(kwText, { intent: ruled.search_intent, confidence: ruled.intent_confidence });
    }

    const serviceFp = serviceTaxonomyFastPath(kwText, intentForFastPath);
    if (serviceFp) {
      const tags = [serviceFp.tag_1, serviceFp.tag_2, serviceFp.tag_3, serviceFp.tag_4, serviceFp.tag_5];
      await updateKeywordIds(supabase, kwRows.map((r) => r.id), {
        tag_1: serviceFp.tag_1,
        tag_2: serviceFp.tag_2,
        tag_3: serviceFp.tag_3,
        tag_4: serviceFp.tag_4,
        tag_5: serviceFp.tag_5,
        kw_cluster: buildClusterFromTags(tags),
        search_intent: serviceFp.intent,
        intent_source: intentForFastPath ? "rule+taxonomy" : "taxonomy",
        intent_confidence: "high",
      });
      kwRows.forEach((r) => completedIds.add(r.id));
      fromFastPath += kwRows.length;
      continue;
    }

    const tvFp = taxonomyFastPath(kwText, (ctx.project as any).category_focus ?? "", intentForFastPath);
    if (tvFp) {
      const intent = intentForFastPath ?? "commercial";
      const tags = [tvFp.tag_1, tvFp.tag_2, tvFp.tag_3, tvFp.tag_4, tvFp.tag_5];
      await updateKeywordIds(supabase, kwRows.map((r) => r.id), {
        tag_1: tvFp.tag_1,
        tag_2: tvFp.tag_2,
        tag_3: tvFp.tag_3,
        tag_4: tvFp.tag_4,
        tag_5: tvFp.tag_5,
        kw_cluster: buildClusterFromTags(tags),
        search_intent: intent,
        intent_source: intentForFastPath ? "rule+taxonomy" : "taxonomy",
        intent_confidence: "high",
      });
      kwRows.forEach((r) => completedIds.add(r.id));
      fromFastPath += kwRows.length;
      continue;
    }

    remainingForAi.push(kwText);
  }

  let aiBatches = 0;
  let rateLimited = false;
  let retryAfterSeconds = 60;
  let lastError: string | null = null;
  const attemptedAiKeywords = new Set<string>();

  async function applyParsed(parsed: CategorisationResult[]) {
    for (const item of parsed) {
      const key = resultKeywordKey(item.keyword);
      const kwRows = rowsByKeyword.get(key);
      if (!kwRows || kwRows.every((r) => completedIds.has(r.id))) continue;
      let rawTag1 = (item.tag_1 || "").trim();
      if (rawTag1 && new Set(["transactional", "commercial", "informational", "navigational"]).has(rawTag1.toLowerCase())) rawTag1 = "";
      const snapped = rawTag1 ? snapToVocabulary(rawTag1, ctx.tagVocabulary) : "";
      const tag_1 = snapped || fallbackPayload(key, ctx.project, intentHintByKw.get(key)?.intent ?? null).tag_1;
      const tag_2 = item.tag_2 || null;
      const tag_3 = item.tag_3 || null;
      const tag_4 = item.tag_4 || null;
      const tag_5 = item.tag_5 || null;
      const hint = intentHintByKw.get(key);
      await updateKeywordIds(supabase, kwRows.map((r) => r.id), {
        tag_1,
        tag_2,
        tag_3,
        tag_4,
        tag_5,
        kw_cluster: buildClusterFromTags([tag_1, tag_2, tag_3, tag_4, tag_5]),
        search_intent: hint?.intent ?? (item.search_intent || "informational"),
        intent_source: hint ? "rule+llm" : "llm",
        intent_confidence: hint?.confidence ?? (item.intent_confidence || "low"),
      });
      kwRows.forEach((r) => completedIds.add(r.id));
      fromAi += kwRows.length;
    }
  }

  // Prioritise rows near the attempt limit so their final real AI attempt is
  // resolved or moved through the explicit fallback path in this tick.
  remainingForAi.sort((a, b) => {
    const ra = rowsByKeyword.get(a) ?? [];
    const rb = rowsByKeyword.get(b) ?? [];
    const aMax = Math.max(0, ...ra.map((r: any) => r.categorisation_attempts ?? 0));
    const bMax = Math.max(0, ...rb.map((r: any) => r.categorisation_attempts ?? 0));
    return bMax - aMax;
  });

  for (let offset = 0; offset < remainingForAi.length && aiBatches < MAX_AI_BATCHES_PER_TICK && Date.now() - startedAt < WORKER_BUDGET_MS; offset += AI_BATCH_SIZE) {
    const batch = remainingForAi.slice(offset, offset + AI_BATCH_SIZE);
    if (!batch.length) break;
    aiBatches += 1;
    const outcome = await runAiBatch({ supabase, apiKey, aiBatch: batch, perKwBudget: 140, ctx, intentHintByKw });
    if (outcome.rateLimited) {
      rateLimited = true;
      retryAfterSeconds = outcome.retryAfter;
      break;
    }
    batch.forEach((keyword) => attemptedAiKeywords.add(keyword));
    if (outcome.error && outcome.stopReason !== "max_tokens") lastError = outcome.error;
    if (outcome.parsed.length) {
      await applyParsed(outcome.parsed);
    } else if (outcome.stopReason === "max_tokens" && batch.length > 1) {
      for (const tiny of batch.map((kw) => [kw])) {
        const retry = await runAiBatch({ supabase, apiKey, aiBatch: tiny, perKwBudget: 260, ctx, intentHintByKw });
        if (retry.rateLimited) {
          rateLimited = true;
          retryAfterSeconds = retry.retryAfter;
          break;
        }
        if (retry.parsed.length) await applyParsed(retry.parsed);
        else lastError = retry.error ?? "AI could not categorise keyword";
      }
      if (rateLimited) break;
    }
  }

  const fallbackIds: string[] = [];
  const attemptedReleaseIds: string[] = [];
  const unattemptedReleaseIds: string[] = [];
  for (const [kwText, kwRows] of rowsByKeyword) {
    const pendingRows = kwRows.filter((r) => !completedIds.has(r.id));
    if (!pendingRows.length) continue;
    const wasAttempted = attemptedAiKeywords.has(kwText);
    const attempts = Math.max(0, ...pendingRows.map((r) => r.categorisation_attempts ?? 0));
    const disposition = categorisationRetryDisposition(attempts, wasAttempted);
    if (disposition === "fallback") {
      const payload = fallbackPayload(kwText, ctx.project, intentHintByKw.get(kwText)?.intent ?? null);
      await updateKeywordIds(supabase, pendingRows.map((r) => r.id), payload);
      pendingRows.forEach((r) => completedIds.add(r.id));
      fallbackIds.push(...pendingRows.map((r) => r.id));
      fromFallback += pendingRows.length;
    } else if (disposition === "retry_consumed") {
      attemptedReleaseIds.push(...pendingRows.map((r) => r.id));
    } else {
      unattemptedReleaseIds.push(...pendingRows.map((r) => r.id));
    }
  }
  if (attemptedReleaseIds.length) {
    await releaseKeywordIds(
      supabase,
      attemptedReleaseIds,
      lastError ?? "AI response omitted one or more keywords",
      true,
    );
  }
  if (unattemptedReleaseIds.length) {
    await releaseKeywordIds(
      supabase,
      unattemptedReleaseIds,
      rateLimited ? "Waiting for the AI rate-limit window" : "Deferred to the next worker tick",
      false,
    );
  }

  const remaining = await countRemaining(supabase, projectId, tier);
  const processed = Math.max(0, total - remaining);
  const nextRunAt = rateLimited
    ? new Date(Date.now() + retryAfterSeconds * 1000 + Math.floor(Math.random() * 3000)).toISOString()
    : remaining > 0
      ? new Date(Date.now() + 10_000).toISOString()
      : new Date().toISOString();
  const status = remaining === 0 ? "done" : rateLimited ? "rate_limited" : "queued";

  await supabase.from("categorisation_jobs").update({
    status,
    total,
    processed,
    from_rules: (job.from_rules ?? 0) + fromRules,
    from_cache: (job.from_cache ?? 0) + fromCache,
    from_fast_path: (job.from_fast_path ?? 0) + fromFastPath,
    from_fallback: (job.from_fallback ?? 0) + fromFallback,
    from_ai: (job.from_ai ?? 0) + fromAi,
    rate_limited_count: (job.rate_limited_count ?? 0) + (rateLimited ? 1 : 0),
    rate_limited_until: rateLimited ? nextRunAt : null,
    next_run_at: nextRunAt,
    heartbeat_at: new Date().toISOString(),
    finished_at: remaining === 0 ? new Date().toISOString() : null,
    last_error: lastError,
  }).eq("id", jobId);

  // Self-chain: keep the worker rolling without waiting for the cron poke.
  if (remaining > 0 && !rateLimited) {
    if (typeof EdgeRuntime !== "undefined" && (EdgeRuntime as any).waitUntil) {
      (EdgeRuntime as any).waitUntil(processJobTick(jobId).catch((e: Error) => console.error("categorisation self-chain error", e)));
    }
  }

  return {
    job_id: jobId,
    processed,
    categorised: completedIds.size,
    remaining,
    total,
    done: remaining === 0,
    rateLimited,
    retryAfterSeconds,
    fromRules,
    fromCache,
    fromFastPath,
    fromFallback,
    fromAi,
    fallback: fallbackIds.length,
    released: attemptedReleaseIds.length + unattemptedReleaseIds.length,
  };
}

async function kickWorker(jobId: string) {
  if (typeof EdgeRuntime !== "undefined" && (EdgeRuntime as any).waitUntil) {
    (EdgeRuntime as any).waitUntil(processJobTick(jobId).catch((e: Error) => console.error("categorisation worker error", e)));
  } else {
    processJobTick(jobId).catch((e: Error) => console.error("categorisation worker error", e));
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const mode = body.mode as "start" | "tick" | "status" | undefined;
    const projectId = body.project_id as string | undefined;
    const jobId = body.job_id as string | undefined;
    const tier: "live" | "deferred" = body.tier === "deferred" ? "deferred" : "live";

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const authHeader = req.headers.get("Authorization");

    // Tick mode is invoked by cron / self-chain (no caller auth). Gate it
    // behind the service-role bearer or the shared HAR_CRON_SECRET so
    // anonymous callers can't force paid Anthropic work.
    if (mode === "tick") {
      const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
      const cronSecret = req.headers.get("x-cron-secret") ?? "";
      const cronSecretEnv = Deno.env.get("HAR_CRON_SECRET") ?? "";
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
      const isInternal =
        (bearer.length > 0 && bearer === serviceKey) ||
        (cronSecretEnv.length > 0 && cronSecret === cronSecretEnv);
      if (!isInternal) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!jobId) {
        // Cron may invoke without a job_id — pick up the oldest stalled live job.
        const service = createClient(supabaseUrl, serviceKey, {
          auth: { autoRefreshToken: false, persistSession: false },
        });
        const { data: stale } = await service
          .from("categorisation_jobs")
          .select("id")
          .in("status", ["queued", "running"])
          .or(`heartbeat_at.is.null,heartbeat_at.lt.${new Date(Date.now() - 5 * 60_000).toISOString()}`)
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        if (!stale) return jsonResponse({ idle: true }, 202);
        const result = await processJobTick((stale as any).id);
        return jsonResponse(result, 202);
      }
      const result = await processJobTick(jobId);
      return jsonResponse(result, 202);
    }

    if (!authHeader) throw new Error("Missing authorization header");

    // Status is cheap and uses caller/RLS visibility.
    if (mode === "status") {
      if (!projectId && !jobId) throw new Error("project_id or job_id required for status mode");
      const caller = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: authHeader } },
        auth: { autoRefreshToken: false, persistSession: false },
      });
      let query = caller.from("categorisation_jobs").select("*").order("updated_at", { ascending: false }).limit(1);
      query = jobId ? query.eq("id", jobId) : query.eq("project_id", projectId).eq("tier", tier);
      const { data, error } = await query.maybeSingle();
      if (error) throw new Error(error.message);
      return jsonResponse({ job: data ?? null });
    }

    if (!projectId) throw new Error("project_id is required");

    // Validate caller can see the project, then create/resume the durable job
    // with service-role so the worker can survive after the browser leaves.
    const caller = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader ?? "" } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: projectCheck, error: projectErr } = await caller
      .from("navigator_projects")
      .select("id")
      .eq("id", projectId)
      .maybeSingle();
    if (projectErr || !projectCheck) throw new Error("Project not found or not accessible");

    const service = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { job, total } = await startJob(service, projectId, tier);
    if (!job) return jsonResponse({ done: true, job_id: null, total: 0, remaining: 0 });

    await kickWorker(job.id);
    return jsonResponse({
      job_id: job.id,
      total,
      remaining: total,
      status: job.status,
      done: false,
      message: "Categorisation is running in the background.",
    }, 202);
  } catch (error) {
    console.error("keyword-categorisation error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return jsonResponse({ error: message }, 500);
  }
});
