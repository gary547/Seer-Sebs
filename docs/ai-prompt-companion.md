# Seer — AI Prompt Companion

A verbatim reference of every AI call the app makes. Each section has the same depth: what it is, where it lives, model + parameters, system prompt, user prompt, tool schema, inputs consumed, outputs written, downstream calculation impact.

Model call-outs are on **every** section.

---

## 1. Keyword Detox — Pass 1 & Pass 2

**File:** `supabase/functions/keyword-detox/index.ts`

**Model:** `claude-sonnet-4-6` (both passes) via `https://api.anthropic.com/v1/messages`.

**Parameters**
- Pass 1: `max_tokens = min(4000, batch.length * 50 + 200)`, `PASS1_BATCH = 50`, `PASS1_CONCURRENCY` env-driven, `tool_choice = detox_pass1`.
- Pass 2: `max_tokens = min(3000, batch.length * 60 + 200)`, `PASS2_BATCH = 25`, `tool_choice = detox_pass2`, Pass 2 system suffixed with `"\n\nYou are the second-pass adjudicator. Be strict and decisive."`.
- Retries: 4 attempts with backoffs `[4s, 12s, 30s]` on 429/529/5xx. Fatal errors (`invalid_api_key`, `authentication_error`, `permission_error`, `billing`) → job `blocked`.

**System prompt (verbatim, both passes)**

```
You are an SEO keyword analyst performing keyword detoxification.

CLIENT:
- Name: ${client.company_name}
- Domain: ${client.domain}
- Industry: ${client.industry || "not specified"}
- Campaign type: ${client.campaign_type || "not specified"}
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
- Reason: a short phrase, max 12 words.
```

**User prompt — Pass 1**

```
KEYWORDS:
${batch.join("\n")}

Use the detox_pass1 tool to return one row per keyword.
```

**User prompt — Pass 2**

```
Re-evaluate these keywords carefully. Some were borderline in the first pass.

KEYWORDS:
${batch.join("\n")}

Use the detox_pass2 tool. Return a final keep or remove for each.
```

**Tool — `detox_pass1`**

```json
{
  "type": "object",
  "properties": {
    "results": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "keyword":    { "type": "string" },
          "verdict":    { "type": "string", "enum": ["keep", "remove", "uncertain"] },
          "reason":     { "type": "string" },
          "confidence": { "type": "number" }
        },
        "required": ["keyword", "verdict", "reason", "confidence"]
      }
    }
  },
  "required": ["results"]
}
```

**Tool — `detox_pass2`** (same shape without `confidence`, `verdict` enum = `["keep","remove"]`).

**Pass 2 selection rules** (in code, not the LLM): a keyword goes to Pass 2 if it was `uncertain`, or `keep` with a brand token overlap, or `remove` with confidence < 0.55, or as a random 2 % audit sample of confident keeps (`AUDIT_RATE`).

**Inputs consumed**: `keywords.keyword` (canonicalised), `clients.own_brand_tokens`, `clients.competitor_brands`, `keyword_rules` (whitelist/blacklist applied *before* the LLM as a rules pre-pass), and same-client cache from prior `keywords.detox_status`.

**Outputs written**: `keywords.detox_status`, `.detox_reason`, `.detox_confidence`; `detox_audit(*)`; `detox_run_stats(*)`; `detox_jobs.status/.block_reason/.heartbeat_at`.

**Downstream impact**: sets the `detox_status = 'keep'` filter every other calculation depends on (enrichment, HAR, forecasts, categorisation, site architecture, content plan, roadmap). Removals silently drop keywords from all revenue numbers.

---

## 2. Keyword Categorisation (live + deferred tiers)

**File:** `supabase/functions/keyword-categorisation/index.ts`

**Model:** `claude-haiku-4-5` via `https://api.anthropic.com/v1/messages`.

