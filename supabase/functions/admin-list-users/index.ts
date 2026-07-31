import { createClient } from "npm:@supabase/supabase-js@2.103.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Caller client (uses caller JWT) — used to verify role via RLS-protected RPC
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const token = authHeader.replace(/^Bearer\s+/i, "");
    const { data: claimsData, error: claimsErr } = await callerClient.auth.getClaims(token);
    if (claimsErr || !claimsData?.claims?.sub) {
      console.error("admin-list-users auth error:", claimsErr);
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = claimsData.claims.sub as string;

    const { data: roleData } = await callerClient.rpc("get_user_role", { _user_id: userId });
    if (roleData !== "admin" && roleData !== "super_admin") {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Admin client (service role) — read auth.users
    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE);

    const { data: authData, error: authErr } = await adminClient.auth.admin.listUsers({ perPage: 1000 });
    if (authErr) throw authErr;

    const userIds = authData.users.map((u) => u.id);

    const [profilesRes, rolesRes, accessRes] = await Promise.all([
      adminClient.from("profiles").select("id, full_name, email, approval_status, approved_at, approved_by, rejection_reason").in("id", userIds),
      adminClient.from("user_roles").select("user_id, role").in("user_id", userIds),
      adminClient.from("user_client_access").select("user_id, client_id").in("user_id", userIds),
    ]);

    const profileMap = new Map((profilesRes.data ?? []).map((p) => [p.id, p]));
    const rolesMap = new Map<string, string>();
    (rolesRes.data ?? []).forEach((r) => rolesMap.set(r.user_id, r.role));
    const accessMap = new Map<string, string[]>();
    (accessRes.data ?? []).forEach((a) => {
      const arr = accessMap.get(a.user_id) ?? [];
      arr.push(a.client_id);
      accessMap.set(a.user_id, arr);
    });

    const users = authData.users.map((u) => {
      const p = profileMap.get(u.id);
      return {
        id: u.id,
        email: u.email,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at,
        full_name: p?.full_name ?? null,
        role: rolesMap.get(u.id) ?? null,
        client_ids: accessMap.get(u.id) ?? [],
        approval_status: p?.approval_status ?? "approved",
        approved_at: p?.approved_at ?? null,
        approved_by: p?.approved_by ?? null,
        rejection_reason: p?.rejection_reason ?? null,
      };
    });

    return new Response(JSON.stringify({ users }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("admin-list-users error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
