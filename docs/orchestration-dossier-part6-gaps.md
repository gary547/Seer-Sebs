# Orchestration Dossier — Part 6 (Gaps)

Read-only supplement closing five items omitted from Parts 1–5.
Date: 2026-07-21. Project: Seer (Supabase ref `xvkfuakwhujtjeaybtzu`).

All figures below are backed by SQL against the live database (queried via
`supabase--read_query`) or by verbatim file reads. No code, migrations, or
job triggers were executed.

---

## 1. Verbatim source: `supabase/functions/ranking-url-lookup/index.ts`

Full 322-line file, unmodified, copied from the working tree:

```typescript
// Boot evidence (guardrail 6):
console.log(`[boot] ranking-url-lookup ${new Date().toISOString()}`);

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const DATAFORSEO_BASE = "https://api.dataforseo.com";

function buildBasicAuth(secret: string): string {
  if (secret.includes(":")) return btoa(secret);
  return secret;
}

function extractItems(json: any, endpoint: string): any[] {
  const tasks = json?.tasks;
  if (!Array.isArray(tasks) || !tasks.length) {
    console.error(`[${endpoint}] No tasks in response:`, JSON.stringify(json?.status_message || json));
    return [];
  }
  const task = tasks[0];
  if (task.status_code !== 20000) {
    console.error(`[${endpoint}] Task failed: ${task.status_code} ${task.status_message}`);
    return [];
  }
  const result = task.result;
  if (!Array.isArray(result) || !result.length) return [];
  if (result[0]?.items && Array.isArray(result[0].items)) {
    return result[0].items;
  }
  return result;
}

async function isCancelled(supabase: any, projectId: string): Promise<boolean> {
  const { data } = await supabase
    .from("navigator_projects")
    .select("ranking_lookup_status")
    .eq("id", projectId)
    .single();
  return data?.ranking_lookup_status === "stopping";
}

async function setStatus(supabase: any, projectId: string, status: string) {
  await supabase
    .from("navigator_projects")
    .update({ ranking_lookup_status: status })
    .eq("id", projectId);
}

/**
 * Background processing — filters DataForSEO by our keywords in batches
 */
async function processRankingLookup(
  project_id: string,
  authHeader: string,
) {
  const DATAFORSEO_API_KEY = Deno.env.get("DATAFORSEO_API_KEY")!;
  const dfBasicAuth = buildBasicAuth(DATAFORSEO_API_KEY);
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const supabaseUser = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    await setStatus(supabase, project_id, "running");

    // Get project + client domain
    const { data: project, error: projErr } = await supabaseUser
      .from("navigator_projects")
      .select("client_id, clients(domain)")
      .eq("id", project_id)
      .single();
    if (projErr || !project) throw new Error("Project not found");

    const domain = (project.clients as any)?.domain;
    if (!domain) throw new Error("Client domain not set");

    const cleanDomain = domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    console.log(`[BG] Using domain: ${cleanDomain}`);

    // Fetch kept keywords that don't yet have a ranking_url AND haven't been
    // recently checked (or were last checked outside the freshness window).
    // This stops us re-paying DataForSEO for known no-matches every sync.
    const FRESHNESS_DAYS = 7;
    const stalenessCutoff = new Date(Date.now() - FRESHNESS_DAYS * 86400 * 1000).toISOString();
    const allKeywords: Array<{ id: string; keyword: string }> = [];
    let from = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await supabaseUser
        .from("keywords")
        .select("id, keyword, ranking_url, ranking_lookup_checked_at")
        .eq("project_id", project_id)
        .eq("detox_status", "keep")
        .is("ranking_url", null)
        .or(`ranking_lookup_checked_at.is.null,ranking_lookup_checked_at.lt.${stalenessCutoff}`)
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`Failed to fetch keywords: ${error.message}`);
      if (!data?.length) break;
      allKeywords.push(...data.map((d: any) => ({ id: d.id, keyword: d.keyword })));
      if (data.length < PAGE) break;
      from += PAGE;
    }

    if (!allKeywords.length) {
      console.log("[BG] No keywords to look up");
      await setStatus(supabase, project_id, "idle");
      return;
    }

    console.log(`[BG] Total keywords to look up: ${allKeywords.length}`);

    // Build keyword map for matching
    const kwMap = new Map<string, string>();
    for (const kw of allKeywords) {
      kwMap.set(kw.keyword.toLowerCase().trim(), kw.id);
    }

    const dfHeaders = {
      Authorization: `Basic ${dfBasicAuth}`,
      "Content-Type": "application/json",
    };

    // Process keywords in batches, filtering server-side via DataForSEO
    const BATCH_SIZE = 700; // Safe batch for filter "in" operator
    const kwList = Array.from(kwMap.keys());
    let matched = 0;
    let batchNum = 0;
    const matchedIds = new Set<string>();

    for (let i = 0; i < kwList.length; i += BATCH_SIZE) {
      batchNum++;
      const batch = kwList.slice(i, i + BATCH_SIZE);

      // Check for cancellation before each batch
      if (await isCancelled(supabase, project_id)) {
        console.log(`[BG] Cancelled at batch ${batchNum}, matched=${matched}`);
        await setStatus(supabase, project_id, "idle");
        return;
      }

      console.log(`[BG] Batch ${batchNum}: ${batch.length} keywords (offset ${i})`);

      // Paginate within this batch's filtered results
      let offset = 0;
      const LIMIT = 1000;

      while (true) {
        const res = await fetch(`${DATAFORSEO_BASE}/v3/dataforseo_labs/google/ranked_keywords/live`, {
          method: "POST",
          headers: dfHeaders,
          body: JSON.stringify([{
            target: cleanDomain,
            location_code: 2826,
            language_code: "en",
            ignore_synonyms: true,
            include_clickstream_data: false,
            load_rank_absolute: false,
            item_types: ["organic"],
            historical_serp_mode: "live",
            filters: ["keyword_data.keyword", "in", batch],
            order_by: ["keyword_data.keyword,asc"],
            limit: LIMIT,
            offset: offset,
          }]),
        });

        if (!res.ok) {
          const body = await res.text();
          throw new Error(`DataForSEO HTTP ${res.status}: ${body.slice(0, 300)}`);
        }

        const json = await res.json();
        const items = extractItems(json, "ranked_keywords");

        if (offset === 0) {
          const total = json?.tasks?.[0]?.result?.[0]?.total_count ?? 0;
          console.log(`[BG] Batch ${batchNum} matched ${total} keywords in DataForSEO`);
        }

        if (!items.length) break;

        // Collect updates from this page
        const updates: Array<{ id: string; ranking_url: string; base_rank: number }> = [];
        for (const item of items) {
          const kw = item?.keyword_data?.keyword;
          if (!kw) continue;

          const kwLower = kw.toLowerCase().trim();
          const kwId = kwMap.get(kwLower);
          if (!kwId) continue;

          const serpItem = item?.ranked_serp_element?.serp_item;
          const rankingUrl = serpItem?.relative_url || serpItem?.url || null;
          const rankPosition = serpItem?.rank_group ?? serpItem?.rank_absolute ?? null;

          if (rankingUrl && rankPosition != null) {
            updates.push({ id: kwId, ranking_url: rankingUrl, base_rank: rankPosition });
          }
        }

        // Batch DB updates in chunks of 50 concurrent requests
        const CHUNK = 50;
        const nowIso = new Date().toISOString();
        for (let c = 0; c < updates.length; c += CHUNK) {
          const chunk = updates.slice(c, c + CHUNK);
          const results = await Promise.all(
            chunk.map((u) =>
              supabase
                .from("keywords")
                .update({
                  ranking_url: u.ranking_url,
                  base_rank: u.base_rank,
                  base_rank_source: "dfs_labs",
                  base_rank_checked_at: nowIso,
                  ranking_lookup_checked_at: nowIso,
                  ranking_lookup_no_match: false,
                })
                .eq("id", u.id)
            )
          );
          results.forEach((r, idx) => {
            if (r.error) {
              console.error(`[BG] Batch update error: ${r.error.message}`);
            } else {
              matched++;
              matchedIds.add(chunk[idx].id);
            }
          });
        }

        offset += LIMIT;
        if (items.length < LIMIT) break;
      }
    }

    // Mark every keyword we tried but didn't match as "no match, checked now"
    // so the next sync skips them within the freshness window.
    const nowIso2 = new Date().toISOString();
    const unmatched = allKeywords.filter((k) => !matchedIds.has(k.id)).map((k) => k.id);
    const NM_CHUNK = 200;
    for (let i = 0; i < unmatched.length; i += NM_CHUNK) {
      const ids = unmatched.slice(i, i + NM_CHUNK);
      const { error } = await supabase
        .from("keywords")
        .update({ ranking_lookup_checked_at: nowIso2, ranking_lookup_no_match: true })
        .in("id", ids);
      if (error) console.error(`[BG] no-match stamp error: ${error.message}`);
    }

    console.log(`[BG] Complete: matched=${matched}, no_match=${unmatched.length}, total=${allKeywords.length}`);
    await setStatus(supabase, project_id, "idle");
  } catch (error) {
    console.error("[BG] ranking-url-lookup error:", error);
    await setStatus(supabase, project_id, "idle");
  }
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

    const { project_id, action } = await req.json();
    if (!project_id) throw new Error("project_id is required");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Handle stop action
    if (action === "stop") {
      await setStatus(supabase, project_id, "stopping");
      return new Response(
        JSON.stringify({ status: "stopping", message: "Stop signal sent" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Start background processing
    // @ts-ignore EdgeRuntime.waitUntil is a Supabase-specific API
    EdgeRuntime.waitUntil(
      processRankingLookup(project_id, authHeader).catch((err) => {
        console.error("[BG] Unhandled error:", err);
        setStatus(supabase, project_id, "idle");
      })
    );

    return new Response(
      JSON.stringify({ status: "processing", message: "Ranking URL lookup started in background" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("ranking-url-lookup error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
```

