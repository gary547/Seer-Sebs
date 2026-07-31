// Unit tests for the deterministic branches in site-architecture.
//
// The three deterministic paths (no-volume watch, no-URL create_content,
// ruleClassify low-volume no-URL) must write relevancy_score = NULL rather
// than 0, so HAR v2 can distinguish "not evaluated" from a genuine
// evaluated-irrelevant verdict. Genuine evaluation paths (slug match, AI)
// may still emit any score, including 0.
//
// We test the pure branch logic — matching the shape used inside the
// serve handler — rather than booting the full Deno.serve loop.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

type Upsert = {
  keyword_id: string;
  matched_url: string | null;
  relevancy_score: number | null;
  content_status: string;
  tactical_rag_status: string;
};

// Mirrors the two Phase 0 branches inside serve().
function classifyDeterministic(kw: {
  id: string;
  ranking_url: string | null;
  avg_monthly_volume: number | null;
}): Upsert | null {
  const vol = kw.avg_monthly_volume ?? 0;
  if (vol <= 0) {
    return {
      keyword_id: kw.id,
      matched_url: kw.ranking_url,
      relevancy_score: null,
      content_status: "amber",
      tactical_rag_status: "watch",
    };
  }
  if (!kw.ranking_url) {
    return {
      keyword_id: kw.id,
      matched_url: null,
      relevancy_score: null,
      content_status: "red",
      tactical_rag_status: "create_content",
    };
  }
  return null;
}

// Mirrors ruleClassify's no-URL/low-volume short-circuit and slug-match path.
function ruleClassify(args: {
  keyword: string;
  ranking_url: string | null;
  avg_monthly_volume: number | null;
}) {
  if (!args.ranking_url) {
    if ((args.avg_monthly_volume ?? 0) < 50) {
      return {
        matched_url: null,
        relevancy_score: null,
        content_status: "red",
        tactical_rag_status: "create_content",
      };
    }
    return null;
  }
  // Slug match (exact-token) — genuine evaluation, may emit non-null score.
  const kwTokens = args.keyword.toLowerCase().split(/\s+/);
  const path = new URL(args.ranking_url).pathname.toLowerCase();
  if (kwTokens.every((t) => path.includes(t))) {
    return {
      matched_url: args.ranking_url,
      relevancy_score: 0.9,
      content_status: "green",
      tactical_rag_status: "no_action_needed",
    };
  }
  return null;
}

Deno.test("Phase 0a — no volume → watch with NULL score", () => {
  const out = classifyDeterministic({ id: "a", ranking_url: "https://x.com/a", avg_monthly_volume: 0 });
  assertEquals(out?.relevancy_score, null);
  assertEquals(out?.tactical_rag_status, "watch");
  assertEquals(out?.content_status, "amber");
});

Deno.test("Phase 0a — null volume → watch with NULL score", () => {
  const out = classifyDeterministic({ id: "a", ranking_url: null, avg_monthly_volume: null });
  assertEquals(out?.relevancy_score, null);
  assertEquals(out?.tactical_rag_status, "watch");
});

Deno.test("Phase 0b — no URL + positive volume → create_content with NULL score", () => {
  const out = classifyDeterministic({ id: "b", ranking_url: null, avg_monthly_volume: 500 });
  assertEquals(out?.relevancy_score, null);
  assertEquals(out?.tactical_rag_status, "create_content");
  assertEquals(out?.content_status, "red");
  assertEquals(out?.matched_url, null);
});

Deno.test("Phase 0 no-op — URL present + positive volume returns null (goes to rules/AI)", () => {
  const out = classifyDeterministic({ id: "c", ranking_url: "https://x.com/c", avg_monthly_volume: 500 });
  assertEquals(out, null);
});

Deno.test("ruleClassify — no URL + volume < 50 → NULL score, create_content", () => {
  const out = ruleClassify({ keyword: "foo bar", ranking_url: null, avg_monthly_volume: 10 });
  assertEquals(out?.relevancy_score, null);
  assertEquals(out?.tactical_rag_status, "create_content");
});

Deno.test("ruleClassify — slug match still returns 0.9 (genuine evaluated verdict preserved)", () => {
  const out = ruleClassify({
    keyword: "widgets",
    ranking_url: "https://example.com/widgets",
    avg_monthly_volume: 500,
  });
  assertEquals(out?.relevancy_score, 0.9);
  assertEquals(out?.tactical_rag_status, "no_action_needed");
});

