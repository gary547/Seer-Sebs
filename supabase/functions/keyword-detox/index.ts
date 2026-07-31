// Keyword Detox V2 — accuracy-first, two-pass Sonnet, background job.
//
// Modes:
//   - { project_id, keywords[], mode:"insert" }  -> hygiene + insert pending rows. (No processing.)
//   - { project_id, mode:"start" }               -> create detox_jobs row, kick waitUntil worker, return 202 { job_id }.
//   - { job_id, mode:"tick" }                    -> resume worker for stuck/queued job (called by cron or self).
//
// Pipeline (worker):
//   Phase A: sanitize + dedupe (already done at insert time)
//   Phase B: rules pre-pass         -> verdicts
//   Phase C: same-client cache hit  -> verdicts
//   Phase D: Pass 1 Sonnet 4.6      -> { keep | remove | uncertain, confidence }
//   Phase E: Pass 2 Sonnet 4.6      -> adjudicates uncertain + brand-mention keeps + low-conf removes + 2% random audit
//   Phase F: rule-override safety net (rules win over any AI keep)
//   Phase G: bulk DB writes + audit log + cache writes + progress update
//
// Hard rules:
//   - Sonnet 4.6 on both passes.
//   - Single-word stop-word filter is ONLY exact-match articles/conjunctions.
//   - Audits/overrides logged silently to detox_audit; no UI banner.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { sanitizeKeyword } from "../_shared/keyword-hygiene.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
function intEnv(name: string, fallback: number): number {
  const v = parseInt(Deno.env.get(name) ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
const PASS1_BATCH = intEnv("DETOX_PASS1_BATCH", 50);          // keywords per Sonnet call (Pass 1)
const PASS1_CONCURRENCY = intEnv("DETOX_PASS1_CONCURRENCY", 4); // parallel Sonnet calls
const PASS2_BATCH = intEnv("DETOX_PASS2_BATCH", 25);
const PASS2_CONCURRENCY = intEnv("DETOX_PASS2_CONCURRENCY", 3);
const WORKER_BUDGET_MS = intEnv("DETOX_WORKER_BUDGET_MS", 110_000); // < edge limit, leaves room for cleanup
const TICK_FETCH_LIMIT = intEnv("DETOX_TICK_FETCH_LIMIT", 1000);    // pending rows to claim per outer loop iter
const AUDIT_RATE = parseFloat(Deno.env.get("DETOX_AUDIT_RATE") ?? "0.02");

const STOP_WORDS_EXACT = new Set([
  "the","and","or","of","a","an","to","in","on","for","with","at","by","from","is","it",
]);

const SONNET_MODEL = "claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// Hygiene + rules (lifted from V1 with single-word handling tightened)
// ---------------------------------------------------------------------------
// sanitizeKeyword now imported from ../_shared/keyword-hygiene.ts

const PROFANITY = ["fuck","shit","porn","xxx","nude","naked","sex","cunt","wank","tits","boob","dick","cock","pussy","milf"];
const POSTCODE_US = /\b\d{5}(-\d{4})?\b/;
const POSTCODE_UK = /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/i;
const PHONE = /(?:\+?\d[\s().-]*){9,}/;

function tokenize(kw: string): string[] {
  return kw.toLowerCase().split(/\s+/).filter(Boolean);
}
function containsTokenOrPhrase(kw: string, needle: string): boolean {
  const n = needle.toLowerCase().trim();
  if (!n) return false;
  if (n.includes(" ")) return kw.includes(n);
  return new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(kw);
}

type Verdict = { status: "keep" | "removed"; reason: string; ruleName?: string };

function ruleClassify(
  kw: string,
  whitelist: string[],
  blacklist: string[],
  competitorBrands: string[],
): Verdict | null {
  const lower = kw.toLowerCase();
  for (const w of whitelist) {
    if (containsTokenOrPhrase(lower, w)) {
      return { status: "keep", reason: `matched whitelist rule: ${w}`, ruleName: `whitelist:${w}` };
    }
  }
  if (!lower.replace(/[\s\d]/g, "").length) return { status: "removed", reason: "numeric or empty keyword", ruleName: "numeric" };
  if (lower.length <= 1) return { status: "removed", reason: "single character", ruleName: "single_char" };
  if (lower.length > 200) return { status: "removed", reason: "keyword too long", ruleName: "too_long" };
  if (PHONE.test(lower)) return { status: "removed", reason: "phone number", ruleName: "phone" };
  if (POSTCODE_UK.test(lower) || POSTCODE_US.test(lower)) return { status: "removed", reason: "postcode", ruleName: "postcode" };
  if (tokenize(lower).length === 1 && STOP_WORDS_EXACT.has(lower)) {
    return { status: "removed", reason: "stop word only", ruleName: "stop_word" };
  }
  for (const p of PROFANITY) {
    if (containsTokenOrPhrase(lower, p)) return { status: "removed", reason: "profanity / adult", ruleName: "profanity" };
  }
  for (const b of blacklist) {
    if (containsTokenOrPhrase(lower, b)) return { status: "removed", reason: `matched blacklist rule: ${b}`, ruleName: `blacklist:${b}` };
  }
  for (const c of competitorBrands) {
    const c0 = c.toLowerCase().trim();
    if (!c0) continue;
    if (containsTokenOrPhrase(lower, c0)) return { status: "removed", reason: `competitor brand: ${c}`, ruleName: `competitor:${c}` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sonnet call (tool-calling, JSON-safe)
// ---------------------------------------------------------------------------
type Pass1Result = { keyword: string; verdict: "keep" | "remove" | "uncertain"; reason: string; confidence: number };
type Pass2Result = { keyword: string; verdict: "keep" | "remove"; reason: string };

type AiOk<T> = { ok: true; data: T[] };
type AiErr = { ok: false; fatal: boolean; status: number; message: string };
type AiResult<T> = AiOk<T> | AiErr;

/**
 * Detect Anthropic errors that the user can't recover from by retrying:
 * billing (out of credit), bad/missing key, or permission revoked.
 * These must STOP the worker and surface to the UI — we never want to
 * mark keywords as `removed` just because the API is unreachable.
 */
function isFatalAnthropicError(status: number, body: string): boolean {
  if (status === 401 || status === 402 || status === 403) return true;
  const b = (body || "").toLowerCase();
  return (
    b.includes("credit balance") ||
    b.includes("invalid_api_key") ||
    b.includes("authentication_error") ||
    b.includes("permission_error") ||
    b.includes("billing")
  );
}

function extractAnthropicMessage(status: number, body: string): string {
  try {
    const j = JSON.parse(body);
    return j?.error?.message || `Anthropic ${status}`;
  } catch {
    return `Anthropic ${status}`;
  }
}

async function callSonnetPass1(
  apiKey: string,
  systemPrompt: string,
  batch: string[],
): Promise<AiResult<Pass1Result>> {
  const userPrompt = `KEYWORDS:\n${batch.join("\n")}\n\nUse the detox_pass1 tool to return one row per keyword.`;
  const BACKOFFS_MS = [4_000, 12_000, 30_000];
  for (let attempt = 0; attempt < 4; attempt++) {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: SONNET_MODEL,
        max_tokens: Math.min(4000, batch.length * 50 + 200),
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        tools: [{
          name: "detox_pass1",
          description: "Return verdict (keep/remove/uncertain) + confidence 0-1 + short reason for each keyword.",
          input_schema: {
            type: "object",
            properties: {
              results: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    keyword: { type: "string" },
                    verdict: { type: "string", enum: ["keep", "remove", "uncertain"] },
                    reason: { type: "string" },
                    confidence: { type: "number" },
                  },
                  required: ["keyword", "verdict", "reason", "confidence"],
                },
              },
            },
            required: ["results"],
          },
        }],
        tool_choice: { type: "tool", name: "detox_pass1" },
      }),
    });
    if (resp.status === 429 || resp.status === 529) {
      if (attempt === 3) return { ok: false, fatal: false, status: resp.status, message: `rate limited (${resp.status})` };
      const ra = Number(resp.headers.get("retry-after")) || 0;
      await new Promise((r) => setTimeout(r, ra > 0 ? ra * 1000 : BACKOFFS_MS[attempt]));
      continue;
    }
    if (!resp.ok) {
      const t = await resp.text();
      console.error("Sonnet Pass1 error", resp.status, t.slice(0, 300));
      if (isFatalAnthropicError(resp.status, t)) {
        return { ok: false, fatal: true, status: resp.status, message: extractAnthropicMessage(resp.status, t) };
      }
      if (resp.status >= 500 && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      return { ok: false, fatal: false, status: resp.status, message: t.slice(0, 200) };
    }
    const data = await resp.json();
    const tu = (data.content || []).find((p: any) => p?.type === "tool_use" && p?.name === "detox_pass1");
    const raw = tu?.input?.results;
    if (!Array.isArray(raw)) return { ok: false, fatal: false, status: 200, message: "no tool_use in response" };
    return {
      ok: true,
      data: raw
        .filter((r: any) => r && typeof r === "object" && r.keyword)
        .map((r: any) => ({
          keyword: String(r.keyword).toLowerCase().trim(),
          verdict: r.verdict === "remove" ? "remove" : r.verdict === "uncertain" ? "uncertain" : "keep",
          reason: String(r.reason || "").slice(0, 240),
          confidence: typeof r.confidence === "number" ? Math.max(0, Math.min(1, r.confidence)) : 0.5,
        })),
    };
  }
  return { ok: false, fatal: false, status: 0, message: "exhausted retries" };
}