---

## 2. Verbatim RPC definitions (claim / lock / progress)

Source: `SELECT pg_get_functiondef(oid) FROM pg_proc WHERE pronamespace='public' AND proname IN (…)`.
`claim_detox_batch` **does not exist** — a namespace-wide search (`proname ILIKE '%detox%' OR proname ILIKE '%claim%'`) returned only the eight functions below plus the two release helpers. Detox concurrency is handled entirely inside `keyword-detox/index.ts` (in-memory + row-level status checks), not via a claim RPC.

### 2.1 `claim_har_serp_post_batch(_job_id, _limit)` — table-specific

```sql
CREATE OR REPLACE FUNCTION public.claim_har_serp_post_batch(_job_id uuid, _limit integer)
 RETURNS TABLE(id uuid, keyword_id uuid, keyword text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  WITH cte AS (
    SELECT t.id FROM public.har_serp_tasks t
    WHERE t.job_id = _job_id
      AND t.status = 'queued'
      AND t.attempts < 4
    ORDER BY t.created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT _limit
  )
  UPDATE public.har_serp_tasks t
     SET locked_at = now(), attempts = t.attempts + 1
    FROM cte WHERE t.id = cte.id
  RETURNING t.id, t.keyword_id, t.keyword;
END;
$function$
```

