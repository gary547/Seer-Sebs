import { useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Archive,
  BarChart3,
  Binary,
  Boxes,
  Database,
  GitCompareArrows,
  History,
  Layers3,
  ListChecks,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Tags,
  Trash2,
  TrendingUp,
} from "lucide-react";
import { toast } from "sonner";

import GscUploadPanel from "@/components/GscUploadPanel";
import {
  CtrVisualPanel,
  DemandVisualPanel,
  SerpVisualPanel,
  VolumeVisualPanel,
} from "@/components/admin/CalculationVisualPanels";
import CollapsibleSection from "@/components/navigator/CollapsibleSection";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  deleteProjectGscUpload,
  type CalculationControl,
} from "@/integrations/gcp/calculation-control";
import {
  type ProjectCalculationSummary,
  type ProjectCtrCurves,
} from "@/integrations/gcp/calculations";

interface Props {
  control: CalculationControl;
  ctrCurves: ProjectCtrCurves | undefined;
  onRun: (source: string) => Promise<void>;
  projectId: string;
  running: boolean;
  summary: ProjectCalculationSummary | undefined;
}

const storageKey = (projectId: string) =>
  `seer-admin-calculation-sections:${projectId}`;

function number(value: number | null | undefined, digits = 0): string {
  return value == null
    ? "—"
    : new Intl.NumberFormat("en-GB", {
        maximumFractionDigits: digits,
      }).format(value);
}

function money(value: number | null | undefined): string {
  return value == null
    ? "—"
    : new Intl.NumberFormat("en-GB", {
        currency: "GBP",
        maximumFractionDigits: 0,
        notation: Math.abs(value) >= 1_000_000 ? "compact" : "standard",
        style: "currency",
      }).format(value);
}

function percent(numerator: number, denominator: number): string {
  return denominator === 0 ? "0%" : `${Math.round((numerator / denominator) * 100)}%`;
}

function dateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString("en-GB") : "—";
}

function MetricStrip({
  items,
}: {
  items: Array<{ label: string; value: string }>;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      {items.map((item) => (
        <div
          key={item.label}
          className="rounded-lg border border-hairline bg-canvas/50 px-4 py-3"
        >
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
            {item.label}
          </div>
          <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-ink">
            {item.value}
          </div>
        </div>
      ))}
    </div>
  );
}

function RefreshAction({
  archived,
  label,
  onRun,
  running,
}: {
  archived: boolean;
  label: string;
  onRun: (source: string) => Promise<void>;
  running: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-hairline bg-surface px-4 py-3">
      <p className="text-xs leading-5 text-ink-muted">
        Refreshes this model and every dependency through the canonical GCP pipeline.
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={archived || running}
        onClick={() => void onRun(label)}
      >
        <RefreshCw className={`h-3.5 w-3.5 ${running ? "animate-spin" : ""}`} />
        {label}
      </Button>
    </div>
  );
}

function Empty({ children }: { children: string }) {
  return (
    <div className="rounded-lg border border-dashed border-hairline px-5 py-7 text-center text-sm text-ink-muted">
      {children}
    </div>
  );
}

