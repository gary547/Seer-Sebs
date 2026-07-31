import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { records } = await req.json();
    if (!Array.isArray(records) || records.length === 0) {
      return new Response(JSON.stringify({ error: "records array required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Use the caller's auth token so RLS applies
    const authHeader = req.headers.get("Authorization");
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: authHeader ? { Authorization: authHeader } : {} } },
    );

    // Upsert in batches of 50
    const batch = records.map((r: any) => ({
      serp_feature_raw: r.serp_feature_raw,
      result_type: r.result_type,
      serp_intent: r.serp_intent,
    }));

    const { data, error } = await supabase
      .from("serp_feature_index")
      .upsert(batch, { onConflict: "serp_feature_raw" })
      .select();

    if (error) throw error;

    return new Response(
      JSON.stringify({ success: true, count: data.length }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