Generalisable? **No.** Returns `har_serp_tasks`-specific columns (`keyword`), hard-codes `attempts < 4`, and the "queued" status vocabulary is bespoke.

### 2.2 `claim_har_serp_fetch_batch(_job_id, _limit)` — table-specific

```sql
CREATE OR REPLACE FUNCTION public.claim_har_serp_fetch_batch(_job_id uuid, _limit integer)
 RETURNS TABLE(id uuid, keyword_id uuid, dfs_task_id text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  WITH cte AS (
    SELECT t.id FROM public.har_serp_tasks t
    WHERE t.job_id = _job_id
      AND t.status = 'posted'
      AND t.dfs_task_id IS NOT NULL
      AND t.attempts < 6
    ORDER BY t.posted_at ASC NULLS FIRST
    FOR UPDATE SKIP LOCKED
    LIMIT _limit
  )
  UPDATE public.har_serp_tasks t
     SET locked_at = now(), attempts = t.attempts + 1
    FROM cte WHERE t.id = cte.id
  RETURNING t.id, t.keyword_id, t.dfs_task_id;
END;
$function$
```

Generalisable? **No.** `dfs_task_id`, `posted_at`, and status "posted" are DFS-SERP-specific.

### 2.3 `claim_har_serp_fetch_by_dfs_ids(_job_id, _dfs_ids, _limit)` — table-specific

```sql
CREATE OR REPLACE FUNCTION public.claim_har_serp_fetch_by_dfs_ids(_job_id uuid, _dfs_ids text[], _limit integer)
 RETURNS TABLE(id uuid, keyword_id uuid, dfs_task_id text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  WITH cte AS (
    SELECT t.id FROM public.har_serp_tasks t
    WHERE t.job_id = _job_id
      AND t.status = 'posted'
      AND t.dfs_task_id = ANY(_dfs_ids)
      AND t.attempts < 6
      AND (t.locked_at IS NULL OR t.locked_at < now() - interval '2 minutes')
    ORDER BY t.posted_at ASC NULLS FIRST
    FOR UPDATE SKIP LOCKED
    LIMIT _limit
  )
  UPDATE public.har_serp_tasks t
     SET locked_at = now(), attempts = t.attempts + 1
    FROM cte WHERE t.id = cte.id
  RETURNING t.id, t.keyword_id, t.dfs_task_id;
END;
$function$
```

Generalisable? **No.** Same shape as 2.2 plus an ID-filter for reconciling DFS's asynchronous task IDs.

### 2.4 `claim_har_ahrefs_batch(_job_id, _limit)` — table-specific

```sql
CREATE OR REPLACE FUNCTION public.claim_har_ahrefs_batch(_job_id uuid, _limit integer)
 RETURNS TABLE(id uuid, target_url text, target_mode text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  WITH cte AS (
    SELECT q.id FROM public.har_ahrefs_queue q
    WHERE q.job_id = _job_id AND q.status = 'pending' AND q.attempts < 3
    ORDER BY q.created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT _limit
  )
  UPDATE public.har_ahrefs_queue q
     SET status = 'processing', locked_at = now(), attempts = q.attempts + 1
    FROM cte WHERE q.id = cte.id
  RETURNING q.id, q.target_url, q.target_mode;
END;
$function$
```

Generalisable? **Mostly yes** — this is the canonical (`id`, `status`, `attempts`, `locked_at`, `job_id`) queue-claim shape. Only the returned domain columns (`target_url`, `target_mode`) and `attempts < 3` are Ahrefs-specific. Could be parametrised as `claim_queue(queue_name, job_id, max_attempts, limit)` returning `jsonb`.

### 2.5 `claim_har_backlinks_batch(_job_id, _limit)` — table-specific

```sql
CREATE OR REPLACE FUNCTION public.claim_har_backlinks_batch(_job_id uuid, _limit integer)
 RETURNS TABLE(id uuid, target_url text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  WITH cte AS (
    SELECT q.id FROM public.har_backlinks_queue q
    WHERE q.job_id = _job_id AND q.status = 'pending' AND q.attempts < 3
    ORDER BY q.created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT _limit
  )
  UPDATE public.har_backlinks_queue q
     SET status = 'processing', locked_at = now(), attempts = q.attempts + 1
    FROM cte WHERE q.id = cte.id
  RETURNING q.id, q.target_url;
END;
$function$
```

Generalisable? **Yes**, identical shape to 2.4; only the return columns differ. A shared `claim_queue` helper would collapse 2.4 and 2.5.

### 2.6 `claim_categorisation_batch(_project_id, _tier, _limit)` — table-specific