async function callSonnetPass2(
  apiKey: string,
  systemPrompt: string,
  batch: string[],
): Promise<AiResult<Pass2Result>> {
  const userPrompt = `Re-evaluate these keywords carefully. Some were borderline in the first pass.\n\nKEYWORDS:\n${batch.join("\n")}\n\nUse the detox_pass2 tool. Return a final keep or remove for each.`;
  const BACKOFFS_MS = [4_000, 12_000, 30_000];
  for (let attempt = 0; attempt < 4; attempt++) {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: SONNET_MODEL,
        max_tokens: Math.min(3000, batch.length * 60 + 200),
        system: systemPrompt + "\n\nYou are the second-pass adjudicator. Be strict and decisive.",
        messages: [{ role: "user", content: userPrompt }],
        tools: [{
          name: "detox_pass2",
          description: "Final keep/remove verdict for each keyword.",
          input_schema: {
            type: "object",
            properties: {
              results: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    keyword: { type: "string" },
                    verdict: { type: "string", enum: ["keep", "remove"] },
                    reason: { type: "string" },
                  },
                  required: ["keyword", "verdict", "reason"],
                },
              },
            },
            required: ["results"],
          },
        }],
        tool_choice: { type: "tool", name: "detox_pass2" },
      }),
    });
    if (resp.status === 429 || resp.status === 529) {
      if (attempt === 3) return { ok: false, fatal: false, status: resp.status, message: `rate limited (${resp.status})` };
      const ra = Number(resp.headers.get("retry-after")) || 0;
      await new Promise((r) => setTimeout(r, ra > 0 ? ra * 1000 : BACKOFFS_MS[attempt]));
      continue;
    }
    if (!resp.ok) {
      const t = await resp.text();
      console.error("Sonnet Pass2 error", resp.status, t.slice(0, 300));
      if (isFatalAnthropicError(resp.status, t)) {
        return { ok: false, fatal: true, status: resp.status, message: extractAnthropicMessage(resp.status, t) };
      }
      if (resp.status >= 500 && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      return { ok: false, fatal: false, status: resp.status, message: t.slice(0, 200) };
    }
    const data = await resp.json();
    const tu = (data.content || []).find((p: any) => p?.type === "tool_use" && p?.name === "detox_pass2");
    const raw = tu?.input?.results;
    if (!Array.isArray(raw)) return { ok: false, fatal: false, status: 200, message: "no tool_use in response" };
    return {
      ok: true,
      data: raw
        .filter((r: any) => r && typeof r === "object" && r.keyword)
        .map((r: any) => ({
          keyword: String(r.keyword).toLowerCase().trim(),
          verdict: r.verdict === "remove" ? "remove" : "keep",
          reason: String(r.reason || "").slice(0, 240),
        })),
    };
  }
  return { ok: false, fatal: false, status: 0, message: "exhausted retries" };
}

