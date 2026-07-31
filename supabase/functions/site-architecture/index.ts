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