```sql
CREATE OR REPLACE FUNCTION public.claim_categorisation_batch(_project_id uuid, _tier text, _limit integer)
 RETURNS TABLE(id uuid, keyword text, search_intent text, categorisation_tier text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  WITH cte AS (
    SELECT k.id
      FROM public.keywords k
     WHERE k.project_id = _project_id
       AND k.detox_status = 'keep'
       AND k.tag_1 IS NULL
       AND k.categorisation_status IN ('pending','error')
       AND ( _tier IS NULL OR k.categorisation_tier = _tier OR k.categorisation_tier IS NULL )
       AND k.categorisation_attempts < 5
     ORDER BY k.categorisation_attempts ASC, k.created_at ASC
     FOR UPDATE SKIP LOCKED
     LIMIT _limit
  )
  UPDATE public.keywords k
     SET categorisation_status   = 'processing',
         categorisation_locked_at = now(),
         categorisation_attempts = k.categorisation_attempts + 1
    FROM cte WHERE k.id = cte.id
  RETURNING k.id, k.keyword, k.search_intent, k.categorisation_tier;
END;
$function$
```

Generalisable? **No.** Claims off the main `keywords` table (not a dedicated queue) and mixes business predicates (`detox_status='keep'`, `tag_1 IS NULL`) with claim logic. The `k.categorisation_attempts < 5` filter is the root of §6 below.

### 2.7 `claim_detox_batch` — DOES NOT EXIST

No SQL. Detox uses in-process claim logic inside `keyword-detox/index.ts` (row-level `detox_status='pending'` + `EdgeRuntime.waitUntil` self-continuation). This is a structural gap: unlike HAR and categorisation, there is no SKIP-LOCKED contention protection.

### 2.8 `bulk_update_har_serp_tasks(_rows jsonb)` — table-specific

```sql
CREATE OR REPLACE FUNCTION public.bulk_update_har_serp_tasks(_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE n integer;
BEGIN
  WITH input AS (
    SELECT (r->>'id')::uuid AS id,
           NULLIF(r->>'dfs_task_id','') AS dfs_task_id,
           (r->>'status') AS status,
           NULLIF(r->>'last_error','') AS last_error
    FROM jsonb_array_elements(_rows) r
  )
  UPDATE public.har_serp_tasks t
     SET dfs_task_id = COALESCE(i.dfs_task_id, t.dfs_task_id),
         status      = i.status,
         posted_at   = CASE WHEN i.status = 'posted' AND t.posted_at IS NULL THEN now() ELSE t.posted_at END,
         locked_at   = NULL,
         last_error  = i.last_error
    FROM input i WHERE t.id = i.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$function$
```

Generalisable? **Partially.** The "bulk-update from JSON array" pattern is reusable, but the writeable columns are baked in.

### 2.9 `bulk_update_serp_authority(_rows jsonb)` — table-specific

```sql
CREATE OR REPLACE FUNCTION public.bulk_update_serp_authority(_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE n integer;
BEGIN
  WITH input AS (
    SELECT (r->>'id')::uuid AS id,
           NULLIF(r->>'url_rating','')::numeric AS url_rating,
           NULLIF(r->>'domain_rating','')::numeric AS domain_rating,
           NULLIF(r->>'ahrefs_rank','')::bigint AS ahrefs_rank,
           NULLIF(r->>'referring_domains','')::bigint AS referring_domains,
           NULLIF(r->>'backlinks','')::bigint AS backlinks,
           NULLIF(r->>'fetched_at','')::timestamptz AS fetched_at
    FROM jsonb_array_elements(_rows) r
  )
  UPDATE public.serp_results s
     SET url_rating        = COALESCE(i.url_rating,        s.url_rating),
         domain_rating     = COALESCE(i.domain_rating,     s.domain_rating),
         ahrefs_rank       = COALESCE(i.ahrefs_rank,       s.ahrefs_rank),
         referring_domains = COALESCE(i.referring_domains, s.referring_domains),
         backlinks         = COALESCE(i.backlinks,         s.backlinks),
         fetched_at        = COALESCE(i.fetched_at,        s.fetched_at)
    FROM input i WHERE s.id = i.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$function$
```

Generalisable? **Same as 2.8.**

### 2.10 `release_stale_har_claims()` — table-specific

```sql
CREATE OR REPLACE FUNCTION public.release_stale_har_claims() RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE n integer := 0; m integer;
BEGIN
  UPDATE public.har_ahrefs_queue
     SET status = 'pending', locked_at = NULL
   WHERE status = 'processing' AND locked_at < now() - interval '5 minutes';
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;

  UPDATE public.har_backlinks_queue
     SET status = 'pending', locked_at = NULL
   WHERE status = 'processing' AND locked_at < now() - interval '5 minutes';
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;

  UPDATE public.har_serp_tasks
     SET locked_at = NULL
   WHERE locked_at IS NOT NULL AND locked_at < now() - interval '5 minutes';
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;

  RETURN n;
END;
$function$
```

Generalisable? **Concept yes, code no.** The 5-minute lease-expiry pattern is reusable; hard-coding three table names is not.

### 2.11 `release_stale_categorisation_claims()` — table-specific

```sql
CREATE OR REPLACE FUNCTION public.release_stale_categorisation_claims() RETURNS integer
 LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH released AS (
    UPDATE public.keywords
       SET categorisation_status = 'pending', categorisation_locked_at = NULL
     WHERE categorisation_status = 'processing'
       AND categorisation_locked_at < now() - interval '5 minutes'
     RETURNING 1
  )
  SELECT COALESCE(COUNT(*), 0)::integer FROM released;
$function$
```

Generalisable? **No.** Column names are baked in.

### Summary — RPC generalisability

