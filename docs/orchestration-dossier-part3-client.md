# Orchestration Dossier — Part 3: Client-Side Orchestration

Verbatim sources for the hooks and components that own the browser-driven pipeline loop. The advisor should treat every fetch/loop/timer in these files as browser-tab-lifetime-dependent unless proven otherwise.

---

## src/hooks/useNavigatorSync.ts

### `src/hooks/useNavigatorSync.ts`

```ts
import { useState, useEffect, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";

/**
 * Single source of truth for the Navigator sync pipeline.
 *
 * Both the header `SyncNowPanel` and the first-run `BuildProgressPanel`
 * consume this hook so the byte-identical pipeline runs in both places — no
 * forking of phase logic, no risk of one entry point falling out of date.
 *
 * The pipeline itself (phase order, probe queries, edge function calls) is
 * lifted verbatim from the previous in-component implementation. Forecast
 * math, CTR curves, HAR, revenue, and opportunity tagging are untouched.
 */

export type PhaseStatus = "pending" | "running" | "skipped" | "done" | "error";

export interface Phase {
  key: string;
  label: string;
  description: string;
  status: PhaseStatus;
  detail?: string;
}

export const initialPhases: Phase[] = [
  { key: "detox",          label: "Keyword Detox",         description: "Run Claude detox on any new keywords",                  status: "pending" },
  { key: "categorisation", label: "Categorisation",        description: "Assign Tag 1–5 + intent to kept keywords",             status: "pending" },
  { key: "enrichment",     label: "Enrichment",            description: "DataForSEO volume, difficulty, intent",                status: "pending" },
  { key: "ranking_urls",   label: "Ranking URLs",          description: "Resolve client ranking URLs (only if missing)",        status: "pending" },
  { key: "har",            label: "TP & SERP refresh",    description: "Refetch SERP rankings, features, backlinks if stale",  status: "pending" },
  { key: "gsc",            label: "GSC intent enrichment", description: "Re-enrich latest GSC upload (only if missing intent)", status: "pending" },
  { key: "forecasts",      label: "Recompute forecasts",   description: "Always re-run — picks up the freshest data",           status: "pending" },
  { key: "site_arch",      label: "Site architecture",     description: "Score keyword-to-URL relevancy for any new keywords",  status: "pending" },
];

export const formatElapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem.toString().padStart(2, "0")}s`;
};

interface Options {
  projectId: string;
  stalenessDays?: number;
}

export interface BlockedDetox {
  projectId: string;
  jobId: string;
  message: string;
  reason: string;
}

