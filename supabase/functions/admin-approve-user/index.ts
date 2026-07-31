import { createClient } from "npm:@supabase/supabase-js@2.103.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const VALID_ROLES = ["super_admin", "admin", "user", "view_only"] as const;
const VALID_DECISIONS = ["approve", "reject"] as const;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const body = await req.json();
    const targetUserId = String(body.user_id ?? "").trim();
    const decision = String(body.decision ?? "");
    const role = body.role ? String(body.role) : null;
    const clientIds: string[] = Array.isArray(body.client_ids) ? body.client_ids : [];
    const rejectionReason = body.rejection_reason ? String(body.rejection_reason).trim() : null;

    if (!targetUserId) {
      return new Response(JSON.stringify({ error: "Missing user_id" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (!VALID_DECISIONS.includes(decision as typeof VALID_DECISIONS[number])) {
      return new Response(JSON.stringify({ error: "Invalid decision" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (role && !VALID_ROLES.includes(role as typeof VALID_ROLES[number])) {
      return new Response(JSON.stringify({ error: "Invalid role" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const token = authHeader.replace(/^Bearer\s+/i, "");
    const { data: claimsData, error: claimsErr } = await callerClient.auth.getClaims(token);
    if (claimsErr || !claimsData?.claims?.sub) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const callerId = claimsData.claims.sub as string;

    const { data: callerRole } = await callerClient.rpc("get_user_role", { _user_id: callerId });
    if (callerRole !== "admin" && callerRole !== "super_admin") {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if ((role === "admin" || role === "super_admin") && callerRole !== "super_admin") {
      return new Response(JSON.stringify({ error: "Only super_admin can assign admin roles" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE);

    if (decision === "approve") {
      const { error: profileErr } = await adminClient
        .from("profiles")
        .update({
          approval_status: "approved",
          approved_at: new Date().toISOString(),
          approved_by: callerId,
          rejection_reason: null,
        })
        .eq("id", targetUserId);
      if (profileErr) throw profileErr;

      // Optional role override
      if (role) {
        await adminClient.from("user_roles").delete().eq("user_id", targetUserId);
        const { error: roleErr } = await adminClient.from("user_roles").insert({ user_id: targetUserId, role });
        if (roleErr) throw roleErr;
      }

      // Optional client access grants (additive)
      if (clientIds.length) {
        const rows = clientIds.map((cid) => ({ user_id: targetUserId, client_id: cid }));
        const { error: accessErr } = await adminClient
          .from("user_client_access")
          .upsert(rows, { onConflict: "user_id,client_id" });
        if (accessErr) throw accessErr;
      }
    } else {
      // Reject
      const { error: profileErr } = await adminClient
        .from("profiles")
        .update({
          approval_status: "rejected",
          rejection_reason: rejectionReason,
          approved_by: callerId,
          approved_at: new Date().toISOString(),
        })
        .eq("id", targetUserId);
      if (profileErr) throw profileErr;
    }

    return new Response(JSON.stringify({ ok: true, user_id: targetUserId, decision }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("admin-approve-user error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