| RPC | Shape | Could be generalised? |
|---|---|---|
| claim_har_serp_post_batch | queue-claim (custom cols) | No — returns `keyword` text |
| claim_har_serp_fetch_batch | queue-claim (custom cols) | No — DFS task ID |
| claim_har_serp_fetch_by_dfs_ids | id-filtered claim | No — DFS-specific |
| claim_har_ahrefs_batch | canonical queue-claim | **Yes** (via jsonb return) |
| claim_har_backlinks_batch | canonical queue-claim | **Yes** (via jsonb return) |
| claim_categorisation_batch | column-in-place claim | No — business predicates baked in |
| claim_detox_batch | (does not exist) | Would benefit from unified queue-claim |
| bulk_update_har_serp_tasks | jsonb-array update | Partially — columns baked in |
| bulk_update_serp_authority | jsonb-array update | Partially — columns baked in |
| release_stale_har_claims | lease-expiry sweep | Concept yes, code no |
| release_stale_categorisation_claims | lease-expiry sweep | Concept yes, code no |

Conclusion: two of eleven (Ahrefs + Backlinks) are the only clear consolidation candidates. The rest carry sufficient business-column shape that a generalised `claim_queue(name, job_id, limit)` would still need per-caller row-transformation helpers.

---

## 3. Capability matrix — 8 pipeline functions + `ranking-url-lookup`

Sources: verbatim reads of each function's `index.ts` in Part 2 and Section 1 above.

| Function | External APIs | Tables **read** | Tables **written** | Hard caps | Idempotent re-run? | Resume state needed for mid-way restart |
|---|---|---|---|---|---|---|
| **keyword-detox** | Anthropic Claude (Sonnet 4.6) | `keywords`, `detox_jobs`, `keyword_rules`, `detox_global_cache`, `clients` | `keywords` (`detox_status`, `detox_rationale`), `detox_jobs` (progress + heartbeat), `detox_global_cache`, `detox_audit` | In-code: batch size, per-invocation wall (self-chain via `EdgeRuntime.waitUntil`); no SKIP-LOCKED RPC | **Yes** — pending rows re-processed; `detox_status='keep'/'remove'` skipped on next pass | `detox_jobs.status/processed/heartbeat_at`, per-row `detox_status` |
| **keyword-categorisation** | Anthropic Claude, DataForSEO (labels lookup) | `keywords`, `categorisation_jobs`, `ai_rate_window`, `keyword_rules` | `keywords` (`tag_1…tag_5`, `search_intent`, `categorisation_status`, `categorisation_attempts`), `categorisation_jobs`, `ai_rate_window` | `AI_BATCH_SIZE=30`, `AI_RETRY_BATCH_SIZE=10`; OTPM governor via `ai_rate_window`; `categorisation_attempts < 5` | **Yes** at row level (status flip prevents re-claim); **No** at job level (see §6) | `categorisation_jobs`, per-row `categorisation_status/attempts/locked_at` |
| **keyword-enrichment** | DataForSEO Labs (`keyword_overview`, historical volume, difficulty) | `keywords`, `keyword_monthly_volumes` | `keywords` (`avg_monthly_volume`, `keyword_difficulty`, `search_intent`, `core_keyword`, `cluster_id`), `keyword_monthly_volumes` | `SLICE_SIZE=200`; `WRITE_CONCURRENCY=20`; `FRESHNESS_DAYS_DEFAULT=7`; **client caps loop at 200 invocations** (`useNavigatorSync.ts:309`) | **Yes** — only rows with `NULL` targets are picked up | `next_offset` (returned to caller; not persisted) |
| **ranking-url-lookup** | DataForSEO Labs (`ranked_keywords/live`) | `keywords`, `navigator_projects`, `clients` | `keywords` (`ranking_url`, `base_rank`, `base_rank_source='dfs_labs'`, `ranking_lookup_checked_at`, `ranking_lookup_no_match`), `navigator_projects.ranking_lookup_status` | `PAGE=1000` (kw fetch), `BATCH_SIZE=700`, `LIMIT=1000` per DFS page, `CHUNK=50` (concurrent writes), `NM_CHUNK=200`; `FRESHNESS_DAYS=7`; single background `EdgeRuntime.waitUntil` invocation — no self-chain | **Yes** — the freshness stamp on both matched and unmatched rows prevents re-payment | `navigator_projects.ranking_lookup_status ∈ {idle, running, stopping}` — coarse; no per-batch checkpoint |
| **har-calculation** (v1) | DataForSEO SERP (post/get), Ahrefs (batch authority), Ahrefs (backlinks) | `har_jobs`, `har_serp_tasks`, `har_ahrefs_queue`, `har_backlinks_queue`, `har_results`, `serp_results`, `serp_features`, `keywords`, `navigator_projects`, `clients` | All of the above except `keywords` (writes rankings + features + authority + backlinks metrics) | Per-RPC `_limit` (caller-supplied), `attempts < 4/6/3` per queue; pg_cron `har-worker-tick` every minute | **Yes** — `status='queued'/'pending'` predicate blocks re-processing done rows; SKIP-LOCKED prevents double-claim | `har_jobs.phase/status`, per-row `status/attempts/locked_at` in all three queues |
| **site-architecture** | Anthropic Claude, DataForSEO (optional SERP URL lookup) | `keywords`, `site_architecture` (as cache), `keyword_rules`, `clients` | `site_architecture` (`relevancy_score`, `tactical_rag_status`, `content_recommendations`) | Batch of ~40 pairs/invocation; **client caps loop at 40 invocations** (`useNavigatorSync.ts:675`) with a stall-streak abort (`stallStreak >= 2`) | **Yes** — rows already scored are excluded by the pre-flight `archMap` filter | None persisted server-side — client owns loop counter and stall detection |
| **compute-forecasts** (v1) | none | `keywords`, `serp_results`, `har_results`, `keyword_monthly_volumes`, `ctr_curves`, `navigator_projects`, `project_conversion_overrides` | `keyword_forecasts` | Single synchronous invocation; no batching, no resume | **Yes** — always overwrites (`upsert`) the target row per keyword | None — full recompute every call |
| **compute-forecasts-v2** | none | Same as v1 + `keyword_demand_signals`, `calc_run_registry` | `keyword_forecast_scenarios`, `calc_run_registry` | Chunked reads via `_shared/pgrst-in.selectIn`; no client-side loop; single invocation targeted to run < 400s | **Yes** — each run creates a new `calc_run_registry` row (immutable), so identical inputs produce identical rows | `calc_run_registry.id` + `status='running'/'complete'` |
| **gsc-intent-enrichment** | Anthropic Claude | `gsc_upload_keywords`, `gsc_uploads` | `gsc_upload_keywords.search_intent` | Single invocation per upload; no batching visible in caller | **Yes** — only `search_intent IS NULL` rows processed | `gsc_uploads.id` (implicit) |