export function useNavigatorSync({ projectId, stalenessDays = 7 }: Options) {
  const queryClient = useQueryClient();
  const [running, setRunning] = useState(false);
  const [phases, setPhases] = useState<Phase[]>(initialPhases);
  const [completedAt, setCompletedAt] = useState<Date | null>(null);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [activePhaseStartedAt, setActivePhaseStartedAt] = useState<number | null>(null);
  const [activePhaseKey, setActivePhaseKey] = useState<string | null>(null);
  const [blockedDetox, setBlockedDetox] = useState<BlockedDetox | null>(null);
  const [, setNowTick] = useState(0);

  // Tick every second while a sync is running so elapsed timers stay live.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNowTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [running]);


  const updatePhase = useCallback((key: string, patch: Partial<Phase>) => {
    setPhases((prev) => prev.map((p) => (p.key === key ? { ...p, ...patch } : p)));
    if (patch.status === "running") {
      setActivePhaseKey(key);
      setActivePhaseStartedAt(Date.now());
    }
  }, []);

  const runSync = useCallback(async () => {
    setRunning(true);
    setCompletedAt(null);
    setRunStartedAt(Date.now());
    setActivePhaseStartedAt(null);
    setActivePhaseKey(null);
    setBlockedDetox(null);
    setPhases(initialPhases.map((p) => ({ ...p, status: "pending", detail: undefined })));


    const stalenessCutoff = new Date(Date.now() - stalenessDays * 86400 * 1000);
    let currentPhaseKey = "";

    try {
      // ---- Read project sync flags up-front --------------------------------
      // These let us short-circuit whole phases when nothing has changed since
      // the last successful sync. Without this gate, every "Sync Now" press
      // fires probe queries (and sometimes empty edge-function jobs) for
      // every phase even on a clean project.
      const { data: syncRow } = await supabase
        .from("navigator_projects")
        .select("last_synced_at, keywords_dirty, serp_dirty, inputs_dirty")
        .eq("id", projectId)
        .maybeSingle();

      const firstSync       = !syncRow?.last_synced_at;
      const keywordsChanged = firstSync || !!syncRow?.keywords_dirty;
      const serpDirtyFlag   = firstSync || !!syncRow?.serp_dirty;
      const inputsChanged   = firstSync || !!syncRow?.inputs_dirty;

      const [
        { count: pendingDetoxCount },
        { data: lastSerp },
        { data: lastGsc },
      ] = await Promise.all([
        supabase.from("keywords").select("id", { count: "exact", head: true }).eq("project_id", projectId).eq("detox_status", "pending"),
        supabase.from("serp_results").select("fetched_at").eq("project_id", projectId).order("fetched_at", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("gsc_uploads").select("id, uploaded_at").eq("project_id", projectId).order("uploaded_at", { ascending: false }).limit(1).maybeSingle(),
      ]);

      const serpStale = !lastSerp?.fetched_at || new Date(lastSerp.fetched_at) < stalenessCutoff;
      const serpChanged = serpDirtyFlag || serpStale;

      // ---- Phase 1: Detox (background job) --------------------------------
      currentPhaseKey = "detox";
      if (!keywordsChanged && (pendingDetoxCount ?? 0) === 0) {
        updatePhase("detox", { status: "skipped", detail: "No keyword changes since last sync" });
      } else if ((pendingDetoxCount ?? 0) > 0) {
        updatePhase("detox", { status: "running", detail: `Starting detox for ${pendingDetoxCount} keywords…` });
        const { data: startData, error: startErr } = await supabase.functions.invoke("keyword-detox", {
          body: { project_id: projectId, mode: "start" },
        });
        if (startErr) throw new Error(`Detox: ${startErr.message}`);
        if ((startData as any)?.error) throw new Error(`Detox: ${(startData as any).error}`);
        const jobId = (startData as any)?.job_id as string | null;

        if (!jobId) {
          updatePhase("detox", { status: "skipped", detail: "No pending keywords" });
        } else {
          // Poll detox_jobs row. The user CAN close this tab — the worker keeps
          // running on the edge and a cron tick re-kicks it if it stalls.
          const POLL_MS = 2_000;
          const MAX_WAIT_MS = 60 * 60 * 1_000; // 1h hard ceiling for a single sync UI session
          const t0 = Date.now();
          let lastProcessed = -1;
          let stallTicks = 0;
          let kept = 0, removed = 0;
          // eslint-disable-next-line no-constant-condition
          while (true) {
            await new Promise((r) => setTimeout(r, POLL_MS));
            const { data: jobRow } = await supabase
              .from("detox_jobs").select("status, total, processed, kept, removed, last_error, heartbeat_at, block_reason")
              .eq("id", jobId).maybeSingle();
            if (!jobRow) {
              throw new Error("Detox job row disappeared");
            }
            const j = jobRow as any;
            kept = j.kept ?? 0;
            removed = j.removed ?? 0;
            const remaining = Math.max(0, (j.total ?? 0) - (j.processed ?? 0));
            updatePhase("detox", {
              status: "running",
              detail: `Detoxing… ${remaining} remaining (${kept} kept · ${removed} removed)`,
            });
            if (j.status === "done") break;
            if (j.status === "blocked") {
              // Anthropic fatal error (no credit / bad key / permission denied).
              // Surface to the UI so the user can choose to skip detox and
              // keep every keyword. Pipeline pauses here until they decide.
              const msg = j.last_error || "Anthropic is unavailable";
              updatePhase("detox", { status: "error", detail: msg });
              setBlockedDetox({ projectId, jobId, message: msg, reason: j.block_reason || "ai_unavailable" });
              toast.error("Keyword Detox blocked", { description: msg });
              setRunning(false);
              return;
            }
            if (j.status === "error") throw new Error(`Detox: ${j.last_error || "unknown error"}`);

            const hbAge = j.heartbeat_at ? Date.now() - new Date(j.heartbeat_at).getTime() : 0;
            if (hbAge > 90_000) {
              await supabase.functions.invoke("keyword-detox", {
                body: { mode: "tick", job_id: jobId },
              }).catch(() => {});
            }

            if (j.processed === lastProcessed) {
              stallTicks++;
              if (stallTicks > 60) {
                const hint = j.last_error ? ` (last error: ${j.last_error})` : " (check Edge Function logs)";
                throw new Error(`Detox stalled — no progress for ${Math.round((stallTicks * POLL_MS) / 1000)}s${hint}`);
              }
            } else {
              stallTicks = 0;
              lastProcessed = j.processed;
            }
            if (Date.now() - t0 > MAX_WAIT_MS) throw new Error("Detox took longer than 1h — check Edge Function logs");
          }

          updatePhase("detox", { status: "done", detail: `${kept} kept, ${removed} removed` });
        }
      } else {
        updatePhase("detox", { status: "skipped", detail: "All keywords already detoxed" });
      }

      // ---- Phase 2: Categorisation (LIVE tier only) ----------------------
      // Long-tail informational/navigational keywords (≥5 words) are routed
      // to the deferred tier and processed by an overnight cron run, so they
      // never block the forecast build. We must count LIVE-tier-pending only —
      // counting all `tag_1 IS NULL` keywords would re-fire categorisation
      // every sync as soon as any deferred long-tail keyword exists, and the
      // worker would claim 0 rows (since it filters to live tier).
      currentPhaseKey = "categorisation";
      const [{ count: liveUncategorisedCount }, { count: keptCount }, { count: deferredBacklog }] = await Promise.all([
        supabase
          .from("keywords")
          .select("id", { count: "exact", head: true })
          .eq("project_id", projectId)
          .eq("detox_status", "keep")
          .is("tag_1", null)
          .or("categorisation_tier.is.null,categorisation_tier.eq.live"),
        supabase.from("keywords").select("id", { count: "exact", head: true }).eq("project_id", projectId).eq("detox_status", "keep"),
        supabase.from("keywords").select("id", { count: "exact", head: true }).eq("project_id", projectId).eq("detox_status", "keep").is("tag_1", null).eq("categorisation_tier", "deferred"),
      ]);

      if (!keywordsChanged && (liveUncategorisedCount ?? 0) === 0) {
        const note = (deferredBacklog ?? 0) > 0
          ? `${deferredBacklog} long-tail queued for overnight`
          : "No keyword changes since last sync";
        updatePhase("categorisation", { status: "skipped", detail: note });
      } else if ((liveUncategorisedCount ?? 0) > 0) {
        updatePhase("categorisation", { status: "running", detail: `Starting background categorisation for ${liveUncategorisedCount} keywords…` });
        const { data, error } = await supabase.functions.invoke("keyword-categorisation", {
          body: { project_id: projectId, tier: "live", mode: "start" },
        });
        if (error) throw new Error(`Categorisation: ${error.message}`);
        if ((data as any)?.error) throw new Error(`Categorisation: ${(data as any).error}`);

        const jobId = (data as any)?.job_id as string | null;
        let job: any = null;
        if (jobId) {
          for (let i = 0; i < 10; i++) {
            await new Promise((r) => setTimeout(r, 2_000));
            const { data: jobRow } = await supabase
              .from("categorisation_jobs")
              .select("status,total,processed,last_error,from_rules,from_cache,from_fast_path,from_ai,rate_limited_until")
              .eq("id", jobId)
              .maybeSingle();
            job = jobRow;
            if (!job) break;
            if (job.status === "error") throw new Error(`Categorisation: ${job.last_error || "unknown error"}`);
            const remaining = Math.max(0, (job.total ?? 0) - (job.processed ?? 0));
            updatePhase("categorisation", {
              status: "running",
              detail: `Categorisation running in background… ${job.processed ?? 0}/${job.total ?? 0} done (${remaining} remaining)`,
            });
            if (job.status === "done" || job.status === "rate_limited") break;
          }
        }

        const lastDeferred = deferredBacklog ?? 0;
        const savings = (job?.from_rules ?? 0) + (job?.from_cache ?? 0) + (job?.from_fast_path ?? 0);
        const deferredNote = lastDeferred > 0
          ? ` · ${lastDeferred} long-tail queued for overnight`
          : "";
        updatePhase("categorisation", {
          status: "done",
          detail: job?.status === "done"
            ? `Categorised ${job.processed ?? 0} live keywords (${savings} resolved without AI)${deferredNote}`
            : `Categorisation continues safely in background${deferredNote}`,
        });
        if (lastDeferred > 0) {
          toast.info(`${lastDeferred} long-tail keywords queued — they'll be categorised overnight and appear in the next sync.`);
        }
      } else if ((keptCount ?? 0) === 0) {
        updatePhase("categorisation", { status: "skipped", detail: "No kept keywords to categorise" });
      } else {
        const note = (deferredBacklog ?? 0) > 0
          ? `All live keywords categorised · ${deferredBacklog} long-tail queued for overnight`
          : "All keywords already categorised";
        updatePhase("categorisation", { status: "skipped", detail: note });
      }

      // ---- Phase 3: Enrichment --------------------------------------------
      currentPhaseKey = "enrichment";
      if (!keywordsChanged) {
        updatePhase("enrichment", { status: "skipped", detail: "No keyword changes since last sync" });
      } else {
      const [{ count: missingDifficultyCount }, { count: missingVolumeCount }] = await Promise.all([
        supabase.from("keywords").select("id", { count: "exact", head: true }).eq("project_id", projectId).eq("detox_status", "keep").is("keyword_difficulty", null),
        supabase.from("keywords").select("id", { count: "exact", head: true }).eq("project_id", projectId).eq("detox_status", "keep").is("avg_monthly_volume", null),
      ]);
      const enrichmentNeeded = (missingDifficultyCount ?? 0) > 0 || (missingVolumeCount ?? 0) > 0;
      if (enrichmentNeeded) {
        const missing = Math.max(missingDifficultyCount ?? 0, missingVolumeCount ?? 0);
        updatePhase("enrichment", { status: "running", detail: `Enriching ${missing} keywords via DataForSEO…` });

        // Sliced enrichment — function processes ~200 keywords per invocation
        // to stay under the 2s CPU limit. Loop until done.
        let offset = 0;
        let totalEnriched = 0;
        let totalVol = 0;
        let totalDiff = 0;
        for (let i = 0; i < 200; i++) {
          const { data, error } = await supabase.functions.invoke("keyword-enrichment", {
            body: { project_id: projectId, mode: "enrich", offset },
          });
          if (error) throw new Error(`Enrichment: ${error.message}`);
          if ((data as any)?.error) throw new Error(`Enrichment: ${(data as any).error}`);
          totalEnriched += (data as any)?.enriched ?? 0;
          totalVol += (data as any)?.volume_updated ?? 0;
          totalDiff += (data as any)?.difficulty_updated ?? 0;
          const next = (data as any)?.next_offset ?? offset;
          updatePhase("enrichment", {
            status: "running",
            detail: `Enriching… ${totalEnriched}/${missing} done`,
          });
          if ((data as any)?.done || next === offset) break;
          offset = next;
          await new Promise((r) => setTimeout(r, 200));
        }

        if ((missingVolumeCount ?? 0) > 0 && totalVol === 0) {
          throw new Error(
            `Enrichment returned 0 volumes for ${missingVolumeCount} keywords — DataForSEO likely rejected the batch. Check edge function logs.`,
          );
        }

        // Peaks pass — separate sliced invocation set, also CPU-bounded.
        updatePhase("enrichment", { status: "running", detail: `Computing seasonality peaks…` });
        let peakOffset = 0;
        let totalPeaks = 0;
        for (let i = 0; i < 200; i++) {
          const { data, error } = await supabase.functions.invoke("keyword-enrichment", {
            body: { project_id: projectId, mode: "peaks", offset: peakOffset },
          });
          if (error) throw new Error(`Enrichment peaks: ${error.message}`);
          if ((data as any)?.error) throw new Error(`Enrichment peaks: ${(data as any).error}`);
          totalPeaks += (data as any)?.peak_updated ?? 0;
          const next = (data as any)?.next_offset ?? peakOffset;
          if ((data as any)?.done || next === peakOffset) break;
          peakOffset = next;
        }

        updatePhase("enrichment", {
          status: "done",
          detail: `Enriched ${totalEnriched} kw · ${totalVol} volumes · ${totalDiff} difficulty · ${totalPeaks} peaks`,
        });
      } else if ((keptCount ?? 0) === 0) {
        updatePhase("enrichment", { status: "skipped", detail: "No kept keywords to enrich" });
      } else {
        updatePhase("enrichment", { status: "skipped", detail: "All metrics present" });
      }
      }

      // ---- Phase 4: Ranking URLs ------------------------------------------
      currentPhaseKey = "ranking_urls";
      const freshCutoffIso = stalenessCutoff.toISOString();
      if (!keywordsChanged) {
        updatePhase("ranking_urls", { status: "skipped", detail: "No keyword changes since last sync" });
      } else {
      const [{ count: missingRankingCount }, { count: freshNoMatchCount }] = await Promise.all([
        supabase
          .from("keywords")
          .select("id", { count: "exact", head: true })
          .eq("project_id", projectId)
          .eq("detox_status", "keep")
          .is("ranking_url", null)
          .or(`ranking_lookup_checked_at.is.null,ranking_lookup_checked_at.lt.${freshCutoffIso}`),
        supabase
          .from("keywords")
          .select("id", { count: "exact", head: true })
          .eq("project_id", projectId)
          .eq("detox_status", "keep")
          .is("ranking_url", null)
          .gte("ranking_lookup_checked_at", freshCutoffIso),
      ]);

      if ((missingRankingCount ?? 0) > 0) {
        updatePhase("ranking_urls", { status: "running", detail: `Resolving ${missingRankingCount} missing URLs…` });
        const { error } = await supabase.functions.invoke("ranking-url-lookup", { body: { project_id: projectId } });
        if (error) throw new Error(`Ranking URL lookup: ${error.message}`);
        const skippedNote = (freshNoMatchCount ?? 0) > 0 ? ` · skipped ${freshNoMatchCount} fresh no-matches` : "";
        updatePhase("ranking_urls", { status: "done", detail: `Looked up ${missingRankingCount} URLs (some may have no DataForSEO match)${skippedNote}` });
      } else if ((freshNoMatchCount ?? 0) > 0) {
        updatePhase("ranking_urls", { status: "skipped", detail: `${freshNoMatchCount} keywords still have no DataForSEO match (checked within ${stalenessDays}d)` });
      } else {
        updatePhase("ranking_urls", { status: "skipped", detail: "All ranking URLs present" });
      }
      }

      // ---- Phase 5: HAR / SERP refresh ------------------------------------
      // Gate the expensive missing-HAR scan on dirty flags. If nothing has
      // changed and SERP is fresh, skip without even reading har_results.
      currentPhaseKey = "har";
      let missingHarCount = 0;
      if (!serpChanged && !keywordsChanged) {
        // Skip discovery query entirely
      } else {
        const { data: keptIds } = await supabase
          .from("keywords")
          .select("id")
          .eq("project_id", projectId)
          .eq("detox_status", "keep");
        const { data: harRows } = await supabase
          .from("har_results")
          .select("keyword_id")
          .eq("project_id", projectId);
        const harSet = new Set((harRows ?? []).map((r: any) => r.keyword_id));
        missingHarCount = (keptIds ?? []).filter((k: any) => !harSet.has(k.id)).length;
      }

      if (serpStale || missingHarCount > 0) {
        const reason = missingHarCount > 0
          ? `${missingHarCount} keywords missing TP data`
          : (lastSerp?.fetched_at
              ? `last fetched ${formatDistanceToNow(new Date(lastSerp.fetched_at), { addSuffix: true })}`
              : "no SERP data yet");
        updatePhase("har", { status: "running", detail: `Starting durable refresh — ${reason}` });

        // Kick off the durable worker (returns immediately with a job id).
        const { data: startData, error: invokeErr } = await supabase.functions.invoke("har-calculation", {
          body: { mode: "start", project_id: projectId },
        });
        if (invokeErr) {
          const msg = (invokeErr as any)?.context?.body
            ? await (invokeErr as any).context.text?.().catch(() => "") || invokeErr.message
            : invokeErr.message;
          // Soft-skip when there are simply no kept keywords yet — not a sync failure.
          if (/no .?keep.? keywords/i.test(msg || "") || /No kept keywords/i.test(msg || "")) {
            updatePhase("har", { status: "skipped", detail: "No kept keywords — run Keyword Detox first" });
            return;
          }
          throw new Error(`TP calculation: ${invokeErr.message}`);
        }

        // Poll har_jobs (not navigator_projects.har_status). The worker is
        // resumed every minute by pg_cron, so we only watch progress here —
        // we never time out on the user. If the user closes the tab the
        // job continues in the background and resumes on revisit.
        const startedAt = Date.now();
        const POLL_INTERVAL_MS = 3000;
        const STALL_THRESHOLD_MS = 10 * 60 * 1000;
        let lastProgressKey = "";
        let lastProgressAt = Date.now();
        let finalStatus: string | null = null;
        // Sliding window of (timestamp_ms, totalDone) samples for ETA calc.
        const samples: Array<{ t: number; done: number }> = [];
        // Soft cap on the foreground watcher — after 25 minutes we let the
        // user proceed; the cron will keep finishing the job.
        const FOREGROUND_CAP_MS = 25 * 60 * 1000;

        while (Date.now() - startedAt < FOREGROUND_CAP_MS) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          const { data: jobRow } = await supabase
            .from("har_jobs")
            .select(
              "status,phase,serp_tasks_total,serp_tasks_posted,serp_tasks_done,ahrefs_targets_total,ahrefs_targets_done,backlinks_targets_total,backlinks_targets_done,backlinks_skipped,last_error",
            )
            .eq("project_id", projectId)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (!jobRow) continue;

          const elapsed = formatElapsed(Date.now() - startedAt);
          const serpDone = jobRow.serp_tasks_done ?? 0;
          const serpTotal = jobRow.serp_tasks_total ?? 0;
          const ahDone = jobRow.ahrefs_targets_done ?? 0;
          const ahTotal = jobRow.ahrefs_targets_total ?? 0;
          const blDone = jobRow.backlinks_targets_done ?? 0;
          const blTotal = jobRow.backlinks_targets_total ?? 0;

          const progressKey = `${serpDone}-${ahDone}-${blDone}-${jobRow.phase}`;
          if (progressKey !== lastProgressKey) {
            lastProgressKey = progressKey;
            lastProgressAt = Date.now();
          }

          // ETA — keep a 30s sliding window of total progress across all phases.
          const totalDone = serpDone + ahDone + blDone;
          const totalTotal = serpTotal + ahTotal + (jobRow.backlinks_skipped ? 0 : blTotal);
          const now = Date.now();
          samples.push({ t: now, done: totalDone });
          while (samples.length && now - samples[0].t > 30_000) samples.shift();
          let etaLabel = "";
          if (samples.length >= 2 && totalTotal > totalDone) {
            const dDone = totalDone - samples[0].done;
            const dT = (now - samples[0].t) / 1000; // seconds
            if (dDone > 0 && dT > 0) {
              const rate = dDone / dT; // items/sec
              const remaining = totalTotal - totalDone;
              etaLabel = ` · ETA ~${formatElapsed((remaining / rate) * 1000)}`;
            }
          }

          const detail = [
            `SERP ${serpDone}/${serpTotal}`,
            ahTotal ? `Ahrefs ${ahDone}/${ahTotal}` : null,
            blTotal && !jobRow.backlinks_skipped ? `Backlinks ${blDone}/${blTotal}` : null,
            `(${elapsed})${etaLabel}`,
          ].filter(Boolean).join(" · ");

          updatePhase("har", { status: "running", detail });

          if (jobRow.status === "completed") { finalStatus = "completed"; break; }
          if (jobRow.status === "error")     { finalStatus = "error"; break; }

          // Soft stall warning — cron keeps trying, surface a message but don't fail.
          if (Date.now() - lastProgressAt > STALL_THRESHOLD_MS) {
            updatePhase("har", {
              status: "running",
              detail: `${detail} — no recent progress, the background worker will retry automatically`,
            });
          }
        }

        if (finalStatus === "completed") {
          updatePhase("har", { status: "done", detail: "Refreshed SERPs, features, backlinks" });
        } else if (finalStatus === "error") {
          throw new Error("TP calculation failed — check har-calculation edge function logs.");
        } else {
          // Foreground cap reached — job continues in background.
          updatePhase("har", {
            status: "done",
            detail: "Still running in background — safe to leave this page; cron will finish the job",
          });
        }
      } else {
        const ageLabel = lastSerp?.fetched_at
          ? formatDistanceToNow(new Date(lastSerp.fetched_at), { addSuffix: true })
          : "recent";
        updatePhase("har", { status: "skipped", detail: `Fresh — last fetched ${ageLabel}` });
      }

      // ---- Phase 6: GSC enrichment ----------------------------------------
      currentPhaseKey = "gsc";
      if (lastGsc?.id) {
        const { count: missingIntentCount } = await supabase
          .from("gsc_upload_keywords")
          .select("id", { count: "exact", head: true })
          .eq("upload_id", lastGsc.id)
          .is("search_intent", null);

        if ((missingIntentCount ?? 0) > 0) {
          updatePhase("gsc", { status: "running", detail: `Enriching ${missingIntentCount} keywords…` });
          const { error } = await supabase.functions.invoke("gsc-intent-enrichment", {
            body: { upload_id: lastGsc.id, project_id: projectId },
          });
          if (error) throw new Error(`GSC enrichment: ${error.message}`);
          updatePhase("gsc", { status: "done", detail: `Enriched ${missingIntentCount} keywords` });
        } else {
          updatePhase("gsc", { status: "skipped", detail: "All GSC keywords already enriched" });
        }
      } else {
        updatePhase("gsc", { status: "skipped", detail: "No GSC upload found" });
      }

      // ---- Phase 7: Forecasts ---------------------------------------------
      // Forecasts depend on keyword data, SERP/HAR data, and project inputs
      // (CTR, AOV, conversion rate). If none have changed since last sync,
      // re-running compute-forecasts would produce identical output.
      currentPhaseKey = "forecasts";
      // Self-heal: also recompute when forecasts have fewer rows with `har`
      // populated than `har_results` has rows with `har_position`. This catches
      // the "HAR finished in background after sync moved on" case so users
      // never see empty Primary/Secondary/Tertiary revenue tiles.
      let forecastsStale = false;
      try {
        // Scope both sides to forecastable keywords (kept + volume > 0) so the
        // comparison is apples-to-apples. Without this scoping we'd see e.g.
        // 825 har_results vs 508 forecasts and always think we're stale.
        const { data: forecastableKws } = await supabase
          .from("keywords")
          .select("id")
          .eq("project_id", projectId)
          .eq("detox_status", "keep")
          .gt("avg_monthly_volume", 0);
        const fkIds = (forecastableKws ?? []).map((k: any) => k.id);

        let harResultsWithPos = 0;
        let forecastsWithHar = 0;
        const CHUNK = 100;
        for (let i = 0; i < fkIds.length; i += CHUNK) {
          const slice = fkIds.slice(i, i + CHUNK);
          const [{ count: hCount }, { count: fCount }] = await Promise.all([
            supabase
              .from("har_results")
              .select("id", { count: "exact", head: true })
              .in("keyword_id", slice)
              .not("har_position", "is", null),
            supabase
              .from("keyword_forecasts")
              .select("id", { count: "exact", head: true })
              .in("keyword_id", slice)
              .not("har", "is", null),
          ]);
          harResultsWithPos += hCount ?? 0;
          forecastsWithHar += fCount ?? 0;
        }
        if (harResultsWithPos > forecastsWithHar) {
          forecastsStale = true;
        }
      } catch (e) {
        console.warn("forecast staleness check failed", e);
      }

      if (!keywordsChanged && !serpChanged && !inputsChanged && !forecastsStale) {
        updatePhase("forecasts", { status: "skipped", detail: "No upstream changes — forecasts unchanged" });
      } else {
        updatePhase("forecasts", {
          status: "running",
          detail: forecastsStale ? "Backfilling HAR-based forecasts…" : "Recomputing from latest data…",
        });
        const { data: forecastData, error: forecastErr } = await supabase.functions.invoke("compute-forecasts", { body: { project_id: projectId } });
        if (forecastErr) throw new Error(`Compute forecasts: ${forecastErr.message}`);
        const forecastCount = (forecastData as any)?.count ?? (forecastData as any)?.forecasts?.length ?? null;
        updatePhase("forecasts", {
          status: "done",
          detail: forecastCount != null ? `${forecastCount} forecasts updated` : "Forecasts updated",
        });
      }

      // ---- Phase 8: Site architecture -------------------------------------
      currentPhaseKey = "site_arch";
      if (!keywordsChanged && !inputsChanged) {
        updatePhase("site_arch", { status: "skipped", detail: "No keyword or input changes since last sync" });
      } else {
      const { data: keptForArch } = await supabase
        .from("keywords")
        .select("id, avg_monthly_volume")
        .eq("project_id", projectId)
        .eq("detox_status", "keep");
      const keptArchIds = (keptForArch ?? []).map((k: any) => k.id);

      // CRITICAL: chunk the .in() — passing hundreds of UUIDs in one request
      // builds a URL that Supabase silently truncates, returning [] with no
      // error, which then mis-classifies every keyword as "missing arch".
      const PREFLIGHT_CHUNK = 150;
      const archMap = new Map<string, { relevancy_score: number | null; tactical_rag_status: string | null }>();
      for (let i = 0; i < keptArchIds.length; i += PREFLIGHT_CHUNK) {
        const slice = keptArchIds.slice(i, i + PREFLIGHT_CHUNK);
        const { data: archRows, error: preflightErr } = await supabase
          .from("site_architecture")
          .select("keyword_id, relevancy_score, tactical_rag_status")
          .in("keyword_id", slice);
        if (preflightErr) throw new Error(`Site arch preflight: ${preflightErr.message}`);
        for (const r of archRows ?? []) {
          archMap.set(r.keyword_id as string, {
            relevancy_score: r.relevancy_score as number | null,
            tactical_rag_status: r.tactical_rag_status as string | null,
          });
        }
      }
      const missingArchCount = (keptForArch ?? []).filter((k: any) => {
        const a = archMap.get(k.id);
        if (!a || a.relevancy_score == null) return true;
        if (a.tactical_rag_status === "watch" && (k.avg_monthly_volume ?? 0) > 0) return true;
        return false;
      }).length;

      if (missingArchCount > 0) {
        updatePhase("site_arch", { status: "running", detail: `Scoring ${missingArchCount} keyword/URL pairs…` });
        let totalProcessed = 0;
        let savedRules = 0;
        let savedCache = 0;
        let savedNoUrl = 0;
        let lastRemaining = Number.POSITIVE_INFINITY;
        let stallStreak = 0;
        for (let i = 0; i < 40; i++) {
          const { data: archData, error: archErr } = await supabase.functions.invoke("site-architecture", { body: { project_id: projectId } });
          if (archErr) throw new Error(`Site architecture: ${archErr.message}`);
          if ((archData as any)?.error) throw new Error(`Site architecture: ${(archData as any).error}`);

          const d = archData as any;
          const remaining = d?.remaining ?? 0;
          const processedThisCall = d?.processed ?? 0;
          totalProcessed += processedThisCall;
          savedRules += d?.fromRules ?? 0;
          savedCache += d?.fromCache ?? 0;
          savedNoUrl += d?.fromNoUrl ?? 0;

          if (d?.rateLimited) {
            const waitS = d?.retryAfterSeconds ?? 30;
            const isPayment = d?.paymentRequired;
            if (isPayment) throw new Error("AI credits exhausted — add funds in Settings → Workspace → Usage");
            for (let s = waitS; s > 0; s--) {
              updatePhase("site_arch", {
                status: "running",
                detail: `AI rate limit reached — pausing ${s}s (${remaining} remaining)`,
              });
              await new Promise((r) => setTimeout(r, 1000));
            }
            continue;
          }

          updatePhase("site_arch", {
            status: "running",
            detail: `Scoring site architecture… ${remaining} remaining (${savedNoUrl} gaps + ${savedRules + savedCache} rules/cache resolved)`,
          });
          if (d?.done || remaining === 0) break;

          if (d?.writeFailed) {
            throw new Error(
              `Site architecture write failed: ${d?.writeError ?? "unknown"} — check edge function logs.`,
            );
          }

          if (processedThisCall === 0 && remaining >= lastRemaining) {
            stallStreak++;
            if (d?.malformed) {
              throw new Error(
                `Site architecture stalled at ${remaining} remaining — AI returned malformed structured output. Check edge function logs.`,
              );
            }
            if (stallStreak >= 2) {
              throw new Error(
                `Site architecture stalled at ${remaining} remaining across 2 invocations. Check edge function logs.`,
              );
            }
          } else {
            stallStreak = 0;
          }
          lastRemaining = remaining;
        }
        const savings = savedRules + savedCache + savedNoUrl;
        updatePhase("site_arch", {
          status: "done",
          detail: savings > 0
            ? `Scored ${totalProcessed} keywords (${savings} resolved without AI)`
            : `Scored ${totalProcessed} keywords`,
        });
      } else if (keptArchIds.length === 0) {
        updatePhase("site_arch", { status: "skipped", detail: "No kept keywords to score" });
      } else {
        updatePhase("site_arch", { status: "skipped", detail: "All keywords already scored" });
      }
      }

      // ---- Mark synced + clear all dirty flags ----------------------------
      const syncedAt = new Date().toISOString();
      await supabase
        .from("navigator_projects")
        .update({
          last_synced_at: syncedAt,
          last_dirty_at: null,
          keywords_dirty: false,
          serp_dirty: false,
          inputs_dirty: false,
        })
        .eq("id", projectId);

      await queryClient.invalidateQueries();

      setCompletedAt(new Date());
      // Detect "nothing to sync" — true when every phase ended skipped.
      let allSkipped = false;
      setPhases((prev) => {
        allSkipped = prev.every((p) => p.status === "skipped");
        return prev;
      });
      if (allSkipped) {
        toast.success("Nothing to sync", { description: "Everything is already up to date." });
      } else {
        toast.success("Sync complete", { description: "All downstream sections refreshed." });
      }
    } catch (err: any) {
      if (currentPhaseKey) updatePhase(currentPhaseKey, { status: "error", detail: err.message });
      toast.error("Sync failed", { description: err.message });
    } finally {
      setRunning(false);
    }
  }, [projectId, stalenessDays, queryClient, updatePhase]);

  const skipDetox = useCallback(async () => {
    if (!blockedDetox) return;
    try {
      const { data, error } = await supabase.functions.invoke("keyword-detox", {
        body: { mode: "skip", project_id: blockedDetox.projectId },
      });
      if (error) throw new Error(error.message);
      if ((data as any)?.error) throw new Error((data as any).error);
      const kept = (data as any)?.kept ?? 0;
      toast.success("Detox skipped", { description: `Kept ${kept} keyword(s). Resuming pipeline…` });
      setBlockedDetox(null);
      // Resume the full pipeline; detox phase will now find zero pending rows
      // and skip cleanly, then categorisation/HAR/forecasts run as normal.
      await runSync();
    } catch (err: any) {
      toast.error("Couldn't skip detox", { description: err.message });
    }
  }, [blockedDetox]);

  const dismissBlockedDetox = useCallback(() => setBlockedDetox(null), []);

  return {
    running,
    phases,
    completedAt,
    runStartedAt,
    activePhaseKey,
    activePhaseStartedAt,
    runSync,
    blockedDetox,
    skipDetox,
    dismissBlockedDetox,
  };
}


