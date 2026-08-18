import { useEffect, useState } from "react";
import {
  Check,
  Circle,
  Clock3,
  Database,
  Gauge,
  Layers3,
  Play,
  RotateCcw,
  ShieldCheck,
  TriangleAlert,
  Workflow,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  PipelineReadiness,
  PipelineRun,
  PipelineStageId,
  PipelineStageState,
} from "@/integrations/gcp/pipeline";

type RunMode = "full" | "recalculate" | "resume";

const tracks: Array<{
  description: string;
  id: string;
  label: string;
  stages: PipelineStageId[];
}> = [
  {
    description: "Brand-safe, device-aware click curves",
    id: "A",
    label: "CTR truth",
    stages: ["brand-classification", "gsc-intent", "ctr-curves"],
  },
  {
    description: "Volume history, trend and seasonality",
    id: "B",
    label: "Demand",
    stages: ["historical-volume", "demand-signals"],
  },
  {
    description: "SERP, authority, backlinks and LPS",
    id: "C",
    label: "Competitive",
    stages: ["serp-collection", "authority", "backlinks", "link-power-score"],
  },
  {
    description: "Ranking URL and content-fit scoring",
    id: "D",
    label: "Content",
    stages: ["ranking-url", "site-architecture"],
  },
];

function trackState(
  run: PipelineRun | null,
  stages: readonly PipelineStageId[],
): PipelineStageState | "idle" {
  if (!run) return "idle";
  const states = stages.map(
    (id) => run.stages.find((stage) => stage.id === id)?.state ?? "pending",
  );
  if (states.includes("failed")) return "failed";
  if (states.includes("running")) return "running";
  if (states.includes("queued")) return "queued";
  if (states.every((state) => state === "succeeded")) return "succeeded";
  return "pending";
}

function StateMark({ state }: { state: PipelineStageState | "idle" }) {
  if (state === "succeeded") {
    return <Check className="h-3.5 w-3.5 text-emerald-600" />;
  }
  if (state === "failed") {
    return <TriangleAlert className="h-3.5 w-3.5 text-destructive" />;
  }
  if (state === "running" || state === "queued") {
    return <Clock3 className="h-3.5 w-3.5 animate-pulse text-signal" />;
  }
  return <Circle className="h-3.5 w-3.5 text-ink-faint" />;
}