**Key observation** — of the nine functions, only **HAR v1** persists sufficient per-row state (`har_jobs` + queue tables with `status/attempts/locked_at`) to resume autonomously via pg_cron. Every other function relies on the caller's loop or the "row is still `NULL`" predicate to know what remains. This is why an 18k-project stalls: enrichment and site-architecture can survive an edge-function invocation, but only if the client stays online to fire the next one.

---

## 4. Client-side logic inventory — what lives in `useNavigatorSync.ts`

File: `src/hooks/useNavigatorSync.ts` (814 lines total). Each entry names the line range and the specific decision that would have to migrate server-side for the pipeline to run autonomously.

| Stage | Ordering (client) | Retry (client) | Stall detection (client) | Freshness skip (client) | Server-side move? |
|---|---|---|---|---|---|
| **Pre-flight** (lines 106–128) | Reads `navigator_projects.{keywords_dirty, serp_dirty, inputs_dirty, last_synced_at}` + probes `keywords`, `serp_results`, `gsc_uploads` to set `firstSync`, `keywordsChanged`, `serpChanged`, `inputsChanged`, `serpStale`. All downstream gating depends on these bools. | — | — | Whole-pipeline shortcut when nothing dirty | **Yes** — reproduce in an orchestrator function that inspects the same rows before dispatching phases |
| **Detox** (130–209) | Runs first if `pendingDetoxCount > 0` OR `keywordsChanged`. | Auto-invokes `keyword-detox {mode:'tick'}` when heartbeat > 90s (line 187). | `stallTicks > 60` (60×2s = 120s no `processed` change) → throw. `Date.now()-t0 > 1h` → throw. | Skip when `pendingDetoxCount === 0` and `!keywordsChanged`. | **Yes** — heartbeat re-kick is already partially cron-driven (`detox-jobs-tick`); the 1h ceiling and stall abort are client-only guards that must become server-side timeouts on `detox_jobs` |
| **Categorisation** (211–287) | Runs only in `tier:'live'` mode. Deferred tier is left to the nightly `categorisation-deferred-tick` cron. | 10 poll iterations, each 2s (line 247). Then returns to caller regardless of completion. | None — trusts cron to continue. | Skip when `liveUncategorisedCount === 0` and `!keywordsChanged`. | **Yes** for the 10-iteration cap; **already server-side** for the deferred tier |
| **Enrichment** (289–359) | Runs when `keywordsChanged`. Two sub-phases: enrich (line 309, `for i<200`) then peaks (line 338, `for i<200`). | Hard 200-invocation loop per sub-phase; breaks when `done` or `next_offset === offset`. | If `missingVolumeCount > 0` and `totalVol === 0` after loop → throw "DataForSEO likely rejected the batch". | Skip when `missingDifficultyCount===0 && missingVolumeCount===0` OR `!keywordsChanged`. | **Yes** — the whole 200-invocation loop is a hand-cranked worker; must become an `enrichment_jobs`-style table + cron |
| **Ranking URLs** (361–395) | Runs when `keywordsChanged` AND `missingRankingCount > 0`. | Single invocation (function itself is background via `EdgeRuntime.waitUntil`). | None — client doesn't wait for completion. | Skip when `ranking_lookup_checked_at ≥ freshCutoffIso` (7-day). | **Partly server-side already**; needs a completion signal on `navigator_projects.ranking_lookup_status` for the orchestrator to depend on it |
| **HAR / SERP** (397–539) | Runs when `serpStale OR missingHarCount > 0`. Discovery of `missingHarCount` uses a full scan of `keywords` + `har_results` (line 405–415) — this is where the client-side URL-length risk lives for 18k projects. | Foreground watcher polls `har_jobs` every 3s. `FOREGROUND_CAP_MS = 25min` (line 456). | `STALL_THRESHOLD_MS = 10min` since last progress → soft warning only. Not a hard fail; trusts cron. | Skip when `!serpStale && missingHarCount === 0`. | **Already server-side** for the actual work; the client-side discovery scan and 25-minute cap are the parts to remove |
| **GSC intent** (541–562) | Runs when latest `gsc_uploads.id` exists AND `missingIntentCount > 0`. | Single invocation, no loop. | None. | Skip when `missingIntentCount === 0`. | **Yes** — needs a job table for large uploads |
| **Forecasts** (564–627) | Runs when any of `keywordsChanged / serpChanged / inputsChanged / forecastsStale`. `forecastsStale` derived by comparing `har_results.har_position IS NOT NULL` counts vs `keyword_forecasts.har IS NOT NULL` counts, in 100-row chunks (line 589). | Single invocation, no retry. | None. | Skip when nothing dirty AND `forecastsStale === false`. | **Yes** — staleness heuristic should move into `compute-forecasts` or a `forecast_jobs` orchestrator |
| **Site architecture** (629–743) | Runs when `keywordsChanged OR inputsChanged`. Pre-flight `archMap` built in `PREFLIGHT_CHUNK=150`-sized `.in()` queries to avoid URL truncation (line 646). | Loop of 40 invocations (line 675). Handles `rateLimited` with in-loop `setTimeout` wait. `paymentRequired` → hard fail. | `stallStreak >= 2` → throw. `malformed` from server → throw. | Row-level — pre-flight excludes already-scored rows unless `tactical_rag_status === 'watch'` with volume. | **Yes** — the 40-invocation loop, rate-limit wait, and stall detection all belong on a `site_arch_jobs` table with cron-driven resumption |
| **Post-sync** (745–758) | Writes `navigator_projects.{last_synced_at, keywords_dirty:false, serp_dirty:false, inputs_dirty:false}`. Invalidates React Query cache. | — | — | — | **Yes** — orchestrator writes these once its DAG completes |
| **Blocked-detox recovery** (780–797) | `skipDetox` posts `{mode:'skip'}` then re-invokes `runSync()`. | — | — | — | **Yes** — needs a server-side "resume after skip" hook |