// Pass2Result type declared above with shared AiResult types.

// ---------------------------------------------------------------------------
// Bulk DB write helpers
// ---------------------------------------------------------------------------
async function bulkUpdateByVerdict(
  supabase: any,
  projectId: string,
  verdicts: Map<string, Verdict>,
): Promise<{ kept: number; removed: number }> {
  if (!verdicts.size) return { kept: 0, removed: 0 };
  const groups = new Map<string, { status: "keep" | "removed"; reason: string; keywords: string[] }>();
  for (const [kw, v] of verdicts) {
    const k = `${v.status}::${v.reason}`;
    if (!groups.has(k)) groups.set(k, { status: v.status, reason: v.reason, keywords: [] });
    groups.get(k)!.keywords.push(kw);
  }
  let kept = 0, removed = 0;
  for (const g of groups.values()) {
    const CHUNK = 400;
    for (let i = 0; i < g.keywords.length; i += CHUNK) {
      const slice = g.keywords.slice(i, i + CHUNK);
      const { error } = await supabase
        .from("keywords")
        .update({ detox_status: g.status, detox_reason: g.reason })
        .eq("project_id", projectId)
        .eq("detox_status", "pending")
        .in("keyword", slice);
      if (error) { console.error("Bulk update error:", error.message); continue; }
      if (g.status === "keep") kept += slice.length; else removed += slice.length;
    }
  }
  return { kept, removed };
}

