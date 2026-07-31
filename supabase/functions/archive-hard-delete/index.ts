import { createClient } from "npm:@supabase/supabase-js@2.103.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function clearBucketFolder(
  admin: ReturnType<typeof createClient>,
  bucket: string,
  prefix: string,
): Promise<{ removed: number; bytes: number; errors: string[] }> {
  let removed = 0;
  let bytes = 0;
  const errors: string[] = [];
  // Iterate until empty (cap pages to avoid runaway).
  for (let page = 0; page < 50; page++) {
    const { data, error } = await admin.storage.from(bucket).list(prefix, { limit: 1000 });
    if (error) {
      errors.push(`list ${bucket}/${prefix}: ${error.message}`);
      break;
    }
    if (!data || data.length === 0) break;
    const paths: string[] = [];
    for (const item of data) {
      if (!item.name) continue;
      const size = (item.metadata as { size?: number } | null)?.size ?? 0;
      bytes += size;
      paths.push(`${prefix}/${item.name}`);
    }
    if (paths.length === 0) break;
    const { error: rmErr } = await admin.storage.from(bucket).remove(paths);
    if (rmErr) {
      errors.push(`remove ${bucket}/${prefix}: ${rmErr.message}`);
      break;
    }
    removed += paths.length;
    if (data.length < 1000) break;
  }
  return { removed, bytes, errors };
}

function logoPathFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  // Stored either as bare object path or as a public/signed URL containing the bucket name.
  const marker = "/client-logos/";
  const idx = url.indexOf(marker);
  if (idx >= 0) {
    const tail = url.slice(idx + marker.length).split("?")[0];
    return tail || null;
  }
  if (!/^https?:\/\//i.test(url)) return url.replace(/^\/+/, "");
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);

    let body: { entity_type?: string; entity_id?: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    const entity_type = body.entity_type;
    const entity_id = body.entity_id;
    if (entity_type !== "client" && entity_type !== "project") {
      return json({ error: "entity_type must be 'client' or 'project'" }, 400);
    }
    if (!entity_id || !UUID_RE.test(entity_id)) {
      return json({ error: "entity_id must be a UUID" }, 400);
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const { data: claimsData, error: claimsErr } = await caller.auth.getClaims(token);
    if (claimsErr || !claimsData?.claims?.sub) return json({ error: "Unauthorized" }, 401);
    const actorId = claimsData.claims.sub as string;

    const { data: role, error: roleErr } = await caller.rpc("get_user_role", { _user_id: actorId });
    if (roleErr) return json({ error: roleErr.message }, 500);
    if (role !== "admin" && role !== "super_admin") return json({ error: "Forbidden" }, 403);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // Resolve target context.
    let clientId: string | null = null;
    let entityName = "";
    let logoUrl: string | null = null;
    const projectIds: string[] = [];

    if (entity_type === "client") {
      const { data: client, error } = await admin
        .from("clients")
        .select("id, company_name, logo_url, archived_at")
        .eq("id", entity_id)
        .maybeSingle();
      if (error) return json({ error: error.message }, 500);
      if (!client) return json({ error: "Client not found" }, 404);
      if (!client.archived_at) return json({ error: "Client must be archived before hard delete" }, 409);
      clientId = client.id as string;
      entityName = client.company_name as string;
      logoUrl = (client.logo_url as string | null) ?? null;

      const { data: projects, error: projErr } = await admin
        .from("navigator_projects")
        .select("id")
        .eq("client_id", entity_id);
      if (projErr) return json({ error: projErr.message }, 500);
      for (const p of projects ?? []) projectIds.push(p.id as string);
    } else {
      const { data: project, error } = await admin
        .from("navigator_projects")
        .select("id, project_name, client_id, archived_at")
        .eq("id", entity_id)
        .maybeSingle();
      if (error) return json({ error: error.message }, 500);
      if (!project) return json({ error: "Project not found" }, 404);
      if (!project.archived_at) return json({ error: "Project must be archived before hard delete" }, 409);
      clientId = project.client_id as string;
      entityName = project.project_name as string;
      projectIds.push(project.id as string);
    }

    // Capture row counts (best-effort, never fatal).
    const counts: Record<string, number> = {};
    const safeCount = async (table: string, column: string, value: string) => {
      try {
        const { count } = await admin
          .from(table)
          .select("*", { count: "exact", head: true })
          .eq(column, value);
        if (typeof count === "number") counts[table] = count;
      } catch (_) { /* ignore */ }
    };
    if (entity_type === "client") {
      await safeCount("navigator_projects", "client_id", entity_id);
    }
    for (const pid of projectIds) {
      for (const t of ["keywords", "keyword_forecasts", "content_plan_items", "serp_results", "monitor_campaigns"]) {
        // Sum across projects.
        try {
          const { count } = await admin
            .from(t)
            .select("*", { count: "exact", head: true })
            .eq("project_id", pid);
          if (typeof count === "number") counts[t] = (counts[t] ?? 0) + count;
        } catch (_) { /* ignore */ }
      }
    }

    // Storage cleanup (best-effort).
    const storage: {
      bytes_removed: number;
      objects_removed: number;
      buckets: string[];
      errors: string[];
    } = { bytes_removed: 0, objects_removed: 0, buckets: [], errors: [] };

    if (entity_type === "client") {
      const path = logoPathFromUrl(logoUrl);
      if (path) {
        const { error: rmErr } = await admin.storage.from("client-logos").remove([path]);
        if (rmErr) storage.errors.push(`client-logos: ${rmErr.message}`);
        else {
          storage.objects_removed += 1;
          if (!storage.buckets.includes("client-logos")) storage.buckets.push("client-logos");
        }
      }
    }
    for (const pid of projectIds) {
      const res = await clearBucketFolder(admin, "slide-exports", pid);
      storage.objects_removed += res.removed;
      storage.bytes_removed += res.bytes;
      if (res.removed > 0 && !storage.buckets.includes("slide-exports")) storage.buckets.push("slide-exports");
      storage.errors.push(...res.errors);
    }

    // Perform the hard delete via caller-scoped RPC so the admin gate fires again.
    const rpcName = entity_type === "client" ? "hard_delete_client" : "hard_delete_project";
    const rpcArg = entity_type === "client" ? { _client_id: entity_id } : { _project_id: entity_id };
    const { error: rpcErr } = await caller.rpc(rpcName, rpcArg);
    if (rpcErr) {
      return json({
        error: rpcErr.message,
        storage,
        note: "Storage objects already removed before RPC failure",
      }, 500);
    }

    // Final summary audit row (additive; tagged so it doesn't look like a duplicate).
    try {
      await admin.from("archive_audit").insert({
        entity_type,
        entity_id,
        client_id: clientId,
        action: "hard_delete",
        actor_id: actorId,
        metadata: {
          summary_written_by: "edge",
          storage,
          counts,
        },
      });
    } catch (e) {
      // Audit summary failure is non-fatal; the RPC already wrote a row.
      console.warn("audit summary insert failed", e);
    }

    return json({
      ok: true,
      entity_type,
      entity_id,
      entity_name: entityName,
      storage,
      counts,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: msg }, 500);
  }
});