function money(value: number): string {
  return new Intl.NumberFormat("en-GB", {
    currency: "GBP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(value);
}

interface Props {
  archived: boolean;
  onSaveBrandTerms: (brandTerms: string[]) => Promise<void>;
  onRun: (mode: RunMode) => Promise<void>;
  onSavePolicy: (policy: PipelineReadiness["policy"]) => Promise<void>;
  onStampPrecurated: () => Promise<void>;
  readiness: PipelineReadiness | undefined;
  run: PipelineRun | null;
  running: boolean;
  savingBrandTerms: boolean;
  savingPolicy: boolean;
  stampingPrecurated: boolean;
}

export default function AutonomousPipelinePanel({
  archived,
  onSaveBrandTerms,
  onRun,
  onSavePolicy,
  onStampPrecurated,
  readiness,
  run,
  running,
  savingBrandTerms,
  savingPolicy,
  stampingPrecurated,
}: Props) {
  const [promotionFloor, setPromotionFloor] = useState<string | null>(null);
  const [competitiveFloor, setCompetitiveFloor] = useState<string | null>(null);
  const [brandTermsText, setBrandTermsText] = useState("");
  const displayedPromotionFloor =
    promotionFloor ?? String(readiness?.policy.gscPromotionImpressionsFloor ?? 1);
  const displayedCompetitiveFloor =
    competitiveFloor ??
    String(readiness?.policy.competitiveEnrichmentVolumeFloor ?? 0);
  const canRun = Boolean(readiness?.ready) && !archived && !running;
  const configuredBrandTerms = readiness?.configuration.explicitBrandTerms ?? [];
  const displayedBrandTerms = configuredBrandTerms.length
    ? configuredBrandTerms
    : readiness?.configuration.brandTerms ?? [];
  const displayedBrandTermsText = displayedBrandTerms.join(", ");

  useEffect(() => {
    setBrandTermsText(displayedBrandTermsText);
  }, [displayedBrandTermsText, readiness?.projectId]);

  const parsedBrandTerms = [...new Map(
    brandTermsText
      .split(",")
      .map((term) => term.trim())
      .filter(Boolean)
      .map((term) => [term.toLowerCase(), term]),
  ).values()];

  return (
    <section className="overflow-hidden rounded-xl border border-hairline bg-surface shadow-card">
      <div className="grid gap-0 border-b border-hairline lg:grid-cols-[1.2fr_0.8fr]">
        <div className="px-5 py-5 lg:px-6">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Workflow className="h-4 w-4 text-signal" />
            Autonomous forecast pipeline
          </div>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-muted">
            Intake and qualification feed four parallel tracks. HAR and Revenue
            start only after their required inputs pass formal readiness checks.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {readiness?.gates.map((gate) => (
              <Badge
                key={gate.id}
                variant={gate.ready ? "outline" : "destructive"}
                className={
                  gate.ready
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                    : undefined
                }
              >
                {gate.ready ? <Check className="mr-1 h-3 w-3" /> : null}
                {gate.label}
              </Badge>
            ))}
          </div>
          <div className="mt-4 rounded-lg border border-hairline bg-canvas/40 p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <label className="min-w-0 flex-1 space-y-1.5 text-xs text-ink-muted">
                Brand terms
                <Input
                  aria-label="Brand terms"
                  placeholder="brand, brand name, known variation"
                  value={brandTermsText}
                  onChange={(event) => setBrandTermsText(event.target.value)}
                />
              </label>
              <Button
                disabled={!readiness || archived || savingBrandTerms}
                size="sm"
                variant="outline"
                onClick={() => void onSaveBrandTerms(parsedBrandTerms)}
              >
                {savingBrandTerms ? "Saving…" : "Save terms"}
              </Button>
            </div>
            <p className="mt-2 text-[11px] leading-5 text-ink-muted">
              {readiness?.configuration.brandTermsSource === "domain_fallback"
                ? `Using ${readiness.configuration.brandTerms.join(", ")} from the client domain until explicit variations are saved.`
                : readiness?.configuration.brandTermsSource === "explicit"
                  ? "These terms are shared by every project for this client."
                  : "Add at least one unambiguous brand term before classification."}
            </p>
          </div>
        </div>

        <div className="border-t border-hairline bg-canvas/60 px-5 py-5 lg:border-l lg:border-t-0">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">
            <Gauge className="h-3.5 w-3.5" /> Operator policy
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <label className="space-y-1.5 text-xs text-ink-muted">
              Minimum GSC impressions
              <Input
                aria-label="Minimum GSC impressions"
                min={0}
                type="number"
                value={displayedPromotionFloor}
                onChange={(event) => setPromotionFloor(event.target.value)}
              />
            </label>
            <label className="space-y-1.5 text-xs text-ink-muted">
              Paid enrichment volume floor
              <Input
                aria-label="Paid enrichment volume floor"
                min={0}
                type="number"
                value={displayedCompetitiveFloor}
                onChange={(event) => setCompetitiveFloor(event.target.value)}
              />
            </label>
          </div>
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-xs text-ink-muted">
              {readiness?.preview.promotableGscQueryCount ?? 0} of{" "}
              {readiness?.preview.latestGscQueryCount ?? 0} GSC queries qualify
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={!readiness || archived || savingPolicy}
              onClick={() =>
                void onSavePolicy({
                  competitiveEnrichmentVolumeFloor: Math.max(
                    0,
                    Number(displayedCompetitiveFloor) || 0,
                  ),
                  gscPromotionImpressionsFloor: Math.max(
                    0,
                    Number(displayedPromotionFloor) || 0,
                  ),
                })
              }
            >
              {savingPolicy ? "Saving…" : "Save policy"}
            </Button>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-hairline pt-3 text-[11px] text-ink-muted">
            <span>{readiness?.preview.duplicateGscQueryCount ?? 0} existing duplicates</span>
            <span>{readiness?.preview.paidEligibleKeywordCount ?? 0} paid-enrichment eligible</span>
            <Button
              className={
                readiness?.missing.includes("qualified_keywords")
                  ? "ml-auto"
                  : "ml-auto h-auto px-2 py-1 text-[11px]"
              }
              disabled={
                archived ||
                stampingPrecurated ||
                !readiness?.preview.manualKeywordCount
              }
              size="sm"
              variant={readiness?.missing.includes("qualified_keywords") ? "outline" : "ghost"}
              onClick={() => void onStampPrecurated()}
            >
              {stampingPrecurated ? "Stamping…" : "Mark manual set as pre-curated"}
            </Button>
          </div>
        </div>
      </div>

      <div className="px-5 py-5 lg:px-6">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {tracks.map((track) => {
            const state = trackState(run, track.stages);
            return (
              <div
                key={track.id}
                className="rounded-lg border border-hairline bg-canvas/40 p-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-xs font-semibold text-signal">
                    TRACK {track.id}
                  </span>
                  <span className="flex items-center gap-2">
                    {track.id === "C" ? (
                      <Badge variant="outline" className="text-[10px]">Critical path</Badge>
                    ) : null}
                    <StateMark state={state} />
                  </span>
                </div>
                <h3 className="mt-2 text-sm font-semibold text-ink">{track.label}</h3>
                <p className="mt-1 min-h-10 text-xs leading-5 text-ink-muted">
                  {track.description}
                </p>
                <div className="mt-3 space-y-1.5 border-t border-hairline pt-3">
                  {track.stages.map((stageId) => {
                    const stage = run?.stages.find((item) => item.id === stageId);
                    return (
                      <div
                        key={stageId}
                        className="flex items-center justify-between gap-2 text-[11px] text-ink-muted"
                      >
                        <span>{stageId.replace(/-/g, " ")}</span>
                        <span className="flex items-center gap-1.5">
                          {stage && stage.attempts > 1 ? ` · ${stage.attempts} attempts` : null}
                          <span>{stage?.state ?? "idle"}</span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {readiness ? (
          <div className="mt-4 grid gap-2 rounded-lg border border-hairline bg-canvas/40 p-4 sm:grid-cols-3 lg:grid-cols-6">
            {[
              ["Provider complete", readiness.providerSummary.succeeded],
              ["Submitted", readiness.providerSummary.submitted],
              ["Pending", readiness.providerSummary.pending],
              ["Failed", readiness.providerSummary.failed],
              ["Max attempts", readiness.providerSummary.maxAttempts],
              ["Fresh cache", readiness.providerSummary.cacheEntriesAvailable],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <p className="text-[11px] text-ink-muted">{label}</p>
                <p className="mt-1 font-mono text-sm font-semibold text-ink">{value}</p>
              </div>
            ))}
          </div>
        ) : null}

        <div className="mt-4 flex flex-col gap-3 rounded-lg border border-hairline bg-surface p-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex items-start gap-3">
            <div className="rounded-md bg-signal/10 p-2 text-signal">
              <ShieldCheck className="h-4 w-4" />
            </div>
            <div>
              <p className="text-sm font-medium text-ink">
                {readiness?.ready
                  ? "All configuration gates passed"
                  : "Configuration must be completed before a paid run"}
              </p>
              <p className="mt-0.5 text-xs text-ink-muted">
                Runs continue server-side and can be safely resumed after an interruption.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button disabled={!canRun} variant="signal" onClick={() => void onRun("full")}>
              <Play className="h-4 w-4" /> Full pipeline
            </Button>
            <Button disabled={!canRun} variant="outline" onClick={() => void onRun("resume")}>
              <RotateCcw className="h-4 w-4" /> Resume missing work
            </Button>
            <Button
              disabled={
                !canRun ||
                run?.status !== "succeeded" ||
                readiness?.dirty.keywords ||
                readiness?.dirty.serp
              }
              variant="outline"
              onClick={() => void onRun("recalculate")}
            >
              <Gauge className="h-4 w-4" /> Recalculate forecasts
            </Button>
          </div>
        </div>

        {readiness?.substitutions.length ? (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50/70 p-4">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-amber-900">
              <TriangleAlert className="h-3.5 w-3.5" /> Recorded substitutions
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {readiness.substitutions.map((substitution) => (
                <div
                  key={`${substitution.stageId}-${substitution.input}`}
                  className="flex items-center justify-between gap-3 rounded-md border border-amber-200/80 bg-white/70 px-3 py-2 text-xs"
                >
                  <span className="text-ink-muted">
                    {substitution.input.replace(/_/g, " ")} →{" "}
                    {substitution.substitute.replace(/_/g, " ")}
                  </span>
                  <Badge variant="outline" className="border-amber-300 text-amber-900">
                    {substitution.count}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {readiness?.rollups.length ? (
          <div className="mt-4 space-y-3">
            <div className="grid gap-3 md:grid-cols-3">
              {readiness.rollups.map((rollup) => (
                <div key={rollup.scenario} className="rounded-lg border border-hairline p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-muted">
                      {rollup.scenario}
                    </span>
                    <Layers3 className="h-4 w-4 text-signal" />
                  </div>
                  <p className="mt-3 text-xl font-semibold tracking-tight text-ink">
                    {money(rollup.clusterDedupedExpectedIncrementalAnnual)}
                  </p>
                  <p className="mt-1 text-xs text-ink-muted">Cluster-deduped opportunity</p>
                  <div className="mt-3 flex items-center justify-between border-t border-hairline pt-3 text-xs text-ink-muted">
                    <span>Naive {money(rollup.naiveExpectedIncrementalAnnual)}</span>
                    <span>{money(rollup.doubleCountAnnual)} removed</span>
                  </div>
                </div>
              ))}
            </div>
            {(() => {
              const rollup =
                readiness.rollups.find((item) => item.scenario === "realistic") ??
                readiness.rollups[0];
              if (!rollup) return null;
              const views = [
                {
                  items: rollup.clusterRollup.slice(0, 4).map((item) => ({
                    label: item.clusterKey,
                    meta: `${item.memberCount} members`,
                    value: item.expectedIncrementalAnnual,
                  })),
                  title: "Top clusters",
                },
                {
                  items: rollup.categoryRollup.slice(0, 4).map((item) => ({
                    label: item.category,
                    meta: `${item.keywordCount} keywords`,
                    value: item.expectedIncrementalAnnual,
                  })),
                  title: "Categories",
                },
                {
                  items: rollup.quarterRollup.slice(0, 4).map((item) => ({
                    label: item.quarter,
                    meta: `${item.keywordCount} keywords`,
                    value: item.expectedIncrementalAnnual,
                  })),
                  title: "Quarter plan",
                },
                {
                  items: rollup.trendRollup.slice(0, 4).map((item) => ({
                    label: item.trend.replace(/_/g, " "),
                    meta: `${item.keywordCount} keywords`,
                    value: item.expectedIncrementalAnnual,
                  })),
                  title: "Demand trend",
                },
              ];
              return (
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  {views.map((view) => (
                    <div key={view.title} className="rounded-lg border border-hairline bg-canvas/40 p-4">
                      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-muted">
                        {view.title}
                      </p>
                      <div className="mt-3 space-y-2">
                        {view.items.length ? view.items.map((item) => (
                          <div key={item.label} className="flex items-start justify-between gap-3 text-xs">
                            <span className="min-w-0">
                              <span className="block truncate font-medium capitalize text-ink">{item.label}</span>
                              <span className="text-[10px] text-ink-muted">{item.meta}</span>
                            </span>
                            <span className="shrink-0 font-mono text-ink">{money(item.value)}</span>
                          </div>
                        )) : (
                          <p className="text-xs text-ink-muted">No data in this view.</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        ) : (
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-dashed border-hairline px-4 py-3 text-xs text-ink-muted">
            <Database className="h-4 w-4" /> Final rollups will appear after the first successful run.
          </div>
        )}
      </div>
    </section>
  );
}
