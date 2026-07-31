# Orchestration Dossier — Part 2: Edge Function Sources (Additional)

Companion to Part 1. Contains verbatim sources of the remaining orchestration-critical edge functions cited in `docs/autonomous-pipeline-audit-2026-07-21.md`. Zero abbreviation.

---

## supabase/functions/site-architecture/index.ts

### `supabase/functions/site-architecture/index.ts`

````ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { fetchAllRows, selectIn } from "../_shared/pgrst-in.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Total rows we inspect/upsert per invocation.
const MAX_ROWS_PER_INVOCATION = 250;
// Rows actually sent to the AI in one structured tool-call request.
// Kept small to avoid Gemini MALFORMED_FUNCTION_CALL on large payloads.
const AI_BATCH_SIZE = 30;
const AI_RETRY_BATCH_SIZE = 10;
const MAX_TOKENS = 2048;
const MODEL = "google/gemini-3-flash-preview";
const AI_GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

// DB check constraints:
// content_status: 'green' | 'amber' | 'red'
// tactical_rag_status: 'no_action_needed' | 'create_content' | 'optimise_content' | 'new_content' | 'green'
const CONTENT_STATUSES = new Set(["green", "amber", "red"]);
const TACTICAL_STATUSES = new Set([
  "no_action_needed",
  "create_content",
  "optimise_content",
  "new_content",
  "green",
  "watch",
]);

function sanitizeContentStatus(val: string): string {
  if (CONTENT_STATUSES.has(val)) return val;
  if (val === "existing_optimised") return "green";
  if (val === "existing_needs_optimisation") return "amber";
  if (val === "existing_poor_match" || val === "content_gap") return "red";
  return "amber";
}

function sanitizeTacticalStatus(val: string): string {
  if (TACTICAL_STATUSES.has(val)) return val;
  if (val === "consolidate") return "optimise_content";
  return "optimise_content";
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "at", "by",
  "with", "is", "are", "from", "as", "be", "it", "this", "that",
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/[\s\-_/]+/)
    .filter((t) => t && !STOPWORDS.has(t));
}

function urlPathTokens(url: string): string[] {
  try {
    const u = new URL(url);
    return tokenize(decodeURIComponent(u.pathname + " " + u.hostname));
  } catch {
    return tokenize(url);
  }
}

type RuleResult = {
  matched_url: string | null;
  relevancy_score: number | null;
  content_status: string;
  tactical_rag_status: string;
} | null;

function ruleClassify(args: {
  keyword: string;
  ranking_url: string | null;
  avg_monthly_volume: number | null;
  brandTokens: string[];
}): RuleResult {
  const { keyword, ranking_url, avg_monthly_volume, brandTokens } = args;
  const kwTokens = tokenize(keyword);

  // No URL + low volume → content gap, skip Claude
  if (!ranking_url) {
    if ((avg_monthly_volume ?? 0) < 50) {
      // relevancy_score NULL = not evaluated (no URL/volume to score).
      // 0 is reserved for a genuine evaluated-irrelevant verdict.
      // HAR v2 treats NULL as neutral 0.5 with a confidence penalty.
      return {
        matched_url: null,
        relevancy_score: null,
        content_status: "red",
        tactical_rag_status: "create_content",
      };
    }
    return null; // ambiguous gap, send to Claude
  }

  const urlTokens = new Set(urlPathTokens(ranking_url));
  const allMatch = kwTokens.length > 0 && kwTokens.every((t) => urlTokens.has(t));

  // Exact slug match — clearly well-targeted
  if (allMatch) {
    return {
      matched_url: ranking_url,
      relevancy_score: 0.9,
      content_status: "green",
      tactical_rag_status: "no_action_needed",
    };
  }

  // Brand keyword on the brand domain (any path)
  if (brandTokens.length && brandTokens.some((b) => kwTokens.includes(b))) {
    try {
      const host = new URL(ranking_url).hostname.toLowerCase();
      if (brandTokens.some((b) => host.includes(b))) {
        return {
          matched_url: ranking_url,
          relevancy_score: 0.85,
          content_status: "green",
          tactical_rag_status: "no_action_needed",
        };
      }
    } catch { /* ignore */ }
  }

  return null;
}

