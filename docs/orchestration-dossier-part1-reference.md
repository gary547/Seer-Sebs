# Orchestration Dossier — Part 1: Reference Implementations

**Deliverable set (all parts produced, no file contents abbreviated):**

- `docs/orchestration-dossier-part1-reference.md` (this file)
- `docs/orchestration-dossier-part2-functions.md`
- `docs/orchestration-dossier-part3-client.md`
- `docs/orchestration-dossier-part4-state.md`
- `docs/orchestration-dossier-part5-gsc-promotion.md`

Every embedded source file is reproduced verbatim end-to-end. No `...`, no `(rest unchanged)`, no paraphrasing. Only redaction is `HAR_CRON_SECRET` values (rendered as `«REDACTED_HAR_CRON_SECRET»`); secret NAMES and the code that reads them are preserved. The Supabase publishable anon key is left as-is because the system prompt confirms it is a publishable key.

Generated: 2026-07-21.

---

## 1.1 supabase/functions/keyword-detox/index.ts (verbatim)

### `supabase/functions/keyword-detox/index.ts`

```ts
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

```

---

## 1.2 supabase/functions/har-calculation/index.ts (verbatim)

### `supabase/functions/har-calculation/index.ts`

```ts
// Durable HAR/TP worker — fast path (Option A).
// Modes:
//   start  — { project_id, stalenessDays? }   → seeds har_jobs + queues, returns job_id
//   tick   — { project_id? | job_id? }        → advances one micro-batch on one job
//   status — { project_id } or { job_id }     → returns the current job row
//
// Each tick is short-lived (≤ ~50s). All progress is persisted in
// har_jobs / har_serp_tasks / har_ahrefs_queue / har_backlinks_queue, so
// crashes and rate limits never lose work. After every productive tick the
// worker self-chains via EdgeRuntime.waitUntil() so it doesn't have to wait
// for the next pg_cron minute. pg_cron remains the safety net.
//
// HAR maths (runPhaseCompute) is unchanged from the previous version.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ── Tuning (Option A: conservative parallel pools) ────────────────────────
const TICK_BUDGET_MS       = 50_000;
const HEARTBEAT_MS         = 10_000;
const SERP_POST_BATCH      = 100;
const SERP_POST_PARALLEL   = 3;
const SERP_FETCH_BATCH     = 150;
const SERP_FETCH_PARALLEL  = 8;
const AHREFS_BATCH         = 100;
const AHREFS_PARALLEL      = 4;
const BACKLINKS_BATCH      = 500;
const BACKLINKS_PARALLEL   = 3;
const CHAIN_GUARD_MS       = 30_000;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function admin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE);
}

const dfsAuth = () => {
  const k = Deno.env.get("DATAFORSEO_API_KEY")!;
  return k.includes(":") ? btoa(k) : k;
};

const normalizeDomain = (u: string) =>
  (u || "").replace(/^https?:\/\/(www\.)?/, "").split("/")[0].toLowerCase();

async function fetchWithRetry(url: string, options: RequestInit, retries = 2): Promise<Response> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, options);
      return r;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw new Error("unreachable");
}

// Run async tasks in parallel with a max concurrency cap.
async function runPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function chunkedDo<T>(rows: T[], size: number, fn: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size));
}

// ───────────────────────────────────────────────────────────────────────────
// START — stale-aware: only enqueue keywords with no SERP row or stale rows
// ───────────────────────────────────────────────────────────────────────────
async function handleStart(project_id: string, stalenessDays = 7) {
  const sb = admin();

  // Replace any non-terminal job for this project.
  await sb
    .from("har_jobs")
    .update({ status: "error", last_error: "superseded by new run", completed_at: new Date().toISOString() })
    .eq("project_id", project_id)
    .not("status", "in", "(completed,error)");

  // Cleanup orphaned queue rows from prior runs.
  await sb.from("har_serp_tasks").delete().eq("project_id", project_id);
  await sb.from("har_ahrefs_queue").delete().eq("project_id", project_id);
  await sb.from("har_backlinks_queue").delete().eq("project_id", project_id);

  // Page through all kept keywords.
  const kept: Array<{ id: string; keyword: string; ranking_url: string | null }> = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await sb
      .from("keywords")
      .select("id, keyword, ranking_url")
      .eq("project_id", project_id)
      .eq("detox_status", "keep")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`fetch keywords: ${error.message}`);
    if (!data?.length) break;
    kept.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  if (!kept.length) {
    const e: any = new Error(
      "No 'keep' keywords found for this project. Run Keyword Detox first (or restore some keywords) before calculating HAR."
    );
    e.statusCode = 400;
    throw e;
  }

  // Determine which kept keywords already have FRESH serp_results — skip those.
  const cutoff = new Date(Date.now() - stalenessDays * 86_400_000).toISOString();
  const freshKeywordIds = new Set<string>();
  const ids = kept.map((k) => k.id);
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const { data } = await sb
      .from("serp_results")
      .select("keyword_id, fetched_at")
      .in("keyword_id", chunk)
      .gte("fetched_at", cutoff);
    for (const r of data ?? []) freshKeywordIds.add((r as any).keyword_id);
  }
  const toQueue = kept.filter((k) => !freshKeywordIds.has(k.id));
  // If everything is fresh we still create a job so compute runs and HAR
  // is recomputed against the latest ahrefs/backlinks data.
  const serpTotal = toQueue.length;

  const { data: job, error: jobErr } = await sb
    .from("har_jobs")
    .insert({
      project_id,
      status: serpTotal ? "posting_serp" : "fetching_ahrefs",
      phase: serpTotal ? "post_serp" : "fetch_ahrefs",
      total_keywords: kept.length,
      serp_tasks_total: serpTotal,
      started_at: new Date().toISOString(),
      next_run_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (jobErr) throw new Error(`create job: ${jobErr.message}`);

  // Seed SERP tasks (only stale/missing).
  for (let i = 0; i < toQueue.length; i += 500) {
    const chunk = toQueue.slice(i, i + 500).map((k) => ({
      job_id: job.id,
      project_id,
      keyword_id: k.id,
      keyword: k.keyword,
      status: "queued",
    }));
    if (chunk.length) {
      const { error } = await sb.from("har_serp_tasks").insert(chunk);
      if (error) throw new Error(`seed serp tasks: ${error.message}`);
    }
  }

  // Seed Ahrefs queue with client domain + each kept keyword's ranking_url.
  const { data: project } = await sb
    .from("navigator_projects")
    .select("id, clients(domain)")
    .eq("id", project_id)
    .single();
  const rawDomain = (project?.clients as any)?.domain;
  if (!rawDomain) throw new Error("client domain missing");
  const clientDomain = rawDomain.replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "");

  const ahrefsSeeds = new Set<string>();
  ahrefsSeeds.add(`https://${clientDomain}`);
  for (const kw of kept) {
    if (!kw.ranking_url) continue;
    const u = kw.ranking_url.startsWith("http")
      ? kw.ranking_url
      : kw.ranking_url.startsWith("/")
        ? `https://${clientDomain}${kw.ranking_url}`
        : `https://${kw.ranking_url}`;
    ahrefsSeeds.add(u);
  }
  if (ahrefsSeeds.size > 0) {
    const rows = [...ahrefsSeeds].map((url) => ({
      job_id: job.id,
      project_id,
      target_url: url,
      target_mode: url === `https://${clientDomain}` ? "domain" : "exact",
      status: "pending",
    }));
    for (let i = 0; i < rows.length; i += 500) {
      await sb.from("har_ahrefs_queue").insert(rows.slice(i, i + 500));
    }
    await sb.from("har_jobs").update({ ahrefs_targets_total: rows.length }).eq("id", job.id);
  }

  await sb.from("navigator_projects").update({ har_status: "running" }).eq("id", project_id);

  // Kick the first tick immediately.
  scheduleSelfTick(job.id);

  return { job_id: job.id, total_keywords: kept.length, serp_tasks_total: serpTotal, fresh_skipped: kept.length - serpTotal };
}