```

---

## src/hooks/useBackgroundJobs.ts

### `src/hooks/useBackgroundJobs.ts`

```ts
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type JobKind = "detox" | "categorisation" | "har" | "url_monitor";
export type JobState = "running" | "queued" | "done" | "error" | "idle" | "scheduled";

export interface BackgroundJob {
  kind: JobKind;
  label: string;
  state: JobState;
  /** Human one-liner shown beside the label. */
  detail: string;
  /** 0..1 if a meaningful progress is known. */
  progress: number | null;
  /** ISO timestamp of last activity. */
  updatedAt: string | null;
  /** Optional underlying job id (for the expand row). */
  jobId?: string | null;
  /** Last error if any. */
  lastError?: string | null;
  /** Heartbeat staleness, seconds. */
  staleSeconds?: number | null;
}

const STALE_HEARTBEAT_S = 5 * 60;

/**
 * Aggregates the latest per-project background-job rows across detox,
 * categorisation (live + deferred), HAR, and URL monitor scheduling. Polls
 * fast while anything is active and slows down once everything is idle.
 */
export function useBackgroundJobs(projectId: string | undefined) {
  return useQuery({
    queryKey: ["background_jobs", projectId],
    enabled: !!projectId,
    refetchInterval: (q) => {
      const data = q.state.data as BackgroundJob[] | undefined;
      const active = data?.some((j) => j.state === "running" || j.state === "queued");
      return active ? 8000 : 60000;
    },
    queryFn: async (): Promise<BackgroundJob[]> => {
      if (!projectId) return [];

      const [detox, catLive, catDeferred, har, kwCounts] = await Promise.all([
        supabase
          .from("detox_jobs")
          .select("id,status,processed,total,kept,removed,started_at,finished_at,heartbeat_at,updated_at,last_error")
          .eq("project_id", projectId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("categorisation_jobs")
          .select("id,status,tier,processed,total,started_at,finished_at,heartbeat_at,updated_at,last_error")
          .eq("project_id", projectId)
          .eq("tier", "live")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("categorisation_jobs")
          .select("id,status,tier,processed,total,started_at,finished_at,heartbeat_at,updated_at,last_error")
          .eq("project_id", projectId)
          .eq("tier", "deferred")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("har_jobs")
          .select(
            "id,status,phase,serp_tasks_done,serp_tasks_total,ahrefs_targets_done,ahrefs_targets_total,backlinks_targets_done,backlinks_targets_total,started_at,completed_at,updated_at,last_error",
          )
          .eq("project_id", projectId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        // Aggregate keyword categorisation progress (the source of truth — jobs
        // can be stale while keyword rows show real completion).
        supabase
          .from("keywords")
          .select("categorisation_status,categorisation_tier,detox_status", { count: "exact", head: false })
          .eq("project_id", projectId)
          .eq("detox_status", "keep")
          .limit(5000),
      ]);

      const now = Date.now();
      const ageS = (iso?: string | null) =>
        iso ? Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000)) : null;
      const fmtAge = (s: number | null) => {
        if (s == null) return "";
        if (s < 60) return `${s}s ago`;
        if (s < 3600) return `${Math.round(s / 60)}m ago`;
        if (s < 86400) return `${Math.round(s / 3600)}h ago`;
        return `${Math.round(s / 86400)}d ago`;
      };

      // ── Detox ───────────────────────────────────────────────────────────
      const out: BackgroundJob[] = [];
      const d = detox.data as any;
      if (!d) {
        out.push({
          kind: "detox",
          label: "Detox",
          state: "idle",
          detail: "Not run yet",
          progress: null,
          updatedAt: null,
        });
      } else {
        const beat = ageS(d.heartbeat_at ?? d.started_at);
        const isStale = d.status !== "done" && d.status !== "error" && beat != null && beat > STALE_HEARTBEAT_S;
        const state: JobState =
          d.status === "done"
            ? "done"
            : d.status === "error"
              ? "error"
              : isStale
                ? "error"
                : d.status === "queued" || d.status === "running"
                  ? "running"
                  : "idle";
        out.push({
          kind: "detox",
          label: "Detox",
          state,
          detail:
            state === "done"
              ? `${d.kept ?? 0} kept · ${d.removed ?? 0} removed · ${fmtAge(ageS(d.finished_at ?? d.updated_at))}`
              : isStale
                ? `Stalled at ${d.processed}/${d.total} — heartbeat ${fmtAge(beat)}`
                : `${d.processed}/${d.total} processed`,
          progress: d.total ? Math.min(1, (d.processed ?? 0) / d.total) : null,
          updatedAt: d.updated_at,
          jobId: d.id,
          lastError: d.last_error,
          staleSeconds: beat,
        });
      }

      // ── Categorisation (combine live + deferred + keyword counters) ────
      const kwRows = (kwCounts.data as any[]) ?? [];
      const totalKept = kwRows.length;
      const categorised = kwRows.filter((k) => k.categorisation_status === "done").length;
      const livePending = kwRows.filter(
        (k) => k.categorisation_status !== "done" && k.categorisation_tier === "live",
      ).length;
      const deferredPending = kwRows.filter(
        (k) => k.categorisation_status !== "done" && k.categorisation_tier === "deferred",
      ).length;

      const cl = catLive.data as any;
      const cd = catDeferred.data as any;
      const liveBeat = ageS(cl?.heartbeat_at ?? cl?.started_at);
      const liveStalled =
        cl && cl.status !== "done" && cl.status !== "error" && liveBeat != null && liveBeat > STALE_HEARTBEAT_S;
      const liveActive = cl && (cl.status === "queued" || cl.status === "running") && !liveStalled;
      const deferredActive = cd && (cd.status === "queued" || cd.status === "running");

      let catState: JobState = "idle";
      let catDetail = "Not run yet";
      if (totalKept > 0) {
        if (liveActive || deferredActive) {
          catState = "running";
          catDetail = `${categorised}/${totalKept} done · ${livePending + deferredPending} pending`;
        } else if (liveStalled) {
          catState = "error";
          catDetail = `Stalled at ${cl.processed}/${cl.total} — heartbeat ${fmtAge(liveBeat)}; auto-resume on next tick`;
        } else if (livePending + deferredPending === 0) {
          catState = "done";
          catDetail = `${categorised}/${totalKept} categorised`;
        } else {
          catState = "queued";
          catDetail = `${categorised}/${totalKept} done · ${livePending} live + ${deferredPending} deferred pending`;
        }
      }
      out.push({
        kind: "categorisation",
        label: "Categorisation",
        state: catState,
        detail: catDetail,
        progress: totalKept ? categorised / totalKept : null,
        updatedAt: cl?.updated_at ?? cd?.updated_at ?? null,
        jobId: cl?.id ?? cd?.id ?? null,
        lastError: cl?.last_error ?? cd?.last_error ?? null,
        staleSeconds: liveBeat,
      });

      // ── HAR ─────────────────────────────────────────────────────────────
      const h = har.data as any;
      if (!h) {
        out.push({
          kind: "har",
          label: "HAR / SERP",
          state: "idle",
          detail: "Not run yet",
          progress: null,
          updatedAt: null,
        });
      } else {
        const serpTotal = h.serp_tasks_total ?? 0;
        const serpDone = h.serp_tasks_done ?? 0;
        const ahTotal = h.ahrefs_targets_total ?? 0;
        const ahDone = h.ahrefs_targets_done ?? 0;
        const blTotal = h.backlinks_targets_total ?? 0;
        const blDone = h.backlinks_targets_done ?? 0;
        const total = serpTotal + ahTotal + blTotal;
        const done = serpDone + ahDone + blDone;
        const beat = ageS(h.updated_at);
        const isStale =
          h.status !== "completed" && h.status !== "error" && beat != null && beat > STALE_HEARTBEAT_S;
        const state: JobState =
          h.status === "completed"
            ? "done"
            : h.status === "error"
              ? "error"
              : isStale
                ? "error"
                : "running";
        const phaseLabel =
          h.phase === "post_serp"
            ? "Posting SERP"
            : h.phase === "poll_serp"
              ? "Fetching SERP"
              : h.phase === "fetch_ahrefs"
                ? "Fetching Ahrefs"
                : h.phase === "fetch_backlinks"
                  ? "Fetching backlinks"
                  : h.phase === "compute"
                    ? "Computing HAR"
                    : "Working";
        out.push({
          kind: "har",
          label: "HAR / SERP",
          state,
          detail:
            state === "done"
              ? `${serpDone}/${serpTotal} SERP · ${fmtAge(ageS(h.completed_at ?? h.updated_at))}`
              : `${phaseLabel} — SERP ${serpDone}/${serpTotal}, Ahrefs ${ahDone}/${ahTotal}, Backlinks ${blDone}/${blTotal}`,
          progress: total ? done / total : null,
          updatedAt: h.updated_at,
          jobId: h.id,
          lastError: h.last_error,
          staleSeconds: beat,
        });
      }

      // ── URL monitor (project-scoped if any campaigns exist) ─────────────
      const { data: nextCheck } = await supabase
        .from("monitored_urls")
        .select("next_check_at, last_checked_at, mc:monitor_campaigns!inner(navigator_project_id)")
        .eq("monitor_campaigns.navigator_project_id", projectId)
        .order("next_check_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (nextCheck) {
        const nextS = ageS(nextCheck.next_check_at);
        const inFutureS = nextCheck.next_check_at
          ? Math.round((new Date(nextCheck.next_check_at).getTime() - now) / 1000)
          : null;
        out.push({
          kind: "url_monitor",
          label: "URL Monitor",
          state: "scheduled",
          detail:
            inFutureS != null && inFutureS > 0
              ? `Next check in ${inFutureS < 60 ? `${inFutureS}s` : `${Math.round(inFutureS / 60)}m`}`
              : `Last check ${fmtAge(ageS(nextCheck.last_checked_at))}`,
          progress: null,
          updatedAt: nextCheck.last_checked_at,
        });
      }

      return out;
    },
  });
}