**Parameters**
- `AI_BATCH_SIZE = 15` (env `CAT_AI_BATCH_SIZE`), `MAX_AI_BATCHES_PER_TICK = 5`.
- `max_tokens = min(3000, aiBatch.length * perKwBudget + 500)`; `perKwBudget` defaults ~22 tokens/kw + 120 overhead.
- OTPM governor via `reserveOTPM(supabase, MODEL, dynamicMaxTokens)` writing to `ai_rate_window`.
- Tier routing: transactional/commercial → `live`; long-tail (≥5 words) informational/navigational/unknown → `deferred` (cron-driven at 02:00 UTC via `categorisation-deferred-tick`).
- `tool_choice = categorise_keywords`.

**System prompt (verbatim)**

```
You are an SEO keyword categoriser. For each keyword, assign a category hierarchy and classify search intent.

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

Intent must be exactly transactional, commercial, informational, or navigational. Use low confidence only when genuinely ambiguous.
```

**User prompt**

```
CLIENT CONTEXT:
- Client: ${ctx.client.company_name}
- Industry: ${ctx.client.industry || "not specified"}
- Category focus: ${project.category_focus || "not specified"}

KEYWORDS:
${keywordListWithHints}    // one per line; suffix "[intent=xxx]" when a hint is available

Use the categorise_keywords tool. Return one item per keyword.
```

**Tool — `categorise_keywords`**

```json
{
  "type": "object",
  "properties": {
    "results": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "keyword":            { "type": "string" },
          "tag_1":              { "type": "string" },
          "tag_2":              { "type": "string" },
          "tag_3":              { "type": "string" },
          "tag_4":              { "type": "string" },
          "tag_5":              { "type": "string" },
          "search_intent":      { "type": "string", "enum": ["transactional","commercial","informational","navigational"] },
          "intent_confidence":  { "type": "string", "enum": ["high","low"] }
        },
        "required": ["keyword","tag_1","search_intent","intent_confidence"]
      }
    }
  },
  "required": ["results"]
}
```

**Inputs consumed**: `keywords.keyword`, existing `tag_1` vocabulary (capped by `VOCAB_CAP_DEFAULT`), `keyword_rules` (whitelist/blacklist topics), `clients.company_name/.industry`, `navigator_projects.category_focus`, prior intent hint if any.

**Outputs written**: `keywords.tag_1..tag_5`, `.search_intent`, `.intent_confidence`, `.intent_source='ai'`, `.categorisation_status`, `.categorisation_tier`, `.categorisation_attempts`, `categorisation_jobs(*)`.

**Downstream impact**: `search_intent` feeds the CTR resolver in `compute-forecasts`; `tag_1` powers cluster grouping in `content-plan-generate` and roadmap segmentation.

---

## 3. Categorisation Consolidate

**File:** `supabase/functions/categorisation-consolidate/index.ts`

**Model:** `claude-sonnet-4-5` via `https://api.anthropic.com/v1/messages`.

**Parameters:** `max_tokens = 2000`, `tool_choice = propose_mapping`. Only invoked when there are ≥ 2 non-intent Tag 1 values to potentially merge. Intent-labeled Tag 1 values (`transactional`/`commercial`/`informational`/`navigational`) are auto-cleared *without* going to the LLM.

**System prompt (verbatim)**

```
You are an SEO taxonomist consolidating duplicate / near-duplicate Tag 1 category labels for a single client.

Rules:
- Output a JSON mapping { "oldTag": "newTag" } where newTag is the canonical value.
- Only include entries you want to RENAME. Tags that should stay as-is must NOT appear in the mapping (they default to KEEP).
- Choose the canonical value with the HIGHEST keyword count when merging duplicates.
- Singular form, Title Case (e.g. "Weight Loss" not "weightloss").
- Never use intent labels (Transactional / Commercial / Informational / Navigational) as a target — those are intent, not topics.
- Only merge tags that are clearly the same topic. When in doubt, keep them separate.
```

**User prompt**