// Self-chain: re-invoke our own function with mode:"tick" without awaiting.
function scheduleSelfTick(job_id: string) {
  try {
    const url = `${SUPABASE_URL}/functions/v1/har-calculation`;
    const promise = fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SERVICE_ROLE}`,
        apikey: SERVICE_ROLE,
      },
      body: JSON.stringify({ mode: "tick", job_id }),
    }).catch((e) => console.warn("self-tick failed", e));
    // @ts-ignore — EdgeRuntime is provided by Supabase Deno runtime
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(promise);
  } catch (e) {
    console.warn("scheduleSelfTick error", e);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// TICK — pick one runnable job and advance one phase
// ───────────────────────────────────────────────────────────────────────────
async function handleTick(opts: { project_id?: string; job_id?: string } = {}) {
  const sb = admin();
  await sb.rpc("release_stale_har_claims");

  let job: any = null;
  if (opts.job_id) {
    const { data } = await sb.from("har_jobs").select("*").eq("id", opts.job_id).maybeSingle();
    job = data;
    if (!job || job.status === "completed" || job.status === "error") return { idle: true };
  } else {
    const q = sb
      .from("har_jobs")
      .select("*")
      .not("status", "in", "(completed,error)")
      .lte("next_run_at", new Date().toISOString())
      .order("next_run_at", { ascending: true })
      .limit(1);
    if (opts.project_id) q.eq("project_id", opts.project_id);
    const { data: jobs } = await q;
    job = jobs?.[0];
    if (!job) return { idle: true };
  }

  // Re-entrancy guard: if locked very recently, another tick is already running.
  if (job.locked_at && Date.now() - new Date(job.locked_at).getTime() < CHAIN_GUARD_MS) {
    return { busy: true, job_id: job.id };
  }

  // Heartbeat / lock
  await sb
    .from("har_jobs")
    .update({ locked_at: new Date().toISOString(), attempts: (job.attempts ?? 0) + 1 })
    .eq("id", job.id);

  const deadline = Date.now() + TICK_BUDGET_MS;
  let lastHeartbeat = Date.now();
  const beat = async () => {
    if (Date.now() - lastHeartbeat > HEARTBEAT_MS) {
      lastHeartbeat = Date.now();
      await sb.from("har_jobs").update({ locked_at: new Date().toISOString() }).eq("id", job.id);
    }
  };

  let advanced = false;
  let chainNext = false;
  try {
    // Phase 1: POST queued SERP tasks
    if (job.serp_tasks_posted < job.serp_tasks_total) {
      advanced = await runPhasePostSerp(sb, job, deadline, beat);
      await sb.from("har_jobs").update({ status: "posting_serp", phase: "post_serp", next_run_at: new Date().toISOString() }).eq("id", job.id);
      chainNext = true;
    }
    // Phase 2: poll/fetch posted tasks
    else if (job.serp_tasks_done < job.serp_tasks_total) {
      advanced = await runPhasePollSerp(sb, job, deadline, beat);
      const next = advanced ? new Date().toISOString() : new Date(Date.now() + 20_000).toISOString();
      await sb.from("har_jobs").update({ status: "polling_serp", phase: "poll_serp", next_run_at: next }).eq("id", job.id);
      chainNext = advanced; // if no progress, let cron pick it up after the wait
    }
    // Phase 3: seed Ahrefs queue with discovered SERP URLs (one-time)
    else if (job.phase === "post_serp" || job.phase === "poll_serp") {
      await seedAhrefsFromSerp(sb, job);
      await sb.from("har_jobs").update({ phase: "fetch_ahrefs", status: "fetching_ahrefs", next_run_at: new Date().toISOString() }).eq("id", job.id);
      chainNext = true;
    }
    // Phase 4: Ahrefs
    else if (job.ahrefs_targets_done < job.ahrefs_targets_total) {
      advanced = await runPhaseAhrefs(sb, job, deadline, beat);
      await sb.from("har_jobs").update({ status: "fetching_ahrefs", phase: "fetch_ahrefs", next_run_at: new Date().toISOString() }).eq("id", job.id);
      chainNext = true;
    }
    // Phase 5: seed backlinks queue from SERP URLs (one-time)
    else if (job.phase !== "fetch_backlinks" && job.phase !== "compute") {
      await seedBacklinksFromSerp(sb, job);
      await sb.from("har_jobs").update({ phase: "fetch_backlinks", status: "fetching_backlinks", next_run_at: new Date().toISOString() }).eq("id", job.id);
      chainNext = true;
    }
    // Phase 6: backlinks
    else if (!job.backlinks_skipped && job.backlinks_targets_done < job.backlinks_targets_total) {
      const { advanced: adv, skipped } = await runPhaseBacklinks(sb, job, deadline, beat);
      advanced = adv;
      const patch: any = { status: "fetching_backlinks", phase: "fetch_backlinks", next_run_at: new Date().toISOString() };
      if (skipped) patch.backlinks_skipped = true;
      await sb.from("har_jobs").update(patch).eq("id", job.id);
      chainNext = true;
    }
    // Phase 7: compute HAR + write final tables
    else {
      await sb.from("har_jobs").update({ phase: "compute", status: "computing" }).eq("id", job.id);
      await runPhaseCompute(sb, job);

      // Re-run forecasts BEFORE flipping har_status to completed, so that by
      // the time the UI sees `har_status='completed'` the keyword_forecasts
      // rows already have `har` + `har_revenue_gain_annual` populated.
      //
      // Previously this was a fire-and-forget fetch wrapped in
      // EdgeRuntime.waitUntil — if it dropped (cold start, runtime kill,
      // network blip) the project ended up with valid har_results but every
      // keyword_forecasts.har = NULL, which surfaced as £0 in the TP Revenue
      // column and the TP Revenue Uplift dashboard widget.
      let recomputeError: string | null = null;
      try {
        const fcUrl = `${SUPABASE_URL}/functions/v1/compute-forecasts`;
        const fcRes = await fetch(fcUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SERVICE_ROLE}`,
            apikey: SERVICE_ROLE,
          },
          body: JSON.stringify({ project_id: job.project_id }),
        });
        if (!fcRes.ok) {
          const body = await fcRes.text().catch(() => "");
          recomputeError = `compute-forecasts HTTP ${fcRes.status}: ${body.slice(0, 300)}`;
          console.warn("post-HAR compute-forecasts non-ok:", recomputeError);
        } else {
          console.log("post-HAR compute-forecasts succeeded");
        }
      } catch (e: any) {
        recomputeError = `compute-forecasts threw: ${e?.message ?? String(e)}`;
        console.warn(recomputeError);
      }

      await sb
        .from("har_jobs")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
          last_error: recomputeError, // null on success; recorded if recompute failed
        })
        .eq("id", job.id);
      await sb.from("navigator_projects").update({ har_status: "completed" }).eq("id", job.project_id);

      // Cleanup queues now that we've persisted everything we need
      await sb.from("har_serp_tasks").delete().eq("job_id", job.id);
      await sb.from("har_ahrefs_queue").delete().eq("job_id", job.id);
      await sb.from("har_backlinks_queue").delete().eq("job_id", job.id);

      chainNext = false;
    }

    if (chainNext) scheduleSelfTick(job.id);
    return await summarise(sb, job.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("tick error", msg);
    const fatal = /auth\/subscription|client domain|No kept/i.test(msg);
    await sb
      .from("har_jobs")
      .update({
        status: fatal ? "error" : "rate_limited",
        last_error: msg,
        next_run_at: new Date(Date.now() + (fatal ? 0 : 60_000)).toISOString(),
        completed_at: fatal ? new Date().toISOString() : null,
      })
      .eq("id", job.id);
    if (fatal) {
      await sb.from("navigator_projects").update({ har_status: "error" }).eq("id", job.project_id);
    }
    return { error: msg, job_id: job.id };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// PHASE: post SERP tasks (parallel posts + bulk RPC writeback)
// ───────────────────────────────────────────────────────────────────────────
async function runPhasePostSerp(sb: any, job: any, deadline: number, beat: () => Promise<void>): Promise<boolean> {
  let didWork = false;
  while (Date.now() < deadline) {
    // Claim SERP_POST_PARALLEL batches up-front so we can hit DFS in parallel.
    const claimBatches: Array<Array<{ id: string; keyword: string }>> = [];
    for (let p = 0; p < SERP_POST_PARALLEL; p++) {
      const { data: claims } = await sb.rpc("claim_har_serp_post_batch", {
        _job_id: job.id,
        _limit: SERP_POST_BATCH,
      });
      if (!claims?.length) break;
      claimBatches.push(claims as any);
    }
    if (!claimBatches.length) return didWork;

    const responses = await runPool(claimBatches, SERP_POST_PARALLEL, async (claims) => {
      const payload = claims.map((c) => ({
        keyword: c.keyword,
        location_code: 2826,
        language_code: "en",
        depth: 20,
        device: "desktop",
        os: "windows",
        tag: c.id,
      }));
      const resp = await fetchWithRetry(
        "https://api.dataforseo.com/v3/serp/google/organic/task_post",
        {
          method: "POST",
          headers: { Authorization: `Basic ${dfsAuth()}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const body = await resp.json().catch(() => ({}));
      return { claims, tasks: body.tasks ?? [] };
    });

    // Build a single bulk-update payload for all responses combined.
    // Track which claim ids were already 'posted' on this attempt so we don't
    // double-count retries against serp_tasks_posted.
    const alreadyPostedIds = new Set<string>();
    {
      const allClaimIds = claimBatches.flat().map((c) => c.id);
      const { data: existing } = await sb
        .from("har_serp_tasks")
        .select("id,status")
        .in("id", allClaimIds);
      for (const r of existing ?? []) if (r.status === "posted") alreadyPostedIds.add(r.id);
    }

    const bulkRows: any[] = [];
    let postedCount = 0;
    for (const { tasks } of responses) {
      for (const t of tasks) {
        const ourId = t.data?.tag;
        if (!ourId) continue;
        if (t.id && (t.status_code === 20100 || t.status_code === 20000)) {
          bulkRows.push({ id: ourId, dfs_task_id: t.id, status: "posted", last_error: null });
          if (!alreadyPostedIds.has(ourId)) postedCount++;
        } else {
          bulkRows.push({ id: ourId, dfs_task_id: null, status: "queued", last_error: t.status_message ?? `code ${t.status_code}` });
        }
      }
    }

    if (bulkRows.length) {
      await sb.rpc("bulk_update_har_serp_tasks", { _rows: bulkRows });
      didWork = true;
    }
    if (postedCount > 0) {
      const newPosted = Math.min((job.serp_tasks_posted ?? 0) + postedCount, job.serp_tasks_total ?? 0);
      await sb
        .from("har_jobs")
        .update({ serp_tasks_posted: newPosted })
        .eq("id", job.id);
      job.serp_tasks_posted = newPosted;
    }
    await beat();
  }
  return didWork;
}

// ───────────────────────────────────────────────────────────────────────────
// PHASE: poll SERP results — driven by tasks_ready, parallel task_get
// ───────────────────────────────────────────────────────────────────────────
const extractSubItems = (item: any): Array<{ url: string; title?: string }> => {
  const out: Array<{ url: string; title?: string }> = [];
  const visit = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (typeof n.url === "string" && /^https?:\/\//.test(n.url)) out.push({ url: n.url, title: n.title });
    if (Array.isArray(n.items)) n.items.forEach(visit);
    if (Array.isArray(n.references)) n.references.forEach(visit);
    if (Array.isArray(n.expanded_element)) n.expanded_element.forEach(visit);
  };
  visit(item);
  return out;
};

async function runPhasePollSerp(sb: any, job: any, deadline: number, beat: () => Promise<void>): Promise<boolean> {
  // 1. Ask DFS which posted tasks are ready.
  const readyResp = await fetchWithRetry(
    "https://api.dataforseo.com/v3/serp/google/organic/tasks_ready",
    { method: "GET", headers: { Authorization: `Basic ${dfsAuth()}` } },
  );
  const readyBody = await readyResp.json().catch(() => ({}));
  const readyIds: string[] = (readyBody.tasks?.[0]?.result ?? []).map((it: any) => it.id).filter(Boolean);

  // 2. Claim ready rows.
  let claims: any[] = [];
  if (readyIds.length) {
    const { data } = await sb.rpc("claim_har_serp_fetch_by_dfs_ids", {
      _job_id: job.id,
      _dfs_ids: readyIds,
      _limit: SERP_FETCH_BATCH,
    });
    claims = data ?? [];
  }

  // 2b. Stale-posted fallback: if nothing came back from tasks_ready, but we have
  // rows that were posted > 3 min ago, try fetching them directly. DFS sometimes
  // drops tasks from the ready feed before we see them, and direct task_get works
  // regardless. This is the difference between "wait forever" and "self-heal".
  if (!claims.length) {
    const { data: stale } = await sb.rpc("claim_har_serp_fetch_batch", {
      _job_id: job.id,
      _limit: Math.min(SERP_FETCH_BATCH, 50),
    });
    claims = stale ?? [];
    console.log(JSON.stringify({
      phase: "poll_serp", job: job.id,
      ready_ids: readyIds.length, ready_claimed: 0, stale_claimed: claims.length,
      done: job.serp_tasks_done, total: job.serp_tasks_total,
    }));
  } else {
    console.log(JSON.stringify({
      phase: "poll_serp", job: job.id,
      ready_ids: readyIds.length, ready_claimed: claims.length,
      done: job.serp_tasks_done, total: job.serp_tasks_total,
    }));
  }

  if (!claims.length) return false;

  const clientDomainNorm = await getClientDomainNorm(sb, job.project_id);

  const serpResultRows: any[] = [];
  const serpRankingRows: any[] = [];
  const serpFeatureRows: any[] = [];
  const fetchedKeywordIds = new Set<string>();
  const fetchedTaskIds: string[] = [];
  const erroredTasks: Array<{ id: string; error: string }> = [];

  // 3. Parallel task_get with a pool.
  await runPool(claims as any[], SERP_FETCH_PARALLEL, async (c: any) => {
    if (Date.now() > deadline) return;
    try {
      const r = await fetchWithRetry(
        `https://api.dataforseo.com/v3/serp/google/organic/task_get/advanced/${c.dfs_task_id}`,
        { method: "GET", headers: { Authorization: `Basic ${dfsAuth()}` } },
      );
      const j = await r.json();
      const t = j.tasks?.[0];
      if (t?.status_code !== 20000) {
        erroredTasks.push({ id: c.id, error: t?.status_message ?? `code ${t?.status_code}` });
        return;
      }
      const items = t.result?.[0]?.items ?? [];
      fetchedKeywordIds.add(c.keyword_id);
      for (const item of items) {
        if (item.type === "organic") {
          if (item.rank_absolute > 20) continue;
          const url = item.url ?? "";
          const domain = normalizeDomain(url);
          serpResultRows.push({
            project_id: job.project_id,
            keyword_id: c.keyword_id,
            rank_absolute: item.rank_absolute,
            url,
            domain,
            fetched_at: new Date().toISOString(),
          });
          serpRankingRows.push({
            keyword_id: c.keyword_id,
            rank_position: item.rank_absolute,
            ranking_url: url,
            ranking_domain: domain,
            is_our_domain: domain === clientDomainNorm,
          });
        } else {
          // Vintage stamping: single per-task capture timestamp so all feature
          // rows from one SERP fetch share the same captured_at. serp_result_id
          // is left NULL here — feature items (PAA, Answer, images, etc.) do
          // not map to a specific organic serp_results row in this path.
          const capturedAt = new Date().toISOString();
          const subs = extractSubItems(item);
          if (subs.length === 0) {
            serpFeatureRows.push({
              keyword_id: c.keyword_id,
              result_type: item.type,
              top_serp_feature: item.title ?? null,
              top_serp_feature_url: null,
              serp_feature_count: 1,
              serp_feature_owned: false,
              captured_at: capturedAt,
              serp_result_id: null,
            });
          } else {
            for (const s of subs) {
              const sd = normalizeDomain(s.url);
              serpFeatureRows.push({
                keyword_id: c.keyword_id,
                result_type: item.type,
                top_serp_feature: s.title ?? item.title ?? null,
                top_serp_feature_url: s.url,
                serp_feature_count: subs.length,
                serp_feature_owned: sd === clientDomainNorm,
                captured_at: capturedAt,
                serp_result_id: null,
              });
            }
          }
        }
      }
      fetchedTaskIds.push(c.id);
    } catch (err) {
      erroredTasks.push({ id: c.id, error: err instanceof Error ? err.message : String(err) });
    }
    await beat();
  });

  // 4. Persist (bulk).
  if (fetchedKeywordIds.size > 0) {
    const ids = [...fetchedKeywordIds];
    await chunkedDo(ids, 200, async (chunk) => {
      await sb.from("serp_rankings").delete().in("keyword_id", chunk);
      await sb.from("serp_features").delete().in("keyword_id", chunk);
    });
    await chunkedDo(serpResultRows, 500, (chunk) =>
      sb.from("serp_results").upsert(chunk, { onConflict: "keyword_id,rank_absolute" }),
    );
    await chunkedDo(serpRankingRows, 500, (chunk) => sb.from("serp_rankings").insert(chunk));
    await chunkedDo(serpFeatureRows, 500, (chunk) => sb.from("serp_features").insert(chunk));
  }

  if (fetchedTaskIds.length > 0) {
    await chunkedDo(fetchedTaskIds, 500, (chunk) =>
      sb.from("har_serp_tasks")
        .update({ status: "fetched", fetched_at: new Date().toISOString(), locked_at: null })
        .in("id", chunk),
    );
    await sb
      .from("har_jobs")
      .update({ serp_tasks_done: (job.serp_tasks_done ?? 0) + fetchedTaskIds.length })
      .eq("id", job.id);
    job.serp_tasks_done = (job.serp_tasks_done ?? 0) + fetchedTaskIds.length;
  }

  if (erroredTasks.length > 0) {
    // Bulk: same status/error for each (last_error differs but we keep it best-effort)
    await chunkedDo(erroredTasks, 200, (chunk) =>
      Promise.all(chunk.map((e) =>
        sb.from("har_serp_tasks").update({ status: "error", last_error: e.error, locked_at: null }).eq("id", e.id),
      )),
    );
    await sb
      .from("har_jobs")
      .update({ serp_tasks_done: (job.serp_tasks_done ?? 0) + erroredTasks.length })
      .eq("id", job.id);
    job.serp_tasks_done = (job.serp_tasks_done ?? 0) + erroredTasks.length;
  }

  return fetchedTaskIds.length > 0 || erroredTasks.length > 0;
}

async function getClientDomainNorm(sb: any, project_id: string): Promise<string> {
  const { data } = await sb
    .from("navigator_projects")
    .select("clients(domain)")
    .eq("id", project_id)
    .single();
  const raw = (data?.clients as any)?.domain ?? "";
  return raw.replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "").toLowerCase();
}

// ───────────────────────────────────────────────────────────────────────────
// SEEDING: discover SERP URLs and add to Ahrefs / Backlinks queues
// ───────────────────────────────────────────────────────────────────────────
async function seedAhrefsFromSerp(sb: any, job: any) {
  const { data: ks } = await sb
    .from("keywords")
    .select("id")
    .eq("project_id", job.project_id)
    .eq("detox_status", "keep");
  const keywordIds = (ks ?? []).map((r: any) => r.id);
  if (!keywordIds.length) return;

  const allUrls = new Set<string>();
  for (let i = 0; i < keywordIds.length; i += 500) {
    const chunk = keywordIds.slice(i, i + 500);
    const { data } = await sb.from("serp_results").select("url").in("keyword_id", chunk);
    for (const r of data ?? []) if (r.url) allUrls.add(r.url);
  }

  const { data: existing } = await sb.from("har_ahrefs_queue").select("target_url").eq("job_id", job.id);
  const have = new Set((existing ?? []).map((r: any) => r.target_url));

  const toInsert = [...allUrls]
    .filter((u) => !have.has(u))
    .map((u) => ({ job_id: job.id, project_id: job.project_id, target_url: u, target_mode: "exact", status: "pending" }));

  for (let i = 0; i < toInsert.length; i += 500) {
    await sb.from("har_ahrefs_queue").insert(toInsert.slice(i, i + 500));
  }

  const { count } = await sb
    .from("har_ahrefs_queue")
    .select("id", { count: "exact", head: true })
    .eq("job_id", job.id);
  await sb.from("har_jobs").update({ ahrefs_targets_total: count ?? 0 }).eq("id", job.id);
  job.ahrefs_targets_total = count ?? 0;
}

async function seedBacklinksFromSerp(sb: any, job: any) {
  const { data: rows } = await sb
    .from("har_ahrefs_queue")
    .select("target_url, target_mode")
    .eq("job_id", job.id)
    .eq("target_mode", "exact");
  const urls = [...new Set((rows ?? []).map((r: any) => r.target_url))];
  if (!urls.length) return;
  const toInsert = urls.map((u) => ({ job_id: job.id, project_id: job.project_id, target_url: u, status: "pending" }));
  for (let i = 0; i < toInsert.length; i += 500) {
    await sb.from("har_backlinks_queue").insert(toInsert.slice(i, i + 500));
  }
  await sb.from("har_jobs").update({ backlinks_targets_total: toInsert.length }).eq("id", job.id);
  job.backlinks_targets_total = toInsert.length;
}

// ───────────────────────────────────────────────────────────────────────────
// PHASE: Ahrefs (parallel batch-analysis)
// ───────────────────────────────────────────────────────────────────────────
async function runPhaseAhrefs(sb: any, job: any, deadline: number, beat: () => Promise<void>): Promise<boolean> {
  const AHREFS_KEY = Deno.env.get("AHREFS_API_KEY")!;
  let didWork = false;

  while (Date.now() < deadline) {
    // Claim AHREFS_PARALLEL batches up-front.
    const batches: Array<Array<{ id: string; target_url: string; target_mode: string }>> = [];
    for (let p = 0; p < AHREFS_PARALLEL; p++) {
      const { data: claims } = await sb.rpc("claim_har_ahrefs_batch", {
        _job_id: job.id,
        _limit: AHREFS_BATCH,
      });
      if (!claims?.length) break;
      batches.push(claims as any);
    }
    if (!batches.length) return didWork;

    let totalDone = 0;
    try {
      await runPool(batches, AHREFS_PARALLEL, async (claims) => {
        const resp = await fetchWithRetry("https://api.ahrefs.com/v3/batch-analysis/batch-analysis", {
          method: "POST",
          headers: { Authorization: `Bearer ${AHREFS_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            select: ["url", "url_rating", "domain_rating", "ahrefs_rank"],
            targets: claims.map((c) => ({ url: c.target_url, mode: c.target_mode, protocol: "both" })),
            output: "json",
          }),
        });
        if (!resp.ok) {
          const status = resp.status;
          const txt = await resp.text();
          if (status === 401 || status === 402 || status === 403) {
            throw new Error(`Ahrefs auth/subscription error (${status}): ${txt}`);
          }
          await sb
            .from("har_ahrefs_queue")
            .update({ status: "pending", locked_at: null, last_error: `${status}: ${txt.slice(0, 200)}` })
            .in("id", claims.map((c) => c.id));
          return;
        }
        const body = await resp.json();
        const targets = body.targets ?? [];
        // Ahrefs returns rows in the same order as the request payload.
        await Promise.all(
          claims.map((c, i) =>
            sb.from("har_ahrefs_queue").update({
              status: "done",
              url_rating: targets[i]?.url_rating ?? 0,
              domain_rating: targets[i]?.domain_rating ?? 0,
              ahrefs_rank: targets[i]?.ahrefs_rank ?? 0,
              locked_at: null,
            }).eq("id", c.id),
          ),
        );
        totalDone += claims.length;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/auth\/subscription/.test(msg)) throw err;
      // Release any leftover claims back to pending (best-effort).
      const allIds = batches.flat().map((c) => c.id);
      await sb
        .from("har_ahrefs_queue")
        .update({ status: "pending", locked_at: null, last_error: msg.slice(0, 200) })
        .in("id", allIds);
      return didWork;
    }

    if (totalDone > 0) {
      await sb.from("har_jobs").update({ ahrefs_targets_done: (job.ahrefs_targets_done ?? 0) + totalDone }).eq("id", job.id);
      job.ahrefs_targets_done = (job.ahrefs_targets_done ?? 0) + totalDone;
      didWork = true;
    }
    await beat();
  }
  return didWork;
}

// ───────────────────────────────────────────────────────────────────────────
// PHASE: Backlinks (parallel)
// ───────────────────────────────────────────────────────────────────────────
async function runPhaseBacklinks(sb: any, job: any, deadline: number, beat: () => Promise<void>): Promise<{ advanced: boolean; skipped: boolean }> {
  let didWork = false;
  let skipped = false;

  while (Date.now() < deadline) {
    const batches: Array<Array<{ id: string; target_url: string }>> = [];
    for (let p = 0; p < BACKLINKS_PARALLEL; p++) {
      const { data: claims } = await sb.rpc("claim_har_backlinks_batch", {
        _job_id: job.id,
        _limit: BACKLINKS_BATCH,
      });
      if (!claims?.length) break;
      batches.push(claims as any);
    }
    if (!batches.length) return { advanced: didWork, skipped };

    let totalDone = 0;
    try {
      await runPool(batches, BACKLINKS_PARALLEL, async (claims) => {
        const targets = claims.map((c) => c.target_url);
        const [refResp, blResp] = await Promise.all([
          fetchWithRetry("https://api.dataforseo.com/v3/backlinks/bulk_referring_domains/live", {
            method: "POST",
            headers: { Authorization: `Basic ${dfsAuth()}`, "Content-Type": "application/json" },
            body: JSON.stringify([{ targets }]),
          }),
          fetchWithRetry("https://api.dataforseo.com/v3/backlinks/bulk_backlinks/live", {
            method: "POST",
            headers: { Authorization: `Basic ${dfsAuth()}`, "Content-Type": "application/json" },
            body: JSON.stringify([{ targets }]),
          }),
        ]);
        const [refData, blData] = await Promise.all([refResp.json(), blResp.json()]);

        const refStatus = refData.tasks?.[0]?.status_code;
        const blStatus = blData.tasks?.[0]?.status_code;
        if (refStatus === 40204 || blStatus === 40204) {
          await sb
            .from("har_backlinks_queue")
            .update({ status: "done", locked_at: null })
            .in("id", claims.map((c) => c.id));
          skipped = true;
          totalDone += claims.length;
          return;
        }

        const refMap: Record<string, number> = {};
        const blMap: Record<string, number> = {};
        for (const i of refData.tasks?.[0]?.result?.[0]?.items ?? []) refMap[i.target] = i.referring_domains ?? 0;
        for (const i of blData.tasks?.[0]?.result?.[0]?.items ?? []) blMap[i.target] = i.backlinks ?? 0;

        await Promise.all(
          claims.map((c) =>
            sb.from("har_backlinks_queue").update({
              status: "done",
              referring_domains: refMap[c.target_url] ?? null,
              backlinks: blMap[c.target_url] ?? null,
              locked_at: null,
            }).eq("id", c.id),
          ),
        );
        totalDone += claims.length;
      });
    } catch (err) {
      const allIds = batches.flat().map((c) => c.id);
      await sb
        .from("har_backlinks_queue")
        .update({ status: "pending", locked_at: null, last_error: (err instanceof Error ? err.message : String(err)).slice(0, 200) })
        .in("id", allIds);
      return { advanced: didWork, skipped };
    }

    if (totalDone > 0) {
      await sb
        .from("har_jobs")
        .update({ backlinks_targets_done: (job.backlinks_targets_done ?? 0) + totalDone })
        .eq("id", job.id);
      job.backlinks_targets_done = (job.backlinks_targets_done ?? 0) + totalDone;
      didWork = true;
    }
    await beat();
  }
  return { advanced: didWork, skipped };
}

// ───────────────────────────────────────────────────────────────────────────
// PHASE: Compute HAR + finalise (formula UNCHANGED)
// ───────────────────────────────────────────────────────────────────────────
async function runPhaseCompute(sb: any, job: any) {
  const project_id = job.project_id;
  const clientDomainNorm = await getClientDomainNorm(sb, project_id);
  const clientDomain = clientDomainNorm;

  // Build URL → metrics map from har_ahrefs_queue
  const ahrefsMap: Record<string, { url_rating: number; domain_rating: number; ahrefs_rank: number }> = {};
  let from = 0;
  while (true) {
    const { data } = await sb
      .from("har_ahrefs_queue")
      .select("target_url, url_rating, domain_rating, ahrefs_rank")
      .eq("job_id", job.id)
      .range(from, from + 999);
    if (!data?.length) break;
    for (const r of data) {
      ahrefsMap[r.target_url] = {
        url_rating: Number(r.url_rating ?? 0),
        domain_rating: Number(r.domain_rating ?? 0),
        ahrefs_rank: Number(r.ahrefs_rank ?? 0),
      };
    }
    if (data.length < 1000) break;
    from += 1000;
  }

  const blMap: Record<string, { ref: number | null; bl: number | null }> = {};
  if (!job.backlinks_skipped) {
    let bf = 0;
    while (true) {
      const { data } = await sb
        .from("har_backlinks_queue")
        .select("target_url, referring_domains, backlinks")
        .eq("job_id", job.id)
        .range(bf, bf + 999);
      if (!data?.length) break;
      for (const r of data) blMap[r.target_url] = { ref: r.referring_domains, bl: r.backlinks };
      if (data.length < 1000) break;
      bf += 1000;
    }
  }

  // Bulk-upsert serp_results metrics in one call per 500-row chunk.
  let sf = 0;
  while (true) {
    const { data } = await sb
      .from("serp_results")
      .select("id, url")
      .eq("project_id", project_id)
      .range(sf, sf + 999);
    if (!data?.length) break;
    const updates = data.map((r: any) => {
      const a = ahrefsMap[r.url] ?? { url_rating: null, domain_rating: null, ahrefs_rank: null };
      const b = blMap[r.url] ?? { ref: null, bl: null };
      return {
        id: r.id,
        url_rating: a.url_rating,
        domain_rating: a.domain_rating,
        ahrefs_rank: a.ahrefs_rank,
        referring_domains: b.ref,
        backlinks: b.bl,
      };
    });
    await chunkedDo(updates, 500, (chunk) => sb.from("serp_results").upsert(chunk, { onConflict: "id" }));
    if (data.length < 1000) break;
    sf += 1000;
  }

  // Client domain metrics
  const clientKey = `https://${clientDomain}`;
  const clientMetrics = ahrefsMap[clientKey] ?? { url_rating: 0, domain_rating: 0, ahrefs_rank: 0 };
  await sb.from("client_domain_metrics").upsert(
    {
      project_id,
      domain: clientDomain,
      url_rating: clientMetrics.url_rating,
      domain_rating: clientMetrics.domain_rating,
      ahrefs_rank: clientMetrics.ahrefs_rank,
      fetched_at: new Date().toISOString(),
    },
    { onConflict: "project_id" },
  );

  // HAR per kept keyword (formula unchanged)
  const kept: Array<{ id: string; ranking_url: string | null }> = [];
  let kf = 0;
  while (true) {
    const { data } = await sb
      .from("keywords")
      .select("id, ranking_url")
      .eq("project_id", project_id)
      .eq("detox_status", "keep")
      .range(kf, kf + 999);
    if (!data?.length) break;
    kept.push(...data);
    if (data.length < 1000) break;
    kf += 1000;
  }

  const harRows: any[] = [];
  for (const kw of kept) {
    const { data: serps } = await sb
      .from("serp_results")
      .select("rank_absolute, url")
      .eq("project_id", project_id)
      .eq("keyword_id", kw.id)
      .order("rank_absolute", { ascending: true });

    let kwClientUR = clientMetrics.url_rating;
    if (kw.ranking_url) {
      const u = kw.ranking_url.startsWith("http")
        ? kw.ranking_url
        : kw.ranking_url.startsWith("/")
          ? `https://${clientDomain}${kw.ranking_url}`
          : `https://${kw.ranking_url}`;
      kwClientUR = ahrefsMap[u]?.url_rating ?? clientMetrics.url_rating;
    }
    let pos: number | null = null;
    let compUR: number | null = null;
    let compUrl: string | null = null;
    for (const c of serps ?? []) {
      const entry = ahrefsMap[c.url];
      const cur = entry?.url_rating;
      // Missing competitor UR: skip — do not let client "beat" an unknown row.
      if (cur === undefined || cur === null) continue;
      if (kwClientUR >= cur) {
        pos = c.rank_absolute;
        compUR = cur;
        compUrl = c.url;
        break;
      }
    }
    harRows.push({
      project_id,
      keyword_id: kw.id,
      har_position: pos,
      client_url_rating: kwClientUR,
      har_competitor_ur: compUR,
      har_competitor_url: compUrl,
      calculated_at: new Date().toISOString(),
    });
  }
  for (let i = 0; i < harRows.length; i += 500) {
    await sb.from("har_results").upsert(harRows.slice(i, i + 500), { onConflict: "keyword_id" });
  }
  await sb.from("har_jobs").update({ har_rows_done: harRows.length }).eq("id", job.id);
}

async function summarise(sb: any, job_id: string) {
  const { data } = await sb.from("har_jobs").select("*").eq("id", job_id).single();
  return { job: data };
}

// ───────────────────────────────────────────────────────────────────────────
// HTTP entrypoint
// ───────────────────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const mode = body.mode ?? "tick";

    // Authorization gate: this function invokes paid external APIs and mutates
    // rows via the service role. Reject anonymous callers.
    const authHeader = req.headers.get("Authorization") ?? "";
    const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const cronSecretHeader = req.headers.get("x-cron-secret") ?? "";
    const cronSecretEnv = Deno.env.get("HAR_CRON_SECRET") ?? "";
    const isInternal =
      bearer === SERVICE_ROLE ||
      (cronSecretEnv.length > 0 && cronSecretHeader === cronSecretEnv);

    // For end-user calls, validate the JWT and (for start/status) the target
    // project visibility. `tick` is only ever fired by our own self-chain or
    // the pg_cron watchdog, so require the service-role bearer or shared secret.
    if (!isInternal) {

      if (!bearer) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (mode === "tick") {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const userClient = createClient(
        SUPABASE_URL,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: authHeader } } },
      );
      const { data: userData, error: userErr } = await userClient.auth.getUser(bearer);
      if (userErr || !userData?.user?.id) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // Resolve project_id (status may pass job_id only) and verify visibility.
      let projectIdToCheck: string | null = body.project_id ?? null;
      if (!projectIdToCheck && body.job_id) {
        const { data: jobRow } = await admin()
          .from("har_jobs").select("project_id").eq("id", body.job_id).maybeSingle();
        projectIdToCheck = jobRow?.project_id ?? null;
      }
      if (!projectIdToCheck) {
        return new Response(JSON.stringify({ error: "project_id or job_id required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data: canProject } = await userClient.rpc("is_visible_project", { _project_id: projectIdToCheck });
      if (!canProject) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    let result: unknown;
    if (mode === "start") {
      if (!body.project_id) throw new Error("project_id required");
      result = await handleStart(body.project_id, body.stalenessDays);
    } else if (mode === "tick") {
      result = await handleTick({ project_id: body.project_id, job_id: body.job_id });
    } else if (mode === "status") {
      const sb = admin();
      if (body.job_id) {
        const { data } = await sb.from("har_jobs").select("*").eq("id", body.job_id).maybeSingle();
        result = { job: data };
      } else if (body.project_id) {
        const { data } = await sb
          .from("har_jobs")
          .select("*")
          .eq("project_id", body.project_id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        result = { job: data };
      } else throw new Error("project_id or job_id required");
    } else {
      throw new Error(`unknown mode: ${mode}`);
    }
    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = typeof err?.statusCode === "number" ? err.statusCode : 500;
    return new Response(JSON.stringify({ error: msg }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});


```

---

## 1.3 supabase/functions/keyword-categorisation/index.ts (verbatim)

### `supabase/functions/keyword-categorisation/index.ts`

````ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { reserveOTPM } from "../_shared/ai-rate-window.ts";

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

async function releaseKeywordIds(supabase: any, ids: string[], errorMessage: string | null = null) {
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    await supabase
      .from("keywords")
      .update({
        categorisation_status: "pending",
        categorisation_locked_at: null,
        categorisation_last_error: errorMessage,
      })
      .in("id", chunk);
  }
}

async function backfillTiers(supabase: any, projectId: string) {
  for (let pass = 0; pass < 10; pass++) {
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
        await supabase.from("keywords").update({ categorisation_tier: tier }).in("id", chunk);
      }
    }
    if (rows.length < 1000) break;
  }
}

async function countRemaining(supabase: any, projectId: string, tier: "live" | "deferred") {
  const { count } = await supabase
    .from("keywords")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("detox_status", "keep")
    .is("tag_1", null)
    .eq("categorisation_tier", tier)
    .neq("categorisation_status", "skipped");
  return count ?? 0;
}

async function countBacklog(supabase: any, projectId: string, tier: "live" | "deferred") {
  const { count } = await supabase
    .from("keywords")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("detox_status", "keep")
    .is("tag_1", null)
    .or(`categorisation_tier.eq.${tier},categorisation_tier.is.null`);
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

  const { data: claimedRows, error: claimErr } = await supabase.rpc("claim_categorisation_batch", {
    _project_id: projectId,
    _tier: tier,
    _limit: CLAIM_LIMIT,
  });
  if (claimErr) throw new Error(`Claim failed: ${claimErr.message}`);
  const claimed = (claimedRows ?? []) as KeywordRow[];

  if (!claimed.length) {
    const remaining = await countRemaining(supabase, projectId, tier);
    await supabase.from("categorisation_jobs").update({
      status: remaining === 0 ? "done" : "queued",
      total,
      processed: Math.max(0, total - remaining),
      finished_at: remaining === 0 ? new Date().toISOString() : null,
      heartbeat_at: new Date().toISOString(),
      next_run_at: remaining === 0 ? new Date().toISOString() : new Date(Date.now() + 60_000).toISOString(),
    }).eq("id", jobId);
    return { done: remaining === 0, job_id: jobId, total, remaining, processed: Math.max(0, total - remaining) };
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
  const aiProcessed = new Set<string>();

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
      aiProcessed.add(key);
      fromAi += kwRows.length;
    }
  }

  // Promote keywords whose claimed rows are near the attempt limit so the
  // fallback path catches them on the next tick instead of looping forever.
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
    let outcome = await runAiBatch({ supabase, apiKey, aiBatch: batch, perKwBudget: 140, ctx, intentHintByKw });
    if (outcome.rateLimited) {
      rateLimited = true;
      retryAfterSeconds = outcome.retryAfter;
      break;
    }
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

  const uncompletedIds: string[] = [];
  for (const r of claimed) if (!completedIds.has(r.id)) uncompletedIds.push(r.id);

  // Rows that repeatedly fail get a low-confidence fallback so one bad keyword
  // can never block a thousand-keyword job forever.
  const fallbackIds: string[] = [];
  const releaseIds: string[] = [];
  for (const [kwText, kwRows] of rowsByKeyword) {
    const pendingRows = kwRows.filter((r) => !completedIds.has(r.id));
    if (!pendingRows.length) continue;
    const shouldFallback = pendingRows.some((r: any) => (r.categorisation_attempts ?? 0) >= 4);
    if (shouldFallback) {
      const payload = fallbackPayload(kwText, ctx.project, intentHintByKw.get(kwText)?.intent ?? null);
      await updateKeywordIds(supabase, pendingRows.map((r) => r.id), payload);
      pendingRows.forEach((r) => completedIds.add(r.id));
      fallbackIds.push(...pendingRows.map((r) => r.id));
      fromFastPath += pendingRows.length;
    } else {
      releaseIds.push(...pendingRows.map((r) => r.id));
    }
  }
  if (releaseIds.length) await releaseKeywordIds(supabase, releaseIds, rateLimited ? "waiting for AI rate-limit window" : lastError);

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
    fromAi,
    fallback: fallbackIds.length,
    released: releaseIds.length,
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

````

---

## 1.4 supabase/functions/categorisation-deferred-tick/index.ts (verbatim)

### `supabase/functions/categorisation-deferred-tick/index.ts`

```ts
// Nightly cron entry point: walks every project that has deferred-tier
// uncategorised keywords and invokes `keyword-categorisation` with
// `tier: "deferred"` for each. The work itself is rate-limited by the
// shared OTPM governor so multiple projects don't trip Anthropic's cap.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Auth gate: this cron function spends paid Anthropic credits across every
    // project. Require the service-role bearer or the shared HAR_CRON_SECRET
    // (same convention used by har-calculation) — reject anonymous callers.
    const authHeader = req.headers.get("Authorization") ?? "";
    const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const cronSecret = req.headers.get("x-cron-secret") ?? "";
    const cronSecretEnv = Deno.env.get("HAR_CRON_SECRET") ?? "";
    const isInternal =
      (bearer.length > 0 && bearer === serviceKey) ||
      (cronSecretEnv.length > 0 && cronSecret === cronSecretEnv);
    if (!isInternal) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Find projects with deferred backlog.
    const { data: backlog } = await supabase
      .from("keywords")
      .select("project_id")
      .eq("detox_status", "keep")
      .is("tag_1", null)
      .eq("categorisation_tier", "deferred")
      .limit(5000);

    const projectIds = Array.from(new Set((backlog ?? []).map((r: any) => r.project_id)));
    let totalInvocations = 0;

    for (const projectId of projectIds) {
      // Loop the worker until done or rate-limited; cap at 50 invocations per
      // project per nightly run so we never live-lock a single project.
      for (let i = 0; i < 50; i++) {
        const resp = await fetch(`${supabaseUrl}/functions/v1/keyword-categorisation`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceKey}`,
            apikey: serviceKey,
          },
          body: JSON.stringify({ project_id: projectId, tier: "deferred" }),
        });
        totalInvocations += 1;
        if (!resp.ok) break;
        const data = await resp.json();
        if (data?.rateLimited) {
          const wait = Math.min(60, data.retryAfterSeconds ?? 30);
          await new Promise((r) => setTimeout(r, wait * 1000));
          continue;
        }
        if (data?.done || (data?.remaining ?? 0) === 0) break;
        if ((data?.processed ?? 0) === 0) break; // stalled
      }
    }

    return new Response(
      JSON.stringify({ ok: true, projects: projectIds.length, invocations: totalInvocations }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("categorisation-deferred-tick error", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

```