export default function CalculationControlPanels({
  control,
  ctrCurves,
  onRun,
  projectId,
  running,
  summary,
}: Props) {
  const queryClient = useQueryClient();
  const archived = control.archived;
  const key = storageKey(projectId);
  const calibration = summary?.calibration;
  const latestUpload = control.gscReadiness.uploads[0] ?? null;
  const observedCtrPoints = (ctrCurves?.curves ?? [])
    .flatMap((curve) => curve.points)
    .filter((point) => point.source === "gsc").length;
  const uploadWindowDays = latestUpload?.dateRangeStart && latestUpload.dateRangeEnd
    ? Math.floor(
        (new Date(latestUpload.dateRangeEnd).getTime() -
          new Date(latestUpload.dateRangeStart).getTime()) /
          86_400_000,
      ) + 1
    : null;
  const readinessWarnings = [
    !latestUpload ? "Upload Search Console data before relying on CTR or calibration." : null,
    latestUpload && uploadWindowDays === null ? "The latest upload has no date range." : null,
    uploadWindowDays !== null && uploadWindowDays < 90
      ? `The latest window covers only ${uploadWindowDays} days; 90 or more is recommended.`
      : null,
    latestUpload && latestUpload.queryRows < 200
      ? "The latest upload has fewer than 200 query rows."
      : null,
  ].filter((warning): warning is string => warning !== null);

  const deleteUpload = async (uploadId: string, filename: string) => {
    if (!window.confirm(`Remove ${filename}? This will mark the project for recalculation.`)) {
      return;
    }
    try {
      await deleteProjectGscUpload(projectId, uploadId);
      await queryClient.invalidateQueries({
        queryKey: ["admin", "calculation-control", projectId],
      });
      toast.success("GSC upload removed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove upload");
    }
  };

  return (
    <section className="space-y-3" aria-label="Calculation controls">
      <CollapsibleSection
        id="gsc-readiness"
        storageKey={key}
        title="GSC data readiness"
        icon={<Database className="h-4 w-4 text-signal" />}
        badge={
          <Badge variant={latestUpload ? "secondary" : "destructive"}>
            {latestUpload ? `${latestUpload.queryRows.toLocaleString()} query rows` : "not ready"}
          </Badge>
        }
        summary={latestUpload ? `${latestUpload.dateRangeStart ?? "No start"} → ${latestUpload.dateRangeEnd ?? "No end"}` : "No upload"}
        defaultOpen
      >
        <div className="space-y-4 pt-4">
          <MetricStrip
            items={[
              { label: "Uploads", value: number(control.gscReadiness.uploads.length) },
              { label: "Latest query rows", value: number(latestUpload?.queryRows) },
              { label: "Latest page rows", value: number(latestUpload?.pageRows) },
              { label: "Device", value: latestUpload?.device ?? "—" },
            ]}
          />
          {readinessWarnings.length > 0 && (
            <div className="rounded-lg border border-amber-300/70 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-950">
              {readinessWarnings.map((warning) => <div key={warning}>{warning}</div>)}
            </div>
          )}
          {!archived && (
            <div className="rounded-lg border border-hairline bg-canvas/30 p-4">
              <GscUploadPanel
                projectId={projectId}
                onUploaded={() => {
                  void queryClient.invalidateQueries({
                    queryKey: ["admin", "calculation-control", projectId],
                  });
                }}
              />
            </div>
          )}
          {control.gscReadiness.uploads.length === 0 ? (
            <Empty>No Search Console evidence has been uploaded for this project.</Empty>
          ) : (
            <div className="overflow-auto rounded-lg border border-hairline">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Source</TableHead>
                    <TableHead>Window</TableHead>
                    <TableHead>Device</TableHead>
                    <TableHead className="text-right">Queries</TableHead>
                    <TableHead className="text-right">Pages</TableHead>
                    <TableHead>Imported</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {control.gscReadiness.uploads.map((upload) => (
                    <TableRow key={upload.id}>
                      <TableCell className="font-medium">
                        {upload.originalFilename ?? upload.sourceName}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {upload.dateRangeStart ?? "—"} → {upload.dateRangeEnd ?? "—"}
                      </TableCell>
                      <TableCell>{upload.device}</TableCell>
                      <TableCell className="text-right font-mono">{number(upload.queryRows)}</TableCell>
                      <TableCell className="text-right font-mono">{number(upload.pageRows)}</TableCell>
                      <TableCell className="text-xs text-ink-muted">{dateTime(upload.createdAt)}</TableCell>
                      <TableCell>
                        {!archived && (
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            aria-label={`Remove ${upload.originalFilename ?? upload.sourceName}`}
                            onClick={() => void deleteUpload(upload.id, upload.originalFilename ?? upload.sourceName)}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <RefreshAction archived={archived} label="Generate CTR curves" onRun={onRun} running={running} />
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        id="ctr-curves"
        storageKey={key}
        title="CTR curves (v2)"
        icon={<TrendingUp className="h-4 w-4 text-signal" />}
        badge={<Badge variant="outline">CANONICAL</Badge>}
        summary={`${ctrCurves?.curves.length ?? 0} curves · ${observedCtrPoints} observed points`}
      >
        <div className="space-y-4 pt-4">
          <CtrVisualPanel data={ctrCurves} />
          <RefreshAction archived={archived} label="Refresh CTR v2" onRun={onRun} running={running} />
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        id="calibration"
        storageKey={key}
        title="Calibration (modelled vs actual)"
        icon={<ShieldCheck className="h-4 w-4 text-signal" />}
        badge={<Badge variant="outline">GATE</Badge>}
        summary={calibration ? `${calibration.status} · ${calibration.matched} matched` : "No snapshot"}
      >
        <div className="space-y-4 pt-4">
          <MetricStrip items={[
            { label: "Status", value: calibration?.status ?? "—" },
            { label: "Matched", value: number(calibration?.matched) },
            { label: "Overall ratio", value: number(calibration?.overallRatio as number | null, 3) },
            { label: "Promotion eligible", value: calibration?.promotionEligible ? "Yes" : "No" },
          ]} />
          {calibration ? (
            <div className="grid gap-3 lg:grid-cols-2">
              <DataBlock title="By intent" value={calibration.byIntent} />
              <DataBlock title="By rank band" value={calibration.byRankBand} />
            </div>
          ) : <Empty>No calibration snapshot is available.</Empty>}
          <RefreshAction archived={archived} label="Recompute calibration" onRun={onRun} running={running} />
        </div>
      </CollapsibleSection>

      <CollapsibleSection id="base-rank" storageKey={key} title="base_rank source reconciliation" icon={<Binary className="h-4 w-4 text-signal" />} badge={<Badge variant="outline">BACKFILL</Badge>} summary={`${control.baseRank.withRank}/${control.baseRank.total} ranked`}>
        <div className="space-y-4 pt-4">
          <MetricStrip items={[
            { label: "Kept keywords", value: number(control.baseRank.total) },
            { label: "With base rank", value: number(control.baseRank.withRank) },
            { label: "Missing", value: number(control.baseRank.missing) },
            { label: "Coverage", value: percent(control.baseRank.withRank, control.baseRank.total) },
          ]} />
          <KeyValueRows values={control.baseRank.sources} empty="No base-rank sources are available." />
          <RefreshAction archived={archived} label="Reconcile base ranks" onRun={onRun} running={running} />
        </div>
      </CollapsibleSection>

      <CollapsibleSection id="dfs-cluster-keys" storageKey={key} title="DFS cluster keys (core_keyword backfill)" icon={<Layers3 className="h-4 w-4 text-signal" />} badge={<Badge variant="outline">BACKFILL</Badge>} summary={`${control.clustering.memberCount} mapped members`}>
        <div className="space-y-4 pt-4">
          <p className="text-sm leading-6 text-ink-muted">The GCP clustering contract stores the canonical keyword and basis for every cluster, replacing the legacy core_keyword backfill.</p>
          <MetricStrip items={[
            { label: "Mapped members", value: number(control.clustering.memberCount) },
            { label: "Clusters", value: number(control.clustering.clusterCount) },
            { label: "Multi-keyword", value: number(control.clustering.multiMemberCount) },
            { label: "Largest", value: number(control.clustering.largestCluster) },
          ]} />
          <KeyValueRows values={control.clustering.canonicalBases} empty="No canonical cluster keys are available." />
          <RefreshAction archived={archived} label="Backfill cluster keys" onRun={onRun} running={running} />
        </div>
      </CollapsibleSection>

      <CollapsibleSection id="keyword-clustering" storageKey={key} title="Keyword clustering (form-based)" icon={<Boxes className="h-4 w-4 text-signal" />} badge={<Badge variant="outline">CLUSTERING</Badge>} summary={`${control.clustering.clusterCount} clusters`}>
        <div className="space-y-4 pt-4">
          {control.clustering.topClusters.length === 0 ? <Empty>No keyword clusters are available.</Empty> : (
            <div className="overflow-auto rounded-lg border border-hairline"><Table><TableHeader><TableRow><TableHead>Cluster key</TableHead><TableHead>Canonical keyword</TableHead><TableHead className="text-right">Members</TableHead></TableRow></TableHeader><TableBody>{control.clustering.topClusters.map((cluster) => <TableRow key={cluster.clusterKey}><TableCell className="font-mono text-xs">{cluster.clusterKey}</TableCell><TableCell className="font-medium">{cluster.canonicalKeyword}</TableCell><TableCell className="text-right font-mono">{cluster.memberCount}</TableCell></TableRow>)}</TableBody></Table></div>
          )}
          <RefreshAction archived={archived} label="Recompute clusters" onRun={onRun} running={running} />
        </div>
      </CollapsibleSection>

      <CollapsibleSection id="volume-history" storageKey={key} title="Volume History" icon={<History className="h-4 w-4 text-signal" />} badge={<Badge variant="outline">ADMIN ONLY</Badge>} summary={`${percent(control.volumeHistory.with24Months, control.volumeHistory.keptKeywords)} with 24 months`}>
        <div className="space-y-4 pt-4">
          <VolumeVisualPanel data={control.volumeHistory} />
          <RefreshAction archived={archived} label="Refresh volume history" onRun={onRun} running={running} />
        </div>
      </CollapsibleSection>

      <CollapsibleSection id="demand-signals" storageKey={key} title="Demand signals" icon={<Activity className="h-4 w-4 text-signal" />} summary={`${control.demand.signals} signals · ${control.demand.warnings} warnings`}>
        <div className="space-y-4 pt-4">
          <DemandVisualPanel data={control.demand} />
          <RefreshAction archived={archived} label="Compute demand signals" onRun={onRun} running={running} />
        </div>
      </CollapsibleSection>

      <CollapsibleSection id="demand-intelligence" storageKey={key} title="Demand intelligence" icon={<Sparkles className="h-4 w-4 text-signal" />} summary={`${control.demand.categories.length} categories`}>
        <div className="pt-4">
          {control.demand.categories.length === 0 ? <Empty>No category-level demand intelligence is available.</Empty> : (
            <div className="overflow-auto rounded-lg border border-hairline"><Table><TableHeader><TableRow><TableHead>Category</TableHead><TableHead className="text-right">Keywords</TableHead><TableHead className="text-right">Monthly volume</TableHead><TableHead className="text-right">Warnings</TableHead></TableRow></TableHeader><TableBody>{control.demand.categories.map((category) => <TableRow key={category.category}><TableCell className="font-medium">{category.category}</TableCell><TableCell className="text-right font-mono">{number(category.keywordCount)}</TableCell><TableCell className="text-right font-mono">{number(category.monthlyVolume)}</TableCell><TableCell className="text-right font-mono">{number(category.warningCount)}</TableCell></TableRow>)}</TableBody></Table></div>
          )}
        </div>
      </CollapsibleSection>

      <CollapsibleSection id="serp-visibility" storageKey={key} title="SERP visibility v2 preview" icon={<BarChart3 className="h-4 w-4 text-signal" />} summary={`${control.serpVisibility.featureCount} features`}>
        <div className="space-y-4 pt-4">
          <SerpVisualPanel data={control.serpVisibility} />
        </div>
      </CollapsibleSection>

      <CollapsibleSection id="content-fit" storageKey={key} title="Content-fit diagnostics" icon={<ListChecks className="h-4 w-4 text-signal" />} summary={`${control.contentFit.scored}/${control.contentFit.total} scored`}>
        <div className="space-y-4 pt-4">
          <MetricStrip items={[
            { label: "Matched", value: number(control.contentFit.matched) },
            { label: "Missing", value: number(control.contentFit.missing) },
            { label: "Zero scores", value: number(control.contentFit.zero) },
            { label: "Average score", value: number(control.contentFit.averageScore, 1) },
          ]} />
          {control.contentFit.zeroRows.length > 0 && <div className="overflow-auto rounded-lg border border-hairline"><Table><TableHeader><TableRow><TableHead>Zero-score keyword</TableHead><TableHead>Ranking URL</TableHead><TableHead>Action</TableHead></TableRow></TableHeader><TableBody>{control.contentFit.zeroRows.map((row) => <TableRow key={row.keyword}><TableCell className="font-medium">{row.keyword}</TableCell><TableCell className="max-w-[420px] truncate text-xs">{row.rankingUrl ?? "—"}</TableCell><TableCell>{row.tacticalStatus ?? "—"}</TableCell></TableRow>)}</TableBody></Table></div>}
        </div>
      </CollapsibleSection>

      <CollapsibleSection id="har-comparison" storageKey={key} title="HAR v1 vs v2 comparison" icon={<GitCompareArrows className="h-4 w-4 text-signal" />} summary={`${control.comparisons.comparableHarCount} comparable keywords`}>
        <div className="space-y-4 pt-4">
          <MetricStrip items={[
            { label: "V2 keywords", value: number(control.comparisons.keywordCount) },
            { label: "Comparable", value: number(control.comparisons.comparableHarCount) },
            { label: "Average rank delta", value: number(control.comparisons.averageHarDelta, 2) },
            { label: "Legacy source", value: control.comparisons.comparableHarCount ? "Migration archive" : "Unavailable" },
          ]} />
          <ComparisonTable mode="har" rows={control.comparisons.items} />
        </div>
      </CollapsibleSection>

      <CollapsibleSection id="revenue-comparison" storageKey={key} title="Revenue v1 vs v2 comparison" icon={<GitCompareArrows className="h-4 w-4 text-signal" />} summary={`${control.comparisons.comparableRevenueCount} comparable keywords`}>
        <div className="space-y-4 pt-4">
          <MetricStrip items={[
            { label: "Comparable", value: number(control.comparisons.comparableRevenueCount) },
            { label: "V2 scenarios", value: number(summary?.revenue.reduce((total, row) => total + row.forecastCount, 0)) },
            { label: "Latest run", value: control.latestSuccessfulRun?.id.slice(0, 8) ?? "—" },
            { label: "Completed", value: dateTime(control.latestSuccessfulRun?.completedAt ?? null) },
          ]} />
          <ComparisonTable mode="revenue" rows={control.comparisons.items} />
        </div>
      </CollapsibleSection>

      <CollapsibleSection id="brand-classification" storageKey={key} title="Brand classification" icon={<Tags className="h-4 w-4 text-signal" />} summary={`${control.brandClassification.unclassified} unclassified`}>
        <div className="space-y-4 pt-4">
          <MetricStrip items={[
            { label: "Branded", value: number(control.brandClassification.branded) },
            { label: "Non-brand", value: number(control.brandClassification.unbranded) },
            { label: "Unclassified", value: number(control.brandClassification.unclassified) },
            { label: "Configured terms", value: number(control.brandClassification.brandTerms.length) },
          ]} />
          <div className="flex flex-wrap gap-2">{control.brandClassification.brandTerms.length ? control.brandClassification.brandTerms.map((term) => <Badge key={term} variant="outline">{term}</Badge>) : <span className="text-sm text-ink-muted">No client brand terms are configured.</span>}</div>
          <RefreshAction archived={archived} label="Classify brand terms" onRun={onRun} running={running} />
        </div>
      </CollapsibleSection>

      <CollapsibleSection id="recent-runs" storageKey={key} title="Recent runs" icon={<Archive className="h-4 w-4 text-signal" />} summary={`${control.recentRuns.length} runs`}>
        <div className="pt-4">
          {control.recentRuns.length === 0 ? <Empty>This project has no calculation runs.</Empty> : (
            <div className="overflow-auto rounded-lg border border-hairline"><Table><TableHeader><TableRow><TableHead>Run</TableHead><TableHead>Status</TableHead><TableHead>Created</TableHead><TableHead>Completed</TableHead><TableHead>Failure stage</TableHead></TableRow></TableHeader><TableBody>{control.recentRuns.map((run) => <TableRow key={run.id}><TableCell className="font-mono text-xs">{run.id.slice(0, 8)}</TableCell><TableCell><Badge variant={run.status === "succeeded" ? "default" : run.status === "failed" ? "destructive" : "outline"}>{run.status}</Badge></TableCell><TableCell className="text-xs">{dateTime(run.createdAt)}</TableCell><TableCell className="text-xs">{dateTime(run.completedAt)}</TableCell><TableCell>{run.failureStage ?? "—"}</TableCell></TableRow>)}</TableBody></Table></div>
          )}
        </div>
      </CollapsibleSection>
    </section>
  );
}

function KeyValueRows({ values, empty }: { values: Record<string, number>; empty: string }) {
  const rows = Object.entries(values).sort((left, right) => right[1] - left[1]);
  if (rows.length === 0) return <Empty>{empty}</Empty>;
  return <div className="flex flex-wrap gap-2">{rows.map(([label, value]) => <Badge key={label} variant="secondary">{label.replace(/_/g, " ")} · {value.toLocaleString()}</Badge>)}</div>;
}

function DataBlock({ title, value }: { title: string; value: unknown }) {
  return <div className="rounded-lg border border-hairline bg-canvas/50 p-4"><div className="text-xs font-semibold text-ink">{title}</div><pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-5 text-ink-muted">{JSON.stringify(value ?? {}, null, 2)}</pre></div>;
}

function ComparisonTable({ mode, rows }: { mode: "har" | "revenue"; rows: CalculationControl["comparisons"]["items"] }) {
  if (rows.length === 0) return <Empty>No v2 output is available for comparison.</Empty>;
  const comparable = rows.filter((row) => mode === "har" ? row.harV1 !== null : row.targetIncrementalRevenueV1 !== null);
  if (comparable.length === 0) return <Empty>Legacy v1 values were not present in the migration archive for this project.</Empty>;
  return <div className="max-h-[480px] overflow-auto rounded-lg border border-hairline"><Table><TableHeader><TableRow><TableHead>Keyword</TableHead><TableHead className="text-right">v1</TableHead><TableHead className="text-right">v2</TableHead><TableHead className="text-right">Delta</TableHead></TableRow></TableHeader><TableBody>{comparable.map((row) => { const v1 = mode === "har" ? row.harV1 : row.targetIncrementalRevenueV1; const v2 = mode === "har" ? row.harV2 : row.targetIncrementalRevenueV2; const delta = v1 == null || v2 == null ? null : v2 - v1; return <TableRow key={`${mode}:${row.keywordId}`}><TableCell className="font-medium">{row.keyword}</TableCell><TableCell className="text-right font-mono">{mode === "har" ? number(v1, 1) : money(v1)}</TableCell><TableCell className="text-right font-mono">{mode === "har" ? number(v2, 1) : money(v2)}</TableCell><TableCell className="text-right font-mono">{mode === "har" ? number(delta, 1) : money(delta)}</TableCell></TableRow>; })}</TableBody></Table></div>;
}