```
EXISTING TAG 1 VALUES (with row counts):
${tagList}          // "- \"Weight Loss\" (312 kw)" per line

Use the propose_mapping tool. Return only the renames you propose.
```

**Tool — `propose_mapping`**

```json
{
  "type": "object",
  "properties": {
    "renames": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "from": { "type": "string" },
          "to":   { "type": "string" }
        },
        "required": ["from","to"]
      }
    }
  },
  "required": ["renames"]
}
```

**Inputs consumed**: distinct `keywords.tag_1` values + counts scoped to a single client.

**Outputs written**: preview-only in this call (mapping returned to the UI); the actual `keywords.tag_1` updates happen in a follow-up admin call once the user confirms.

**Downstream impact**: cleans up cluster keys used by `content-plan-generate` and dashboard cluster reporting.

---

## 4. Site Architecture Scoring

**File:** `supabase/functions/site-architecture/index.ts`

**Model:** `google/gemini-3-flash-preview` via **Lovable AI Gateway** (`https://ai.gateway.lovable.dev/v1/chat/completions`, Bearer `LOVABLE_API_KEY`).

**Parameters:** `AI_BATCH_SIZE = 30`, `AI_RETRY_BATCH_SIZE = 10`, `MAX_TOKENS = 2048`. On malformed/empty tool calls the batch is split into 10-row chunks and retried once. Handles 402 (payment required) and 429 by returning a rate-limit notice with `retry-after`.

**System prompt (verbatim)**

```
You are an SEO site architecture analyst. Client domain: ${clientDomain}.
For each row "idx|keyword|url|intent" decide:
- relevancy_score (0-1): how well url matches keyword intent.
- content_status: "green" (well optimised), "amber" (needs work), "red" (poor match).
- tactical_rag_status: "no_action_needed" | "optimise_content" | "create_content" | "new_content".
```

**User prompt**

```
0|black tea benefits|https://example.com/black-tea|informational
1|buy loose leaf|https://example.com/shop/loose-leaf|transactional
...
```

**Tool — `score_rows`** (OpenAI-style function tool)

```json
{
  "type": "object",
  "properties": {
    "results": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "idx":                 { "type": "number" },
          "relevancy_score":     { "type": "number" },
          "content_status":      { "type": "string", "enum": ["green","amber","red"] },
          "tactical_rag_status": { "type": "string", "enum": ["no_action_needed","optimise_content","create_content","new_content"] }
        },
        "required": ["idx","relevancy_score","content_status","tactical_rag_status"],
        "additionalProperties": false
      }
    }
  },
  "required": ["results"],
  "additionalProperties": false
}
```

**Inputs consumed**: distinct `keywords.keyword × ranking_url × search_intent` signatures for kept keywords.

**Outputs written**: `site_architecture.relevancy_score`, `.content_status`, `.tactical_rag_status`, `.matched_url` per keyword.

**Downstream impact**: `content-plan-generate` uses `tactical_rag_status` to pick `content_action` (`optimise` / `watch` / `create`); `roadmap-to-success` surfaces the status as evidence in the roadmap payload. **Not consumed by revenue or HAR calculations today.**

---

## 5. Content Plan Briefing

**File:** `supabase/functions/content-plan-generate/index.ts`

**Model:** `claude-sonnet-4-5` via `https://api.anthropic.com/v1/messages`.

**Parameters:** `max_tokens = 12000`. Single batched call over up to `finalItems.length` clusters (currently capped at 12 in the SERP top-3 prefetch). No tool use — expects raw JSON array in the response text.

**System prompt (verbatim)**

```
You are a senior SEO content strategist. For each item below, return a single JSON array with one object per idx with fields:
- idx (number)
- page_title_h1 (string, ≤70 chars)
- meta_title (string, ≤60 chars)
- meta_description (string, ≤160 chars)
- synopsis (string, 3 short paragraphs separated by \n\n. Para 1: who/why. Para 2: "Sections to include:" followed by a bullet list (use - prefix) of suggested H2/H3 sections derived from the SERP top 3 + cluster keywords. Para 3: "Content gaps:" bullet list of themes the SERP top 3 cover that we should match plus whitespace neither covers.)
- suggested_h2 (string[] of 4-7 items)
- internal_link_anchors (string[] of 3-5 likely anchor phrases for inbound internal links)

Respond with ONLY the JSON array. No prose, no code fences.
```