function extractJsonArray(raw: string): unknown[] | null {
  const cleaned = raw
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing authorization header");

    // User-scoped client to verify project access through RLS.
    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Service-role client for the bulk site_architecture writes. RLS still
    // protects all reads; writes go through after we have verified the caller
    // can see the project below.
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { project_id } = await req.json();
    if (!project_id) throw new Error("project_id is required");

    // Get client + domain context — verified through caller's RLS.
    const { data: project, error: projErr } = await supabaseUser
      .from("navigator_projects")
      .select("client_id, clients(domain, company_name)")
      .eq("id", project_id)
      .single();
    if (projErr || !project) throw new Error("Project not found or not accessible");

    const clientId = project.client_id as string;
    const clientDomain = ((project.clients as any)?.domain ?? "").toLowerCase();
    const companyName = ((project.clients as any)?.company_name ?? "").toLowerCase();
    const brandTokens = Array.from(
      new Set([
        ...tokenize(companyName),
        ...tokenize(clientDomain.replace(/\.[a-z.]+$/, "")),
      ]),
    ).filter((t) => t.length > 2);

    // Find kept keywords still missing site-architecture rows OR with NULL relevancy.
    // Truncation-remediation 2026-07-18: page across the 1,000-row PostgREST
    // cap so large projects don't silently under-report the pending set.
    const keptRows = await fetchAllRows<any>(
      supabase,
      "keywords",
      "id, keyword, ranking_url, search_intent, tag_1, avg_monthly_volume",
      (q) => q.eq("project_id", project_id).eq("detox_status", "keep").order("id", { ascending: true }),
    );

    const keptIds = (keptRows ?? []).map((k) => k.id);
    if (keptIds.length === 0) {
      return new Response(
        JSON.stringify({ processed: 0, remaining: 0, done: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Fetch existing arch rows for the kept set.
    // CRITICAL: chunk to ~150 IDs/request — a single .in() with hundreds of
    // UUIDs builds a URL >8KB which Supabase silently truncates/rejects,
    // returning [] with no error. That made the "remaining" calculation report
    // every kept keyword as missing even after successful writes.
    const READ_CHUNK = 150;
    const existingArch = new Map<
      string,
      { relevancy_score: number | null; tactical_rag_status: string | null; last_evaluated_at: string | null }
    >();
    for (let i = 0; i < keptIds.length; i += READ_CHUNK) {
      const slice = keptIds.slice(i, i + READ_CHUNK);
      const { data: archRows, error: readErr } = await supabase
        .from("site_architecture")
        .select("keyword_id, relevancy_score, tactical_rag_status, last_evaluated_at")
        .in("keyword_id", slice);
      if (readErr) throw new Error(`Read existing arch: ${readErr.message}`);
      for (const r of archRows ?? []) {
        existingArch.set(r.keyword_id as string, {
          relevancy_score: r.relevancy_score as number | null,
          tactical_rag_status: r.tactical_rag_status as string | null,
          last_evaluated_at: (r as any).last_evaluated_at as string | null,
        });
      }
    }

    // A row is "pending" if it has no arch row yet, OR its arch row is not
    // finalised. Deterministic branches (`watch` for no-volume rows,
    // `create_content` for no-URL rows) intentionally write relevancy_score
    // NULL — that NULL means "not evaluated", not "needs re-processing". We
    // only re-queue such rows when the input signal changes: a `watch` row
    // gains volume, or a `create_content` row gains a ranking_url. Otherwise
    // a NULL relevancy_score without a deterministic tactical status means
    // the row still owes a real score and should be sent through rules/AI.
    const isPending = (
      k: { ranking_url: string | null; avg_monthly_volume: number | null },
      a: { relevancy_score: number | null; tactical_rag_status: string | null } | undefined,
    ) => {
      if (!a) return true;
      const vol = k.avg_monthly_volume ?? 0;
      if (a.tactical_rag_status === "watch") return vol > 0; // re-classify once volume shows up
      if (a.tactical_rag_status === "create_content") return !!k.ranking_url; // re-classify once URL exists
      return a.relevancy_score == null;
    };
    const pending = (keptRows ?? []).filter((k) => isPending(k, existingArch.get(k.id)));


    if (pending.length === 0) {
      return new Response(
        JSON.stringify({ processed: 0, remaining: 0, done: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Take ONE batch this invocation
    const batch = pending.slice(0, MAX_ROWS_PER_INVOCATION);
    const remainingBefore = pending.length;

    type Upsert = {
      keyword_id: string;
      matched_url: string | null;
      relevancy_score: number | null;
      content_status: string;
      tactical_rag_status: string;
      last_evaluated_at: string | null;
    };
    const upserts: Upsert[] = [];
    let fromRules = 0;
    let fromCache = 0;
    let fromWatch = 0;
    let fromNoUrl = 0;
    let preservedScores = 0;
    const nowIso = new Date().toISOString();

    // Score-preservation helper (advisor ruling — option i, Gate A closure).
    //
    // Deterministic branches (Phase 0a watch / Phase 0b no-URL / ruleClassify
    // low-volume no-URL short-circuit) MUST NOT overwrite a previously
    // evaluated relevancy_score just because today's SERP scrape blinked
    // and left the keyword without a ranking_url or volume signal. They may
    // still update tactical_rag_status / content_status / matched_url as the
    // current state warrants, but the stored score and its last_evaluated_at
    // are carried forward from the prior row when one exists.
    //
    // Fresh evaluations (slug match, brand match, cross-project cache hit,
    // AI verdict) always stamp last_evaluated_at = now.
    const buildDeterministic = (
      kwId: string,
      fallback: Omit<Upsert, "keyword_id" | "relevancy_score" | "last_evaluated_at">,
    ): Upsert => {
      const prev = existingArch.get(kwId);
      if (prev && prev.relevancy_score != null) {
        preservedScores++;
        return {
          keyword_id: kwId,
          ...fallback,
          relevancy_score: prev.relevancy_score,
          last_evaluated_at: prev.last_evaluated_at ?? null,
        };
      }
      return { keyword_id: kwId, ...fallback, relevancy_score: null, last_evaluated_at: null };
    };
    const buildFresh = (u: Omit<Upsert, "last_evaluated_at">): Upsert => ({
      ...u,
      last_evaluated_at: nowIso,
    });

    // Phase 0a: keywords with no volume signal → park as "watch".
    // Phase 0b: keywords with no ranking_url + positive volume → deterministic
    //          "content gap". Skip AI entirely; AI cannot do better than this.
    const candidates: typeof batch = [];
    for (const kw of batch) {
      const vol = kw.avg_monthly_volume ?? 0;
      if (vol <= 0) {
        upserts.push(buildDeterministic(kw.id, {
          matched_url: kw.ranking_url,
          content_status: "amber",
          tactical_rag_status: "watch",
        }));
        fromWatch++;
        continue;
      }
      if (!kw.ranking_url) {
        upserts.push(buildDeterministic(kw.id, {
          matched_url: null,
          content_status: "red",
          tactical_rag_status: "create_content",
        }));
        fromNoUrl++;
        continue;
      }
      candidates.push(kw);
    }

    // Phase 1: Rule-based pre-classification (URL slug match, brand match)
    const needsAi: typeof batch = [];
    for (const kw of candidates) {
      const r = ruleClassify({
        keyword: kw.keyword,
        ranking_url: kw.ranking_url,
        avg_monthly_volume: kw.avg_monthly_volume,
        brandTokens,
      });
      if (r) {
        // ruleClassify may return a deterministic no-URL short-circuit
        // (relevancy_score === null) or a genuine slug/brand-match verdict
        // (relevancy_score number). Preserve prior score for the former,
        // stamp fresh timestamp for the latter.
        if (r.relevancy_score == null) {
          upserts.push(buildDeterministic(kw.id, {
            matched_url: r.matched_url,
            content_status: r.content_status,
            tactical_rag_status: r.tactical_rag_status,
          }));
        } else {
          upserts.push(buildFresh({ keyword_id: kw.id, ...r }));
        }
        fromRules++;
      } else {
        needsAi.push(kw);
      }
    }

    // Phase 2: Cross-project cache lookup within the same client
    if (needsAi.length > 0 && clientId) {
      const keywords = Array.from(new Set(needsAi.map((k) => k.keyword)));
      // Truncation-remediation 2026-07-18: chunk keyword list via selectIn
      // (paginate) so 1,000+ same-client matches are never silently capped.
      const clientKw = await selectIn<any>(
        supabase,
        "keywords",
        "id, keyword, ranking_url, project_id, navigator_projects!inner(client_id)",
        "keyword",
        keywords,
        { paginate: true, extraFilter: (q) => q.eq("navigator_projects.client_id", clientId).neq("project_id", project_id) },
      );
      const cacheKwIds = clientKw.map((r: any) => r.id);
      const cacheBySig = new Map<string, Upsert>();
      if (cacheKwIds.length) {
        // Route through selectIn (MAX_IN_CHUNK=100) so we can never rebuild
        // a giant URL, and paginate in case a huge cache appears.
        const cacheRows = await selectIn<any>(
          supabase,
          "site_architecture",
          "keyword_id, matched_url, relevancy_score, content_status, tactical_rag_status",
          "keyword_id",
          cacheKwIds,
          { paginate: true, extraFilter: (q) => q.not("relevancy_score", "is", null) },
        );
        for (const r of cacheRows) {
          const src = (clientKw as any[])?.find((k) => k.id === r.keyword_id);
          if (!src) continue;
          const sig = `${src.keyword}::${src.ranking_url ?? ""}`;
          if (!cacheBySig.has(sig)) {
            cacheBySig.set(sig, {
              keyword_id: "",
              matched_url: r.matched_url as string | null,
              relevancy_score: r.relevancy_score as number,
              content_status: r.content_status as string,
              tactical_rag_status: r.tactical_rag_status as string,
            });
          }
        }
      }
      const stillNeedAi: typeof needsAi = [];
      for (const kw of needsAi) {
        const sig = `${kw.keyword}::${kw.ranking_url ?? ""}`;
        const hit = cacheBySig.get(sig);
        if (hit) {
          upserts.push(buildFresh({ ...hit, keyword_id: kw.id }));
          fromCache++;
        } else {
          stillNeedAi.push(kw);
        }
      }
      needsAi.length = 0;
      needsAi.push(...stillNeedAi);
    }

    // Phase 3: AI for the remainder, de-duplicated by (keyword, ranking_url),
    // capped to AI_BATCH_SIZE per invocation. Tries one retry at a smaller
    // batch size if the model returns a malformed function call.
    let aiAttempted = 0;
    let aiParsed = 0;
    let malformed = false;
    let rateLimitInfo: { retryAfterSeconds: number; paymentRequired: boolean } | null = null;

    if (needsAi.length > 0) {
      const sigToKws = new Map<string, typeof needsAi>();
      for (const kw of needsAi) {
        const sig = `${kw.keyword}::${kw.ranking_url ?? ""}`;
        const arr = sigToKws.get(sig) ?? [];
        arr.push(kw);
        sigToKws.set(sig, arr);
      }
      const allDistinct = Array.from(sigToKws.entries());

      const system = `You are an SEO site architecture analyst. Client domain: ${clientDomain}.
For each row "idx|keyword|url|intent" decide:
- relevancy_score (0-1): how well url matches keyword intent.
- content_status: "green" (well optimised), "amber" (needs work), "red" (poor match).
- tactical_rag_status: "no_action_needed" | "optimise_content" | "create_content" | "new_content".`;

      const callAi = async (entries: [string, typeof needsAi][]) => {
        const rowsPrompt = entries.map(([, group], idx) => {
          const k = group[0];
          return `${idx}|${k.keyword}|${k.ranking_url}|${k.search_intent ?? "?"}`;
        }).join("\n");

        return await fetch(AI_GATEWAY_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${LOVABLE_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: MODEL,
            max_tokens: MAX_TOKENS,
            messages: [
              { role: "system", content: system },
              { role: "user", content: rowsPrompt },
            ],
            tools: [{
              type: "function",
              function: {
                name: "score_rows",
                description: "Return a score for each input row.",
                parameters: {
                  type: "object",
                  properties: {
                    results: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          idx: { type: "number" },
                          relevancy_score: { type: "number" },
                          content_status: { type: "string", enum: ["green", "amber", "red"] },
                          tactical_rag_status: {
                            type: "string",
                            enum: ["no_action_needed", "optimise_content", "create_content", "new_content"],
                          },
                        },
                        required: ["idx", "relevancy_score", "content_status", "tactical_rag_status"],
                        additionalProperties: false,
                      },
                    },
                  },
                  required: ["results"],
                  additionalProperties: false,
                },
              },
            }],
            tool_choice: { type: "function", function: { name: "score_rows" } },
          }),
        });
      };

      const applyParsedResults = (
        entries: [string, typeof needsAi][],
        parsed: any[],
      ) => {
        let count = 0;
        for (const item of parsed) {
          const idx = typeof item.idx === "number" ? item.idx : -1;
          if (idx < 0 || idx >= entries.length) continue;
          const [, group] = entries[idx];
          const relevancy = Math.min(1, Math.max(0, Number(item.relevancy_score) || 0));
          const content = sanitizeContentStatus(String(item.content_status || "amber"));
          const tactical = sanitizeTacticalStatus(String(item.tactical_rag_status || "optimise_content"));
          for (const kw of group) {
            upserts.push(buildFresh({
              keyword_id: kw.id,
              matched_url: kw.ranking_url,
              relevancy_score: relevancy,
              content_status: content,
              tactical_rag_status: tactical,
            }));
            count++;
          }
        }
        return count;
      };

      const runChunk = async (entries: [string, typeof needsAi][]): Promise<boolean> => {
        if (entries.length === 0) return true;
        aiAttempted += entries.reduce((n, [, g]) => n + g.length, 0);

        const resp = await callAi(entries);
        if (resp.status === 429 || resp.status === 402) {
          const retryAfterHeader = resp.headers.get("retry-after");
          rateLimitInfo = {
            retryAfterSeconds: retryAfterHeader ? parseInt(retryAfterHeader, 10) || 30 : 30,
            paymentRequired: resp.status === 402,
          };
          return false;
        }
        if (!resp.ok) {
          const errText = await resp.text();
          throw new Error(`AI gateway error ${resp.status}: ${errText.slice(0, 300)}`);
        }
        const aiData = await resp.json();
        const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
        let parsed: any[] | null = null;
        if (toolCall?.function?.arguments) {
          try {
            const args = JSON.parse(toolCall.function.arguments);
            parsed = Array.isArray(args.results) ? args.results : null;
          } catch (e) {
            console.error("Failed to parse tool call args", e);
          }
        }

        if (!parsed && entries.length > AI_RETRY_BATCH_SIZE) {
          console.warn(
            `AI malformed/empty for ${entries.length} rows; retrying in chunks of ${AI_RETRY_BATCH_SIZE}`,
          );
          let allOk = true;
          for (let i = 0; i < entries.length; i += AI_RETRY_BATCH_SIZE) {
            const sub = entries.slice(i, i + AI_RETRY_BATCH_SIZE);
            const ok = await runChunk(sub);
            if (!ok) allOk = false;
          }
          return allOk;
        }

        if (!parsed) {
          malformed = true;
          console.error(
            "No structured results from AI",
            JSON.stringify(aiData).slice(0, 400),
          );
          return true;
        }

        aiParsed += applyParsedResults(entries, parsed);
        return true;
      };

      for (let i = 0; i < allDistinct.length; i += AI_BATCH_SIZE) {
        const slice = allDistinct.slice(i, i + AI_BATCH_SIZE);
        const ok = await runChunk(slice);
        if (!ok) break;
      }
    }

    // De-dupe by keyword_id (last write wins) before sending to Postgres.
    const dedupedMap = new Map<string, Upsert>();
    for (const u of upserts) dedupedMap.set(u.keyword_id, u);
    const deduped = Array.from(dedupedMap.values());

    let upsertsAttempted = deduped.length;
    let upsertsWritten = 0;
    let writeError: string | null = null;

    if (deduped.length > 0) {
      const CHUNK = 200;
      for (let i = 0; i < deduped.length; i += CHUNK) {
        const slice = deduped.slice(i, i + CHUNK);
        const { data: written, error: upErr } = await supabase
          .from("site_architecture")
          .upsert(slice, { onConflict: "keyword_id" })
          .select("keyword_id");
        if (upErr) {
          writeError = upErr.message;
          console.error("site-arch upsert error:", upErr.message);
          break;
        }
        upsertsWritten += (written ?? []).length;
      }
    }

    // Recompute true remaining from the database — chunked, with error checks,
    // so a failed read can never masquerade as "all rows pending".
    let remainingAfter = remainingBefore;
    {
      const arch2 = new Map<string, { relevancy_score: number | null; tactical_rag_status: string | null }>();
      for (let i = 0; i < keptIds.length; i += READ_CHUNK) {
        const slice = keptIds.slice(i, i + READ_CHUNK);
        const { data: archRows2, error: verifyErr } = await supabase
          .from("site_architecture")
          .select("keyword_id, relevancy_score, tactical_rag_status")
          .in("keyword_id", slice);
        if (verifyErr) throw new Error(`Verify arch: ${verifyErr.message}`);
        for (const r of archRows2 ?? []) {
          arch2.set(r.keyword_id as string, {
            relevancy_score: r.relevancy_score as number | null,
            tactical_rag_status: r.tactical_rag_status as string | null,
          });
        }
      }
      remainingAfter = (keptRows ?? []).filter((k) => isPending(k, arch2.get(k.id))).length;
    }
    const processedNew = Math.max(0, remainingBefore - remainingAfter);
    const writeFailed = !!writeError || (upsertsAttempted > 0 && upsertsWritten === 0 && processedNew === 0);
    const stalled = !rateLimitInfo && !writeFailed && processedNew === 0 && remainingAfter > 0;

    console.log(
      `site-arch batch: before=${remainingBefore} after=${remainingAfter} new=${processedNew} ` +
        `attempted=${upsertsAttempted} written=${upsertsWritten} writeError=${writeError ?? "-"} ` +
        `noUrl=${fromNoUrl} watch=${fromWatch} rules=${fromRules} cache=${fromCache} preserved=${preservedScores} ` +
        `aiAttempted=${aiAttempted} aiParsed=${aiParsed} malformed=${malformed} ` +
        `rateLimited=${!!rateLimitInfo}`,
    );

    if (rateLimitInfo) {
      return new Response(
        JSON.stringify({
          rateLimited: true,
          retryAfterSeconds: (rateLimitInfo as any).retryAfterSeconds,
          paymentRequired: (rateLimitInfo as any).paymentRequired,
          processed: processedNew,
          remainingBefore,
          remaining: remainingAfter,
          fromRules,
          fromCache,
          fromNoUrl,
          fromWatch,
          done: false,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        processed: processedNew,
        processedNew,
        remainingBefore,
        remaining: remainingAfter,
        done: remainingAfter === 0 && !writeFailed,
        stalled,
        malformed,
        writeFailed,
        writeError,
        upsertsAttempted,
        upsertsWritten,
        fromWatch,
        fromNoUrl,
        fromRules,
        fromCache,
        preservedScores,
        aiAttempted,
        aiParsed,
        rows_fetched: {
          keywords: keptRows.length,
          site_architecture_existing: existingArch.size,
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("site-architecture error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

````

---

## supabase/functions/har-calculation-v2/index.ts

### `supabase/functions/har-calculation-v2/index.ts`

```ts
// har-calculation-v2
// Phase 9 · Prompt 9.2 — HAR v2 composite scenario computation.
// Admin-only. Manual invocation. Reads stored data only (no external calls).
// Writes 3 rows per keyword to keyword_forecast_scenarios tagged with a
// calc_run_registry row (model_version = HAR_V2_MODEL_VERSION from _shared/har-v2.ts). Revenue fields left NULL.
// HAR v1 (har-calculation, har_results, keyword_forecasts) is not modified.
//
// Contract:
//   POST /functions/v1/har-calculation-v2
//   Body: { project_id: uuid }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  CALC_RUN_FAILED_STATUS,
  CALC_RUN_PARTIAL_STATUS,
  CALC_RUN_SUCCESS_STATUS,
  type CalcRunTerminalStatus,
} from "../_shared/calc-run-registry.ts";
import {
  HAR_V2_MODEL_VERSION,
  SCENARIOS,
  canonicalUrl,
  computeScenario,
  resolveClientRankingUrl,
  type ClientLpsSource,
  type ClientLpsMatch,
  type CompetitorRow,
  type CompositeInputs,
  type OverrideInfo,
  type ScoringConfig,
} from "../_shared/har-v2.ts";
import {
  buildContextDivisors,
  computeLpsForRow,
  type ClientDomainRef,
  type SerpRowMetrics,
} from "../_shared/link-power-score.ts";
import { selectIn } from "../_shared/pgrst-in.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const KW_CHUNK = 100;
const INSERT_CHUNK = 500;
const LPS_MODEL_VERSION = "lps_v2.0.0";

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
function serializeErr(e: unknown): { code?: string; message: string; details?: string; hint?: string } {
  if (e instanceof Error) return { message: e.message };
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    return {
      code: typeof o.code === "string" ? o.code : undefined,
      message: typeof o.message === "string" ? o.message : JSON.stringify(e),
      details: typeof o.details === "string" ? o.details : undefined,
      hint: typeof o.hint === "string" ? o.hint : undefined,
    };
  }
  return { message: String(e) };
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

  let payload: { project_id?: string };
  try { payload = await req.json(); } catch { return err(400, "invalid_payload", "Body must be JSON."); }
  const projectId = payload?.project_id;
  if (!projectId || typeof projectId !== "string") {
    return err(400, "invalid_payload", "project_id is required.");
  }

  // ---- Auth + admin ----
  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData?.user) return err(401, "unauthorized", "Invalid or expired token.");
  const userId = userData.user.id;

  const { data: roles, error: roleErr } = await sb.from("user_roles").select("role").eq("user_id", userId);
  if (roleErr) return err(500, "db_error", roleErr.message);
  const isAdmin = (roles ?? []).some((r: { role: string }) => r.role === "admin" || r.role === "super_admin");
  if (!isAdmin) return err(403, "forbidden_admin_only", "Admin role required.");

  // ---- Project visibility ----
  const { data: proj, error: projErr } = await sb
    .from("navigator_projects")
    .select("id, client_id, archived_at")
    .eq("id", projectId)
    .maybeSingle();
  if (projErr) return err(500, "db_error", projErr.message);
  if (!proj) return err(403, "forbidden_project", "Project not visible.");
  if ((proj as { archived_at?: string | null }).archived_at) {
    return err(409, "project_archived", "Cannot compute HAR v2 for an archived project.");
  }

  // ---- Duplicate-run guard (15 min) ----
  const staleCutoffIso = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data: inflight, error: inflightErr } = await sb
    .from("calc_run_registry")
    .select("id, started_at")
    .eq("project_id", projectId)
    .eq("model_version", HAR_V2_MODEL_VERSION)
    .eq("status", "running")
    .is("finished_at", null)
    .gte("started_at", staleCutoffIso)
    .order("started_at", { ascending: false })
    .limit(1);
  if (inflightErr) return err(500, "db_error", inflightErr.message);
  if (inflight && inflight.length > 0) {
    const existing = inflight[0] as { id: string; started_at: string };
    return err(409, "har_v2_run_in_progress", "Another HAR v2 run is already in progress.", {
      calc_run_id: existing.id,
      started_at: existing.started_at,
    });
  }

  // ---- Client authority + domain (reference) ----
  const { data: cdmRows, error: cdmErr } = await sb
    .from("client_domain_metrics")
    .select("url_rating, domain_rating, ahrefs_rank, fetched_at, domain")
    .eq("project_id", projectId)
    .order("fetched_at", { ascending: false, nullsFirst: false })
    .limit(1);
  if (cdmErr) return err(500, "db_error", cdmErr.message);
  const clientAuth = (cdmRows ?? [])[0] as
    | { url_rating: number | null; domain_rating: number | null; ahrefs_rank: number | null; fetched_at: string | null; domain: string | null }
    | undefined;
  const clientUr = clientAuth?.url_rating ?? null;
  const clientDr = clientAuth?.domain_rating ?? null;
  const hasClientAuthority = clientUr != null || clientDr != null;

  const { data: clientRow, error: clientErr } = await sb
    .from("clients")
    .select("domain, domain_normalized")
    .eq("id", (proj as { client_id: string }).client_id)
    .maybeSingle();
  if (clientErr) return err(500, "db_error", clientErr.message);
  const clientDomain = (clientRow as { domain_normalized?: string | null; domain?: string | null } | null)?.domain_normalized
    ?? (clientRow as { domain?: string | null } | null)?.domain
    ?? clientAuth?.domain
    ?? null;
  const clientRef: ClientDomainRef | null = clientAuth
    ? {
        domain: clientAuth.domain ?? clientDomain,
        url_rating: clientAuth.url_rating,
        domain_rating: clientAuth.domain_rating,
        ahrefs_rank: clientAuth.ahrefs_rank,
        fetched_at: clientAuth.fetched_at,
      }
    : null;

  // ---- Latest successful LPS run (for client + competitor LPS lookup) ----
  const { data: lpsRunRow, error: lpsRunErr } = await sb
    .from("calc_run_registry")
    .select("id")
    .eq("project_id", projectId)
    .eq("model_version", LPS_MODEL_VERSION)
    .in("status", ["succeeded", "partial"])
    .order("started_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lpsRunErr) return err(500, "db_error", lpsRunErr.message);
  const latestLpsRunId = (lpsRunRow as { id: string } | null)?.id ?? null;
  const latestLpsRunExists = !!latestLpsRunId;

  // ---- Active HAR scoring config (Prompt 1.7) ---------------------------
  // Loaded once per run so operators can tune scenario knobs without a code
  // deploy. Falls back to hard-coded defaults inside computeScenario when a
  // key is missing from thresholds_json.
  const { data: scoringCfgRow, error: scoringCfgErr } = await sb
    .from("har_scoring_config")
    .select("id, version, thresholds_json")
    .eq("is_active", true)
    .maybeSingle();
  if (scoringCfgErr) return err(500, "db_error", scoringCfgErr.message);
  const thresholds = (scoringCfgRow?.thresholds_json ?? {}) as Record<string, unknown>;
  const asMap = (v: unknown): Record<string, number> | undefined => {
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, number>;
    return undefined;
  };
  const scoringConfig: ScoringConfig | undefined = scoringCfgRow
    ? {
        config_id: (scoringCfgRow as { id: string }).id,
        config_version: (scoringCfgRow as { version: string }).version,
        scenario_thresholds: asMap(thresholds.scenario_thresholds),
        scenario_temperatures: asMap(thresholds.scenario_temperatures),
        scenario_floor_multipliers: asMap(thresholds.scenario_floor_multipliers),
        scenario_prob_factors: asMap(thresholds.scenario_prob_factors),
        min_confidence: typeof thresholds.min_confidence === "number"
          ? (thresholds.min_confidence as number)
          : null,
      }
    : undefined;

  // ---- Open calc_run_registry ----
  const { data: runIns, error: runErr } = await sb
    .from("calc_run_registry")
    .insert({
      project_id: projectId,
      triggered_by: userId,
      trigger_source: "admin_manual",
      model_version: HAR_V2_MODEL_VERSION,
      scope: {
        kind: "har_v2",
        latest_lps_run_id: latestLpsRunId,
        scoring_config_id: scoringConfig?.config_id ?? null,
        scoring_config_version: scoringConfig?.config_version ?? null,
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
    if (closeErr) throw new Error(`calc_run_close_failed: ${closeErr.message}`);
  };

  try {
    // ---- Kept keywords (include ranking_url for client-LPS resolution) ----
    const keptKws: Array<{ id: string; base_rank: number | null; ranking_url: string | null }> = [];
    let offset = 0;
    while (true) {
      const { data, error } = await sb
        .from("keywords")
        .select("id, base_rank, ranking_url")
        .eq("project_id", projectId)
        .eq("detox_status", "keep")
        .range(offset, offset + 999);
      if (error) throw error;
      const rows = (data ?? []) as Array<{ id: string; base_rank: number | null; ranking_url: string | null }>;
      keptKws.push(...rows);
      if (rows.length < 1000) break;
      offset += 1000;
    }
    const keywordIds = keptKws.map((k) => String(k.id));
    const baseRankByKw = new Map<string, number | null>(keptKws.map((k) => [String(k.id), k.base_rank]));
    const clientResolvedUrlByKw = new Map<string, string | null>(
      keptKws.map((k) => [String(k.id), resolveClientRankingUrl(k.ranking_url, clientDomain)]),
    );

    const runWarnings: unknown[] = [];
    const dbErrors: unknown[] = [];

    if (keywordIds.length === 0) {
      const summary = {
        model_version: HAR_V2_MODEL_VERSION,
        keywords_total: 0, keywords_written: 0, scenarios_written: 0,
        skipped_reason: "no_kept_keywords",
      };
      await closeRun(CALC_RUN_SUCCESS_STATUS, summary, runWarnings, []);
      return json(200, { calc_run_id: calcRunId, summary });
    }

    // ---- Upfront maps: manual overrides, per-batch data loaded lazily ----
    const overrideByKw = new Map<string, OverrideInfo>();
    // Incident 2026-07-16-part2: previously `chunk(keywordIds, 500)` produced
    // ~19 KB URLs and aborted with `TypeError: error sending request`. Route
    // through selectIn (MAX_IN_CHUNK=100) to keep every URL well under caps.
    let keywordForecastsFetched = 0;
    {
      const rows = await selectIn<{ id: string; keyword_id: string; har: number | null; har_is_manual: boolean }>(
        sb,
        "keyword_forecasts",
        "id, keyword_id, har, har_is_manual",
        "keyword_id",
        keywordIds,
      );
      keywordForecastsFetched = rows.length;
      for (const r of rows) {
        if (r.har_is_manual && r.har != null) {
          overrideByKw.set(String(r.keyword_id), { har: Number(r.har), v1_forecast_id: r.id });
        }
      }
    }

    let keywordsWritten = 0;
    let keywordsSkipped = 0;
    let scenariosWritten = 0;
    let overrideCount = 0;
    let missingLpsCount = 0;
    let syntheticLpsCount = 0;
    let realClientLpsCount = 0;
    let domainFallbackLpsCount = 0;
    let missingSerpCount = 0;
    let missingContentFitCount = 0;
    const rowsFetched = {
      keywords: keptKws.length,
      keyword_forecasts: keywordForecastsFetched,
      serp_results: 0,
      link_power_scores: 0,
      site_architecture: 0,
      serp_features: 0,
      serp_features_distinct: 0,
    };

    const missingLpsSamples: string[] = [];
    const missingSerpSamples: string[] = [];
    const missingContentSamples: string[] = [];
    const pushSample = (arr: string[], v: string) => { if (arr.length < 10) arr.push(v); };

    const insertBuffer: Array<Record<string, unknown>> = [];
    const flush = async () => {
      if (!insertBuffer.length) return;
      const batch = insertBuffer.splice(0, insertBuffer.length);
      const { error } = await sb.from("keyword_forecast_scenarios").insert(batch);
      if (error) {
        dbErrors.push({ code: "insert_failed", message: error.message, chunk_size: batch.length });
      } else {
        scenariosWritten += batch.length;
      }
    };

    for (const kwBatch of chunk(keywordIds, KW_CHUNK)) {
      // SERP results for this batch — include rd/bl so we can build divisors
      // for synthetic client LPS computation.
      // Truncation-remediation 2026-07-18: route through selectIn(paginate)
      // so heavy batches never silently cap at the 1,000-row default.
      const serpRaw = await selectIn<Record<string, unknown>>(
        sb,
        "serp_results",
        "keyword_id, rank_absolute, url, domain, url_rating, domain_rating, referring_domains, backlinks",
        "keyword_id",
        kwBatch,
        { paginate: true },
      );
      rowsFetched.serp_results += serpRaw.length;
      const serpByKw = new Map<string, CompetitorRow[]>();
      const serpMetricsRows: SerpRowMetrics[] = [];
      for (const r of serpRaw) {
        const kid = String(r.keyword_id);
        if (!serpByKw.has(kid)) serpByKw.set(kid, []);
        serpByKw.get(kid)!.push({
          rank_absolute: r.rank_absolute == null ? null : Number(r.rank_absolute),
          url: (r.url as string | null) ?? null,
          domain: (r.domain as string | null) ?? null,
          url_rating: r.url_rating == null ? null : Number(r.url_rating),
          domain_rating: r.domain_rating == null ? null : Number(r.domain_rating),
          lps_score: null, // filled below
        });
        serpMetricsRows.push({
          keyword_id: kid,
          url_rating: r.url_rating == null ? null : Number(r.url_rating),
          domain_rating: r.domain_rating == null ? null : Number(r.domain_rating),
          referring_domains: r.referring_domains == null ? null : Number(r.referring_domains),
          backlinks: r.backlinks == null ? null : Number(r.backlinks),
        });
      }

      // Divisors for synthetic client LPS (per-keyword or project-p95 fallback).
      const lpsDivisors = buildContextDivisors(serpMetricsRows);

      // LPS rows for this batch (only from latest LPS run). Store by canonical
      // URL so the client's ranking_url can be matched directly. Also keep a
      // per-keyword best-scoring row whose domain matches the client — used as
      // a fallback when keywords.ranking_url is NULL but the client is
      // actually in the SERP.
      const lpsByKwCanonical = new Map<string, number>();
      const lpsByKwClientDomain = new Map<string, { lps_score: number; url: string }>();
      if (latestLpsRunId) {
        const lpsRaw = await selectIn<{ keyword_id: string; url: string; lps_score: number; domain: string | null }>(
          sb,
          "link_power_scores",
          "keyword_id, url, lps_score, domain",
          "keyword_id",
          kwBatch,
          { paginate: true, extraFilter: (q) => q.eq("calc_run_id", latestLpsRunId) },
        );
        rowsFetched.link_power_scores += lpsRaw.length;
        for (const r of lpsRaw) {
          const canon = canonicalUrl(r.url);
          if (canon) lpsByKwCanonical.set(`${r.keyword_id}::${canon}`, Number(r.lps_score));
          if (clientDomain) {
            let rowDomain = (r.domain ?? "").toLowerCase().replace(/^www\./, "");
            if (!rowDomain && canon) {
              try { rowDomain = new URL(canon).hostname; } catch { /* noop */ }
            }
            if (rowDomain && rowDomain === clientDomain) {
              const prev = lpsByKwClientDomain.get(String(r.keyword_id));
              if (!prev || Number(r.lps_score) > prev.lps_score) {
                lpsByKwClientDomain.set(String(r.keyword_id), {
                  lps_score: Number(r.lps_score),
                  url: canon ?? r.url,
                });
              }
            }
          }
        }
      }
      // Attach LPS to competitors by canonical URL.
      for (const [kid, rows] of serpByKw) {
        for (const r of rows) {
          const canon = canonicalUrl(r.url);
          if (!canon) continue;
          const key = `${kid}::${canon}`;
          if (lpsByKwCanonical.has(key)) r.lps_score = lpsByKwCanonical.get(key)!;
        }
      }

      // Site architecture (content fit).
      const { data: saRaw, error: saErr } = await sb
        .from("site_architecture")
        .select("keyword_id, relevancy_score")
        .in("keyword_id", kwBatch);
      if (saErr) throw saErr;
      rowsFetched.site_architecture += (saRaw ?? []).length;
      const contentByKw = new Map<string, number | null>();
      for (const r of (saRaw ?? []) as Array<{ keyword_id: string; relevancy_score: number | null }>) {
        contentByKw.set(String(r.keyword_id), r.relevancy_score);
      }

      // SERP features. This table accumulates rows per ingest with no
      // snapshot/created_at discriminator (~23 rows/kw observed on TVs Ongoing,
      // max 82). A 100-kw chunk therefore routinely exceeds the 1,000-row
      // PostgREST cap and the raw `.in(...)` call above silently truncated
      // (see docs/truncation-audit-2026-07-18.md follow-up). Route through
      // selectIn with paginate:true and dedupe by (keyword_id, result_type)
      // (first-wins) so the retained aggregate values are deterministic
      // regardless of ingest history.
      const sfRaw = await selectIn<Record<string, unknown>>(
        sb,
        "serp_features",
        "keyword_id, result_type, serp_feature_count, top_serp_feature, snippet_opportunity",
        "keyword_id",
        kwBatch,
        { paginate: true },
      );
      rowsFetched.serp_features += sfRaw.length;
      const sfByKw = new Map<string, { count: number | null; top: string | null; snippet: boolean | null }>();
      const seenSfPairs = new Set<string>();
      for (const r of sfRaw) {
        const kid = String(r.keyword_id);
        const rt = ((r.result_type as string | null) ?? "").toLowerCase().trim();
        const pairKey = `${kid}::${rt}`;
        if (rt && seenSfPairs.has(pairKey)) continue;
        if (rt) seenSfPairs.add(pairKey);
        // First-wins per (keyword_id, result_type). The per-keyword aggregate
        // (count/top/snippet) is set once from the first row for the keyword.
        if (!sfByKw.has(kid)) {
          sfByKw.set(kid, {
            count: r.serp_feature_count == null ? null : Number(r.serp_feature_count),
            top: (r.top_serp_feature as string | null) ?? null,
            snippet: r.snippet_opportunity == null ? null : Boolean(r.snippet_opportunity),
          });
        }
      }
      rowsFetched.serp_features_distinct += seenSfPairs.size;

      // Compute per keyword.
      for (const kid of kwBatch) {
        const competitors = serpByKw.get(kid) ?? [];
        if (!competitors.length) {
          missingSerpCount += 1;
          pushSample(missingSerpSamples, kid);
        }
        const contentFit = contentByKw.has(kid) ? contentByKw.get(kid)! : null;
        if (contentFit == null) {
          missingContentFitCount += 1;
          pushSample(missingContentSamples, kid);
        }
        const sf = sfByKw.get(kid) ?? { count: null, top: null, snippet: null };

        // Client LPS resolution:
        //  1. Match client's resolved ranking URL against LPS rows for this
        //     keyword (best signal — page-level LPS for the exact ranking URL).
        //  1b. If keywords.ranking_url is null/unmatched, fall back to any LPS
        //     row for this keyword whose domain equals the client's domain.
        //     Uses the actual observed SERP URL and is still real page-level
        //     LPS — just without a manually-set ranking_url.
        //  2. Otherwise, if we have UR/DR from client_domain_metrics, compute
        //     a synthetic client LPS in-memory using the shared LPS formula
        //     and per-keyword/project divisors from this keyword's SERP rows.
        //  3. Otherwise, leave null and apply the standard confidence penalty.
        const clientResolvedUrl = clientResolvedUrlByKw.get(kid) ?? null;
        let clientLps: number | null = null;
        let clientLpsSource: ClientLpsSource = "unavailable";
        let clientLpsMatch: ClientLpsMatch = "unavailable";
        let resolvedUrlForExplanation: string | null = clientResolvedUrl;
        if (clientResolvedUrl) {
          const key = `${kid}::${clientResolvedUrl}`;
          if (lpsByKwCanonical.has(key)) {
            clientLps = lpsByKwCanonical.get(key)!;
            clientLpsSource = "serp_row";
            clientLpsMatch = "ranking_url";
          }
        }
        if (clientLps == null && lpsByKwClientDomain.has(kid)) {
          const hit = lpsByKwClientDomain.get(kid)!;
          clientLps = hit.lps_score;
          clientLpsSource = "serp_row";
          clientLpsMatch = "domain_fallback";
          resolvedUrlForExplanation = hit.url;
          domainFallbackLpsCount += 1;
        }
        // Default fallback: synthesise client LPS from client_domain_metrics
        // whenever we have UR or DR, regardless of ranking-URL match. This keeps
        // per-competitor LPS-vs-LPS pBeat available instead of collapsing to
        // UR-vs-UR when the client SERP row is missing.
        if (clientLps == null && (clientUr != null || clientDr != null)) {
          const refForSynth: ClientDomainRef = clientRef ?? {
            domain: clientDomain,
            url_rating: clientUr,
            domain_rating: clientDr,
            ahrefs_rank: null,
            fetched_at: null,
          };
          const synth = computeLpsForRow(
            {
              keyword_id: kid,
              url_rating: clientUr,
              domain_rating: clientDr,
              referring_domains: null,
              backlinks: null,
            },
            lpsDivisors,
            { clientDomain, clientRef: refForSynth },
          );
          if (synth.lps_score > 0) {
            clientLps = synth.lps_score;
            clientLpsSource = "synthetic_client_domain";
            clientLpsMatch = "synthetic";
          }
        }


        const hasClientLpsRow = clientLpsSource !== "unavailable";
        if (clientLpsSource === "serp_row") realClientLpsCount += 1;
        else if (clientLpsSource === "synthetic_client_domain") syntheticLpsCount += 1;
        else if (latestLpsRunExists) {
          missingLpsCount += 1;
          pushSample(missingLpsSamples, kid);
        }

        const inputs: CompositeInputs = {
          client_lps: clientLps,
          client_ur: clientUr,
          client_dr: clientDr,
          client_lps_source: clientLpsSource,
          client_lps_match: clientLpsMatch,
          client_resolved_url: resolvedUrlForExplanation,
          competitors,
          content_fit_score: contentFit,
          serp_feature_count: sf.count,
          top_serp_feature: sf.top,
          snippet_opportunity: sf.snippet,
          base_rank: baseRankByKw.get(kid) ?? null,
          latest_lps_run_exists: latestLpsRunExists,
          has_client_lps_row: hasClientLpsRow,
          has_client_authority: hasClientAuthority,
        };

        const override = overrideByKw.get(kid) ?? null;
        if (override) overrideCount += 1;

        let wroteAny = false;
        for (const scenario of SCENARIOS) {
          const res = computeScenario(inputs, scenario, override, scoringConfig);
          insertBuffer.push({
            project_id: projectId,
            keyword_id: kid,
            calc_run_id: calcRunId,
            scenario,
            har_position: res.har_position,
            har_confidence: res.har_confidence,
            rank_attainment_probability: res.rank_attainment_probability,
            authority_score: res.authority_score,
            link_power_score: res.link_power_score,
            link_gap_score: res.link_gap_score,
            content_fit_score: res.content_fit_score,
            serp_visibility_multiplier: res.serp_visibility_multiplier,
            explanation_json: res.explanation_json,
            monthly_revenue_json: {},
            tp_absolute_revenue_annual: null,
            tp_incremental_revenue_annual: null,
            expected_incremental_revenue_annual: null,
            current_revenue_annual: null,
          });
          wroteAny = true;
          if (insertBuffer.length >= INSERT_CHUNK) await flush();
        }
        if (wroteAny) keywordsWritten += 1; else keywordsSkipped += 1;
      }
    }

    await flush();

    if (missingLpsCount > 0) runWarnings.push({ code: "missing_lps_row", count: missingLpsCount, samples: missingLpsSamples });
    if (missingSerpCount > 0) runWarnings.push({ code: "missing_serp_data", count: missingSerpCount, samples: missingSerpSamples });
    if (missingContentFitCount > 0) runWarnings.push({ code: "missing_content_fit", count: missingContentFitCount, samples: missingContentSamples });
    if (!latestLpsRunExists) runWarnings.push({ code: "no_lps_run", message: "No successful LPS run exists for this project; confidence penalised across all scenarios." });
    if (!hasClientAuthority) runWarnings.push({ code: "missing_client_authority", message: "client_domain_metrics has no UR/DR for this project." });

    if (syntheticLpsCount > 0) runWarnings.push({ code: "synthetic_client_lps", count: syntheticLpsCount, message: "Client LPS computed from client_domain_metrics UR/DR (no SERP match)." });

    const summary = {
      model_version: HAR_V2_MODEL_VERSION,
      keywords_total: keywordIds.length,
      keywords_written: keywordsWritten,
      keywords_skipped: keywordsSkipped,
      scenarios_written: scenariosWritten,
      override_count: overrideCount,
      real_client_lps_count: realClientLpsCount,
      domain_fallback_lps_count: domainFallbackLpsCount,
      synthetic_client_lps_count: syntheticLpsCount,
      missing_lps_count: missingLpsCount,
      missing_serp_count: missingSerpCount,
      missing_content_fit_count: missingContentFitCount,
      missing_client_authority: !hasClientAuthority,
      client_domain: clientDomain,
      latest_lps_run_id: latestLpsRunId,
      scoring_config_id: scoringConfig?.config_id ?? null,
      scoring_config_version: scoringConfig?.config_version ?? null,
      rows_fetched: rowsFetched,
    };

    let status: CalcRunTerminalStatus = CALC_RUN_SUCCESS_STATUS;
    if (dbErrors.length && scenariosWritten === 0) status = CALC_RUN_FAILED_STATUS;
    else if (dbErrors.length) status = CALC_RUN_PARTIAL_STATUS;

    await closeRun(status, summary, runWarnings, dbErrors);

    console.log(
      "[har-calculation-v2] project=%s kw_total=%d kw_written=%d scenarios=%d overrides=%d",
      projectId, keywordIds.length, keywordsWritten, scenariosWritten, overrideCount,
    );

    return json(200, { calc_run_id: calcRunId, summary });
  } catch (e) {
    const se = serializeErr(e);
    console.error("[har-calculation-v2] unhandled", JSON.stringify(se), e);
    try {
      await closeRun(
        CALC_RUN_FAILED_STATUS,
        { error: se },
        [],
        [{ code: se.code ?? "unhandled", message: se.message, details: se.details, hint: se.hint }],
      );
    } catch (closeErr) {
      console.error("[har-calculation-v2] close-on-error failed", closeErr);
    }
    return err(500, se.code ?? "unhandled", se.message);
  }
});

```

---

## supabase/functions/compute-forecasts-v2/index.ts

### `supabase/functions/compute-forecasts-v2/index.ts`

```ts
// compute-forecasts-v2
// Phase 10 · Prompt 10.2 — Revenue v2 shadow computation.
//
// Admin-only, manual invocation. Reads stored data only (no external calls).
// Updates revenue columns on the existing HAR v2 keyword_forecast_scenarios
// rows produced by har-calculation-v2. HAR v1 (compute-forecasts,
// keyword_forecasts) is NOT touched.
//
// Contract:
//   POST /functions/v1/compute-forecasts-v2
//   Body: { project_id: uuid, har_calc_run_id?: uuid }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  CALC_RUN_FAILED_STATUS,
  CALC_RUN_PARTIAL_STATUS,
  CALC_RUN_SUCCESS_STATUS,
  type CalcRunTerminalStatus,
} from "../_shared/calc-run-registry.ts";
import { buildCtrResolverV2 } from "../_shared/ctr-resolver-v2.ts";
import {
  indexOverrides,
  resolveConversionOverride,
  type OverrideRow,
} from "../_shared/conversion-override-resolver.ts";
import {
  annualVolumeFromInputs,
  computeRevenueV2,
  REVENUE_V2_MODEL_VERSION,
  type MonthlyVolumeRow,
} from "../_shared/revenue-v2.ts";
// HAR_V2_MODEL_VERSION is intentionally NOT imported here — the HAR guard
// accepts any latest terminal har_v2.* run (see prefix query below).

import {
  resolveSerpVisibilityV2,
  type SerpAdjustmentRow,
  type SerpFeatureRow,
} from "../_shared/serp-visibility-v2.ts";
import { selectIn } from "../_shared/pgrst-in.ts";

const KW_CHUNK = 200;
const UPDATE_CHUNK = 100;


const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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
function serializeErr(e: unknown): { code?: string; message: string; details?: string; hint?: string } {
  if (e instanceof Error) return { message: e.message };
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    return {
      code: typeof o.code === "string" ? o.code : undefined,
      message: typeof o.message === "string" ? o.message : JSON.stringify(e),
      details: typeof o.details === "string" ? o.details : undefined,
      hint: typeof o.hint === "string" ? o.hint : undefined,
    };
  }
  return { message: String(e) };
}

type WarningBag = Map<string, { count: number; samples: string[] }>;
function bump(bag: WarningBag, code: string, sample?: string) {
  const cur = bag.get(code) ?? { count: 0, samples: [] };
  cur.count += 1;
  if (sample && cur.samples.length < 10) cur.samples.push(sample);
  bag.set(code, cur);
}
/**
 * Dedupe-aware bump: no-ops if `seen` already contains `code`. Used to ensure
 * each (scenario, code) pair contributes at most once to `warnings_count`
 * (fixes the double-count where index.ts and computeRevenueV2 both emit the
 * same code for the same scenario row).
 */
function bumpOnce(bag: WarningBag, seen: Set<string>, code: string, sample?: string) {
  if (seen.has(code)) return;
  seen.add(code);
  bump(bag, code, sample);
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

  let payload: { project_id?: string; har_calc_run_id?: string };
  try { payload = await req.json(); } catch { return err(400, "invalid_payload", "Body must be JSON."); }
  const projectId = payload?.project_id;
  if (!projectId || typeof projectId !== "string") {
    return err(400, "invalid_payload", "project_id is required.");
  }
  const requestedHarRunId = payload?.har_calc_run_id ?? null;

  // Auth + admin
  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData?.user) return err(401, "unauthorized", "Invalid or expired token.");
  const userId = userData.user.id;
  const { data: roles, error: roleErr } = await sb.from("user_roles").select("role").eq("user_id", userId);
  if (roleErr) return err(500, "db_error", roleErr.message);
  const isAdmin = (roles ?? []).some((r: { role: string }) => r.role === "admin" || r.role === "super_admin");
  if (!isAdmin) return err(403, "forbidden_admin_only", "Admin role required.");

  // Project visibility
  const { data: proj, error: projErr } = await sb
    .from("navigator_projects")
    .select("id, client_id, archived_at, conversion_rate, aov")
    .eq("id", projectId)
    .maybeSingle();
  if (projErr) return err(500, "db_error", projErr.message);
  if (!proj) return err(403, "forbidden_project", "Project not visible.");
  if ((proj as { archived_at?: string | null }).archived_at) {
    return err(409, "project_archived", "Cannot compute Revenue v2 for an archived project.");
  }
  const project = proj as { id: string; conversion_rate: number | null; aov: number | null };
  const projectCvrDecimal =
    project.conversion_rate != null && Number.isFinite(Number(project.conversion_rate))
      ? Number(project.conversion_rate) / 100
      : null;
  const projectAov =
    project.aov != null && Number.isFinite(Number(project.aov)) ? Number(project.aov) : null;

  // Duplicate-run guard
  const staleCutoffIso = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data: inflight, error: inflightErr } = await sb
    .from("calc_run_registry")
    .select("id, started_at")
    .eq("project_id", projectId)
    .eq("model_version", REVENUE_V2_MODEL_VERSION)
    .eq("status", "running")
    .is("finished_at", null)
    .gte("started_at", staleCutoffIso)
    .limit(1);
  if (inflightErr) return err(500, "db_error", inflightErr.message);
  if (inflight && inflight.length > 0) {
    return err(409, "revenue_v2_run_in_progress", "Another Revenue v2 run is already in progress.", {
      calc_run_id: (inflight[0] as { id: string }).id,
    });
  }

  // Resolve target HAR v2 run — accept any har_v2.* terminal run (latest wins).
  // This decouples Revenue v2 from HAR v2 patch/minor bumps: the consumed
  // version is recorded in summary_json.har_model_version below.
  let harCalcRunId = requestedHarRunId;
  let harModelVersion: string | null = null;
  if (!harCalcRunId) {
    const { data: latestHar, error: harErr } = await sb
      .from("calc_run_registry")
      .select("id, model_version")
      .eq("project_id", projectId)
      .like("model_version", "har_v2%")
      .in("status", ["succeeded", "partial"])
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (harErr) return err(500, "db_error", harErr.message);
    const row = latestHar as { id: string; model_version: string } | null;
    harCalcRunId = row?.id ?? null;
    harModelVersion = row?.model_version ?? null;
  } else {
    // Requested explicitly — look up its version for audit.
    const { data: reqRow, error: reqErr } = await sb
      .from("calc_run_registry")
      .select("model_version")
      .eq("id", harCalcRunId)
      .maybeSingle();
    if (reqErr) return err(500, "db_error", reqErr.message);
    harModelVersion = (reqRow as { model_version: string } | null)?.model_version ?? null;
  }
  if (!harCalcRunId) {
    return err(409, "missing_har_v2_run", "No successful HAR v2 run for this project. Run HAR v2 first.");
  }




  // Open calc_run
  const { data: runIns, error: runErr } = await sb
    .from("calc_run_registry")
    .insert({
      project_id: projectId,
      triggered_by: userId,
      trigger_source: "admin_manual",
      model_version: REVENUE_V2_MODEL_VERSION,
      scope: { kind: "revenue_v2", har_calc_run_id: harCalcRunId, har_model_version: harModelVersion },
      status: "running",
      warnings: [],
      errors: [],
      summary_json: {},
    })
    .select("id")
    .single();
  if (runErr || !runIns) return err(500, "db_error", runErr?.message ?? "Failed to open calc run.");
  const calcRunId = (runIns as { id: string }).id;

  const dbErrors: unknown[] = [];
  const warnings: WarningBag = new Map();

  const closeRun = async (
    status: CalcRunTerminalStatus,
    summary: Record<string, unknown>,
  ) => {
    const warningsArr = Array.from(warnings.entries()).map(([code, v]) => ({
      code, count: v.count, samples: v.samples,
    }));
    const { error: closeErr } = await sb.from("calc_run_registry").update({
      status,
      finished_at: new Date().toISOString(),
      summary_json: summary,
      warnings: warningsArr,
      errors: dbErrors,
    }).eq("id", calcRunId);
    if (closeErr) console.error("[compute-forecasts-v2] close-on-error failed", closeErr);
  };

  try {
    // Load CTR curves (+ metadata for tie-break)
    const [{ data: curves }, { data: curveMeta }] = await Promise.all([
      sb.from("ctr_curves")
        .select("id, project_id, device, intent_segment, rank_position, ctr_percentage, is_fallback")
        .or(`project_id.eq.${projectId},is_fallback.eq.true`),
      sb.from("ctr_curve_metadata")
        .select("ctr_curve_id, source, confidence, sample_impressions, sample_clicks, date_range_start, date_range_end"),
    ]);
    const ctrResolver = buildCtrResolverV2({
      curves: (curves ?? []) as any,
      metadata: (curveMeta ?? []) as any,
    });

    // Load conversion overrides for this project
    const { data: overrideRows } = await sb
      .from("project_conversion_overrides")
      .select("id, scope_type, scope_value, conversion_rate, average_order_value, confidence, source")
      .eq("project_id", projectId);
    const overrideIdx = indexOverrides((overrideRows ?? []) as OverrideRow[]);

    // Load HAR v2 scenario rows for the target run.
    // NOTE: we intentionally do NOT read serp_visibility_multiplier here for
    // revenue purposes — Revenue v2.1 resolves SVM live via
    // resolveSerpVisibilityV2 from serp_features + serp_feature_ctr_adjustments.
    // HAR v2 continues to write that column as a diagnostic.
    const scenarioRows: Array<{
      id: string;
      keyword_id: string;
      scenario: string;
      har_position: number | null;
      har_confidence: number | null;
      rank_attainment_probability: number | null;
      explanation_json: Record<string, unknown> | null;
    }> = [];
    let offset = 0;
    while (true) {
      const { data, error } = await sb
        .from("keyword_forecast_scenarios")
        .select("id, keyword_id, scenario, har_position, har_confidence, rank_attainment_probability, explanation_json")
        .eq("calc_run_id", harCalcRunId)
        .range(offset, offset + 999);
      if (error) throw error;
      const rows = (data ?? []) as typeof scenarioRows;
      scenarioRows.push(...rows);
      if (rows.length < 1000) break;
      offset += 1000;
    }

    if (scenarioRows.length === 0) {
      const summary = {
        model_version: REVENUE_V2_MODEL_VERSION,
        har_calc_run_id: harCalcRunId,
        har_model_version: harModelVersion,

        scenarios_updated: 0,
        keywords_covered: 0,
        rows_fetched: { keyword_forecast_scenarios: 0, keywords: 0, keyword_monthly_volumes: 0, serp_features: 0 },
        skipped_reason: "no_scenarios_for_har_run",
      };
      await closeRun(CALC_RUN_SUCCESS_STATUS, summary);
      return json(200, { calc_run_id: calcRunId, summary });
    }

    // Group scenarios by keyword
    const byKw = new Map<string, typeof scenarioRows>();
    for (const r of scenarioRows) {
      const arr = byKw.get(r.keyword_id) ?? [];
      arr.push(r);
      byKw.set(r.keyword_id, arr);
    }
    const keywordIds = Array.from(byKw.keys());

    // Fetch kept keywords (only those with scenarios in scope)
    const kwMeta = new Map<string, {
      id: string; device: string | null; search_intent: string | null;
      avg_monthly_volume: number | null; base_rank: number | null;
      ranking_url: string | null;
      tags: (string | null)[];
    }>();
    // Incident 2026-07-16-part2: keep every IN-list URL under the edge-runtime
    // cap by routing prefetches through selectIn (MAX_IN_CHUNK=100).
    const rowsFetched = {
      keyword_forecast_scenarios: scenarioRows.length,
      keywords: 0,
      keyword_monthly_volumes: 0,
      serp_features: 0,
      keyword_demand_signals: 0,
    };
    {
      const rows = await selectIn<any>(
        sb,
        "keywords",
        "id, device, search_intent, avg_monthly_volume, base_rank, ranking_url, tag_1, tag_2, tag_3, tag_4, tag_5",
        "id",
        keywordIds,
      );
      rowsFetched.keywords = rows.length;
      for (const r of rows) {
        kwMeta.set(String(r.id), {
          id: String(r.id),
          device: r.device,
          search_intent: r.search_intent,
          avg_monthly_volume: r.avg_monthly_volume,
          base_rank: r.base_rank,
          ranking_url: r.ranking_url,
          tags: [r.tag_1, r.tag_2, r.tag_3, r.tag_4, r.tag_5],
        });
      }
    }

    // Fetch last 12 months of monthly volumes per keyword
    const monthlyByKw = new Map<string, MonthlyVolumeRow[]>();
    {
      const rows = await selectIn<{ keyword_id: string; month: string; volume: number }>(
        sb,
        "keyword_monthly_volumes",
        "keyword_id, month, volume",
        "keyword_id",
        keywordIds,
        { paginate: true },
      );
      rowsFetched.keyword_monthly_volumes = rows.length;
      for (const r of rows) {
        const key = String(r.keyword_id);
        const arr = monthlyByKw.get(key) ?? [];
        arr.push({ month: String(r.month), volume: Number(r.volume) });
        monthlyByKw.set(key, arr);
      }
    }

    // Prompt 2.4 — trend signals per keyword. Optional inputs to revenue-v2;
    // absent/low-confidence entries collapse to factor=1 (zero-behaviour).
    const trendByKw = new Map<string, { trend_pct: number | null; trend_confidence: "low" | "medium" | "high" | null }>();
    {
      const rows = await selectIn<{ keyword_id: string; trend_pct: number | null; trend_confidence: string | null }>(
        sb,
        "keyword_demand_signals",
        "keyword_id, trend_pct, trend_confidence",
        "keyword_id",
        keywordIds,
        { paginate: true },
      );
      rowsFetched.keyword_demand_signals = rows.length;
      for (const r of rows) {
        const conf = r.trend_confidence;
        trendByKw.set(String(r.keyword_id), {
          trend_pct: r.trend_pct == null ? null : Number(r.trend_pct),
          trend_confidence:
            conf === "low" || conf === "medium" || conf === "high" ? conf : null,
        });
      }
    }

    // Load active SERP CTR adjustments once (small, project-agnostic).
    const { data: adjRows, error: adjErr } = await sb
      .from("serp_feature_ctr_adjustments")
      .select("feature_type, device, intent, multiplier, confidence, is_active")
      .eq("is_active", true);
    if (adjErr) throw adjErr;
    const adjustments = (adjRows ?? []) as SerpAdjustmentRow[];

    // Batch-load serp_features per keyword chunk.
    // Truncation guard: this table accumulates rows per ingest (~23 rows/kw on
    // TVs Ongoing, max 82). 100-kw chunks routinely exceed the 1,000-row
    // PostgREST cap, so paginate each chunk. Consumer (resolveSerpVisibilityV2)
    // dedupes by result_type; we also record a distinct-pair count for
    // observability.
    const featuresByKw = new Map<string, SerpFeatureRow[]>();
    let serpFeaturesDistinct = 0;
    {
      const rows = await selectIn<SerpFeatureRow>(
        sb,
        "serp_features",
        "keyword_id, result_type, serp_feature_count, serp_feature_owned, snippet_opportunity",
        "keyword_id",
        keywordIds,
        { paginate: true },
      );
      rowsFetched.serp_features = rows.length;
      const seenPairs = new Set<string>();
      for (const r of rows) {
        const kk = String(r.keyword_id);
        const rt = (r.result_type ?? "").toString().toLowerCase().trim();
        if (rt) seenPairs.add(`${kk}::${rt}`);
        const arr = featuresByKw.get(kk) ?? [];
        arr.push(r);
        featuresByKw.set(kk, arr);
      }
      serpFeaturesDistinct = seenPairs.size;
    }
    (rowsFetched as any).serp_features_distinct = serpFeaturesDistinct;

    // Process and update
    let scenariosUpdated = 0;
    let keywordsCovered = 0;
    const updatesBuffer: Array<Record<string, unknown>> = [];

    // Per-scenario running totals for calc_run_registry.summary_json.totals.
    // Aggregated from computeRevenueV2 outputs; no separate DB read at close.
    const emptyBucket = () => ({
      current_revenue_annual: 0,
      tp_absolute_revenue_annual: 0,
      tp_incremental_revenue_annual: 0,
      expected_incremental_revenue_annual: 0,
      keywords_with_tp: 0,
      tp_abs_without_incremental_count: 0,
      tp_abs_without_incremental_sum: 0,
    });

    const totalsAcc: Record<string, ReturnType<typeof emptyBucket>> = {
      conservative: emptyBucket(),
      realistic: emptyBucket(),
      stretch: emptyBucket(),
    };


    const flush = async () => {
      if (updatesBuffer.length === 0) return;
      const batch = updatesBuffer.splice(0, updatesBuffer.length);
      // UPDATE per row by primary key. We must not upsert on (id) — that would
      // treat the payload as an INSERT and violate NOT NULL on project_id /
      // keyword_id / scenario / calc_run_id (all of which already live on the
      // target row and must not be rewritten from here).
      const results = await Promise.all(
        batch.map(async (row) => {
          const { id, ...fields } = row as { id: string } & Record<string, unknown>;
          const { error } = await sb
            .from("keyword_forecast_scenarios")
            .update(fields)
            .eq("id", id);
          return { id, error };
        }),
      );
      for (const r of results) {
        if (r.error) {
          dbErrors.push({ code: "update_failed", message: r.error.message, id: r.id });
        } else {
          scenariosUpdated += 1;
        }
      }
    };


    for (const kid of keywordIds) {
      const kw = kwMeta.get(kid);
      const scenarios = byKw.get(kid) ?? [];
      if (!kw) {
        bump(warnings, "missing_keyword_row", kid);
        continue;
      }

      const monthly = monthlyByKw.get(kid) ?? [];
      const va = annualVolumeFromInputs(monthly, kw.avg_monthly_volume);
      if (va.source === "none") bump(warnings, "keyword_monthly_volumes_absent", kid);
      else if (va.source === "avg") bump(warnings, "keyword_monthly_volumes_partial", kid);

      // Resolve CVR/AOV once per keyword
      const conv = resolveConversionOverride(
        {
          keyword_id: kid,
          ranking_url: kw.ranking_url,
          search_intent: kw.search_intent,
          tags: kw.tags,
        },
        overrideIdx,
        { cvr: projectCvrDecimal, aov: projectAov },
      );
      if (conv.cvr.value == null) bump(warnings, "missing_cvr", kid);
      if (conv.aov.value == null) bump(warnings, "missing_aov", kid);
      if (conv.cvr.value != null && conv.cvr.value > 0.2) bump(warnings, "override_cvr_high", kid);
      if (conv.aov.value != null && conv.aov.value === 0) bump(warnings, "override_aov_zero", kid);

      const ctrNowRes = ctrResolver.resolve({
        device: kw.device,
        intent: kw.search_intent,
        position: kw.base_rank,
      });
      if (ctrNowRes.tier === "none" && kw.base_rank != null) bump(warnings, "missing_ctr_now", kid);

      // SERP features act through two SEPARATE mechanisms by design: serpPenalty
      // inside HAR's pBeat suppresses rank ATTAINMENT (feature-heavy SERPs are
      // more entrenched); this SVM suppresses CLICK YIELD at a given rank. There
      // is no arithmetic double-count within a single term, but the combined
      // suppression on feature-heavy keywords is intentionally strong and is
      // scheduled for review against calibration data at Gate B (Prompt 2.5).
      // Do not remove either mechanism without that evidence.
      const svmRes = resolveSerpVisibilityV2({
        projectId,
        keywordId: kid,
        device: kw.device,
        intent: kw.search_intent,
        features: featuresByKw.get(kid) ?? [],
        adjustments,
      });
      if (svmRes.featureCount === 0) bump(warnings, "missing_svm", kid);
      else if (svmRes.unmatchedFeatureTypes.length > 0) {
        bump(
          warnings,
          "svm_unmatched_features",
          `${kid}: ${svmRes.unmatchedFeatureTypes.join(",")}`,
        );
      }

      let scenariosForKw = 0;
      for (const s of scenarios) {
        // Per-scenario dedupe set — ensures each (scenario, code) pair is
        // counted at most once even when index.ts and computeRevenueV2 both
        // want to emit the same code.
        const seen = new Set<string>();

        const ctrTpRes = ctrResolver.resolve({
          device: kw.device,
          intent: kw.search_intent,
          position: s.har_position,
        });
        if (ctrTpRes.tier === "none") bumpOnce(warnings, seen, "missing_ctr_tp", kid);
        if (s.har_confidence == null) bumpOnce(warnings, seen, "missing_har_confidence", kid);
        if (s.rank_attainment_probability == null) bumpOnce(warnings, seen, "missing_rank_prob", kid);

        const trendSig = trendByKw.get(kid) ?? null;
        const result = computeRevenueV2({
          scenario: s.scenario as any,
          volume_annual: va.volume_annual,
          ctr_now: ctrNowRes.tier === "none" ? null : ctrNowRes.ctr,
          ctr_tp: ctrTpRes.tier === "none" ? null : ctrTpRes.ctr,
          svm: svmRes.multiplier,
          cvr: conv.cvr.value,
          aov: conv.aov.value,
          pos_now: kw.base_rank,
          pos_tp: s.har_position,
          rank_attainment_probability: s.rank_attainment_probability,
          har_confidence: s.har_confidence,
          monthly_volumes: monthly,
          trend_pct: trendSig?.trend_pct ?? null,
          trend_confidence: trendSig?.trend_confidence ?? null,
        });

        for (const w of result.warnings) bumpOnce(warnings, seen, w, kid);

        // Accumulate per-scenario totals for summary_json.totals.
        const bucket = totalsAcc[s.scenario as string];
        if (bucket) {
          const tpAbs = Number(result.tp_absolute_revenue_annual) || 0;
          bucket.current_revenue_annual += Number(result.current_revenue_annual) || 0;
          bucket.tp_absolute_revenue_annual += tpAbs;
          bucket.tp_incremental_revenue_annual += Number(result.tp_incremental_revenue_annual) || 0;
          bucket.expected_incremental_revenue_annual += Number(result.expected_incremental_revenue_annual) || 0;
          if (tpAbs > 0) bucket.keywords_with_tp += 1;
          // Identity honesty: rows with tp_abs present but tp_incremental
          // absent (typically not_ranking + missing_ctr_now cohort) contribute
          // to Σtp_abs − Σtp_inc without any offset from current_revenue.
          // Surfacing this makes the identity check verifiable from summary_json alone:
          //   Σtp_abs − Σtp_inc − tp_abs_without_incremental.sum ≤ current_revenue
          if (
            result.tp_absolute_revenue_annual != null &&
            result.tp_incremental_revenue_annual == null
          ) {
            bucket.tp_abs_without_incremental_count += 1;
            bucket.tp_abs_without_incremental_sum += tpAbs;
          }
        }




        const merged = {
          ...(s.explanation_json ?? {}),
          revenue_v2: {
            model_version: REVENUE_V2_MODEL_VERSION,
            calc_run_id: calcRunId,
            cvr: {
              value: conv.cvr.value,
              source: conv.cvr.source,
              override_id: conv.cvr.override_id,
              confidence: conv.cvr.confidence,
            },
            aov: {
              value: conv.aov.value,
              source: conv.aov.source,
              override_id: conv.aov.override_id,
              confidence: conv.aov.confidence,
            },
            ctr: {
              now: result.ctr_now,
              tp: result.ctr_tp,
              resolver_tier_now: ctrNowRes.tier,
              resolver_tier_tp: ctrTpRes.tier,
            },
            svm: {
              value: svmRes.multiplier,
              multiplier: result.svm_used,
              matched: svmRes.matched.map((m) => ({
                feature: m.featureType,
                multiplier: m.multiplier,
                tier: m.tier,
              })),
              confidence: svmRes.confidence,
              dataQualityWarning: svmRes.dataQualityWarning,
              source: svmRes.featureCount === 0 ? "no_features_default_1" : "serp_features_v2",
            },
            volume: {
              // legacy alias — kept so existing admin cards / verification
              // queries that read `annual` don't break at Gate B pre-work.
              annual: va.volume_annual,
              base_annual: va.volume_annual,
              source: va.source,
              months_used: va.months_used,
              trend_pct: trendSig?.trend_pct ?? null,
              trend_confidence: trendSig?.trend_confidence ?? null,
              factor_applied: result.factor_applied,
              forward_annual: result.volume_forward,
            },
            confidence_weighting: {
              p_att: result.p_att_used,
              har_conf: result.har_conf_used,
              band_method: result.band_method,
            },
            warnings: result.warnings,
          },
        };

        updatesBuffer.push({
          id: s.id,
          current_revenue_annual: result.current_revenue_annual,
          tp_absolute_revenue_annual: result.tp_absolute_revenue_annual,
          tp_incremental_revenue_annual: result.tp_incremental_revenue_annual,
          expected_incremental_revenue_annual: result.expected_incremental_revenue_annual,
          expected_incremental_low_annual: result.expected_incremental_low_annual,
          expected_incremental_high_annual: result.expected_incremental_high_annual,
          monthly_revenue_json: result.monthly_revenue_json,
          explanation_json: merged,
          calculated_at: new Date().toISOString(),
        });
        scenariosForKw += 1;
        if (updatesBuffer.length >= UPDATE_CHUNK) await flush();
      }
      if (scenariosForKw > 0) keywordsCovered += 1;
    }
    await flush();

    const totals = {
      by_scenario: Object.fromEntries(
        Object.entries(totalsAcc).map(([k, v]) => [k, {
          current_revenue_annual: Math.round(v.current_revenue_annual),
          tp_absolute_revenue_annual: Math.round(v.tp_absolute_revenue_annual),
          tp_incremental_revenue_annual: Math.round(v.tp_incremental_revenue_annual),
          expected_incremental_revenue_annual: Math.round(v.expected_incremental_revenue_annual),
          keywords_with_tp: v.keywords_with_tp,
          tp_abs_without_incremental: {
            count: v.tp_abs_without_incremental_count,
            sum_annual: Math.round(v.tp_abs_without_incremental_sum),
          },
        }]),
      ),
    };


    const summary = {
      model_version: REVENUE_V2_MODEL_VERSION,
      har_calc_run_id: harCalcRunId,
      har_model_version: harModelVersion,

      scenarios_updated: scenariosUpdated,
      keywords_covered: keywordsCovered,
      keywords_total: keywordIds.length,
      warnings_count: Array.from(warnings.values()).reduce((s, v) => s + v.count, 0),
      errors_count: dbErrors.length,
      project_cvr_decimal: projectCvrDecimal,
      project_aov: projectAov,
      totals,
      rows_fetched: rowsFetched,
      note:
        "Expected incremental is confidence-weighted and typically lower than theoretical TP incremental.",
    };


    let status: CalcRunTerminalStatus = CALC_RUN_SUCCESS_STATUS;
    if (dbErrors.length && scenariosUpdated === 0) status = CALC_RUN_FAILED_STATUS;
    else if (dbErrors.length || warnings.size > 0) status = CALC_RUN_PARTIAL_STATUS;

    await closeRun(status, summary);
    console.log(
      "[compute-forecasts-v2] project=%s kw=%d scenarios_updated=%d warnings=%d",
      projectId, keywordIds.length, scenariosUpdated, summary.warnings_count,
    );
    return json(200, { calc_run_id: calcRunId, summary });
  } catch (e) {
    const se = serializeErr(e);
    console.error("[compute-forecasts-v2] unhandled", JSON.stringify(se), e);
    dbErrors.push({ code: se.code ?? "unhandled", message: se.message, details: se.details, hint: se.hint });
    await closeRun(CALC_RUN_FAILED_STATUS, {
      model_version: REVENUE_V2_MODEL_VERSION,
      har_calc_run_id: harCalcRunId,
      har_model_version: harModelVersion,
      error: se,
    });
    return err(500, se.code ?? "unhandled", se.message, { calc_run_id: calcRunId });
  }
});

```

---

## supabase/functions/demand-signals-compute/index.ts

### `supabase/functions/demand-signals-compute/index.ts`

```ts
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

```

---

## supabase/functions/link-power-score-compute/index.ts

### `supabase/functions/link-power-score-compute/index.ts`

```ts
// link-power-score-compute
// Phase 8 · Prompt 8.1 — Link Power Score v2 shadow compute.
// Admin-only. Manual invocation. Reads stored serp_results +
// client_domain_metrics. Writes rows to link_power_scores tagged with a
// calc_run_registry id (model_version = lps_v2.0.0). No external API calls,
// no changes to v1 HAR / forecasts / revenue.
//
// Contract:
//   POST /functions/v1/link-power-score-compute
//   Body: { project_id: uuid, dry_run?: boolean, limit_keywords?: number }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  CALC_RUN_FAILED_STATUS,
  CALC_RUN_SUCCESS_STATUS,
  type CalcRunTerminalStatus,
} from "../_shared/calc-run-registry.ts";
import {
  buildContextDivisors,
  computeLpsForRow,
  LPS_MODEL_VERSION,
  normUrl,
  scoreDistribution,
  type ClientDomainRef,
  type SerpRowMetrics,
} from "../_shared/link-power-score.ts";
import { selectIn } from "../_shared/pgrst-in.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_LIMIT = 5000;
const KW_ID_CHUNK = 100;
const INSERT_CHUNK = 500;

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
function normDomain(d: string | null | undefined): string | null {
  if (!d) return null;
  const s = String(d).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  return s || null;
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
  const isAdmin = (roles ?? []).some((r: { role: string }) => r.role === "admin" || r.role === "super_admin");
  if (!isAdmin) return err(403, "forbidden_admin_only", "Admin role required.");

  // ---- Project visibility ----
  const { data: proj, error: projErr } = await sb
    .from("navigator_projects")
    .select("id, client_id, archived_at")
    .eq("id", projectId)
    .maybeSingle();
  if (projErr) return err(500, "db_error", projErr.message);
  if (!proj) return err(403, "forbidden_project", "Project not visible.");
  if ((proj as { archived_at?: string | null }).archived_at) {
    return err(409, "project_archived", "Cannot compute LPS for an archived project.");
  }

  const clientId = (proj as { client_id?: string | null }).client_id ?? null;

  // ---- Client domain reference ----
  let clientDomain: string | null = null;
  let clientRef: ClientDomainRef | null = null;
  if (clientId) {
    const { data: clientRow, error: cErr } = await sb
      .from("clients")
      .select("domain_normalized, domain")
      .eq("id", clientId)
      .maybeSingle();
    if (cErr) return err(500, "db_error", cErr.message);
    clientDomain = normDomain(
      (clientRow as { domain_normalized?: string | null; domain?: string | null } | null)?.domain_normalized
      ?? (clientRow as { domain?: string | null } | null)?.domain
      ?? null,
    );
  }
  if (clientDomain) {
    const { data: cdmRows, error: cdmErr } = await sb
      .from("client_domain_metrics")
      .select("domain, url_rating, domain_rating, ahrefs_rank, fetched_at")
      .eq("project_id", projectId)
      .eq("domain", clientDomain)
      .order("fetched_at", { ascending: false, nullsFirst: false })
      .limit(1);
    if (cdmErr) return err(500, "db_error", cdmErr.message);
    const row = (cdmRows ?? [])[0] as ClientDomainRef | undefined;
    if (row) clientRef = { ...row, domain: normDomain(row.domain) };
  }

  // ---- Duplicate-run guard: block if another LPS run is still `running`
  // for this project within the last 15 minutes. Older running rows are
  // treated as stale and ignored (they can be reaped separately).
  const staleCutoffIso = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data: inflight, error: inflightErr } = await sb
    .from("calc_run_registry")
    .select("id, started_at")
    .eq("project_id", projectId)
    .eq("model_version", LPS_MODEL_VERSION)
    .eq("status", "running")
    .is("finished_at", null)
    .gte("started_at", staleCutoffIso)
    .order("started_at", { ascending: false })
    .limit(1);
  if (inflightErr) return err(500, "db_error", inflightErr.message);
  if (inflight && inflight.length > 0) {
    const existing = inflight[0] as { id: string; started_at: string };
    return err(409, "lps_run_in_progress", "Another LPS run is already in progress.", {
      calc_run_id: existing.id,
      started_at: existing.started_at,
    });
  }

  // ---- Open calc_run_registry ----
  const scope: Record<string, unknown> = {
    kind: "link_power_score_v2",
    limit_keywords: limitKeywords,
    dry_run: dryRun,
    client_domain: clientDomain,
  };
  const { data: runIns, error: runErr } = await sb
    .from("calc_run_registry")
    .insert({
      project_id: projectId,
      triggered_by: userId,
      trigger_source: "admin_manual",
      model_version: LPS_MODEL_VERSION,
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
    if (closeErr) throw new Error(`calc_run_close_failed: ${closeErr.message}`);
  };

  try {
    // ---- Kept keywords (always capped at MAX_LIMIT even without caller limit) ----
    const effectiveLimit = limitKeywords ?? MAX_LIMIT;
    const { data: kwRows, error: kwErr } = await sb
      .from("keywords")
      .select("id")
      .eq("project_id", projectId)
      .eq("detox_status", "keep")
      .order("created_at", { ascending: true })
      .limit(effectiveLimit + 1);
    if (kwErr) throw kwErr;
    const allIds = (kwRows ?? []).map((k) => String((k as { id: string }).id));
    const capApplied = allIds.length > effectiveLimit;
    const keywordIds = capApplied ? allIds.slice(0, effectiveLimit) : allIds;
    const runWarnings: unknown[] = [];
    if (capApplied) {
      runWarnings.push({
        code: "keyword_cap_applied",
        cap: effectiveLimit,
        total_kept_seen: allIds.length,
        message: `Kept-keyword count exceeded ${effectiveLimit}; only the first ${effectiveLimit} were scored.`,
      });
    }

    if (keywordIds.length === 0) {
      const summary = {
        model_version: LPS_MODEL_VERSION,
        keywords_seen: 0, serp_rows_seen: 0, rows_written: 0,
        rows_fetched: { keywords: 0, serp_results: 0 },
        skipped_reason: "no_kept_keywords",
        client_reference_authority: clientRef,
        dry_run: dryRun,
      };
      await closeRun(CALC_RUN_SUCCESS_STATUS, summary, runWarnings, []);
      return json(200, { calc_run_id: calcRunId, summary });
    }

    // ---- Load SERP results (chunked .in()) ----
    type Serp = SerpRowMetrics & {
      id: string;
      url: string | null;
      domain: string | null;
      rank_absolute: number | null;
    };
    const allSerp: Serp[] = [];
    // Truncation-remediation 2026-07-18: was a chunked loop with bare `.in()`,
    // which caps at PostgREST's 1,000-row default per chunk. Route through
    // selectIn({ paginate: true }) so each 100-id chunk pages fully.
    {
      const sRows = await selectIn<Record<string, unknown>>(
        sb,
        "serp_results",
        "id, keyword_id, rank_absolute, url, domain, url_rating, domain_rating, referring_domains, backlinks",
        "keyword_id",
        keywordIds,
        { paginate: true },
      );
      for (const rr of sRows) {
        allSerp.push({
          id: String(rr.id),
          keyword_id: String(rr.keyword_id),
          rank_absolute: rr.rank_absolute == null ? null : Number(rr.rank_absolute),
          url: (rr.url as string | null) ?? null,
          domain: (rr.domain as string | null) ?? null,
          url_rating: rr.url_rating == null ? null : Number(rr.url_rating),
          domain_rating: rr.domain_rating == null ? null : Number(rr.domain_rating),
          referring_domains: rr.referring_domains == null ? null : Number(rr.referring_domains),
          backlinks: rr.backlinks == null ? null : Number(rr.backlinks),
        });
      }
    }

    if (allSerp.length === 0) {
      const summary = {
        model_version: LPS_MODEL_VERSION,
        keywords_seen: keywordIds.length,
        serp_rows_seen: 0,
        rows_written: 0,
        rows_fetched: { keywords: keywordIds.length, serp_results: 0 },
        skipped_reason: "no_serp_data",
        client_reference_authority: clientRef,
        dry_run: dryRun,
      };
      runWarnings.push({ code: "no_serp_data", count: 1 });
      await closeRun(CALC_RUN_SUCCESS_STATUS, summary, runWarnings, []);
      return json(200, { calc_run_id: calcRunId, summary });
    }

    // ---- Compute + insert in streamed batches ----
    const ctx = buildContextDivisors(allSerp);
    const nowIso = new Date().toISOString();
    const confidenceDist = { high: 0, medium: 0, low: 0 };
    const missingCounts: Record<string, number> = { ur: 0, dr: 0, rd: 0, bl: 0 };
    const scores: number[] = [];
    let rowsWritten = 0;
    let rowsFailed = 0;
    let rowsSkippedInvalidUrl = 0;
    const invalidUrlSamples: Array<{ serp_result_id: string; url: string | null }> = [];
    const dbErrors: unknown[] = [];

    for (const batch of chunk(allSerp, INSERT_CHUNK)) {
      const outRows: Array<Record<string, unknown>> = [];
      for (const s of batch) {
        // Prefer the row's stored domain, but fall back to URL-derived host so
        // rows with a URL but no domain aren't downgraded to missing.
        const normalized = normUrl(s.url);
        if (!normalized) {
          rowsSkippedInvalidUrl += 1;
          if (invalidUrlSamples.length < 10) {
            invalidUrlSamples.push({ serp_result_id: s.id, url: s.url });
          }
          continue;
        }
        const rowDomain = normDomain(s.domain) ?? normalized.domain;
        const useClientRef =
          clientRef && clientDomain && rowDomain && rowDomain === clientDomain
            ? clientRef
            : null;
        const res = computeLpsForRow(s, ctx, {
          clientDomain: useClientRef ? clientDomain : null,
          clientRef: useClientRef,
        });
        confidenceDist[res.confidence] += 1;
        for (const m of res.missing) missingCounts[m] += 1;
        scores.push(res.lps_score);
        outRows.push({
          project_id: projectId,
          calc_run_id: calcRunId,
          serp_result_id: s.id,
          keyword_id: s.keyword_id,
          url: normalized.url,
          domain: rowDomain,
          rank_absolute: s.rank_absolute,
          lps_score: res.lps_score,
          confidence: res.confidence,
          components_json: {
            model_version: LPS_MODEL_VERSION,
            weights: { ur: 0.35, dr: 0.30, rd: 0.20, bl: 0.15 },
            components: res.components,
            missing: res.missing,
            imputations: res.imputations,
            reason: res.reason ?? null,
            context: {
              rd_divisor_source: res.components.rd.divisor_source ?? null,
              bl_divisor_source: res.components.bl.divisor_source ?? null,
              project_rd_p95: ctx.projectRd,
              project_bl_p95: ctx.projectBl,
            },
          },
          created_at: nowIso,
        });
      }

      if (!outRows.length) continue;
      if (dryRun) {
        rowsWritten += outRows.length;
        continue;
      }
      const { error: insErr } = await sb.from("link_power_scores").insert(outRows);
      if (insErr) {
        dbErrors.push({ code: "insert_failed", message: insErr.message, chunk_size: outRows.length });
        rowsFailed += outRows.length;
        continue;
      }
      rowsWritten += outRows.length;
      console.log(
        "[link-power-score-compute] chunk_persisted project=%s rows=%d cumulative=%d",
        projectId, outRows.length, rowsWritten,
      );
    }

    if (rowsSkippedInvalidUrl > 0) {
      runWarnings.push({
        code: "rows_skipped_invalid_url",
        count: rowsSkippedInvalidUrl,
        samples: invalidUrlSamples,
        message: `${rowsSkippedInvalidUrl} SERP rows had missing/invalid URLs and were skipped.`,
      });
    }

    const summary = {
      model_version: LPS_MODEL_VERSION,
      keywords_seen: keywordIds.length,
      serp_rows_seen: allSerp.length,
      rows_written: rowsWritten,
      rows_failed: rowsFailed,
      rows_skipped_invalid_url: rowsSkippedInvalidUrl,
      rows_fetched: {
        keywords: keywordIds.length,
        serp_results: allSerp.length,
      },
      confidence_distribution: confidenceDist,
      score_distribution: scoreDistribution(scores),
      missing_component_counts: missingCounts,
      client_reference_authority: clientRef,
      dry_run: dryRun,
    };

    const runStatus =
      !dryRun && rowsFailed > 0 && rowsWritten === 0
        ? CALC_RUN_FAILED_STATUS
        : CALC_RUN_SUCCESS_STATUS;
    await closeRun(runStatus, summary, runWarnings, dbErrors);

    console.log(
      "[link-power-score-compute] project=%s kw=%d serp=%d rows=%d dry=%s",
      projectId, keywordIds.length, allSerp.length, rowsWritten, String(dryRun),
    );

    return json(200, { calc_run_id: calcRunId, summary, dry_run: dryRun });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      await closeRun(CALC_RUN_FAILED_STATUS, { error: msg, dry_run: dryRun }, [], [{ code: "unhandled", message: msg }]);
    } catch (closeErr) {
      console.error("[link-power-score-compute] close-on-error failed", closeErr);
    }
    return err(500, "unhandled", msg);
  }
});

```

---

## supabase/functions/gsc-workbook-import/index.ts

### `supabase/functions/gsc-workbook-import/index.ts`

```ts
// gsc-workbook-import
// Parses a standard Google Search Console Excel export (.xlsx) and
// persists it as a single gsc_uploads row (source='gsc_workbook_v1')
// plus one gsc_upload_keywords row per Queries entry, and optional
// gsc_upload_pages rows if a Pages sheet is present.
//
// v1.1 (Prompt 2.1):
//   - Optional per-row Device column on Queries/Pages sheets.
//     When present, per-row device is captured and gsc_uploads.device
//     is set to "mixed"; when absent, upload-level device stays "all".
//   - Real-world numeric parsing: quoted thousands separators, "34.5%"
//     CTR, comma decimals ("3,7" → 3.7).
//   - Additive: legacy workbooks without a Device column import
//     byte-identically to v1.
//
// No CTR curve logic, no CSV upload changes. Downstream consumers
// (ctr-curves-from-gsc, resolvers) do not read per-row device yet.
// Auth: caller's Authorization header is used so RLS enforces project access.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import * as XLSX from "https://esm.sh/xlsx@0.18.5?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CHUNK_SIZE = 500;
// Span bounds — reject outside, warn softly inside SHORT_WINDOW_DAYS.
const MIN_SPAN_DAYS = 28;
const MAX_SPAN_DAYS = 550;
const SHORT_WINDOW_DAYS = 90;

type Warning = string;

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, code: string, error: string) {
  return jsonResponse(status, { code, error });
}

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^,]+,/, "").replace(/\s+/g, "");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function normalizeHeader(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

function findColumnIndex(headers: string[], candidates: string[]): number {
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (candidates.some((c) => h.includes(c))) return i;
  }
  return -1;
}

function sheetToRows(ws: XLSX.WorkSheet): unknown[][] {
  return XLSX.utils.sheet_to_json(ws, {
    header: 1,
    blankrows: false,
    defval: null,
    raw: true,
  }) as unknown[][];
}

function findHeaderRow(
  rows: unknown[][],
  required: string[][],
): { headerRowIndex: number; headers: string[] } | null {
  for (let r = 0; r < Math.min(rows.length, 25); r++) {
    const headers = rows[r].map(normalizeHeader);
    const allMatched = required.every((cands) =>
      headers.some((h) => cands.some((c) => h.includes(c))),
    );
    if (allMatched) return { headerRowIndex: r, headers };
  }
  return null;
}

function coerceDate(v: unknown): Date | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === "number") {
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }
  const s = String(v).trim();
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---- Numeric parsing (v1.1) ---------------------------------------------
//
// Tolerates real-world Excel/CSV formatting:
//   "2,074"      → 2074       (thousands separator, group of 3)
//   "1,234,567"  → 1234567
//   "12,5"       → 12.5       (locale decimal comma; trailing 1–2 digit group)
//   "3,7"        → 3.7
//   "34.5"       → 34.5
//
// Rules:
//   1. Strip percent sign and surrounding whitespace.
//   2. If a "." exists, treat "," as thousands separator (strip all).
//   3. Else, if a "," is followed by 1–2 digits at end of string, treat as
//      decimal separator; every other "," is a thousands separator.
export function parseNumber(v: unknown): number {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  let s = String(v).trim();
  if (!s) return 0;
  s = s.replace(/%/g, "").trim();
  if (s.includes(".")) {
    s = s.replace(/,/g, "");
  } else if (s.includes(",")) {
    // Trailing comma-group of 1–2 digits → decimal comma.
    if (/,\d{1,2}$/.test(s) && !/,\d{3}$/.test(s)) {
      const idx = s.lastIndexOf(",");
      const intPart = s.slice(0, idx).replace(/,/g, "");
      const decPart = s.slice(idx + 1);
      s = `${intPart}.${decPart}`;
    } else {
      s = s.replace(/,/g, "");
    }
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

export function parseInteger(v: unknown): number {
  return Math.round(parseNumber(v));
}

// Accepts "34.5%", "0.345", 34.5, 0.345, "34,5%". Clamps to [0, 1].
export function parseCtr(v: unknown): number {
  if (v == null || v === "") return 0;
  const hadPercent = typeof v === "string" && v.trim().endsWith("%");
  const n = parseNumber(v);
  if (!Number.isFinite(n) || n <= 0) return Math.max(0, n || 0);
  const decimal = hadPercent || n > 1 ? n / 100 : n;
  if (decimal < 0) return 0;
  if (decimal > 1) return 1;
  return decimal;
}

// Normalise device strings. Tablet is folded into desktop as standard
// practice for GSC modelling (small share, similar SERP behaviour).
export function normaliseDevice(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim().toUpperCase();
  if (!s) return null;
  if (s === "DESKTOP") return "desktop";
  if (s === "MOBILE") return "mobile";
  if (s === "TABLET") return "desktop";
  return null;
}

// ---- Sheet extractors ---------------------------------------------------

function extractChartDates(
  ws: XLSX.WorkSheet,
): { start: string; end: string; count: number } | { error: string; code: string } {
  const rows = sheetToRows(ws);
  const header = findHeaderRow(rows, [["date"]]);
  if (!header) return { code: "chart_date_column_missing", error: "Chart sheet has no Date column." };

  const dateIdx = header.headers.findIndex((h) => h.includes("date"));
  const dates: Date[] = [];
  for (let r = header.headerRowIndex + 1; r < rows.length; r++) {
    const cell = rows[r][dateIdx];
    const d = coerceDate(cell);
    if (d) dates.push(d);
  }
  if (!dates.length) {
    return { code: "chart_date_column_missing", error: "Chart sheet Date column has no valid dates." };
  }

  const min = new Date(Math.min(...dates.map((d) => d.getTime())));
  const max = new Date(Math.max(...dates.map((d) => d.getTime())));
  const spanDays = Math.round((max.getTime() - min.getTime()) / 86400000) + 1;

  if (spanDays < MIN_SPAN_DAYS || spanDays > MAX_SPAN_DAYS) {
    return {
      code: "date_range_out_of_bounds",
      error:
        `Workbook date range is ${spanDays} days. Standard GSC exports cover ` +
        `${MIN_SPAN_DAYS}–${MAX_SPAN_DAYS} days. A future UI phase will let you enter dates manually.`,
    };
  }

  return { start: toISODate(min), end: toISODate(max), count: dates.length };
}

export interface QueryRow {
  keyword: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  device: string | null;
}

export function extractQueries(
  ws: XLSX.WorkSheet,
): { rows: QueryRow[]; hasDeviceColumn: boolean } | { error: string; code: string } {
  const rows = sheetToRows(ws);
  const header = findHeaderRow(rows, [
    ["top queries", "query", "keyword"],
    ["position"],
  ]);
  if (!header) {
    return {
      code: "queries_columns_missing",
      error: "Queries sheet must have a Query/Top queries column and a Position column.",
    };
  }

  const kwIdx = findColumnIndex(header.headers, ["top queries", "query", "keyword"]);
  const clicksIdx = findColumnIndex(header.headers, ["clicks"]);
  const imprIdx = findColumnIndex(header.headers, ["impressions"]);
  const ctrIdx = findColumnIndex(header.headers, ["ctr"]);
  const posIdx = findColumnIndex(header.headers, ["position"]);
  const devIdx = findColumnIndex(header.headers, ["device"]);
  const hasDeviceColumn = devIdx >= 0;

  if (kwIdx < 0 || posIdx < 0) {
    return {
      code: "queries_columns_missing",
      error: "Queries sheet is missing required columns (keyword / position).",
    };
  }

  const out: QueryRow[] = [];
  for (let r = header.headerRowIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    const kw = String(row[kwIdx] ?? "").trim();
    if (!kw) continue;
    const position = parseNumber(row[posIdx]);
    if (!(position > 0)) continue;
    out.push({
      keyword: kw,
      clicks: clicksIdx >= 0 ? parseInteger(row[clicksIdx]) : 0,
      impressions: imprIdx >= 0 ? parseInteger(row[imprIdx]) : 0,
      ctr: ctrIdx >= 0 ? parseCtr(row[ctrIdx]) : 0,
      position,
      device: hasDeviceColumn ? normaliseDevice(row[devIdx]) : null,
    });
  }

  return { rows: out, hasDeviceColumn };
}

export interface PageRow {
  page_url: string;
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  position: number | null;
  device: string | null;
}

export function extractPages(
  ws: XLSX.WorkSheet,
): { rows: PageRow[]; hasDeviceColumn: boolean } | { skipped: string } {
  const rows = sheetToRows(ws);
  const header = findHeaderRow(rows, [["top pages", "page", "url"]]);
  if (!header) return { skipped: "no recognisable Page column" };

  const urlIdx = findColumnIndex(header.headers, ["top pages", "page", "url"]);
  const clicksIdx = findColumnIndex(header.headers, ["clicks"]);
  const imprIdx = findColumnIndex(header.headers, ["impressions"]);
  const ctrIdx = findColumnIndex(header.headers, ["ctr"]);
  const posIdx = findColumnIndex(header.headers, ["position"]);
  const devIdx = findColumnIndex(header.headers, ["device"]);
  const hasDeviceColumn = devIdx >= 0;

  const out: PageRow[] = [];
  for (let r = header.headerRowIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    const url = String(row[urlIdx] ?? "").trim();
    if (!url) continue;
    out.push({
      page_url: url,
      clicks: clicksIdx >= 0 ? parseInteger(row[clicksIdx]) : null,
      impressions: imprIdx >= 0 ? parseInteger(row[imprIdx]) : null,
      ctr: ctrIdx >= 0 ? parseCtr(row[ctrIdx]) : null,
      position: posIdx >= 0 ? parseNumber(row[posIdx]) : null,
      device: hasDeviceColumn ? normaliseDevice(row[devIdx]) : null,
    });
  }
  return { rows: out, hasDeviceColumn };
}

// ---- CSV parsing --------------------------------------------------------
//
// Tolerant CSV row splitter that respects double-quoted fields (so a value
// like `"2,074"` isn't split on its embedded comma). GSC exports quote any
// value containing a comma or newline; we accept both the quoted and the
// unquoted forms here.
export function parseCsvRows(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") {
      row.push(field);
      if (row.some((v) => v !== "")) out.push(row);
      row = []; field = "";
      continue;
    }
    field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    if (row.some((v) => v !== "")) out.push(row);
  }
  return out;
}

export function extractQueriesFromCsv(
  text: string,
): { rows: QueryRow[]; hasDeviceColumn: boolean } | { error: string; code: string } {
  const grid = parseCsvRows(text);
  if (!grid.length) {
    return { code: "queries_columns_missing", error: "CSV is empty." };
  }
  const header = grid[0].map((v) => String(v ?? "").trim().toLowerCase());
  const kwIdx = findColumnIndex(header, ["top queries", "query", "keyword"]);
  const clicksIdx = findColumnIndex(header, ["clicks"]);
  const imprIdx = findColumnIndex(header, ["impressions"]);
  const ctrIdx = findColumnIndex(header, ["ctr"]);
  const posIdx = findColumnIndex(header, ["position"]);
  const devIdx = findColumnIndex(header, ["device"]);
  const hasDeviceColumn = devIdx >= 0;
  if (kwIdx < 0 || posIdx < 0) {
    return {
      code: "queries_columns_missing",
      error: "CSV must include Query/Top queries and Position columns.",
    };
  }
  const out: QueryRow[] = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    const kw = String(row[kwIdx] ?? "").trim();
    if (!kw) continue;
    const position = parseNumber(row[posIdx]);
    if (!(position > 0)) continue;
    // NB: NO dedupe on keyword — a query legitimately appears once per device.
    out.push({
      keyword: kw,
      clicks: clicksIdx >= 0 ? parseInteger(row[clicksIdx]) : 0,
      impressions: imprIdx >= 0 ? parseInteger(row[imprIdx]) : 0,
      ctr: ctrIdx >= 0 ? parseCtr(row[ctrIdx]) : 0,
      position,
      device: hasDeviceColumn ? normaliseDevice(row[devIdx]) : null,
    });
  }
  return { rows: out, hasDeviceColumn };
}

function isoDateOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return toISODate(d);
}

// ---- Handler ------------------------------------------------------------


serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse(405, "method_not_allowed", "POST only.");

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return errorResponse(500, "misconfigured", "Missing Supabase env vars.");
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return errorResponse(401, "unauthorized", "Missing Authorization header.");

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  let payload: {
    project_id?: string;
    format?: "xlsx_base64" | "csv_text";
    file_base64?: string;
    csv_text?: string;
    filename?: string;
    date_range_start?: string;
    date_range_end?: string;
    device?: string;
  };
  try {
    payload = await req.json();
  } catch {
    return errorResponse(400, "invalid_payload", "Body must be JSON.");
  }
  const projectId = payload?.project_id;
  if (!projectId || typeof projectId !== "string") {
    return errorResponse(400, "invalid_payload", "project_id is required.");
  }
  // Format resolution: explicit `format`, else infer from which body is set.
  const format: "xlsx_base64" | "csv_text" =
    payload.format ??
    (payload.csv_text ? "csv_text" : payload.file_base64 ? "xlsx_base64" : "xlsx_base64");

  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) {
    return errorResponse(401, "unauthorized", "Invalid or expired token.");
  }

  const { data: proj, error: projErr } = await supabase
    .from("navigator_projects")
    .select("id")
    .eq("id", projectId)
    .maybeSingle();
  if (projErr) return errorResponse(500, "db_error", projErr.message);
  if (!proj) return errorResponse(403, "forbidden_project", "Project not visible.");

  const warnings: Warning[] = [];
  let queryRows: QueryRow[] = [];
  let pageRows: PageRow[] = [];
  let pagesHasDevice = false;
  let queriesHasDevice = false;
  let dateStart: string;
  let dateEnd: string;
  let source: "gsc_workbook_v1" | "gsc_csv_v2";
  let sheetsSeen: string[] = [];

  if (format === "csv_text") {
    source = "gsc_csv_v2";
    if (!payload.csv_text || typeof payload.csv_text !== "string") {
      return errorResponse(400, "invalid_payload", "csv_text is required for format=csv_text.");
    }
    const start = isoDateOrNull(payload.date_range_start);
    const end = isoDateOrNull(payload.date_range_end);
    if (!start || !end) {
      return errorResponse(
        400,
        "missing_date_range",
        "date_range_start and date_range_end are required for CSV uploads.",
      );
    }
    if (new Date(end).getTime() < new Date(start).getTime()) {
      return errorResponse(400, "missing_date_range", "date_range_end must be on or after date_range_start.");
    }
    dateStart = start;
    dateEnd = end;

    const csvResult = extractQueriesFromCsv(payload.csv_text);
    if ("error" in csvResult) return errorResponse(400, csvResult.code, csvResult.error);
    queryRows = csvResult.rows;
    queriesHasDevice = csvResult.hasDeviceColumn;
    if (!queryRows.length) {
      return errorResponse(400, "queries_columns_missing", "CSV has no valid keyword rows.");
    }
  } else {
    source = "gsc_workbook_v1";
    const fileB64 = payload.file_base64;
    if (!fileB64 || typeof fileB64 !== "string") {
      return errorResponse(400, "invalid_payload", "file_base64 is required for format=xlsx_base64.");
    }

    let workbook: XLSX.WorkBook;
    try {
      const bytes = base64ToBytes(fileB64);
      workbook = XLSX.read(bytes, { type: "array", cellDates: true });
    } catch (e) {
      return errorResponse(400, "invalid_workbook", `Could not parse xlsx: ${(e as Error).message}`);
    }
    const sheetsByLower = new Map<string, string>();
    for (const name of workbook.SheetNames) sheetsByLower.set(name.toLowerCase(), name);
    sheetsSeen = workbook.SheetNames;
    const chartName = sheetsByLower.get("chart");
    const queriesName = sheetsByLower.get("queries");
    const pagesName = sheetsByLower.get("pages");
    const devicesName = sheetsByLower.get("devices");
    if (!chartName) return errorResponse(400, "chart_sheet_missing", "Workbook has no Chart sheet.");
    if (!queriesName) return errorResponse(400, "queries_sheet_missing", "Workbook has no Queries sheet.");

    const chartResult = extractChartDates(workbook.Sheets[chartName]);
    if ("error" in chartResult) return errorResponse(400, chartResult.code, chartResult.error);
    dateStart = chartResult.start;
    dateEnd = chartResult.end;

    const queriesResult = extractQueries(workbook.Sheets[queriesName]);
    if ("error" in queriesResult) return errorResponse(400, queriesResult.code, queriesResult.error);
    queryRows = queriesResult.rows;
    queriesHasDevice = queriesResult.hasDeviceColumn;
    if (!queryRows.length) {
      return errorResponse(400, "queries_columns_missing", "Queries sheet has no valid keyword rows.");
    }
    if (pagesName) {
      const pagesResult = extractPages(workbook.Sheets[pagesName]);
      if ("rows" in pagesResult) {
        pageRows = pagesResult.rows;
        pagesHasDevice = pagesResult.hasDeviceColumn;
      } else {
        warnings.push(`Pages sheet skipped: ${pagesResult.skipped}.`);
      }
    }
    if (devicesName) warnings.push("Devices sheet ignored in v1.");
  }

  // Span guard applied to BOTH paths.
  const spanDays = Math.round(
    (new Date(dateEnd).getTime() - new Date(dateStart).getTime()) / 86400000,
  ) + 1;
  if (spanDays < MIN_SPAN_DAYS || spanDays > MAX_SPAN_DAYS) {
    return errorResponse(
      400,
      "date_range_out_of_bounds",
      `Date range is ${spanDays} days. Accepted: ${MIN_SPAN_DAYS}–${MAX_SPAN_DAYS} days.`,
    );
  }
  if (spanDays < SHORT_WINDOW_DAYS) {
    warnings.push(`short window (${spanDays} days) — calibration will be noisier.`);
  }

  const perRowDevice = queriesHasDevice || pagesHasDevice;
  let uploadDevice: string;
  if (perRowDevice) {
    uploadDevice = "mixed";
    warnings.push('Per-row Device column detected — upload marked "mixed".');
  } else {
    const callerDev = normaliseDevice(payload.device) ??
      (payload.device && String(payload.device).trim().toLowerCase() === "all" ? "all" : null);
    if (!callerDev) {
      return errorResponse(
        400,
        "invalid_payload",
        "device is required when the file has no per-row Device column (all | mobile | desktop).",
      );
    }
    uploadDevice = callerDev;
  }

  const { data: uploadData, error: uploadErr } = await supabase
    .from("gsc_uploads")
    .insert({
      project_id: projectId,
      device: uploadDevice,
      source,
      date_range_start: dateStart,
      date_range_end: dateEnd,
      row_count: queryRows.length,
    })
    .select("id")
    .single();
  if (uploadErr || !uploadData) {
    return errorResponse(500, "db_error", uploadErr?.message ?? "Failed to insert gsc_uploads.");
  }
  const uploadId = (uploadData as { id: string }).id;

  for (let i = 0; i < queryRows.length; i += CHUNK_SIZE) {
    const chunk = queryRows.slice(i, i + CHUNK_SIZE).map((r) => ({
      upload_id: uploadId,
      keyword: r.keyword,
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr,
      position: r.position,
      device: r.device,
    }));
    const { error: kwErr } = await supabase.from("gsc_upload_keywords").insert(chunk);
    if (kwErr) {
      await supabase.from("gsc_uploads").delete().eq("id", uploadId);
      return errorResponse(500, "db_error", `Keyword insert failed: ${kwErr.message}`);
    }
  }

  let pagesInserted = 0;
  if (pageRows.length) {
    for (let i = 0; i < pageRows.length; i += CHUNK_SIZE) {
      const chunk = pageRows.slice(i, i + CHUNK_SIZE).map((r) => ({
        upload_id: uploadId,
        ...r,
      }));
      const { error: pgErr } = await supabase.from("gsc_upload_pages").insert(chunk);
      if (pgErr) {
        warnings.push(`Pages insert stopped after ${pagesInserted} rows: ${pgErr.message}`);
        break;
      }
      pagesInserted += chunk.length;
    }
  }

  return jsonResponse(200, {
    upload_id: uploadId,
    date_range_start: dateStart,
    date_range_end: dateEnd,
    row_count: queryRows.length,
    pages_inserted: pagesInserted,
    sheets_seen: sheetsSeen,
    upload_device: uploadDevice,
    source,
    warnings,
  });
});

```

---

## supabase/functions/brand-classification/index.ts

### `supabase/functions/brand-classification/index.ts`

```ts
// Brand classification — rule pass + Claude adjudication for uncertain rows.
//
// Modes:
//   - { project_id, mode:"start"  }  -> create brand_classification_jobs row, kick worker, return 202 { job_id }
//   - { project_id, mode:"status" }  -> return latest job row + aggregate counts
//
// Writes ONLY is_branded / brand_confidence on keywords and gsc_upload_keywords.
// Idempotent: re-running overwrites those two columns and nothing else.
//
// Classification basis: DISTINCT normalised keyword (lower/trim). A query that
// appears on multiple device rows is classified once and the verdict is fanned
// out to every row (keywords + gsc_upload_keywords) sharing that normalised
// string. `total_keywords` / `processed_keywords` on the job row count DISTINCT
// queries; `branded_count` / `non_branded_count` count ROWS updated across
// both tables.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { classifyKeyword, deriveBrandTokens } from "../_shared/brand-classifier.ts";
import { fetchAllRows, selectIn } from "../_shared/pgrst-in.ts";
import { reserveOTPM } from "../_shared/ai-rate-window.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SONNET_MODEL = "claude-sonnet-4-6";
const UNCERTAIN_BATCH = 40;
const WORKER_BUDGET_MS = 110_000;

interface StartBody { project_id: string; mode?: "start" | "status" }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normQ(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().trim();
}

async function requireAdmin(sb: any): Promise<boolean> {
  const { data: user } = await sb.auth.getUser();
  if (!user?.user?.id) return false;
  const uid = user.user.id;
  const { data } = await sb.rpc("has_role", { _user_id: uid, _role: "admin" });
  if (data === true) return true;
  const { data: sr } = await sb.rpc("has_role", { _user_id: uid, _role: "super_admin" });
  return sr === true;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);

    const supabaseCaller = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    if (!(await requireAdmin(supabaseCaller))) return json({ error: "Forbidden" }, 403);

    const body = (await req.json()) as StartBody;
    if (!body?.project_id) return json({ error: "project_id required" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    if (body.mode === "status") {
      const { data: job } = await supabase.from("brand_classification_jobs")
        .select("*").eq("project_id", body.project_id)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      const counts = await countBranded(supabase, body.project_id);
      return json({ job, counts });
    }

    // Reuse an in-flight job if fresh.
    const { data: existing } = await supabase.from("brand_classification_jobs")
      .select("*").eq("project_id", body.project_id)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (existing && (existing.status === "queued" || existing.status === "running")
      && existing.heartbeat_at && Date.now() - new Date(existing.heartbeat_at).getTime() < 60_000) {
      return json({ job_id: existing.id, reused: true }, 202);
    }

    const { data: created, error: createErr } = await supabase.from("brand_classification_jobs")
      .insert({ project_id: body.project_id, status: "queued" })
      .select("id").single();
    if (createErr) return json({ error: createErr.message }, 500);

    // deno-lint-ignore no-explicit-any
    const rt = (globalThis as any).EdgeRuntime;
    if (rt?.waitUntil) rt.waitUntil(runWorker(created.id));
    else runWorker(created.id).catch((e) => console.error("worker crash", e));

    return json({ job_id: created.id }, 202);
  } catch (e) {
    console.error("brand-classification error", e);
    return json({ error: (e as Error).message }, 500);
  }
});

async function countBranded(sb: any, projectId: string) {
  // Row-level coverage across BOTH tables so the admin card can show
  // "rows flagged branded / total rows" alongside the distinct-query counters.
  const { data: uploads } = await sb.from("gsc_uploads").select("id").eq("project_id", projectId);
  const uploadIds = (uploads ?? []).map((u: any) => u.id);

  const [kb, kn, ku, kt] = await Promise.all([
    sb.from("keywords").select("id", { count: "exact", head: true }).eq("project_id", projectId).eq("is_branded", true),
    sb.from("keywords").select("id", { count: "exact", head: true }).eq("project_id", projectId).eq("is_branded", false),
    sb.from("keywords").select("id", { count: "exact", head: true }).eq("project_id", projectId).is("is_branded", null),
    sb.from("keywords").select("id", { count: "exact", head: true }).eq("project_id", projectId),
  ]);

  let gb = 0, gn = 0, gu = 0, gt = 0;
  if (uploadIds.length > 0) {
    const [b, n, u, t] = await Promise.all([
      sb.from("gsc_upload_keywords").select("id", { count: "exact", head: true }).in("upload_id", uploadIds).eq("is_branded", true),
      sb.from("gsc_upload_keywords").select("id", { count: "exact", head: true }).in("upload_id", uploadIds).eq("is_branded", false),
      sb.from("gsc_upload_keywords").select("id", { count: "exact", head: true }).in("upload_id", uploadIds).is("is_branded", null),
      sb.from("gsc_upload_keywords").select("id", { count: "exact", head: true }).in("upload_id", uploadIds),
    ]);
    gb = b.count ?? 0; gn = n.count ?? 0; gu = u.count ?? 0; gt = t.count ?? 0;
  }

  return {
    // Legacy shape (keywords table only) — kept for backwards compatibility.
    branded: kb.count ?? 0,
    non_branded: kn.count ?? 0,
    unclassified: ku.count ?? 0,
    // New row-level totals across both surfaces.
    row_totals: {
      keywords: { branded: kb.count ?? 0, non_branded: kn.count ?? 0, unclassified: ku.count ?? 0, total: kt.count ?? 0 },
      gsc: { branded: gb, non_branded: gn, unclassified: gu, total: gt },
      combined: {
        branded: (kb.count ?? 0) + gb,
        non_branded: (kn.count ?? 0) + gn,
        unclassified: (ku.count ?? 0) + gu,
        total: (kt.count ?? 0) + gt,
      },
    },
  };
}

async function heartbeat(sb: any, jobId: string, patch: Record<string, unknown> = {}) {
  await sb.from("brand_classification_jobs").update({ heartbeat_at: new Date().toISOString(), ...patch }).eq("id", jobId);
}

async function runWorker(jobId: string) {
  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const startedAt = Date.now();
  try {
    const { data: job } = await sb.from("brand_classification_jobs").select("*").eq("id", jobId).maybeSingle();
    if (!job) return;
    if (job.status === "complete") return;

    const projectId = job.project_id;
    const { data: project } = await sb.from("navigator_projects")
      .select("client_id, clients(company_name, domain, domain_normalized, brand_terms)")
      .eq("id", projectId).single();
    if (!project) throw new Error("project not found");
    const client = (project as any).clients;

    // Brand vocabulary from keyword_rules — ONLY 'brand' and 'own_brand' types.
    // 'whitelist' is a detox keep-list, not brand vocabulary, and must not contribute
    // (previously caused e.g. "tvs" to be classified as a brand token for AO).
    const { data: rules } = await sb.from("keyword_rules")
      .select("rule_type, keyword_categorisation").eq("client_id", (project as any).client_id);
    const ruleBrandTerms = (rules ?? [])
      .filter((r: any) => r.rule_type === "brand" || r.rule_type === "own_brand")
      .map((r: any) => r.keyword_categorisation)
      .filter(Boolean) as string[];

    // Merge admin-curated explicit brand terms with brand-typed rules.
    // Both are treated as explicit (word-boundary, bypass >=3-char rule) so
    // punctuated terms like "ao.com" survive normalisation intact.
    const explicitTerms = Array.from(new Set([
      ...((client?.brand_terms ?? []) as string[]),
      ...ruleBrandTerms,
    ]));

    const tokens = deriveBrandTokens({
      companyName: client?.company_name ?? null,
      domain: client?.domain ?? null,
      domainNormalised: client?.domain_normalized ?? null,
      explicitTerms,
    });


    // ---- Load rows from both surfaces ----
    // NB: gsc_upload_keywords.keyword is the column name (audited against
    // information_schema — the previous "query" reference was wrong).
    // Both prefetches page past PostgREST's default 1,000-row cap so that
    // large projects (~43k GSC rows for TVs Ongoing / SEO) are covered fully.
    const kwRows = await fetchAllRows<{ id: string; keyword: string | null }>(
      sb, "keywords", "id, keyword", (q) => q.eq("project_id", projectId),
    );

    const { data: uploads } = await sb.from("gsc_uploads").select("id").eq("project_id", projectId);
    const uploadIds = (uploads ?? []).map((u: any) => u.id);
    const gscRows = await selectIn<{ id: string; keyword: string | null }>(
      sb, "gsc_upload_keywords", "id, keyword", "upload_id", uploadIds, { paginate: true },
    );

    // ---- Build distinct-query → row-ids index across both tables ----
    const kwIdsByQuery = new Map<string, string[]>();
    const gscIdsByQuery = new Map<string, string[]>();
    for (const r of kwRows ?? []) {
      const q = normQ(r.keyword);
      if (!q) continue;
      const arr = kwIdsByQuery.get(q) ?? [];
      arr.push(r.id);
      kwIdsByQuery.set(q, arr);
    }
    for (const r of gscRows) {
      const q = normQ(r.keyword);
      if (!q) continue;
      const arr = gscIdsByQuery.get(q) ?? [];
      arr.push(r.id);
      gscIdsByQuery.set(q, arr);
    }
    const allQueries = new Set<string>([...kwIdsByQuery.keys(), ...gscIdsByQuery.keys()]);
    const distinctTotal = allQueries.size;

    await sb.from("brand_classification_jobs").update({
      status: "running",
      started_at: job.started_at ?? new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      brand_tokens: tokens as unknown as Record<string, unknown>,
      total_keywords: distinctTotal,
      last_error: null,
    }).eq("id", jobId);

    // ---- Rule pass over distinct queries ----
    const totals = {
      distinctProcessed: 0,
      distinctUncertain: 0,
      distinctUncertainResolved: 0,
      brandedRows: 0,
      nonBrandedRows: 0,
      uncertainResolvedRows: 0,
      aiCalls: 0,
    };
    const uncertainQueries: string[] = [];

    const kwBrand: string[] = [];
    const kwNon: string[] = [];
    const gscBrand: string[] = [];
    const gscNon: string[] = [];

    for (const q of allQueries) {
      const v = classifyKeyword(q, tokens);
      const kwIds = kwIdsByQuery.get(q) ?? [];
      const gscIds = gscIdsByQuery.get(q) ?? [];
      if (v.decision === "branded") {
        kwBrand.push(...kwIds);
        gscBrand.push(...gscIds);
        totals.brandedRows += kwIds.length + gscIds.length;
        totals.distinctProcessed++;
      } else if (v.decision === "non_branded") {
        kwNon.push(...kwIds);
        gscNon.push(...gscIds);
        totals.nonBrandedRows += kwIds.length + gscIds.length;
        totals.distinctProcessed++;
      } else {
        uncertainQueries.push(q);
        totals.distinctUncertain++;
      }
    }

    await bulkUpdateBranded(sb, "keywords", kwBrand, true, 0.95);
    await bulkUpdateBranded(sb, "keywords", kwNon, false, 0.9);
    await bulkUpdateBranded(sb, "gsc_upload_keywords", gscBrand, true, 0.95);
    await bulkUpdateBranded(sb, "gsc_upload_keywords", gscNon, false, 0.9);

    await heartbeat(sb, jobId, {
      total_keywords: distinctTotal,
      processed_keywords: totals.distinctProcessed,
      branded_count: totals.brandedRows,
      non_branded_count: totals.nonBrandedRows,
    });

    // ---- Claude pass over UNCERTAIN distinct queries ----
    const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
    if (ANTHROPIC_API_KEY && uncertainQueries.length > 0) {
      const companyLabel = client?.company_name ?? client?.domain_normalized ?? "the client";

      for (let i = 0; i < uncertainQueries.length; i += UNCERTAIN_BATCH) {
        if (Date.now() - startedAt > WORKER_BUDGET_MS) break;
        const batch = uncertainQueries.slice(i, i + UNCERTAIN_BATCH);
        const tokensNeeded = batch.length * 30 + 200;

        for (let attempt = 0; attempt < 6; attempt++) {
          const r = await reserveOTPM(sb, SONNET_MODEL, tokensNeeded);
          if (r.reserved) break;
          await new Promise((res) => setTimeout(res, r.waitMs));
        }

        const results = await adjudicate(ANTHROPIC_API_KEY, companyLabel, batch);
        totals.aiCalls++;

        const kb: string[] = [], kn2: string[] = [], gb: string[] = [], gn2: string[] = [];
        for (let j = 0; j < batch.length; j++) {
          const r = results[j];
          if (!r) continue;
          const q = batch[j];
          const kwIds = kwIdsByQuery.get(q) ?? [];
          const gscIds = gscIdsByQuery.get(q) ?? [];
          if (r.is_brand) {
            kb.push(...kwIds); gb.push(...gscIds);
            totals.brandedRows += kwIds.length + gscIds.length;
          } else {
            kn2.push(...kwIds); gn2.push(...gscIds);
            totals.nonBrandedRows += kwIds.length + gscIds.length;
          }
          totals.uncertainResolvedRows += kwIds.length + gscIds.length;
          totals.distinctUncertainResolved++;
          totals.distinctProcessed++;
        }
        await bulkUpdateBranded(sb, "keywords", kb, true, 0.85);
        await bulkUpdateBranded(sb, "keywords", kn2, false, 0.85);
        await bulkUpdateBranded(sb, "gsc_upload_keywords", gb, true, 0.85);
        await bulkUpdateBranded(sb, "gsc_upload_keywords", gn2, false, 0.85);

        await heartbeat(sb, jobId, {
          processed_keywords: totals.distinctProcessed,
          branded_count: totals.brandedRows,
          non_branded_count: totals.nonBrandedRows,
          uncertain_resolved_count: totals.uncertainResolvedRows,
          ai_calls: totals.aiCalls,
        });
      }
    }

    await sb.from("brand_classification_jobs").update({
      status: "complete",
      finished_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      processed_keywords: totals.distinctProcessed,
      total_keywords: distinctTotal,
      branded_count: totals.brandedRows,
      non_branded_count: totals.nonBrandedRows,
      uncertain_resolved_count: totals.uncertainResolvedRows,
      ai_calls: totals.aiCalls,
    }).eq("id", jobId);
  } catch (e) {
    console.error("brand-classification worker error", e);
    await sb.from("brand_classification_jobs").update({
      status: "error",
      last_error: (e as Error).message?.slice(0, 500) ?? "unknown",
      finished_at: new Date().toISOString(),
    }).eq("id", jobId);
  }
}

async function bulkUpdateBranded(sb: any, table: string, ids: string[], is: boolean, confidence: number) {
  if (ids.length === 0) return;
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const { error } = await sb.from(table)
      .update({ is_branded: is, brand_confidence: confidence })
      .in("id", slice);
    if (error) throw error;
  }
}

async function adjudicate(apiKey: string, company: string, keywords: string[]): Promise<{ is_brand: boolean; confidence: number }[]> {
  const prompt = `Company: "${company}".
For each query below, decide if it is a BRAND/NAVIGATIONAL query for THIS company (searching for the brand itself, its site, its login, etc.).
Return strict JSON array in the same order: [{"is_brand": true|false, "confidence": 0..1}, ...]. No prose.

Queries:
${keywords.map((k, i) => `${i + 1}. ${k}`).join("\n")}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: SONNET_MODEL,
      max_tokens: Math.max(400, keywords.length * 30),
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Claude ${res.status}: ${t.slice(0, 200)}`);
  }
  const body = await res.json();
  const text = body?.content?.[0]?.text ?? "";
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return keywords.map(() => ({ is_brand: false, confidence: 0.5 }));
  try {
    const arr = JSON.parse(match[0]);
    return arr.map((r: any) => ({
      is_brand: r?.is_brand === true,
      confidence: typeof r?.confidence === "number" ? r.confidence : 0.7,
    }));
  } catch {
    return keywords.map(() => ({ is_brand: false, confidence: 0.5 }));
  }
}

```

---

## supabase/functions/keyword-enrichment/index.ts

### `supabase/functions/keyword-enrichment/index.ts`

```ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const DATAFORSEO_BASE = "https://api.dataforseo.com";
const BOOT_TS = new Date().toISOString();
console.log(`[keyword-enrichment] BOOT cluster-capture=1 at ${BOOT_TS}`);

// Slice size per invocation. Keeps CPU under the 2s limit even with
// hundreds of monthly-volume rows to write.
const SLICE_SIZE = 200;
// Concurrency for parallel single-row updates.
const WRITE_CONCURRENCY = 20;
// How long enrichment data is considered fresh before we refetch from DFS.
const FRESHNESS_DAYS_DEFAULT = 7;

function sanitizeForDfs(raw: string): string {
  if (!raw) return "";
  return raw
    .toLowerCase()
    .replace(/[?!()\[\]{}<>|\\\/,";:=+*&^%$#@~`']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildBasicAuth(secret: string): string {
  if (secret.includes(":")) return btoa(secret);
  return secret;
}

function extractItems(json: any, endpoint: string): { items: any[]; failed: boolean; errorMsg?: string } {
  const tasks = json?.tasks;
  if (!Array.isArray(tasks) || !tasks.length) {
    const msg = json?.status_message || "no tasks in response";
    return { items: [], failed: true, errorMsg: String(msg) };
  }
  const task = tasks[0];
  if (task.status_code !== 20000) {
    return { items: [], failed: true, errorMsg: `${task.status_code} ${task.status_message}` };
  }
  const result = task.result;
  if (!Array.isArray(result) || !result.length) return { items: [], failed: false };
  if (result[0]?.items && Array.isArray(result[0].items)) return { items: result[0].items, failed: false };
  return { items: result, failed: false };
}

function parseIntent(item: any): string | null {
  const validIntents = ["transactional", "commercial", "informational", "navigational"];
  let raw = item?.keyword_intent ?? item?.intent;
  if (!raw) return null;
  let label: string | undefined;
  if (Array.isArray(raw)) label = raw[0]?.label;
  else if (typeof raw === "object") label = raw.label;
  else if (typeof raw === "string") label = raw;
  const normalized = label?.toLowerCase()?.trim();
  return normalized && validIntents.includes(normalized) ? normalized : null;
}

// Run promise-returning tasks with bounded concurrency.
async function pAll<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results: T[] = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
    }
  });
  await Promise.all(workers);
  return results;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const DATAFORSEO_API_KEY = Deno.env.get("DATAFORSEO_API_KEY");
    if (!DATAFORSEO_API_KEY) throw new Error("DATAFORSEO_API_KEY not configured");
    const dfBasicAuth = buildBasicAuth(DATAFORSEO_API_KEY);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing authorization header");

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const body = await req.json().catch(() => ({}));
    const project_id: string | undefined = body?.project_id;
    const mode: "enrich" | "peaks" = body?.mode === "peaks" ? "peaks" : "enrich";
    const offset: number = Math.max(0, Number(body?.offset) || 0);
    const forceRefresh: boolean = !!body?.forceRefresh;
    const stalenessDays: number = Math.max(1, Number(body?.stalenessDays) || FRESHNESS_DAYS_DEFAULT);
    const stalenessCutoff = new Date(Date.now() - stalenessDays * 86400 * 1000).toISOString();
    if (!project_id) throw new Error("project_id is required");

    const dfHeaders = {
      Authorization: `Basic ${dfBasicAuth}`,
      "Content-Type": "application/json",
    };

    // ───────────────────── PEAKS MODE ─────────────────────
    // Computes peak_month for a slice of kept keyword IDs. Client loops with
    // increasing offset until done=true.
    if (mode === "peaks") {
      const { data: kwSlice, error: kwErr } = await supabase
        .from("keywords")
        .select("id")
        .eq("project_id", project_id)
        .eq("detox_status", "keep")
        .order("id", { ascending: true })
        .range(offset, offset + SLICE_SIZE - 1);
      if (kwErr) throw new Error(`Fetch keywords for peaks: ${kwErr.message}`);
      if (!kwSlice?.length) {
        return new Response(JSON.stringify({ done: true, peak_updated: 0, next_offset: offset }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const ids = kwSlice.map((r) => r.id);
      const { data: monthly } = await supabase
        .from("keyword_monthly_volumes")
        .select("keyword_id, month, volume")
        .in("keyword_id", ids);

      const byKw = new Map<string, { month: number; volume: number }[]>();
      for (const row of monthly ?? []) {
        const m = parseInt(String(row.month).slice(5, 7), 10);
        if (!Number.isFinite(m)) continue;
        const arr = byKw.get(row.keyword_id) ?? [];
        arr.push({ month: m, volume: row.volume ?? 0 });
        byKw.set(row.keyword_id, arr);
      }

      const updates: { id: string; peak_month: string | null }[] = [];
      for (const [kwId, rows] of byKw) {
        if (rows.length < 6) continue;
        const total = rows.reduce((s, r) => s + r.volume, 0);
        const avg = total / rows.length;
        if (avg < 50) continue;
        const peak = rows.reduce((p, r) => (r.volume > p.volume ? r : p), rows[0]);
        const peakMonth = peak.volume >= avg * 1.4 ? String(peak.month).padStart(2, "0") : null;
        if (peakMonth) updates.push({ id: kwId, peak_month: peakMonth });
      }

      await pAll(
        updates.map((u) => () => supabase.from("keywords").update({ peak_month: u.peak_month }).eq("id", u.id).then(() => null)),
        WRITE_CONCURRENCY,
      );

      return new Response(
        JSON.stringify({
          done: kwSlice.length < SLICE_SIZE,
          peak_updated: updates.length,
          next_offset: offset + kwSlice.length,
          processed: kwSlice.length,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ───────────────────── ENRICH MODE ─────────────────────
    // Pull only kept keywords missing or stale on at least one dimension.
    const baseSelect = "id, keyword, search_intent, intent_source, avg_monthly_volume, keyword_difficulty, volume_fetched_at, difficulty_fetched_at, intent_fetched_at";
    let sliceQuery = supabase
      .from("keywords")
      .select(baseSelect)
      .eq("project_id", project_id)
      .eq("detox_status", "keep")
      .order("id", { ascending: true });

    if (!forceRefresh) {
      sliceQuery = sliceQuery.or(
        [
          "avg_monthly_volume.is.null",
          `volume_fetched_at.lt.${stalenessCutoff}`,
          "keyword_difficulty.is.null",
          `difficulty_fetched_at.lt.${stalenessCutoff}`,
          "search_intent.is.null",
          `intent_fetched_at.lt.${stalenessCutoff}`,
        ].join(","),
      );
    }

    const { data: slice, error: sliceErr } = await sliceQuery.range(offset, offset + SLICE_SIZE - 1);
    if (sliceErr) throw new Error(`Fetch keywords: ${sliceErr.message}`);

    if (!slice?.length) {
      return new Response(
        JSON.stringify({
          done: true,
          enriched: 0,
          volume_updated: 0,
          difficulty_updated: 0,
          intent_overridden: 0,
          intent_retained: 0,
          from_cache: 0,
          next_offset: offset,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Cross-keyword cache: reuse another project's recent enrichment of the
    // same sanitized keyword text instead of paying DataForSEO again.
    const sanitizedByKwId = new Map<string, string>();
    for (const kw of slice) {
      const cleaned = sanitizeForDfs(kw.keyword);
      if (cleaned) sanitizedByKwId.set(kw.id, cleaned);
    }
    const sanitizedList = Array.from(new Set(sanitizedByKwId.values()));
    let fromCache = 0;
    const cacheResolvedIds = new Set<string>();

    if (!forceRefresh && sanitizedList.length > 0) {
      const { data: cacheRows } = await supabase
        .from("keywords")
        .select("keyword, avg_monthly_volume, keyword_difficulty, search_intent, intent_source, intent_confidence, competition, volume_fetched_at, difficulty_fetched_at, intent_fetched_at")
        .in("keyword", sanitizedList)
        .neq("project_id", project_id)
        .or(`volume_fetched_at.gte.${stalenessCutoff},difficulty_fetched_at.gte.${stalenessCutoff}`);

      const cacheBy = new Map<string, any>();
      for (const r of cacheRows ?? []) {
        const key = sanitizeForDfs((r as any).keyword);
        if (!cacheBy.has(key)) cacheBy.set(key, r);
      }

      const nowIso = new Date().toISOString();
      const cacheUpdateTasks: (() => Promise<unknown>)[] = [];
      for (const kw of slice as any[]) {
        const c = cacheBy.get(sanitizedByKwId.get(kw.id) ?? "");
        if (!c) continue;
        const fields: Record<string, any> = {};
        if (kw.avg_monthly_volume == null && c.avg_monthly_volume != null) {
          fields.avg_monthly_volume = c.avg_monthly_volume;
          fields.volume_fetched_at = nowIso;
          fields.enrichment_source = "cache";
        }
        if (kw.keyword_difficulty == null && c.keyword_difficulty != null) {
          fields.keyword_difficulty = c.keyword_difficulty;
          fields.difficulty_fetched_at = nowIso;
          fields.enrichment_source = "cache";
        }
        if (kw.search_intent == null && c.search_intent && c.intent_source === "dataforseo") {
          fields.search_intent = c.search_intent;
          fields.intent_source = "dataforseo";
          fields.intent_confidence = c.intent_confidence ?? "high";
          fields.intent_fetched_at = nowIso;
        }
        if (c.competition != null) fields.competition = c.competition;
        if (Object.keys(fields).length) {
          cacheUpdateTasks.push(() => supabase.from("keywords").update(fields).eq("id", kw.id).then(() => null));
          fromCache++;
          cacheResolvedIds.add(kw.id);
        }
      }
      await pAll(cacheUpdateTasks, WRITE_CONCURRENCY);
    }

    const remainingSlice = slice.filter((k: any) => !cacheResolvedIds.has(k.id));
    const kwToId = new Map<string, { id: string }>();
    for (const kw of remainingSlice) {
      const cleaned = sanitizeForDfs(kw.keyword);
      if (cleaned && !kwToId.has(cleaned)) kwToId.set(cleaned, { id: kw.id });
    }
    const keywordTexts = [...kwToId.keys()];
    const errors: string[] = [];

    if (keywordTexts.length === 0) {
      return new Response(
        JSON.stringify({
          done: slice.length < SLICE_SIZE,
          next_offset: offset + slice.length,
          processed: slice.length,
          enriched: slice.length,
          volume_updated: 0,
          difficulty_updated: 0,
          intent_overridden: 0,
          intent_retained: 0,
          from_cache: fromCache,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Single big call per endpoint; SLICE_SIZE (200) is well within DFS limits.
    const [volRes, diffRes, intentRes] = await Promise.all([
      fetch(`${DATAFORSEO_BASE}/v3/keywords_data/google_ads/search_volume/live`, {
        method: "POST",
        headers: dfHeaders,
        body: JSON.stringify([{ keywords: keywordTexts, location_code: 2826, language_code: "en" }]),
      }),
      fetch(`${DATAFORSEO_BASE}/v3/dataforseo_labs/google/bulk_keyword_difficulty/live`, {
        method: "POST",
        headers: dfHeaders,
        body: JSON.stringify([{ keywords: keywordTexts, location_code: 2826, language_code: "en" }]),
      }),
      fetch(`${DATAFORSEO_BASE}/v3/dataforseo_labs/google/search_intent/live`, {
        method: "POST",
        headers: dfHeaders,
        body: JSON.stringify([{ keywords: keywordTexts, language_code: "en" }]),
      }),
    ]);

    const volItems = volRes.ok ? extractItems(await volRes.json(), "search_volume").items : [];
    const diffItems = diffRes.ok ? extractItems(await diffRes.json(), "bulk_keyword_difficulty").items : [];
    const intentItems = intentRes.ok ? extractItems(await intentRes.json(), "search_intent").items : [];
    if (!volRes.ok) errors.push(`vol HTTP ${volRes.status}`);
    if (!diffRes.ok) errors.push(`diff HTTP ${diffRes.status}`);
    if (!intentRes.ok) errors.push(`intent HTTP ${intentRes.status}`);

    // Merge per-keyword updates into one payload per row to minimise DB writes.
    type Patch = { volume?: number; competition?: number; difficulty?: number; intent?: string | null; monthly?: any[]; coreKeyword?: string | null };
    const patches = new Map<string, Patch>();
    const getPatch = (id: string) => {
      let p = patches.get(id);
      if (!p) { p = {}; patches.set(id, p); }
      return p;
    };

    let volumeUpdated = 0;
    let difficultyUpdated = 0;
    let intentOverridden = 0;
    let intentRetained = 0;

    for (const item of volItems) {
      const meta = kwToId.get(sanitizeForDfs(item?.keyword ?? ""));
      if (!meta) continue;
      const p = getPatch(meta.id);
      if (item.search_volume != null) { p.volume = item.search_volume; volumeUpdated++; }
      if (item.competition != null) p.competition = item.competition;
      if (Array.isArray(item.monthly_searches) && item.monthly_searches.length) p.monthly = item.monthly_searches;
      // Capture DataForSEO close-variant cluster identifier (keyword_properties.core_keyword).
      // Read-only metadata; never used to mutate volume.
      const ck = item?.keyword_properties?.core_keyword;
      if (typeof ck === "string" && ck.trim().length) p.coreKeyword = ck;
    }
    for (const item of diffItems) {
      const meta = kwToId.get(sanitizeForDfs(item?.keyword ?? ""));
      if (!meta) continue;
      if (item.keyword_difficulty != null) {
        getPatch(meta.id).difficulty = Math.round(item.keyword_difficulty);
        difficultyUpdated++;
      }
    }
    for (const item of intentItems) {
      const meta = kwToId.get(sanitizeForDfs(item?.keyword ?? ""));
      if (!meta) continue;
      const dfIntent = parseIntent(item);
      if (dfIntent) { getPatch(meta.id).intent = dfIntent; intentOverridden++; }
      else intentRetained++;
    }

    // Parallel single-row updates (one per keyword instead of 3+).
    // Negative-cache: even when DataForSEO returns no value for a keyword,
    // stamp the relevant *_fetched_at so we don't re-pay for the same lookup
    // every sync. We only stamp dimensions we actually attempted (i.e. the
    // keyword was in this DFS request).
    const nowIso = new Date().toISOString();
    const attemptedIds = new Set<string>();
    for (const meta of kwToId.values()) attemptedIds.add(meta.id);

    const updateTasks: (() => Promise<unknown>)[] = [];
    for (const id of attemptedIds) {
      const p = patches.get(id) ?? {};
      const fields: Record<string, any> = {};
      if (p.volume != null) {
        fields.avg_monthly_volume = p.volume;
        fields.enrichment_source = "dataforseo";
      }
      // Stamp volume_fetched_at whether or not DFS returned a value, but
      // only if the volume endpoint succeeded for the batch.
      if (volRes.ok) fields.volume_fetched_at = nowIso;

      if (p.competition != null) fields.competition = p.competition;
      if (p.difficulty != null) {
        fields.keyword_difficulty = p.difficulty;
        fields.enrichment_source = "dataforseo";
      }
      if (diffRes.ok) fields.difficulty_fetched_at = nowIso;

      if (p.intent) {
        fields.search_intent = p.intent;
        fields.intent_source = "dataforseo";
        fields.intent_confidence = "high";
      }
      if (intentRes.ok) fields.intent_fetched_at = nowIso;

      if (p.coreKeyword) {
        const ck = p.coreKeyword;
        fields.core_keyword = ck;
        fields.keyword_cluster_id = ck.trim().toLowerCase() || null;
        fields.cluster_source = "dfs_core_keyword";
      }

      if (Object.keys(fields).length) {
        updateTasks.push(() => supabase.from("keywords").update(fields).eq("id", id).then(() => null));
      }
    }
    await pAll(updateTasks, WRITE_CONCURRENCY);

    // Monthly volumes: upsert on (keyword_id, month, source) to preserve historical rows
    // from other sources (e.g. future 'dataforseo_historical_backfill'). Only rows written
    // by this standard enrichment path (source = 'dataforseo_search_volume') are refreshed.
    //
    // DO NOT reintroduce `delete().eq("keyword_id", id)` here. Other sources share this
    // table and would be silently wiped. See docs/monthly-volume-preservation-checks.md.
    const monthlyTasks: (() => Promise<unknown>)[] = [];
    for (const [id, p] of patches) {
      if (!p.monthly?.length) continue;

      const monthRows = p.monthly.map((m: any) => ({
        keyword_id: id,
        month: `${m.year}-${String(m.month).padStart(2, "0")}-01`,
        volume: m.search_volume ?? 0,
        source: "dataforseo_search_volume",
        fetched_at: nowIso,
      }));
      monthlyTasks.push(async () => {
        if (monthRows.length) {
          await supabase
            .from("keyword_monthly_volumes")
            .upsert(monthRows, { onConflict: "keyword_id,month,source" });
        }
      });
    }
    await pAll(monthlyTasks, WRITE_CONCURRENCY);


    const done = slice.length < SLICE_SIZE;

    return new Response(
      JSON.stringify({
        done,
        next_offset: offset + slice.length,
        processed: slice.length,
        enriched: slice.length,
        volume_updated: volumeUpdated,
        difficulty_updated: difficultyUpdated,
        intent_overridden: intentOverridden,
        intent_retained: intentRetained,
        from_cache: fromCache,
        ...(errors.length ? { warnings: errors } : {}),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("keyword-enrichment error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

```

---

## supabase/functions/url-monitor-tick/index.ts

### `supabase/functions/url-monitor-tick/index.ts`

```ts
// URL Monitor — periodic checker
// Runs every 15 minutes via pg_cron. Picks active URLs whose next_check_at has passed,
// fetches each (manual redirect tracking), and inserts a snapshot. The DB trigger does the diff/issue work.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_REDIRECTS = 10;
const FETCH_TIMEOUT_MS = 15_000;
const BATCH_LIMIT = 50;
const CONCURRENCY = 5;

interface Snapshot {
  monitored_url_id: string;
  http_status: number | null;
  final_url: string | null;
  redirect_chain: { status: number; url: string }[];
  page_title: string | null;
  canonical_url: string | null;
  response_time_ms: number | null;
  error_message: string | null;
}

function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim().slice(0, 500) : null;
}

function extractCanonical(html: string, baseUrl: string): string | null {
  const m = html.match(/<link[^>]+rel=["']?canonical["']?[^>]*href=["']([^"']+)["']/i)
    || html.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']?canonical["']?/i);
  if (!m) return null;
  try {
    return new URL(m[1], baseUrl).toString();
  } catch {
    return m[1];
  }
}

async function fetchWithRedirects(url: string): Promise<Snapshot> {
  const start = performance.now();
  const chain: { status: number; url: string }[] = [];
  let current = url;
  let lastStatus: number | null = null;
  let finalHtml = "";
  let finalUrl = url;
  let errorMessage: string | null = null;

  try {
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(current, {
          method: "GET",
          redirect: "manual",
          signal: ctrl.signal,
          headers: {
            "User-Agent": "SeerURLMonitor/1.0 (+nobraineragency.com)",
            "Accept": "text/html,*/*;q=0.8",
          },
        });
      } finally {
        clearTimeout(t);
      }

      lastStatus = res.status;
      chain.push({ status: res.status, url: current });

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) break;
        try {
          current = new URL(loc, current).toString();
        } catch {
          errorMessage = `Invalid redirect target: ${loc}`;
          break;
        }
        // Drain body to free connection
        try { await res.body?.cancel(); } catch { /* ignore */ }
        continue;
      }

      finalUrl = current;
      // Read up to ~64KB for title/canonical
      const reader = res.body?.getReader();
      if (reader) {
        const dec = new TextDecoder();
        let total = 0;
        while (total < 65_536) {
          const { done, value } = await reader.read();
          if (done) break;
          finalHtml += dec.decode(value, { stream: true });
          total += value.byteLength;
        }
        try { await reader.cancel(); } catch { /* ignore */ }
      }
      break;
    }
  } catch (e) {
    errorMessage = (e as Error).message || String(e);
  }

  return {
    monitored_url_id: "", // filled by caller
    http_status: lastStatus,
    final_url: errorMessage ? null : finalUrl,
    redirect_chain: chain,
    page_title: finalHtml ? extractTitle(finalHtml) : null,
    canonical_url: finalHtml ? extractCanonical(finalHtml, finalUrl) : null,
    response_time_ms: Math.round(performance.now() - start),
    error_message: errorMessage,
  };
}

function nextCheckAt(frequency: string, dailyTime: string): string {
  const now = new Date();
  if (frequency === "1h") return new Date(now.getTime() + 60 * 60_000).toISOString();
  if (frequency === "6h") return new Date(now.getTime() + 6 * 60 * 60_000).toISOString();
  // 24h — schedule for next dailyTime UK (dailyTime format HH:MM or HH:MM:SS)
  const [hh, mm] = (dailyTime || "07:00").split(":").map((n) => parseInt(n, 10));
  const targetH = Number.isFinite(hh) ? hh : 7;
  const targetM = Number.isFinite(mm) ? mm : 0;

  // Get current UK wall-clock parts
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(now).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== "literal") acc[p.type] = p.value;
    return acc;
  }, {});

  const yyyy = Number(parts.year);
  const mo = Number(parts.month);
  const d = Number(parts.day);
  const ukH = Number(parts.hour === "24" ? "0" : parts.hour);
  const ukM = Number(parts.minute);
  const ukS = Number(parts.second);

  // Wall-clock UK "now" expressed as a UTC instant (so diffs match real time)
  const ukNowUtc = Date.UTC(yyyy, mo - 1, d, ukH, ukM, ukS);
  const offsetMs = now.getTime() - ukNowUtc; // UTC = wallUTC + offsetMs

  // Build today's UK target as a wall-clock UTC instant
  let targetWallUtc = Date.UTC(yyyy, mo - 1, d, targetH, targetM, 0);
  if (targetWallUtc <= ukNowUtc) targetWallUtc += 24 * 60 * 60 * 1000;

  return new Date(targetWallUtc + offsetMs).toISOString();
}

async function runWithConcurrency<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    // Auth gate: outbound fetches + service-role writes. Only accept the
    // service-role bearer or the shared HAR_CRON_SECRET header.
    const authHeader = req.headers.get("Authorization") ?? "";
    const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const cronSecret = req.headers.get("x-cron-secret") ?? "";
    const cronSecretEnv = Deno.env.get("HAR_CRON_SECRET") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const isInternal =
      (bearer.length > 0 && bearer === serviceKey) ||
      (cronSecretEnv.length > 0 && cronSecret === cronSecretEnv);
    if (!isInternal) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      serviceKey,
    );

    // Pull due URLs joined with campaign cadence
    const { data: due, error } = await supabase
      .from("monitored_urls")
      .select("id, url, campaign_id, monitor_campaigns!inner(check_frequency, daily_check_time, status)")
      .lte("next_check_at", new Date().toISOString())
      .eq("is_active", true)
      .limit(BATCH_LIMIT);

    if (error) throw error;

    const items = (due || []).filter((r: any) => r.monitor_campaigns?.status === "active");

    const results = await runWithConcurrency(items, CONCURRENCY, async (row: any) => {
      const snap = await fetchWithRedirects(row.url);
      snap.monitored_url_id = row.id;

      const { error: insErr } = await supabase.from("url_check_snapshots").insert(snap);
      if (insErr) console.error("snapshot insert", row.url, insErr.message);

      const next = nextCheckAt(row.monitor_campaigns.check_frequency, row.monitor_campaigns.daily_check_time);
      await supabase.from("monitored_urls")
        .update({ next_check_at: next })
        .eq("id", row.id);

      return { url: row.url, status: snap.http_status, error: snap.error_message };
    });

    return new Response(JSON.stringify({ checked: results.length, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("url-monitor-tick error", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

```

---

## supabase/functions/gsc-intent-enrichment/index.ts

### `supabase/functions/gsc-intent-enrichment/index.ts`

```ts
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
```

---