Deno.test("AI evaluated-irrelevant verdict of 0 is preserved (not nulled)", () => {
  // Simulates the applyParsedResults path: AI can legitimately return 0.
  const aiScore = 0;
  const upsert: Upsert = {
    keyword_id: "d",
    matched_url: "https://x.com/d",
    relevancy_score: Math.min(1, Math.max(0, aiScore)),
    content_status: "red",
    tactical_rag_status: "optimise_content",
  };
  assertEquals(upsert.relevancy_score, 0);
});

// ---------------------------------------------------------------------------
// Score preservation (Gate A closure — advisor option i).
//
// Deterministic branches must NEVER overwrite an existing non-null
// relevancy_score. When the previous row has a genuine evaluated score,
// the deterministic re-run may still update tactical_rag_status /
// content_status / matched_url, but the score and its last_evaluated_at
// are carried forward.
// ---------------------------------------------------------------------------

type UpsertPreserve = Upsert & { last_evaluated_at: string | null };
type PriorRow = { relevancy_score: number | null; last_evaluated_at: string | null };

function buildDeterministic(
  kwId: string,
  fallback: Omit<UpsertPreserve, "keyword_id" | "relevancy_score" | "last_evaluated_at">,
  prior: PriorRow | undefined,
): UpsertPreserve {
  if (prior && prior.relevancy_score != null) {
    return {
      keyword_id: kwId,
      ...fallback,
      relevancy_score: prior.relevancy_score,
      last_evaluated_at: prior.last_evaluated_at,
    };
  }
  return { keyword_id: kwId, ...fallback, relevancy_score: null, last_evaluated_at: null };
}
function buildFresh(u: Omit<UpsertPreserve, "last_evaluated_at">, nowIso: string): UpsertPreserve {
  return { ...u, last_evaluated_at: nowIso };
}

Deno.test("preservation: deterministic branch on kw with existing 0.72 preserves 0.72", () => {
  const prior: PriorRow = { relevancy_score: 0.72, last_evaluated_at: "2026-07-01T00:00:00Z" };
  const out = buildDeterministic("k1", {
    matched_url: null,
    content_status: "red",
    tactical_rag_status: "create_content",
  }, prior);
  assertEquals(out.relevancy_score, 0.72);
  assertEquals(out.last_evaluated_at, "2026-07-01T00:00:00Z");
  // status still moves to the current deterministic verdict.
  assertEquals(out.tactical_rag_status, "create_content");
});

Deno.test("preservation: deterministic branch on kw with prior 0 preserves 0 (genuine verdict)", () => {
  const prior: PriorRow = { relevancy_score: 0, last_evaluated_at: "2026-07-05T00:00:00Z" };
  const out = buildDeterministic("k2", {
    matched_url: null,
    content_status: "amber",
    tactical_rag_status: "watch",
  }, prior);
  // 0 is a valid evaluated score — MUST NOT be nulled.
  assertEquals(out.relevancy_score, 0);
  assertEquals(out.last_evaluated_at, "2026-07-05T00:00:00Z");
});

Deno.test("preservation: deterministic branch with no prior row writes NULL score, no timestamp", () => {
  const out = buildDeterministic("k3", {
    matched_url: null,
    content_status: "red",
    tactical_rag_status: "create_content",
  }, undefined);
  assertEquals(out.relevancy_score, null);
  assertEquals(out.last_evaluated_at, null);
});

Deno.test("preservation: deterministic branch with prior NULL score writes NULL, no timestamp", () => {
  const prior: PriorRow = { relevancy_score: null, last_evaluated_at: null };
  const out = buildDeterministic("k4", {
    matched_url: null,
    content_status: "amber",
    tactical_rag_status: "watch",
  }, prior);
  assertEquals(out.relevancy_score, null);
  assertEquals(out.last_evaluated_at, null);
});

Deno.test("fresh evaluation stamps last_evaluated_at = now, overwrites prior score", () => {
  const nowIso = "2026-07-17T14:00:00Z";
  const aiVerdict = { keyword_id: "k5", matched_url: "https://x.com/k5", relevancy_score: 0.42, content_status: "amber", tactical_rag_status: "optimise_content" };
  const out = buildFresh(aiVerdict, nowIso);
  assertEquals(out.relevancy_score, 0.42);
  assertEquals(out.last_evaluated_at, nowIso);
});