**User prompt**

```
Items:
[
  {
    "idx": 0,
    "format": "hero",
    "primary_keyword": "loose leaf black tea",
    "secondary_keywords": ["...", "..."],
    "intent": "commercial",
    "recommended_url": "https://example.com/loose-leaf",
    "arch_status": "optimise",
    "potential_revenue_gain": 12345,
    "serp_top3": [ { "url": "...", "title": "...", "snippet": "..." }, ... ]
  },
  ...
]
```

**No tool schema** — response parsed as JSON with `extractJson()`; on failure, item rows fall back to keyword text and empty AI fields.

**Inputs consumed** (from other tables, into the payload code, not the prompt directly): `keyword_forecasts.est_current_revenue_annual/.har_revenue_gain_annual/.yearly_revenue_gain_rank1`, `keywords.tag_1`, `site_architecture.tactical_rag_status`, `serp_top3_cache` / live DFS SERP.

**Outputs written**: `content_plan_items.page_title_h1/.meta_title/.meta_description/.synopsis/.internal_links/.notes/.publish_month/.first_draft_deadline/.potential_revenue_gain/.hero_promoted/.cluster_score`, `content_plans.total_revenue_gain`, `content_plan_jobs.status/.processed/.finished_at`.

**Downstream impact**: `publish_month = peak_month - 8 weeks`; `first_draft_deadline = publish_month - (hero_lead_weeks=16 | default_lead_weeks=12) * 7 days`. These are scheduling outputs — not part of revenue or HAR.

---

## 6. Roadmap to Success

**File:** `supabase/functions/roadmap-to-success/index.ts`

**Model:** `claude-sonnet-4-6` via `https://api.anthropic.com/v1/messages`.

**Parameters:** `max_tokens = 1800`. No tool use — expects plain markdown back.

**System prompt (verbatim)**

```
You are an SEO, content marketing, and digital PR strategist with 15 years of experience across complex ecommerce and B2B brands.
Create a practical roadmap to success using only the project data provided.
Prioritise commercially meaningful actions based on priority tier, TP revenue uplift, site architecture gaps, and link gaps.
Avoid generic advice. Every recommendation must cite the keyword/cluster, URL, evidence, action, and expected commercial impact.
Write concise markdown with 3-5 numbered actions. Include digital PR recommendations only when link-gap evidence supports it.
```

**User prompt** (JSON-serialised payload)

```
{
  "project": {
    "name": "…",
    "category_focus": "…",
    "client": "…",
    "domain": "…"
  },
  "opportunities": [
    {
      "keyword": "…",
      "tag_1": "…",
      "intent": "…",
      "priority_tier": "…",
      "current_position": 12,
      "har": 4,
      "tp_revenue_uplift": "£12,345",
      "ranking_url": "https://…",
      "architecture_action": "optimise_content",
      "architecture_fit": "68%",
      "architecture_status": "amber",
      "matched_url": "https://…",
      "client_url_rating": 42,
      "competitor_url_rating_at_tp": 55,
      "link_gap_points": 13,
      "competitor_url_at_tp": "https://competitor.com/…"
    },
    …
  ]
}
```

**No tool schema.**

**Inputs consumed**: joins across `navigator_projects`, `clients`, `keywords`, `keyword_forecasts`, `har_results`, `site_architecture`, `client_domain_metrics`.

**Outputs written**: `project_roadmaps.roadmap_markdown` (new row per generation; searchable History tab).

**Downstream impact**: Advisory output only. Does not modify any calculation input.

---

*End of prompt companion.*
