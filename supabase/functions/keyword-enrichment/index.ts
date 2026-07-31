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
