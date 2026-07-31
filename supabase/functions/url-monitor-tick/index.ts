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
