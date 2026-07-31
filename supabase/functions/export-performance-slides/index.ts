// Export the Performance & Ops tab screenshot into a duplicated Google Slides template.
// Uses the Google Slides connector (which has Drive scopes attached) for both Drive copy and Slides insert.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const TEMPLATE_ID = "1JTTA65ikwfYFahIfDhVUSNHi3wjovG4CiymrDWJjuec";
const SLIDES_BASE = "https://connector-gateway.lovable.dev/google_slides";
const DRIVE_BASE = "https://connector-gateway.lovable.dev/google_drive";

function emuFromPt(pt: number): number {
  return Math.round(pt * 12700);
}

async function gatewayFetch(base: string, path: string, init: RequestInit, lovableKey: string, connectorKey: string) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${lovableKey}`,
      "X-Connection-Api-Key": connectorKey,
    },
  });
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`Gateway ${path} failed [${res.status}]: ${JSON.stringify(body)}`);
  }
  return body;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const SLIDES_KEY = Deno.env.get("GOOGLE_SLIDES_API_KEY");
    if (!SLIDES_KEY) throw new Error("GOOGLE_SLIDES_API_KEY is not configured");

    const DRIVE_KEY = Deno.env.get("GOOGLE_DRIVE_API_KEY");
    if (!DRIVE_KEY) throw new Error("GOOGLE_DRIVE_API_KEY is not configured");

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing Authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { project_id, image_url } = await req.json();
    if (!project_id || !image_url) {
      return new Response(
        JSON.stringify({ error: "project_id and image_url are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Fetch project + client name
    const { data: project, error: projErr } = await supabase
      .from("navigator_projects")
      .select("project_name, clients(company_name)")
      .eq("id", project_id)
      .single();
    if (projErr || !project) throw new Error(`Project not found: ${projErr?.message}`);

    const clientName = (project.clients as any)?.company_name ?? "Client";
    const today = new Date().toISOString().slice(0, 10);
    const newName = `[seer export] ${clientName} ${project.project_name} ${today}`;

    // Step 1: Copy template via dedicated Drive connector
    const copyResp = await gatewayFetch(
      DRIVE_BASE,
      `/drive/v3/files/${TEMPLATE_ID}/copy`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      },
      LOVABLE_API_KEY,
      DRIVE_KEY,
    );
    const newId = copyResp.id;
    if (!newId) throw new Error(`Drive copy did not return an id: ${JSON.stringify(copyResp)}`);

    // Step 2: Read the new presentation via Slides connector
    const pres = await gatewayFetch(
      SLIDES_BASE,
      `/v1/presentations/${newId}`,
      { method: "GET" },
      LOVABLE_API_KEY,
      SLIDES_KEY,
    );

    const slideW = pres.pageSize?.width?.magnitude ?? emuFromPt(720); // default 10in @72pt
    const slideH = pres.pageSize?.height?.magnitude ?? emuFromPt(405);
    const firstSlide = pres.slides?.[0];
    if (!firstSlide) throw new Error("Template has no slides");

    // Find title placeholder bounds (if present)
    let titleBottomEmu = emuFromPt(60); // sensible default ~60pt header band
    let titleLeftEmu = emuFromPt(20);
    let usableWidthEmu = slideW - emuFromPt(40);

    for (const el of firstSlide.pageElements ?? []) {
      const ph = el.shape?.placeholder;
      if (ph && (ph.type === "TITLE" || ph.type === "CENTERED_TITLE")) {
        const tx = el.transform || {};
        const sizeH = el.size?.height?.magnitude ?? 0;
        const scaleY = tx.scaleY ?? 1;
        const translateY = tx.translateY ?? 0;
        titleBottomEmu = translateY + sizeH * scaleY;
        const translateX = tx.translateX ?? 0;
        titleLeftEmu = translateX;
        const sizeW = el.size?.width?.magnitude ?? 0;
        const scaleX = tx.scaleX ?? 1;
        usableWidthEmu = sizeW * scaleX;
        break;
      }
    }

    const gapEmu = emuFromPt(10);
    const imageTopEmu = titleBottomEmu + gapEmu;
    const marginBottomEmu = emuFromPt(20);
    const availableHeightEmu = slideH - imageTopEmu - marginBottomEmu;
    const availableWidthEmu = usableWidthEmu;

    // Probe image dimensions to preserve aspect ratio
    let imgW = 1600;
    let imgH = 900;
    try {
      const head = await fetch(image_url, { method: "GET" });
      const buf = new Uint8Array(await head.arrayBuffer());
      // PNG: width at bytes 16-19, height at 20-23 (big-endian)
      if (
        buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
      ) {
        imgW = (buf[16] << 24) | (buf[17] << 16) | (buf[18] << 8) | buf[19];
        imgH = (buf[20] << 24) | (buf[21] << 16) | (buf[22] << 8) | buf[23];
      }
    } catch (e) {
      console.warn("Could not probe image dimensions, using 16:9 default", e);
    }

    const imgAspect = imgW / imgH;
    let drawW = availableWidthEmu;
    let drawH = drawW / imgAspect;
    if (drawH > availableHeightEmu) {
      drawH = availableHeightEmu;
      drawW = drawH * imgAspect;
    }
    const drawX = titleLeftEmu + (availableWidthEmu - drawW) / 2;
    const drawY = imageTopEmu;

    // Step 3: Insert image into slide 1 via Slides connector
    await gatewayFetch(
      SLIDES_BASE,
      `/v1/presentations/${newId}:batchUpdate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [
            {
              createImage: {
                url: image_url,
                elementProperties: {
                  pageObjectId: firstSlide.objectId,
                  size: {
                    width: { magnitude: drawW, unit: "EMU" },
                    height: { magnitude: drawH, unit: "EMU" },
                  },
                  transform: {
                    scaleX: 1,
                    scaleY: 1,
                    translateX: drawX,
                    translateY: drawY,
                    unit: "EMU",
                  },
                },
              },
            },
          ],
        }),
      },
      LOVABLE_API_KEY,
      SLIDES_KEY,
    );

    // Step 4: Deck sharing is intentionally NOT set to "anyone with link".
    // The template lives in the No Brainer Agency Google Workspace; copies inherit
    // the template's default sharing (agency members). Explicit recipient sharing
    // must be done by the exporter from within Slides. This avoids leaking client
    // revenue/performance data via a forwarded or indexed link.


    return new Response(
      JSON.stringify({
        url: `https://docs.google.com/presentation/d/${newId}/edit`,
        name: newName,
        id: newId,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("export-performance-slides error:", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
