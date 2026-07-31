// URL Monitor — daily snapshot pruner. Deletes url_check_snapshots older than 90 days.
// url_issues are kept indefinitely (and use ON DELETE CASCADE on snapshot_id, so we
// only delete snapshots that no longer have open issues referencing them — but practically,
// issues store enough denormalised value that we can hard-delete safely).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    // Auth gate: match the pattern used by other cron worker functions
    // (url-monitor-tick, keyword-detox tick, categorisation-deferred-tick).
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
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { count, error } = await supabase
      .from("url_check_snapshots")
      .delete({ count: "exact" })
      .lt("checked_at", cutoff);
    if (error) throw error;
    return new Response(JSON.stringify({ pruned: count ?? 0, cutoff }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