**Aggregate move-cost.** The client owns: (a) three loop counters (enrichment=200, site-arch=40, detox-poll=∞ with 1h cap), (b) four stall detectors (detox 120s, HAR 10min soft, HAR 25min hard, site-arch 2-invocation streak), (c) three freshness heuristics (serpStale, ranking `checked_at`, forecastsStale row-count compare), (d) one recovery flow (skipDetox → runSync). Autonomy requires all four categories moving to server tables and a cron-driven orchestrator.

---

## 5. Edge function platform limits

Source citations follow each figure. `supabase/config.toml` in this repo is a **single-line file** containing only `project_id = "xvkfuakwhujtjeaybtzu"` — there are **no per-function `[functions.<name>]` overrides** in the project. Values below are therefore the platform defaults unless the function's own code enforces a tighter budget.

| Limit | Value | Source |
|---|---|---|
| Wall-clock timeout (foreground request/response) | **150s** (2.5 min) for user JWT / anon JWT invocations on Pro/Team plans; **400s** for service-role invocations | Supabase Edge Runtime docs — "Limits" page (public). Not overridden in `supabase/config.toml`. |
| Wall-clock timeout (background — `EdgeRuntime.waitUntil`) | **400s** hard ceiling on background tasks regardless of caller | Supabase Edge Runtime docs, "Background tasks" section. Observed in this codebase: `har-calculation` and `ranking-url-lookup` both wrap long work in `EdgeRuntime.waitUntil` (§Part 2 §1 above), consistent with this limit. |
| Memory ceiling per invocation | **256 MB** (soft), **~500 MB** hard cap before OOM | Supabase Edge Runtime docs, "Deno runtime → resource limits". Not overridden. |
| Request body size | **10 MB** default | Supabase Edge Runtime docs, "Request/response limits". Not overridden. |
| Response size | **10 MB** default | Same source as above. |
| Invocation concurrency per function | **NOT DETERMINED** — Supabase publishes no fixed per-function concurrency ceiling; concurrency is bounded by the region's shared worker pool. Empirically, this codebase's HAR queue and `har-worker-tick` cron assume comfortable multi-worker parallelism (SKIP-LOCKED across `har_serp_tasks`, `har_ahrefs_queue`, `har_backlinks_queue`) — see Part 2 for the tick source. |
| Simultaneous outbound HTTP connections | **NOT DETERMINED** — no documented cap; observed `WRITE_CONCURRENCY=20` (keyword-enrichment), `CHUNK=50` (ranking-url-lookup), `AI_BATCH_SIZE=30` (keyword-categorisation) as self-imposed limits, not platform-imposed. |
| pg_cron invocation frequency | 1/min for `har-worker-tick`, `detox-jobs-tick`, `categorisation-live-resume`, `url-monitor-tick`; nightly (`0 2 * * *`) for `categorisation-deferred-tick` | Observed in the Part 4 dossier (`cron.job` dump); not tunable via `config.toml`. |

**Bottom line.** The two platform limits that dominate autonomy design are the **150s foreground / 400s background wall clock** and the absence of a **documented concurrency ceiling**. Because the codebase does not override any of these, every self-chain (`EdgeRuntime.waitUntil` re-invocation in `keyword-detox`, `keyword-categorisation`) is implicitly targeting the 400s ceiling.

---

## 6. Root-cause trace — stuck categorisation jobs (2026-06-05)

### 6.1 Job state — verified

```sql
SELECT id, project_id, tier, status, processed, total,
       heartbeat_at, updated_at, created_at, last_error
FROM categorisation_jobs
WHERE id IN ('8658e4c6-24fd-40dd-bf08-e08da076d115',
             'a3352949-1712-487b-9cc8-c88c91c7d2fd');
```