// ---------------------------------------------------------------------------
// Worker — runs inside waitUntil. Uses service-role client.
// ---------------------------------------------------------------------------
async function runWorker(jobId: string) {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
  if (!ANTHROPIC_API_KEY) {
    await supabase.from("detox_jobs").update({ status: "error", last_error: "ANTHROPIC_API_KEY missing", finished_at: new Date().toISOString() }).eq("id", jobId);
    return;
  }

  // Claim: only run if queued OR (running but stale heartbeat > 5min)
  const { data: jobRow } = await supabase.from("detox_jobs").select("*").eq("id", jobId).maybeSingle();
  if (!jobRow) return;
  if (jobRow.status === "done") return;
  if (jobRow.status === "running" && jobRow.heartbeat_at && Date.now() - new Date(jobRow.heartbeat_at).getTime() < 60_000) {
    // Another worker is alive. Bail.
    return;
  }

  const projectId = jobRow.project_id;
  const startedAt = Date.now();

  await supabase.from("detox_jobs").update({
    status: "running",
    started_at: jobRow.started_at ?? new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    last_error: null,
  }).eq("id", jobId);

  // Load project + rules + competitors once
  const { data: project } = await supabase
    .from("navigator_projects")
    .select("client_id, clients(company_name, domain, industry, campaign_type)")
    .eq("id", projectId).single();
  if (!project) {
    await supabase.from("detox_jobs").update({ status: "error", last_error: "project not found", finished_at: new Date().toISOString() }).eq("id", jobId);
    return;
  }
  const client = (project as any).clients;
  const clientId = (project as any).client_id;

  const { data: rules } = await supabase.from("keyword_rules").select("rule_type, keyword_categorisation").eq("client_id", clientId);
  const grouped: Record<string, string[]> = {};
  for (const r of rules || []) {
    if (!grouped[r.rule_type]) grouped[r.rule_type] = [];
    grouped[r.rule_type].push(r.keyword_categorisation);
  }
  const blacklist = grouped["blacklist"] ?? [];
  const whitelist = grouped["whitelist"] ?? [];
  const ownBrand = grouped["brand"] ?? (client?.company_name ? [client.company_name] : []);

  const { data: comps } = await supabase.from("competitors").select("competitor_name").eq("client_id", clientId);
  const competitorBrands = (comps ?? []).map((c: any) => c.competitor_name).filter(Boolean);

  const SYSTEM_PROMPT = `You are an SEO keyword analyst performing keyword detoxification.

CLIENT:
- Name: ${client?.company_name ?? "(unknown)"}
- Domain: ${client?.domain ?? "(unknown)"}
- Industry: ${client?.industry || "not specified"}
- Campaign type: ${client?.campaign_type || "not specified"}
- Own brand tokens: ${ownBrand.join(", ") || "(none)"}
- Competitor brands: ${competitorBrands.join(", ") || "(none)"}

For each keyword decide:
1. KEEP — relevant to the client's services/products and not navigational for a different brand.
2. REMOVE — clearly navigational for a competitor brand, irrelevant, gibberish, spam, off-topic, or off-brand.
3. UNCERTAIN — borderline; another pass with more thought is warranted.

Rules of thumb:
- A competitor mention is fine when the keyword describes a service the client also offers and the competitor is incidental ("tv repair near me" is fine even if "currys" is in the client's competitor list and present in the keyword).
- A competitor mention is NOT fine when the keyword is navigational/branded for that competitor ("currys careers", "argos delivery slots").
- "Confidence" is your subjective certainty 0..1. Use < 0.6 sparingly — only when the keyword is genuinely borderline.
- Reason: a short phrase, max 12 words.`;

  // Outer loop: claim batches of pending rows until none left or budget exhausted.
  let totalKept = 0, totalRemoved = 0, totalProcessed = 0;
  let prevPendingCount = -1;
  let zeroProgressIters = 0;
  while (Date.now() - startedAt < WORKER_BUDGET_MS) {
    // Heartbeat
    await supabase.from("detox_jobs").update({ heartbeat_at: new Date().toISOString() }).eq("id", jobId);

    const { data: pending } = await supabase
      .from("keywords")
      .select("keyword")
      .eq("project_id", projectId)
      .eq("detox_status", "pending")
      .limit(TICK_FETCH_LIMIT);
    const rows = pending ?? [];
    if (!rows.length) break;

    // Canonicalise + map back to originals (multiple raw rows can collapse to
    // a single canonical form, e.g. `agency"` and `agency` both -> `agency`).
    const originalsByCanonical = new Map<string, string[]>();
    const working: string[] = [];
    for (const r of rows) {
      const original = String((r as any).keyword);
      const canonical = sanitizeKeyword(original);
      if (!canonical) {
        // Unparseable / empty after sanitising — mark removed immediately so
        // we don't loop on it forever.
        const arr = originalsByCanonical.get("__empty__") ?? [];
        arr.push(original);
        originalsByCanonical.set("__empty__", arr);
        continue;
      }
      if (!originalsByCanonical.has(canonical)) {
        originalsByCanonical.set(canonical, []);
        working.push(canonical);
      }
      originalsByCanonical.get(canonical)!.push(original);
    }

    const verdicts = new Map<string, Verdict>();
    const undecided: string[] = [];

    // Empty-after-sanitise rows: silent removal
    if (originalsByCanonical.has("__empty__")) {
      verdicts.set("__empty__", { status: "removed", reason: "unparseable / empty after sanitisation", ruleName: "unparseable" });
    }

    // Phase B — rules
    for (const kw of working) {
      const v = ruleClassify(kw, whitelist, blacklist, competitorBrands);
      if (v) verdicts.set(kw, v); else undecided.push(kw);
    }

    // Phase C — same-client cache
    if (undecided.length) {
      const { data: clientProjects } = await supabase
        .from("navigator_projects").select("id").eq("client_id", clientId);
      const projIds = (clientProjects ?? []).map((p: any) => p.id);
      const cache = new Map<string, Verdict>();
      const CHUNK = 400;
      for (let i = 0; i < undecided.length; i += CHUNK) {
        const slice = undecided.slice(i, i + CHUNK);
        const { data: cached } = await supabase
          .from("keywords")
          .select("keyword, detox_status, detox_reason")
          .in("project_id", projIds.length ? projIds : [projectId])
          .in("keyword", slice)
          .in("detox_status", ["keep", "removed"]);
        for (const r of cached ?? []) {
          const k = sanitizeKeyword((r as any).keyword);
          if (!k || cache.has(k)) continue;
          cache.set(k, {
            status: (r as any).detox_status as "keep" | "removed",
            reason: `cached: ${(r as any).detox_reason ?? "prior verdict"}`.slice(0, 240),
          });
        }
      }
      const still: string[] = [];
      for (const kw of undecided) {
        const c = cache.get(kw);
        if (c) verdicts.set(kw, c); else still.push(kw);
      }
      undecided.length = 0;
      undecided.push(...still);
    }

    // Track AI health for this outer iteration. If Anthropic returns a fatal
    // error (no credit, bad key, permission denied), we MUST stop and ask the
    // user — never auto-remove keywords just because the API is unreachable.
    let aiHadOk = false;
    let aiHadNonFatalFailure = false;
    const pass1: Map<string, Pass1Result> = new Map();
    if (undecided.length) {
      const batches: string[][] = [];
      for (let i = 0; i < undecided.length; i += PASS1_BATCH) batches.push(undecided.slice(i, i + PASS1_BATCH));

      for (let i = 0; i < batches.length; i += PASS1_CONCURRENCY) {
        if (Date.now() - startedAt >= WORKER_BUDGET_MS) break;
        const slice = batches.slice(i, i + PASS1_CONCURRENCY);
        const settled = await Promise.all(slice.map((b) => callSonnetPass1(ANTHROPIC_API_KEY, SYSTEM_PROMPT, b)));
        for (let j = 0; j < settled.length; j++) {
          const res = settled[j];
          if (!res.ok) {
            if (res.fatal) {
              await supabase.from("detox_jobs").update({
                status: "blocked",
                block_reason: "ai_unavailable",
                last_error: res.message,
                heartbeat_at: new Date().toISOString(),
              }).eq("id", jobId);
              console.warn("keyword-detox: blocked by fatal Anthropic error:", res.message);
              return;
            }
            aiHadNonFatalFailure = true;
            continue;
          }
          aiHadOk = true;
          const sliceSet = new Set(slice[j]);
          for (const r of res.data) {
            // Canonicalise AI's echoed keyword and match against the canonical
            // batch we sent. Defends against trims/quote stripping by the model.
            const canon = sanitizeKeyword(r.keyword);
            if (canon && sliceSet.has(canon)) {
              pass1.set(canon, { ...r, keyword: canon });
            }
          }
        }
        // Heartbeat between concurrency batches
        await supabase.from("detox_jobs").update({ heartbeat_at: new Date().toISOString() }).eq("id", jobId);
      }
      // Any keyword we sent to Pass 1 that came back unmatched -> default to
      // uncertain so Pass 2 can adjudicate. If Pass 2 also doesn't return,
      // we LEAVE the keyword pending (no silent auto-removal).
      for (const kw of undecided) {
        if (!pass1.has(kw)) {
          pass1.set(kw, { keyword: kw, verdict: "uncertain", reason: "no Pass-1 match — sending to Pass 2", confidence: 0.0 });
        }
      }
    }

    // Phase E — Pass 2 Sonnet selection
    const pass2Set = new Set<string>();
    const auditSampleSet = new Set<string>();
    const brandTokens = [...competitorBrands, ...ownBrand].map((b) => b.toLowerCase().trim()).filter(Boolean);
    for (const [kw, r] of pass1) {
      if (r.verdict === "uncertain") { pass2Set.add(kw); continue; }
      const hasBrand = brandTokens.some((b) => containsTokenOrPhrase(kw, b));
      if (r.verdict === "keep" && hasBrand) { pass2Set.add(kw); continue; }
      if (r.verdict === "remove" && r.confidence < 0.55) { pass2Set.add(kw); continue; }
      // Random audit sample of confident keeps
      if (r.verdict === "keep" && Math.random() < AUDIT_RATE) {
        pass2Set.add(kw); auditSampleSet.add(kw);
      }
    }
    const pass2Final = new Map<string, Pass2Result>();
    if (pass2Set.size) {
      const list = Array.from(pass2Set);
      const batches: string[][] = [];
      for (let i = 0; i < list.length; i += PASS2_BATCH) batches.push(list.slice(i, i + PASS2_BATCH));
      for (let i = 0; i < batches.length; i += PASS2_CONCURRENCY) {
        if (Date.now() - startedAt >= WORKER_BUDGET_MS) break;
        const slice = batches.slice(i, i + PASS2_CONCURRENCY);
        const settled = await Promise.all(slice.map((b) => callSonnetPass2(ANTHROPIC_API_KEY, SYSTEM_PROMPT, b)));
        for (let j = 0; j < settled.length; j++) {
          const res = settled[j];
          if (!res.ok) {
            if (res.fatal) {
              await supabase.from("detox_jobs").update({
                status: "blocked",
                block_reason: "ai_unavailable",
                last_error: res.message,
                heartbeat_at: new Date().toISOString(),
              }).eq("id", jobId);
              console.warn("keyword-detox: blocked by fatal Anthropic error (pass2):", res.message);
              return;
            }
            aiHadNonFatalFailure = true;
            continue;
          }
          aiHadOk = true;
          const sliceSet = new Set(slice[j]);
          for (const r of res.data) {
            const canon = sanitizeKeyword(r.keyword);
            if (canon && sliceSet.has(canon)) {
              pass2Final.set(canon, { ...r, keyword: canon });
            }
          }
        }
        await supabase.from("detox_jobs").update({ heartbeat_at: new Date().toISOString() }).eq("id", jobId);
      }
    }

    // Merge AI verdicts: Pass 2 wins where present, else Pass 1.
    // If Pass 2 didn't return for an `uncertain` Pass-1 keyword, LEAVE IT
    // PENDING — we never auto-remove on API failure. The cron tick will
    // pick it up; persistent unparseable rows are caught by the tripwire
    // below (which only fires when AI calls actually succeeded).
    const auditRows: any[] = [];
    for (const [kw, p1] of pass1) {
      const p2 = pass2Final.get(kw);
      let finalStatus: "keep" | "removed";
      let finalReason: string;
      if (p2) {
        finalStatus = p2.verdict === "remove" ? "removed" : "keep";
        finalReason = `[ai-sonnet-2] ${p2.reason}`.slice(0, 240);
        const p1Status = p1.verdict === "keep" ? "keep" : p1.verdict === "remove" ? "removed" : "uncertain";
        const isAudit = auditSampleSet.has(kw);
        const disagreed = p1Status !== "uncertain" && p1Status !== finalStatus;
        if (disagreed || isAudit) {
          auditRows.push({
            job_id: jobId, project_id: projectId, keyword: kw,
            ai_verdict: p1.verdict, ai_reason: p1.reason,
            pass2_verdict: p2.verdict, pass2_reason: p2.reason,
            final_verdict: finalStatus, audit_sample: isAudit,
          });
        }
      } else {
        if (p1.verdict === "uncertain") {
          // No Pass-2 result — leave pending for the next tick rather than
          // silently removing. If this happens because the API is failing
          // transiently, the cron will retry; if it's a model quirk, the
          // tripwire below will catch persistent no-progress (only when
          // AI actually responded successfully).
          continue;
        }
        finalStatus = p1.verdict === "remove" ? "removed" : "keep";
        finalReason = `[ai-sonnet-1] ${p1.reason}`.slice(0, 240);
      }
      verdicts.set(kw, { status: finalStatus, reason: finalReason });
    }


    // Phase F — rule-override safety net.
    // For every "keep" verdict (whether AI or cache), re-run rules. If a rule
    // says remove, the rule wins. Whitelist rules that come back as keep are noops.
    for (const [kw, v] of verdicts) {
      if (v.status !== "keep") continue;
      const rv = ruleClassify(kw, whitelist, blacklist, competitorBrands);
      if (rv && rv.status === "removed") {
        auditRows.push({
          job_id: jobId, project_id: projectId, keyword: kw,
          ai_verdict: "keep", ai_reason: v.reason,
          pass2_verdict: null, pass2_reason: null,
          rule_name: rv.ruleName ?? null,
          final_verdict: "removed", audit_sample: false,
        });
        verdicts.set(kw, { status: "removed", reason: `rule-override: ${rv.reason}`.slice(0, 240) });
      }
    }

    // Phase G — bulk write. Expand canonical verdicts back to ALL original
    // raw keyword strings that collapsed to that canonical form, so the DB
    // update targets the actual stored rows.
    const writeVerdicts = new Map<string, Verdict>();
    for (const [canon, v] of verdicts) {
      const originals = canon === "__empty__"
        ? (originalsByCanonical.get("__empty__") ?? [])
        : (originalsByCanonical.get(canon) ?? [canon]);
      for (const o of originals) writeVerdicts.set(o, v);
    }
    const { kept, removed } = await bulkUpdateByVerdict(supabase, projectId, writeVerdicts);
    totalKept += kept;
    totalRemoved += removed;
    totalProcessed += writeVerdicts.size;

    if (auditRows.length) {
      try {
        const CHUNK = 400;
        for (let i = 0; i < auditRows.length; i += CHUNK) {
          await supabase.from("detox_audit").insert(auditRows.slice(i, i + CHUNK));
        }
      } catch (e) {
        console.warn("detox_audit insert failed (non-fatal):", (e as Error).message);
      }
    }

    // Update progress
    await supabase.from("detox_jobs").update({
      processed: jobRow.processed + totalProcessed,
      kept: jobRow.kept + totalKept,
      removed: jobRow.removed + totalRemoved,
      heartbeat_at: new Date().toISOString(),
    }).eq("id", jobId);

    // If the AI failed transiently for every batch this iteration, don't
    // count it as "no progress" — break the outer loop so cron retries later.
    if (aiHadNonFatalFailure && !aiHadOk && kept + removed === 0) {
      await supabase.from("detox_jobs").update({
        last_error: "Anthropic transient failure — will retry on next tick",
        heartbeat_at: new Date().toISOString(),
      }).eq("id", jobId);
      break;
    }

    // No-progress tripwire: only fires when AI actually returned parsed
    // responses but the worker still couldn't classify the same rows two
    // iterations running (e.g. rogue characters, unmatched AI echoes).
    // Never fires on API failures — those are handled above.
    if (aiHadOk && kept + removed === 0 && rows.length === prevPendingCount) {
      zeroProgressIters++;
      if (zeroProgressIters >= 2) {
        const stuck = rows.map((r: any) => String(r.keyword));
        const CHUNK = 400;
        for (let i = 0; i < stuck.length; i += CHUNK) {
          await supabase
            .from("keywords")
            .update({ detox_status: "removed", detox_reason: "auto-removed: detox could not classify (rogue characters or unmatched AI response)" })
            .eq("project_id", projectId)
            .eq("detox_status", "pending")
            .in("keyword", stuck.slice(i, i + CHUNK));
        }
        await supabase.from("detox_jobs").update({
          last_error: `Auto-cleared ${stuck.length} stuck keyword(s) after no-progress tripwire`,
        }).eq("id", jobId);
        zeroProgressIters = 0;
      }
    } else {
      zeroProgressIters = 0;
    }
    prevPendingCount = rows.length;
  }


  // Are we done?
  const { count: stillPending } = await supabase
    .from("keywords").select("id", { count: "exact", head: true })
    .eq("project_id", projectId).eq("detox_status", "pending");

  if ((stillPending ?? 0) === 0) {
    await supabase.from("detox_jobs").update({
      status: "done",
      finished_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
    }).eq("id", jobId);
    // Promote project status (legacy parity)
    await supabase.from("navigator_projects").update({ status: "data_collection" }).eq("id", projectId);
  } else {
    // Budget exhausted — leave running, drop heartbeat so cron will pick it up.
    await supabase.from("detox_jobs").update({
      heartbeat_at: new Date(Date.now() - 6 * 60_000).toISOString(),
    }).eq("id", jobId);
    // Self-reinvoke for faster continuation (best-effort).
    try {
      const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/keyword-detox`;
      void fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
        body: JSON.stringify({ mode: "tick", job_id: jobId }),
      }).catch(() => {});
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const authHeader = req.headers.get("Authorization");
    const body = await req.json();
    const { project_id, keywords, mode, job_id } = body as {
      project_id?: string; keywords?: string[]; mode?: "insert" | "start" | "tick" | "skip"; job_id?: string;
    };

    // ---- mode: tick (cron / self-reinvoke) ---------------------------------
    if (mode === "tick") {
      // Gate the paid worker behind service-role bearer or shared cron secret.
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
      if (!job_id) throw new Error("job_id required for tick mode");
      // @ts-ignore Deno EdgeRuntime
      if (typeof EdgeRuntime !== "undefined" && (EdgeRuntime as any).waitUntil) {
        // @ts-ignore
        EdgeRuntime.waitUntil(runWorker(job_id));
      } else {
        runWorker(job_id).catch((e) => console.error("worker error", e));
      }
      return new Response(JSON.stringify({ ok: true, job_id }), { status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (!authHeader) throw new Error("Missing authorization header");
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // ---- mode: skip (user opted to keep every keyword because AI is down) --
    // Promotes every keyword on this project that's currently `pending` or
    // was auto-removed by a previous broken/blocked run back to `keep`, and
    // closes out any open detox_jobs row. Used by the "Skip detox & keep all"
    // dialog the UI shows when Anthropic returns a fatal billing/auth error.
    if (mode === "skip") {
      if (!project_id) throw new Error("project_id required");

      // Promote pending rows
      const { count: pendingPromoted } = await supabase
        .from("keywords")
        .update({ detox_status: "keep", detox_reason: "manually kept — detox skipped by user" }, { count: "exact" })
        .eq("project_id", project_id)
        .eq("detox_status", "pending")
        .select("id", { count: "exact", head: true });

      // Recover keywords that were auto-removed by a previously broken run
      // (no Pass-1 match, no Pass-2, or no-progress tripwire reasons).
      const { count: removedPromoted } = await supabase
        .from("keywords")
        .update({ detox_status: "keep", detox_reason: "manually kept — detox skipped by user" }, { count: "exact" })
        .eq("project_id", project_id)
        .eq("detox_status", "removed")
        .or("detox_reason.ilike.%no Pass-1 match%,detox_reason.ilike.%uncertain, no pass2%,detox_reason.ilike.%auto-removed%,detox_reason.ilike.%detox skipped by user%")
        .select("id", { count: "exact", head: true });

      const kept = (pendingPromoted ?? 0) + (removedPromoted ?? 0);

      // Close out any open job row for this project
      await supabase.from("detox_jobs")
        .update({
          status: "done",
          last_error: null,
          block_reason: null,
          kept,
          removed: 0,
          finished_at: new Date().toISOString(),
          heartbeat_at: new Date().toISOString(),
        })
        .eq("project_id", project_id)
        .in("status", ["queued", "running", "blocked"]);

      // Promote project status the same way the worker does on success.
      await supabase.from("navigator_projects").update({ status: "data_collection" }).eq("id", project_id);

      return new Response(JSON.stringify({ ok: true, kept }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }



    // ---- mode: insert (hygiene + insert pending) ---------------------------
    if (mode === "insert") {
      if (!project_id) throw new Error("project_id required");
      if (!keywords?.length) throw new Error("keywords[] required");
      const sanitised = keywords.map((k) => sanitizeKeyword(k)).filter(Boolean);
      const seen = new Set<string>();
      const unique: string[] = [];
      for (const k of sanitised) if (!seen.has(k)) { seen.add(k); unique.push(k); }

      // Filter out already-existing
      const existing = new Set<string>();
      const CHUNK = 500;
      for (let i = 0; i < unique.length; i += CHUNK) {
        const slice = unique.slice(i, i + CHUNK);
        const { data } = await supabase.from("keywords").select("keyword").eq("project_id", project_id).in("keyword", slice);
        for (const r of data ?? []) existing.add(String((r as any).keyword).toLowerCase());
      }
      const toInsert = unique.filter((k) => !existing.has(k));
      if (toInsert.length) {
        const rows = toInsert.map((k) => ({ project_id, keyword: k, source: "manual", device: "mobile", detox_status: "pending" }));
        const { error } = await supabase.from("keywords").upsert(rows, { onConflict: "project_id,keyword", ignoreDuplicates: true });
        if (error) throw new Error(`Insert failed: ${error.message}`);
      }
      return new Response(JSON.stringify({
        inserted: toInsert.length,
        skipped_invalid: keywords.length - sanitised.length,
        skipped_duplicates: unique.length - toInsert.length + (sanitised.length - unique.length),
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ---- mode: start (create job + kick worker) ----------------------------
    if (mode === "start" || mode === undefined) {
      if (!project_id) throw new Error("project_id required");

      // If a job is already queued/running for this project, return it.
      const { data: existing } = await supabase
        .from("detox_jobs").select("*")
        .eq("project_id", project_id).in("status", ["queued", "running"])
        .order("created_at", { ascending: false }).limit(1).maybeSingle();

      let jobId: string;
      let total = 0;
      const { count: pendingCount } = await supabase
        .from("keywords").select("id", { count: "exact", head: true })
        .eq("project_id", project_id).eq("detox_status", "pending");
      total = pendingCount ?? 0;

      if (existing) {
        jobId = (existing as any).id;
      } else {
        if (total === 0) {
          return new Response(JSON.stringify({ done: true, total: 0, job_id: null }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        const { data: created, error: createErr } = await supabase.from("detox_jobs").insert({
          project_id, status: "queued", total, processed: 0, kept: 0, removed: 0,
        }).select("id").single();
        if (createErr) throw new Error(`Job create failed: ${createErr.message}`);
        jobId = (created as any).id;
      }

      // Kick worker
      // @ts-ignore Deno EdgeRuntime
      if (typeof EdgeRuntime !== "undefined" && (EdgeRuntime as any).waitUntil) {
        // @ts-ignore
        EdgeRuntime.waitUntil(runWorker(jobId));
      } else {
        runWorker(jobId).catch((e) => console.error("worker error", e));
      }

      return new Response(JSON.stringify({ job_id: jobId, total }), {
        status: 202,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unknown mode: ${mode}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    console.error("keyword-detox error:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