```

---

## src/hooks/useProjectSyncState.ts

### `src/hooks/useProjectSyncState.ts`

```ts
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface ProjectSyncState {
  last_synced_at: string | null;
  last_dirty_at: string | null;
  keywords_dirty: boolean;
  serp_dirty: boolean;
  inputs_dirty: boolean;
}

/**
 * Reads the sync-state columns on a project. Cached + auto-refetched so any
 * component (Sync button, stepper dots, dirty banners) stays in sync without
 * each one doing its own query.
 */
export function useProjectSyncState(projectId: string | undefined) {
  return useQuery({
    queryKey: ["project_sync_state", projectId],
    queryFn: async (): Promise<ProjectSyncState> => {
      const { data, error } = await supabase
        .from("navigator_projects")
        .select("last_synced_at, last_dirty_at, keywords_dirty, serp_dirty, inputs_dirty")
        .eq("id", projectId!)
        .single();
      if (error) throw error;
      return data as ProjectSyncState;
    },
    enabled: !!projectId,
    refetchInterval: 15000,
  });
}

/** True when *anything* has changed since the last successful sync. */
export function isProjectDirty(state: ProjectSyncState | undefined): boolean {
  if (!state) return false;
  if (state.keywords_dirty || state.serp_dirty || state.inputs_dirty) return true;
  if (!state.last_dirty_at) return false;
  if (!state.last_synced_at) return true;
  return new Date(state.last_dirty_at) > new Date(state.last_synced_at);
}

