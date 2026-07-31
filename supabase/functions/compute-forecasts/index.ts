import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing authorization header");

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { project_id } = await req.json();
    if (!project_id) throw new Error("project_id is required");

    // Get project config
    const { data: project, error: projErr } = await supabase
      .from("navigator_projects")
      .select("aov, conversion_rate, seasonality_start, seasonality_end")
      .eq("id", project_id)
      .single();
    if (projErr || !project) throw new Error("Project not found");

    const aov = project.aov ?? 0;
    const cvr = (project.conversion_rate ?? 0) / 100;

    // Fetch CTR curves for this project
    const { data: ctrCurves, error: ctrErr } = await supabase
      .from("ctr_curves")
      .select("device, intent_segment, rank_position, ctr_percentage")
      .eq("project_id", project_id);
    if (ctrErr) throw new Error(`Failed to fetch CTR curves: ${ctrErr.message}`);

    // Build CTR lookup: key = "device|intent|position" → ctr_percentage
    const ctrMap = new Map<string, number>();
    for (const c of (ctrCurves || [])) {
      const intent = (c.intent_segment || "generic").toLowerCase();
      const key = `${c.device}|${intent}|${c.rank_position}`;
      ctrMap.set(key, c.ctr_percentage);
    }

    function getCtr(device: string, intent: string | null, position: number | null): number {
      if (!position || position > 20) return 0;
      const pos = Math.round(position);
      const intentKey = (intent || "generic").toLowerCase();
      const specific = ctrMap.get(`${device}|${intentKey}|${pos}`);
      if (specific !== undefined) return specific / 100;
      const generic = ctrMap.get(`${device}|generic|${pos}`);
      if (generic !== undefined) return generic / 100;
      // Final fallback: any available intent curve for this device + position.
      // Prefer transactional → commercial → informational → navigational, then any.
      const order = ["transactional", "commercial", "informational", "navigational"];
      for (const intentTry of order) {
        const v = ctrMap.get(`${device}|${intentTry}|${pos}`);
        if (v !== undefined) return v / 100;
      }
      for (const [key, v] of ctrMap) {
        const [d, , p] = key.split("|");
        if (d === device && parseInt(p, 10) === pos) return v / 100;
      }
      return 0;
    }

    // Fetch all kept keywords with volume > 0
    const allKeywords: Array<{
      id: string; keyword: string; avg_monthly_volume: number;
      base_rank: number | null; device: string; search_intent: string | null;
      ranking_url: string | null; peak_month: string | null;
    }> = [];
    let from = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await supabase
        .from("keywords")
        .select("id, keyword, avg_monthly_volume, base_rank, device, search_intent, ranking_url, peak_month")
        .eq("project_id", project_id)
        .eq("detox_status", "keep")
        .gt("avg_monthly_volume", 0)
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`Failed to fetch keywords: ${error.message}`);
      if (!data?.length) break;
      allKeywords.push(...data);
      if (data.length < PAGE) break;
      from += PAGE;
    }

    // ─── Seasonality helpers ──────────────────────────────────────────
    // Pre-compute project-window peak (synthetic midpoint) for fallback.
    function projectWindowPeakMonth(): number | null {
      const s = project?.seasonality_start;
      const e = project?.seasonality_end;
      if (!s || !e) return null;
      const sm = parseInt(String(s).slice(5, 7), 10);
      const em = parseInt(String(e).slice(5, 7), 10);
      if (!Number.isFinite(sm) || !Number.isFinite(em)) return null;
      // Handle wrap-around (e.g. Nov–Feb)
      const span = em >= sm ? em - sm : 12 - sm + em;
      const mid = ((sm - 1 + Math.round(span / 2)) % 12) + 1;
      return mid;
    }
    const fallbackPeakMonth = projectWindowPeakMonth();
    const nowMonth = new Date().getMonth() + 1; // 1–12

    function monthsToNextPeak(peakMonth: number): number {
      // Distance to the next occurrence of peakMonth (0–11)
      const diff = (peakMonth - nowMonth + 12) % 12;
      return diff;
    }
    function urgencyFromWeeks(weeks: number): number {
      if (weeks < 0) return 0.05;
      if (weeks <= 4) return 0.25;
      if (weeks <= 8) return 0.55;
      if (weeks < 12) return 0.85;
      if (weeks <= 16) return 1.0;
      if (weeks <= 24) return 0.7;
      return 0.1;
    }

    if (!allKeywords.length) {
      return new Response(
        JSON.stringify({ computed: 0, skipped: 0, challenges: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check for existing HAR values that are manual (preserve them).
    //
    // CRITICAL: keep this batch small. Supabase/PostgREST builds the .in()
    // filter into the request URL; with batches of ~500 UUIDs the URL exceeds
    // the gateway limit and the query silently returns 0 rows (no error). That
    // caused the "Primary/Secondary/Tertiary £0" bug — har_results was full
    // of valid positions but compute-forecasts only saw matches for the first
    // sliver, leaving every other forecast row with `har = NULL` and therefore
    // `har_revenue_gain_annual = NULL`.
    const LOOKUP_BATCH = 100;
    const keywordIds = allKeywords.map(k => k.id);
    const existingForecasts = new Map<string, { har: number | null; har_is_manual: boolean }>();

    for (let i = 0; i < keywordIds.length; i += LOOKUP_BATCH) {
      const batch = keywordIds.slice(i, i + LOOKUP_BATCH);
      const { data: existing, error: existingErr } = await supabase
        .from("keyword_forecasts")
        .select("keyword_id, har, har_is_manual")
        .in("keyword_id", batch);
      if (existingErr) throw new Error(`Existing forecast lookup: ${existingErr.message}`);
      if (existing) {
        for (const f of existing) {
          existingForecasts.set(f.keyword_id, { har: f.har, har_is_manual: f.har_is_manual });
        }
      }
    }

    // Fetch automated HAR positions from har_results table.
    const harResultsMap = new Map<string, number>();
    for (let i = 0; i < keywordIds.length; i += LOOKUP_BATCH) {
      const batch = keywordIds.slice(i, i + LOOKUP_BATCH);
      const { data: harRows, error: harErr } = await supabase
        .from("har_results")
        .select("keyword_id, har_position")
        .in("keyword_id", batch);
      if (harErr) throw new Error(`HAR results lookup: ${harErr.message}`);
      if (harRows) {
        for (const hr of harRows) {
          if (hr.har_position != null) {
            harResultsMap.set(hr.keyword_id, hr.har_position);
          }
        }
      }
    }
    console.log(`HAR lookup: ${harResultsMap.size} of ${keywordIds.length} keywords have a HAR position`);

    let computed = 0;
    const UPSERT_BATCH = 200;
    const forecasts: any[] = [];

    // We'll also collect forecast data per keyword for the challenge pass
    const forecastMap = new Map<string, {
      est_current_revenue_annual: number;
      yearly_revenue_gain_rank1: number;
      har: number | null;
    }>();

    for (const kw of allKeywords) {
      const volume = kw.avg_monthly_volume;
      const position = kw.base_rank;
      const device = kw.device || "mobile";
      const intent = kw.search_intent;

      const currentCtr = getCtr(device, intent, position);
      const ctrRank1 = getCtr(device, intent, 1);

      let opportunity: string;
      if (!position || position >= 101) {
        opportunity = "opportunity";
      } else if (position <= 3) {
        opportunity = "maintain";
      } else if (position <= 10) {
        opportunity = "improve";
      } else {
        opportunity = "grow";
      }

      const weightedSum = position ? volume * position : null;
      const estCurrentClicksAnnual = volume * currentCtr * 12;
      const estCurrentRevenueAnnual = estCurrentClicksAnnual * cvr * aov;
      const expectedTrafficRank1Annual = volume * ctrRank1 * 12;
      const yearlyTrafficGainRank1 = Math.max(expectedTrafficRank1Annual - estCurrentClicksAnnual, 0);
      const yearlyRevenueGainRank1 = yearlyTrafficGainRank1 * cvr * aov;

      const existing = existingForecasts.get(kw.id);
      const automatedHar = harResultsMap.get(kw.id) ?? null;
      const har = existing?.har_is_manual ? existing.har : (automatedHar ?? existing?.har ?? null);
      const harIsManual = existing?.har_is_manual ?? false;

      // har_traffic_gain_annual = positive *gain* over current (kept as-is)
      // har_revenue_gain_annual = ABSOLUTE annual revenue at TP position
      //   (renamed semantic — column name kept to avoid migration). UI labels
      //   say "TP Revenue" everywhere; this is the figure they show.
      let harTrafficGainAnnual: number | null = null;
      let harRevenueGainAnnual: number | null = null;
      if (har != null) {
        const ctrAtHar = getCtr(device, intent, har);
        const harTrafficAnnual = volume * ctrAtHar * 12;
        harTrafficGainAnnual = Math.max(harTrafficAnnual - estCurrentClicksAnnual, 0);
        harRevenueGainAnnual = harTrafficAnnual * cvr * aov;
      }

      // ─── Seasonality ────────────────────────────────────────────────
      let monthsToPeak: number | null = null;
      let seasonalUrgency: number | null = null;
      let isInCaptureWindow = false;
      let peakSource: string | null = null;
      const ownPeak = kw.peak_month ? parseInt(kw.peak_month, 10) : NaN;
      const peak = Number.isFinite(ownPeak) ? ownPeak : fallbackPeakMonth;
      if (peak) {
        peakSource = Number.isFinite(ownPeak) ? "keyword_volume" : "project_window";
        monthsToPeak = monthsToNextPeak(peak);
        const weeks = monthsToPeak * 4.345;
        seasonalUrgency = urgencyFromWeeks(weeks);
        isInCaptureWindow = weeks >= 8 && weeks <= 16;
      }

      forecasts.push({
        keyword_id: kw.id,
        weighted_sum: weightedSum,
        opportunity,
        current_ctr_pct: Math.round(currentCtr * 10000) / 100,
        est_current_clicks_annual: Math.round(estCurrentClicksAnnual),
        est_current_revenue_annual: Math.round(estCurrentRevenueAnnual * 100) / 100,
        expected_traffic_rank1_annual: Math.round(expectedTrafficRank1Annual),
        yearly_traffic_gain_rank1: Math.round(yearlyTrafficGainRank1),
        yearly_revenue_gain_rank1: Math.round(yearlyRevenueGainRank1 * 100) / 100,
        har,
        har_is_manual: harIsManual,
        har_traffic_gain_annual: harTrafficGainAnnual != null ? Math.round(harTrafficGainAnnual) : null,
        har_revenue_gain_annual: harRevenueGainAnnual != null ? Math.round(harRevenueGainAnnual * 100) / 100 : null,
        months_to_peak: monthsToPeak,
        seasonal_urgency: seasonalUrgency != null ? Math.round(seasonalUrgency * 1000) / 1000 : null,
        is_in_capture_window: isInCaptureWindow,
        peak_source: peakSource,
      });

      // Store for challenge pass
      forecastMap.set(kw.id, {
        est_current_revenue_annual: Math.round(estCurrentRevenueAnnual * 100) / 100,
        yearly_revenue_gain_rank1: Math.round(yearlyRevenueGainRank1 * 100) / 100,
        har,
      });

      if (forecasts.length >= UPSERT_BATCH) {
        const { error } = await supabase
          .from("keyword_forecasts")
          .upsert(forecasts, { onConflict: "keyword_id" });
        if (error) console.error("Forecast upsert error:", error.message);
        else computed += forecasts.length;
        forecasts.length = 0;
      }
    }

    if (forecasts.length) {
      const { error } = await supabase
        .from("keyword_forecasts")
        .upsert(forecasts, { onConflict: "keyword_id" });
      if (error) console.error("Forecast upsert error:", error.message);
      else computed += forecasts.length;
    }

    console.log(`Forecasts computed: ${computed} of ${allKeywords.length}`);

    // Staleness diagnostic: how many upserted rows had a HAR vs a non-zero TP revenue.
    try {
      const withHar = forecastMap.size;
      let withTpRevenue = 0;
      for (const kw of allKeywords) {
        const har = (forecastMap.get(kw.id)?.har ?? null);
        if (har == null) continue;
        const ctrAtHar = getCtr(kw.device || "mobile", kw.search_intent, har);
        if ((kw.avg_monthly_volume || 0) * ctrAtHar * 12 * cvr * aov > 0) withTpRevenue++;
      }
      console.log(`TP revenue summary: withHar=${withHar}, withTpRevenue=${withTpRevenue}, zeroTpRevenueWithHar=${withHar - withTpRevenue}`);
    } catch (_) { /* diagnostic only */ }

    // ─── CHALLENGE PASS ───────────────────────────────────────────────
    // Group keywords by ranking_url to detect cannibalisation.
    // For each URL with 2+ keywords, the keyword with the highest
    // est_current_revenue_annual is the "current" keyword. All others
    // on the same URL are "challengers". The challenge_revenue_gain is
    // the revenue the challenger *could* earn at rank #1 if it had its
    // own dedicated page, minus what it currently earns.
    // ──────────────────────────────────────────────────────────────────

    const urlGroups = new Map<string, Array<{ id: string; revenue: number; revenueGainRank1: number }>>();

    for (const kw of allKeywords) {
      if (!kw.ranking_url) continue;
      const url = kw.ranking_url.toLowerCase().trim();
      if (!url) continue;
      const forecast = forecastMap.get(kw.id);
      if (!forecast) continue;

      if (!urlGroups.has(url)) urlGroups.set(url, []);
      urlGroups.get(url)!.push({
        id: kw.id,
        revenue: forecast.est_current_revenue_annual,
        revenueGainRank1: forecast.yearly_revenue_gain_rank1,
      });
    }

    const challenges: any[] = [];

    for (const [url, keywords] of urlGroups) {
      if (keywords.length < 2) continue;

      // Sort descending by current revenue — top one is "current"
      keywords.sort((a, b) => b.revenue - a.revenue);
      const current = keywords[0];

      for (let i = 1; i < keywords.length; i++) {
        const challenger = keywords[i];
        // Revenue gain if this challenger keyword had its own page
        const challengeRevenueGain = challenger.revenueGainRank1;
        const upliftPct = current.revenue > 0
          ? Math.round((challengeRevenueGain / current.revenue) * 10000) / 100
          : null;

        challenges.push({
          project_id,
          ranking_url: url,
          current_keyword_id: current.id,
          challenge_keyword_id: challenger.id,
          current_annual_revenue: current.revenue,
          challenge_revenue_gain: Math.round(challengeRevenueGain * 100) / 100,
          revenue_uplift_pct: upliftPct,
        });
      }
    }

    // Delete old challenges for this project, then insert new ones
    let challengeCount = 0;
    const { error: delErr } = await supabase
      .from("keyword_challenges")
      .delete()
      .eq("project_id", project_id);
    if (delErr) console.error("Challenge delete error:", delErr.message);

    // Insert in batches
    for (let i = 0; i < challenges.length; i += UPSERT_BATCH) {
      const batch = challenges.slice(i, i + UPSERT_BATCH);
      const { error: insErr } = await supabase
        .from("keyword_challenges")
        .insert(batch);
      if (insErr) console.error("Challenge insert error:", insErr.message);
      else challengeCount += batch.length;
    }

    console.log(`Challenges computed: ${challengeCount}`);

    return new Response(
      JSON.stringify({ computed, total: allKeywords.length, challenges: challengeCount }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("compute-forecasts error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
