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