```

---

## src/components/SyncNowPanel.tsx

### `src/components/SyncNowPanel.tsx`

```tsx
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, CheckCircle2, XCircle, Loader2, Clock, SkipForward, X, AlertCircle, Play, Coffee } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { useProjectSyncState, isProjectDirty } from "@/hooks/useProjectSyncState";
import { useNavigatorSync, formatElapsed, type PhaseStatus, type Phase, type BlockedDetox } from "@/hooks/useNavigatorSync";
import SkipDetoxDialog from "@/components/SkipDetoxDialog";

interface Props {
  projectId: string;
  /** Days before SERP/TP data is considered stale and refetched */
  stalenessDays?: number;
  /**
   * Optional shared sync state. When the parent page also renders the
   * first-run BuildProgressPanel, both surfaces must observe the same run —
   * otherwise pressing Sync Now from the header would spawn a second
   * concurrent pipeline. The parent owns the hook and passes its handles
   * through here so we render and trigger the same run.
   */
  sharedSync?: {
    running: boolean;
    phases: Phase[];
    completedAt: Date | null;
    runStartedAt: number | null;
    activePhaseKey: string | null;
    activePhaseStartedAt: number | null;
    runSync: () => Promise<void> | void;
    blockedDetox?: BlockedDetox | null;
    skipDetox?: () => Promise<void> | void;
    dismissBlockedDetox?: () => void;
  };
}