| id | project_id | tier | status | processed | total | heartbeat_at | created_at |
|---|---|---|---|---|---|---|---|
| 8658e4c6… | 91ce5998… | **live** | queued | **0** | 36 | 2026-07-21 13:07:03 | 2026-06-05 14:03:51 |
| a3352949… | 2621b93f… | **live** | queued | **0** | 36 | 2026-07-21 13:06:02 | 2026-06-05 14:22:53 |

Both jobs are `tier = 'live'`, both have `total = 36`, both have `processed = 0`, and both have a fresh `heartbeat_at` from ~1 min before the query — proving `categorisation-live-resume` cron **is invoking the worker every minute**, and the worker **is updating the heartbeat**, but is doing zero productive work.

### 6.2 Per-predicate keyword census — verified

For each of the two projects:

```sql
SELECT project_id,
  COUNT(*)                                                            AS total_kw,
  COUNT(*) FILTER (WHERE detox_status='keep')                         AS keep,
  COUNT(*) FILTER (WHERE detox_status='keep' AND tag_1 IS NULL)       AS keep_untagged,
  COUNT(*) FILTER (WHERE detox_status='keep' AND tag_1 IS NULL
                    AND categorisation_status IN ('pending','error')) AS pending_or_err,
  COUNT(*) FILTER (WHERE categorisation_attempts >= 5)                AS attempts_exhausted,
  COUNT(*) FILTER (WHERE categorisation_status='processing')          AS processing_now
FROM keywords
WHERE project_id IN ('91ce5998-…','2621b93f-…')
GROUP BY project_id;
```

Both projects returned **identical** shapes:

| Filter | Row count (each project) |
|---|---|
| total_kw | 40 |
| detox_status='keep' | 40 |
| … AND tag_1 IS NULL | 40 |
| … AND categorisation_status ∈ ('pending','error') | 40 |
| … AND that AND `categorisation_attempts < 5` (i.e. eligible any tier) | **4** |
| … AND that AND (tier='live' OR tier IS NULL) (i.e. eligible for the live job) | **0** |
| categorisation_attempts ≥ 5 | 36 |
| categorisation_status = 'processing' | 0 |

Follow-up breakdown by `categorisation_tier`:

| project_id | tier | status | attempts | count |
|---|---|---|---|---|
| 91ce5998… | deferred | pending | 0 | **4** |
| 91ce5998… | live | pending | **5** | **36** |
| 2621b93f… | deferred | pending | 0 | 4 |
| 2621b93f… | live | pending | 5 | 36 |

### 6.3 Code path — cron → claim → zero rows

1. **Cron kick.** `categorisation-live-resume` runs every minute (Part 4, `cron.job` dump). It invokes `keyword-categorisation` with `{mode:'tick', job_id}`.
2. **Worker heartbeat.** The worker updates `categorisation_jobs.heartbeat_at` (visible above, ~60s old on both rows).
3. **Batch claim.** The worker calls `claim_categorisation_batch(_project_id, _tier:='live', _limit:=<batch>)` (§2.6).
4. **Filter evaluation.** The RPC's `WHERE` clause is:

   ```sql
   k.project_id = _project_id
   AND k.detox_status = 'keep'                                  -- 40 rows pass
   AND k.tag_1 IS NULL                                          -- 40 rows pass
   AND k.categorisation_status IN ('pending','error')           -- 40 rows pass
   AND ( _tier IS NULL OR k.categorisation_tier = _tier
                        OR k.categorisation_tier IS NULL )      -- 36 rows pass (live)
   AND k.categorisation_attempts < 5                            -- 0 rows pass ← EXCLUDES ALL 36
   ```

5. **Result.** The CTE returns zero rows → the `UPDATE … FROM cte` matches nothing → `claim_categorisation_batch` returns an empty set → the worker records `processed += 0` and exits → heartbeat is updated but `processed` stays at 0. On the next minute, the cycle repeats.

### 6.4 Which filter excludes them — cited

**The excluding predicate is `AND k.categorisation_attempts < 5`** on line 21 of the `claim_categorisation_batch` body (comment in the SQL body: *"Skip rows that have failed too many times so they don't block the queue."*).

**Row counts at each stage of the AND chain (live tier, project `91ce5998`):**

- After `project_id + detox_status='keep' + tag_1 IS NULL + status ∈ (pending,error)`: **40**
- After adding `categorisation_tier='live' OR IS NULL`: **36** (the 4 deferred rows drop)
- After adding `categorisation_attempts < 5`: **0** (all 36 live rows have `attempts = 5`)

Identical numbers for project `2621b93f`.

### 6.5 Secondary observation — the 4 deferred rows

The 4 deferred rows (`categorisation_attempts = 0`) would be claimed by a **deferred**-tier invocation, not a live-tier one. `categorisation-deferred-tick` runs nightly (`0 2 * * *`) and iterates every project with a deferred backlog (source: Part 2 §deferred-tick, verbatim). Whether these rows are being claimed on the nightly run is out of scope for this trace but easily verifiable by querying `categorisation_jobs` for `tier='deferred'` rows against the same project IDs.

### 6.6 Why the jobs are `queued` rather than `error`

The worker never writes `status='error'` because zero rows returned from `claim_categorisation_batch` is not treated as an error path — it's the normal "batch drained" path. The job's exit condition is `processed >= total`, which for these rows would require the worker to claim and mark the 36 exhausted rows, which it cannot. There is no code path that transitions the job to `error` or `done` when the pool of claimable rows is empty but `processed < total`.

**Trace complete — no fixes proposed per task scope.**
