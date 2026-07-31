import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

/**
 * categorisation-consolidate
 *
 * Admin-triggered, opt-in cleanup of polluted/near-duplicate Tag 1 values
 * for a single client. Modes:
 *
 * - "preview": fetch all distinct Tag 1 values + row counts for the client,
 *    ask Claude to propose a mapping (oldTag → newTag | null), and return
 *    the mapping side-by-side with row counts so the operator can preview
 *    EXACTLY what moves before they apply.
 *
 * - "apply": persist the mapping. For every keyword whose Tag 1 changes:
 *    1) snapshot before/after into `keyword_tag_history` with a shared
 *       `batch_id`, then 2) UPDATE the keyword. Both happen for the SAME
 *    client only. Forecast math, CTR curves, HAR, revenue, opportunity
 *    tagging — none of these are touched.
 *
 * - "undo": find the most recent `batch_id` for this client in
 *    `keyword_tag_history` and restore the `tag_1_before` / `kw_cluster_before`
 *    values, then DELETE that history batch so the operator can re-run
 *    consolidate cleanly.
 *
 * Mapping value semantics (oldTag → value):
 *   string  : rename oldTag to this canonical value (snap)
 *   null    : clear oldTag (set tag_1 = NULL — used for intent labels)
 *   "KEEP"  : leave oldTag untouched (defaults to KEEP for any missing key)
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const INTENT_LABELS = new Set(["transactional", "commercial", "informational", "navigational"]);

type MappingValue = string | null;
type Mapping = Record<string, MappingValue>;

function buildClusterFromTags(tags: (string | null)[]): string | null {
  const joined = tags.filter(Boolean).join(" > ");
  return joined || null;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing authorization header");

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Identify the caller — used to stamp `keyword_tag_history.changed_by`.
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) throw new Error("Not authenticated");
    const callerId = userData.user.id;

    const body = await req.json();
    const mode: "preview" | "apply" | "undo" = body.mode;
    const clientId: string = body.client_id;
    if (!mode || !clientId) throw new Error("mode and client_id are required");

    // ---- Resolve all keywords in this client's projects ------------------
    const { data: clientProjects, error: projErr } = await supabase
      .from("navigator_projects")
      .select("id")
      .eq("client_id", clientId);
    if (projErr) throw new Error(`Failed to fetch client projects: ${projErr.message}`);
    const projectIds = (clientProjects ?? []).map((p: any) => p.id);

    if (!projectIds.length) {
      return new Response(
        JSON.stringify({ mode, distinctTags: [], mapping: {}, totalAffected: 0, message: "No projects for this client." }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ---------------- UNDO ------------------------------------------------
    if (mode === "undo") {
      // Most recent batch for this client (consolidate-only — never touch
      // history rows from other sources like a future "recategorise" flow).
      const { data: lastBatchRows, error: lastErr } = await supabase
        .from("keyword_tag_history")
        .select("batch_id, changed_at")
        .eq("client_id", clientId)
        .eq("source", "consolidate")
        .order("changed_at", { ascending: false })
        .limit(1);
      if (lastErr) throw new Error(`Failed to find last batch: ${lastErr.message}`);
      const batchId = (lastBatchRows ?? [])[0]?.batch_id;
      if (!batchId) {
        return new Response(
          JSON.stringify({ mode, undone: 0, message: "No consolidate batch found to undo." }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // Pull every history row in that batch — these contain the snapshot
      // we need to restore.
      const { data: historyRows, error: histErr } = await supabase
        .from("keyword_tag_history")
        .select("keyword_id, tag_1_before, kw_cluster_before")
        .eq("batch_id", batchId)
        .eq("source", "consolidate");
      if (histErr) throw new Error(`Failed to load history: ${histErr.message}`);

      let restored = 0;
      // Group by (tag_1_before, kw_cluster_before) so we issue ~1 UPDATE per
      // unique restore target instead of one per keyword.
      const groups = new Map<string, { tag_1: string | null; kw_cluster: string | null; ids: string[] }>();
      for (const r of historyRows ?? []) {
        const t1 = (r as any).tag_1_before ?? null;
        const kc = (r as any).kw_cluster_before ?? null;
        const key = `${t1 ?? "∅"}__${kc ?? "∅"}`;
        if (!groups.has(key)) groups.set(key, { tag_1: t1, kw_cluster: kc, ids: [] });
        groups.get(key)!.ids.push((r as any).keyword_id);
      }
      for (const g of groups.values()) {
        for (const idsChunk of chunk(g.ids, 500)) {
          const { error: updErr } = await supabase
            .from("keywords")
            .update({ tag_1: g.tag_1, kw_cluster: g.kw_cluster })
            .in("id", idsChunk);
          if (updErr) throw new Error(`Restore failed: ${updErr.message}`);
          restored += idsChunk.length;
        }
      }

      // Delete the batch's history rows so a follow-up consolidate starts
      // from a clean slate.
      const { error: delErr } = await supabase
        .from("keyword_tag_history")
        .delete()
        .eq("batch_id", batchId);
      if (delErr) console.warn("Failed to delete history batch:", delErr.message);

      return new Response(
        JSON.stringify({ mode, batch_id: batchId, restored }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ---- Distinct Tag 1 values + row counts -----------------------------
    // Pull all rows once and aggregate in memory. Default Supabase row cap
    // is 1000 so we paginate.
    const distinctCounts = new Map<string, number>();
    let nullCount = 0;
    const PAGE = 1000;
    let from = 0;
    while (true) {
      const { data: page, error } = await supabase
        .from("keywords")
        .select("tag_1", { count: "exact" })
        .in("project_id", projectIds)
        .eq("detox_status", "keep")
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`Failed to scan keywords: ${error.message}`);
      if (!page?.length) break;
      for (const row of page) {
        const t = (row as any).tag_1;
        if (t == null || t === "") nullCount += 1;
        else distinctCounts.set(t, (distinctCounts.get(t) ?? 0) + 1);
      }
      if (page.length < PAGE) break;
      from += PAGE;
    }

    const distinctTags = Array.from(distinctCounts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count);

    // ---------------- PREVIEW --------------------------------------------
    if (mode === "preview") {
      if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured");
      if (!distinctTags.length) {
        return new Response(
          JSON.stringify({ mode, distinctTags: [], mapping: {}, totalAffected: 0, message: "No Tag 1 values to consolidate." }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // Auto-mapping for intent-labelled values (deterministic — no AI cost
      // and never wrong). These are guaranteed to be the Section 6a
      // pollution we want to clear.
      const autoMapping: Mapping = {};
      const tagsForAi: { tag: string; count: number }[] = [];
      for (const { tag, count } of distinctTags) {
        if (INTENT_LABELS.has(tag.toLowerCase())) {
          autoMapping[tag] = null; // clear — intent stays in search_intent
        } else {
          tagsForAi.push({ tag, count });
        }
      }

      let aiMapping: Mapping = {};
      if (tagsForAi.length >= 2) {
        const tagList = tagsForAi.map((t) => `- "${t.tag}" (${t.count} kw)`).join("\n");
        const systemPrompt = `You are an SEO taxonomist consolidating duplicate / near-duplicate Tag 1 category labels for a single client.

Rules:
- Output a JSON mapping { "oldTag": "newTag" } where newTag is the canonical value.
- Only include entries you want to RENAME. Tags that should stay as-is must NOT appear in the mapping (they default to KEEP).
- Choose the canonical value with the HIGHEST keyword count when merging duplicates.
- Singular form, Title Case (e.g. "Weight Loss" not "weightloss").
- Never use intent labels (Transactional / Commercial / Informational / Navigational) as a target — those are intent, not topics.
- Only merge tags that are clearly the same topic. When in doubt, keep them separate.`;

        const userPrompt = `EXISTING TAG 1 VALUES (with row counts):
${tagList}

Use the propose_mapping tool. Return only the renames you propose.`;

        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-5",
            max_tokens: 2000,
            system: systemPrompt,
            messages: [{ role: "user", content: userPrompt }],
            tools: [{
              name: "propose_mapping",
              description: "Return a flat mapping of oldTag -> newTag for renames.",
              input_schema: {
                type: "object",
                properties: {
                  renames: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        from: { type: "string" },
                        to: { type: "string" },
                      },
                      required: ["from", "to"],
                    },
                  },
                },
                required: ["renames"],
              },
            }],
            tool_choice: { type: "tool", name: "propose_mapping" },
          }),
        });
        if (!resp.ok) {
          const errText = await resp.text();
          console.error("Anthropic error:", resp.status, errText);
          throw new Error(`Anthropic API error: ${resp.status}`);
        }
        const data = await resp.json();
        const toolUse = (data.content || []).find((p: any) => p?.type === "tool_use" && p?.name === "propose_mapping");
        const renames: { from: string; to: string }[] = toolUse?.input?.renames ?? [];
        const knownTags = new Set(tagsForAi.map((t) => t.tag));
        for (const r of renames) {
          if (!r.from || !r.to) continue;
          if (!knownTags.has(r.from)) continue; // ignore hallucinated keys
          if (r.from === r.to) continue;        // no-op
          if (INTENT_LABELS.has(r.to.toLowerCase())) continue; // never demote to intent
          aiMapping[r.from] = r.to;
        }
      }

      const mapping: Mapping = { ...autoMapping, ...aiMapping };
      // Compute exact affected row totals for the preview UI.
      let totalAffected = 0;
      for (const tag of Object.keys(mapping)) {
        totalAffected += distinctCounts.get(tag) ?? 0;
      }

      return new Response(
        JSON.stringify({
          mode,
          distinctTags,
          nullCount,
          mapping,
          totalAffected,
          intentMerges: Object.keys(autoMapping).length,
          aiRenames: Object.keys(aiMapping).length,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ---------------- APPLY ----------------------------------------------
    if (mode === "apply") {
      const mapping: Mapping = body.mapping ?? {};
      const mappingKeys = Object.keys(mapping);
      if (!mappingKeys.length) {
        return new Response(
          JSON.stringify({ mode, applied: 0, batch_id: null, message: "Empty mapping — nothing to apply." }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // Generate one batch id so the operator can undo this exact run.
      const batchId = crypto.randomUUID();
      let totalApplied = 0;

      for (const oldTag of mappingKeys) {
        const newTag = mapping[oldTag];

        // Fetch all keyword rows currently labelled with oldTag (paginate).
        const affectedIds: { id: string; kw_cluster: string | null; tag_2: string | null; tag_3: string | null; tag_4: string | null; tag_5: string | null }[] = [];
        let pageFrom = 0;
        while (true) {
          const { data: page, error } = await supabase
            .from("keywords")
            .select("id, kw_cluster, tag_2, tag_3, tag_4, tag_5")
            .in("project_id", projectIds)
            .eq("tag_1", oldTag)
            .range(pageFrom, pageFrom + PAGE - 1);
          if (error) throw new Error(`Apply scan failed: ${error.message}`);
          if (!page?.length) break;
          affectedIds.push(...(page as any[]));
          if (page.length < PAGE) break;
          pageFrom += PAGE;
        }
        if (!affectedIds.length) continue;

        // 1) Snapshot before/after into history. Insert in chunks.
        const historyRows = affectedIds.map((row) => ({
          keyword_id: row.id,
          client_id: clientId,
          changed_by: callerId,
          source: "consolidate",
          batch_id: batchId,
          tag_1_before: oldTag,
          tag_1_after: newTag, // null = cleared
          kw_cluster_before: row.kw_cluster,
          kw_cluster_after: buildClusterFromTags([newTag, row.tag_2, row.tag_3, row.tag_4, row.tag_5]),
        }));
        for (const slice of chunk(historyRows, 500)) {
          const { error: histErr } = await supabase.from("keyword_tag_history").insert(slice);
          if (histErr) throw new Error(`History insert failed: ${histErr.message}`);
        }

        // 2) Apply the UPDATE — group by destination kw_cluster so we keep
        //    the cluster derivation in lockstep with tag_1.
        // Group by kw_cluster_after so we issue 1 UPDATE per distinct cluster value.
        const byCluster = new Map<string, { kw_cluster: string | null; ids: string[] }>();
        for (const row of affectedIds) {
          const newCluster = buildClusterFromTags([newTag, row.tag_2, row.tag_3, row.tag_4, row.tag_5]);
          const key = newCluster ?? "∅";
          if (!byCluster.has(key)) byCluster.set(key, { kw_cluster: newCluster, ids: [] });
          byCluster.get(key)!.ids.push(row.id);
        }
        for (const g of byCluster.values()) {
          for (const idsChunk of chunk(g.ids, 500)) {
            const { error: updErr } = await supabase
              .from("keywords")
              .update({ tag_1: newTag, kw_cluster: g.kw_cluster })
              .in("id", idsChunk);
            if (updErr) throw new Error(`Apply update failed: ${updErr.message}`);
            totalApplied += idsChunk.length;
          }
        }
      }

      return new Response(
        JSON.stringify({ mode, applied: totalApplied, batch_id: batchId }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    throw new Error(`Unknown mode: ${mode}`);
  } catch (error) {
    console.error("categorisation-consolidate error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
