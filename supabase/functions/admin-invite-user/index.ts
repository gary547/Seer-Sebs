import { createClient } from "npm:@supabase/supabase-js@2.103.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const VALID_ROLES = ["super_admin", "admin", "user", "view_only"] as const;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const body = await req.json();
    const email = String(body.email ?? "").trim().toLowerCase();
    const fullName = String(body.full_name ?? "").trim();
    const role = String(body.role ?? "view_only");
    const clientIds: string[] = Array.isArray(body.client_ids) ? body.client_ids : [];

    if (!email || !email.includes("@")) {
      return new Response(JSON.stringify({ error: "Invalid email" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (!VALID_ROLES.includes(role as typeof VALID_ROLES[number])) {
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
    // Only super_admin can invite admins or super_admins
    if ((role === "admin" || role === "super_admin") && callerRole !== "super_admin") {
      return new Response(JSON.stringify({ error: "Only super_admin can assign admin roles" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE);

    // Invite or find existing user
    let targetUserId: string | null = null;
    const { data: invited, error: inviteErr } = await adminClient.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName, invited_by_admin: true },
      redirectTo: `${new URL(req.url).origin.replace("https://", "https://")}/reset-password`,
    });

    if (inviteErr) {
      // If user already exists, look them up
      const msg = inviteErr.message?.toLowerCase() ?? "";
      if (msg.includes("already") || msg.includes("registered") || msg.includes("exists")) {
        const { data: list } = await adminClient.auth.admin.listUsers({ perPage: 1000 });
        const existing = list.users.find((u) => u.email?.toLowerCase() === email);
        if (!existing) throw inviteErr;
        targetUserId = existing.id;
      } else {
        throw inviteErr;
      }
    } else {
      targetUserId = invited.user?.id ?? null;
    }

    if (!targetUserId) throw new Error("Could not resolve target user");

    // Ensure profile exists and is auto-approved (admin-initiated)
    await adminClient.from("profiles").upsert({
      id: targetUserId,
      email,
      full_name: fullName || null,
      approval_status: "approved",
      approved_at: new Date().toISOString(),
      approved_by: callerId,
    }, { onConflict: "id" });

    // Set role: delete existing roles, insert new one (single-role model)
    await adminClient.from("user_roles").delete().eq("user_id", targetUserId);
    await adminClient.from("user_roles").insert({ user_id: targetUserId, role });

    // Grant client access
    if (clientIds.length) {
      const rows = clientIds.map((cid) => ({ user_id: targetUserId!, client_id: cid }));
      await adminClient.from("user_client_access").upsert(rows, { onConflict: "user_id,client_id" });
    }

    return new Response(JSON.stringify({ user_id: targetUserId, email }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("admin-invite-user error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