export default function SyncNowPanel({ projectId, stalenessDays = 7, sharedSync }: Props) {
  const [open, setOpen] = useState(false);

  const { data: syncState } = useProjectSyncState(projectId);
  const dirty = isProjectDirty(syncState);
  const firstRun = !syncState?.last_synced_at;

  const localSync = useNavigatorSync({ projectId, stalenessDays });
  const merged = sharedSync ?? localSync;
  const {
    running,
    phases,
    completedAt,
    runStartedAt,
    activePhaseKey,
    activePhaseStartedAt,
    runSync,
  } = merged;
  // Blocked-detox handles live on the underlying hook in both paths.
  const blockedDetox = (merged as any).blockedDetox ?? localSync.blockedDetox ?? null;
  const skipDetox = (merged as any).skipDetox ?? localSync.skipDetox;
  const dismissBlockedDetox = (merged as any).dismissBlockedDetox ?? localSync.dismissBlockedDetox;


  const handleRun = () => {
    setOpen(true);
    runSync();
  };

  // Keyboard shortcut: ⌘/Ctrl + S triggers Sync Now from anywhere in the project
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!running) handleRun();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, projectId]);

  const StatusIcon = ({ status }: { status: PhaseStatus }) => {
    switch (status) {
      case "running":
        return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
      case "done":
        return <CheckCircle2 className="h-4 w-4 text-accent" />;
      case "skipped":
        return <SkipForward className="h-4 w-4 text-muted-foreground" />;
      case "error":
        return <XCircle className="h-4 w-4 text-destructive" />;
      default:
        return <Clock className="h-4 w-4 text-muted-foreground/50" />;
    }
  };

  const buttonLabel = running
    ? "Syncing…"
    : firstRun
      ? "Run Pipeline"
      : dirty
        ? "Sync Now · Changes pending"
        : "Sync Now";

  const ButtonIcon = running ? Loader2 : firstRun ? Play : dirty ? AlertCircle : RefreshCw;

  return (
    <div className="flex flex-col items-end gap-2">
      <SkipDetoxDialog
        blocked={blockedDetox}
        onConfirm={() => skipDetox?.()}
        onCancel={() => dismissBlockedDetox?.()}
      />

      <Button
        variant={firstRun ? "default" : "outline"}
        size="sm"
        onClick={handleRun}
        disabled={running}
        className={cn(
          "gap-1.5 transition-colors",
          dirty && !running && !firstRun &&
            "bg-warning/15 border-warning/40 text-warning hover:bg-warning/25 hover:text-warning"
        )}
        title={
          firstRun
            ? "Run the full pipeline for this project (⌘/Ctrl + S)"
            : dirty
              ? "Upstream data has changed — sync to update all tabs (⌘/Ctrl + S)"
              : syncState?.last_synced_at
                ? `Last synced ${formatDistanceToNow(new Date(syncState.last_synced_at), { addSuffix: true })} (⌘/Ctrl + S)`
                : "Run a sync to refresh all tabs (⌘/Ctrl + S)"
        }
      >
        <ButtonIcon className={cn("h-3.5 w-3.5", running && "animate-spin")} />
        {buttonLabel}
      </Button>

      {open && (
        <Card className="w-[460px] p-3 shadow-lg border-border">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold">Smart sync</span>
              {running && runStartedAt && (
                <Badge variant="secondary" className="text-[10px] h-4">
                  {formatElapsed(Date.now() - runStartedAt)} elapsed
                </Badge>
              )}
              {completedAt && (
                <Badge variant="secondary" className="text-[10px] h-4">
                  Done {formatDistanceToNow(completedAt, { addSuffix: true })}
                </Badge>
              )}
            </div>
            {!running && (
              <button
                onClick={() => setOpen(false)}
                className="text-muted-foreground hover:text-foreground"
                aria-label="Close sync panel"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {running && (
            <div className="mb-3 flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-2 text-[11px] text-foreground">
              <Coffee className="h-3.5 w-3.5 mt-0.5 shrink-0 text-warning" />
              <div className="leading-snug">
                <span className="font-semibold">This can take 5–10 minutes on large projects.</span>{" "}
                SERP, Ahrefs and forecast calls run in the background — feel free to grab a brew and come back.
                You can safely leave this page; progress will resume on the next visit.
              </div>
            </div>
          )}

          <p className="text-[11px] text-muted-foreground mb-3">
            Runs the full pipeline in dependency order. Phases auto-skip when their inputs are already fresh.
          </p>
          <ul className="space-y-2">
            {phases.map((phase) => {
              const isActive =
                phase.status === "running" &&
                phase.key === activePhaseKey &&
                activePhaseStartedAt != null;
              const phaseElapsed = isActive ? formatElapsed(Date.now() - (activePhaseStartedAt ?? 0)) : null;
              return (
                <li key={phase.key} className="flex items-start gap-2 text-xs">
                  <div className="mt-0.5">
                    <StatusIcon status={phase.status} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">{phase.label}</span>
                      {phaseElapsed && (
                        <span className="text-[10px] text-muted-foreground tabular-nums">
                          {phaseElapsed}
                        </span>
                      )}
                    </div>
                    <div className="text-muted-foreground text-[11px] truncate">
                      {phase.detail || phase.description}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}

```

---

## src/components/navigator/BuildProgressPanel.tsx

### `src/components/navigator/BuildProgressPanel.tsx`

```tsx
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckCircle2, XCircle, Loader2, Clock, SkipForward, Coffee, ArrowRight } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { formatElapsed, type Phase, type PhaseStatus } from "@/hooks/useNavigatorSync";

interface Props {
  phases: Phase[];
  running: boolean;
  completedAt: Date | null;
  runStartedAt: number | null;
  activePhaseKey: string | null;
  activePhaseStartedAt: number | null;
  onViewForecast: () => void;
}

const StatusIcon = ({ status }: { status: PhaseStatus }) => {
  switch (status) {
    case "running":
      return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
    case "done":
      return <CheckCircle2 className="h-4 w-4 text-accent" />;
    case "skipped":
      return <SkipForward className="h-4 w-4 text-muted-foreground" />;
    case "error":
      return <XCircle className="h-4 w-4 text-destructive" />;
    default:
      return <Clock className="h-4 w-4 text-muted-foreground/50" />;
  }
};

/**
 * Inline build-progress card shown on the Keywords tab of brand-new projects
 * (gated upstream on `last_synced_at IS NULL`). Mirrors the SyncNowPanel
 * phase list but in a larger, friendlier first-run layout. Phase data comes
 * straight from the shared `useNavigatorSync` hook so the pipeline is
 * byte-identical to the header Sync Now button.
 */
export default function BuildProgressPanel({
  phases,
  running,
  completedAt,
  runStartedAt,
  activePhaseKey,
  activePhaseStartedAt,
  onViewForecast,
}: Props) {
  const hasError = phases.some((p) => p.status === "error");
  const allTerminal = !running && phases.every((p) => p.status !== "pending" && p.status !== "running");
  const buildSucceeded = !!completedAt && !hasError;

  return (
    <Card className="p-5 border-primary/20 bg-gradient-to-br from-background to-primary/5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-base font-semibold flex items-center gap-2">
            {running && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
            {buildSucceeded ? "Forecast ready" : running ? "Building your forecast" : "Build paused"}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {buildSucceeded
              ? `Completed ${formatDistanceToNow(completedAt!, { addSuffix: true })}.`
              : running
                ? "You can safely leave this page — progress resumes on your next visit."
                : "Resolve the error below or press Run Pipeline to retry."}
          </p>
        </div>
        {running && runStartedAt && (
          <Badge variant="secondary" className="text-[10px] h-5">
            {formatElapsed(Date.now() - runStartedAt)} elapsed
          </Badge>
        )}
      </div>

      {running && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-2.5 text-[11px] text-foreground">
          <Coffee className="h-3.5 w-3.5 mt-0.5 shrink-0 text-warning" />
          <div className="leading-snug">
            <span className="font-semibold">First builds typically take 5–10 minutes.</span>{" "}
            We're calling DataForSEO, Ahrefs and Claude in the background — feel free to grab a brew.
          </div>
        </div>
      )}

      <ul className="space-y-2.5">
        {phases.map((phase) => {
          const isActive =
            phase.status === "running" &&
            phase.key === activePhaseKey &&
            activePhaseStartedAt != null;
          const phaseElapsed = isActive ? formatElapsed(Date.now() - (activePhaseStartedAt ?? 0)) : null;
          return (
            <li key={phase.key} className="flex items-start gap-2.5 text-xs">
              <div className="mt-0.5">
                <StatusIcon status={phase.status} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-foreground">{phase.label}</span>
                  {phaseElapsed && (
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      {phaseElapsed}
                    </span>
                  )}
                </div>
                <div className="text-muted-foreground text-[11px]">
                  {phase.detail || phase.description}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {buildSucceeded && (
        <div className="mt-4 pt-4 border-t border-border flex justify-end">
          <Button onClick={onViewForecast} size="sm" className="gap-1.5">
            View forecast
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </Card>
  );
}

```

---

## src/components/SkipDetoxDialog.tsx

### `src/components/SkipDetoxDialog.tsx`

```tsx
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { BlockedDetox } from "@/hooks/useNavigatorSync";

interface Props {
  blocked: BlockedDetox | null;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

/**
 * Shown when Keyword Detox can't reach Anthropic (no credit, invalid key,
 * permission denied). Lets the user skip detox and promote every keyword to
 * `keep` so the rest of the pipeline (Categorisation → HAR → forecasts)
 * can continue without losing their manually curated keyword list.
 */
export default function SkipDetoxDialog({ blocked, onConfirm, onCancel }: Props) {
  const open = blocked !== null;
  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Keyword Detox can't run right now</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm">
              <p>
                Anthropic returned:{" "}
                <span className="font-mono text-xs text-foreground">
                  {blocked?.message || "AI provider unavailable"}
                </span>
              </p>
              <p>
                You can skip detox and keep <strong>all current keywords</strong> as-is.
                They'll move straight into Categorisation, Enrichment and HAR — useful
                when your keyword list has already been manually reviewed.
              </p>
              <p className="text-muted-foreground">
                Or cancel, top up Anthropic credits, and click Sync Now to retry.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => { void onConfirm(); }}>
            Skip detox &amp; keep all keywords
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

```

---

