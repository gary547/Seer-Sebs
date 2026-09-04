import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AlertTriangle, CheckCircle2, Database, Eye } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { ChartContainer } from "@/components/ui/chart";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type CalculationControl } from "@/integrations/gcp/calculation-control";
import { type ProjectCtrCurves } from "@/integrations/gcp/calculations";
import {
  ctrChartRows,
  humanise,
  volumeCoverageBuckets,
} from "@/components/admin/calculationDiagnostics";

const DEVICE_COLOURS: Record<string, string> = {
  desktop: "hsl(var(--signal-2))",
  mobile: "hsl(var(--signal))",
  tablet: "hsl(var(--signal-3))",
};

const DISTRIBUTION_COLOURS = [
  "bg-signal",
  "bg-[hsl(var(--signal-2))]",
  "bg-[hsl(var(--signal-3))]",
  "bg-amber-400",
  "bg-rose-400",
];

function number(value: number | null | undefined, digits = 0): string {
  return value == null
    ? "—"
    : new Intl.NumberFormat("en-GB", {
        maximumFractionDigits: digits,
      }).format(value);
}

function percent(value: number | null | undefined, digits = 0): string {
  return value == null ? "—" : `${(value * 100).toFixed(digits)}%`;
}

function StatGrid({
  items,
}: {
  items: Array<{ hint?: string; label: string; value: string }>;
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
          {item.hint && (
            <div className="mt-1 text-[11px] leading-4 text-ink-muted">
              {item.hint}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Distribution({
  title,
  values,
}: {
  title: string;
  values: Array<{ count: number; label: string }>;
}) {
  const total = values.reduce((sum, item) => sum + item.count, 0);
  return (
    <div className="rounded-lg border border-hairline bg-canvas/40 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs font-semibold text-ink">{title}</div>
        <div className="font-mono text-[11px] tabular-nums text-ink-muted">
          {total.toLocaleString()} rows
        </div>
      </div>
      <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-surface-muted">
        {values.map((item, index) => (
          <div
            key={item.label}
            className={DISTRIBUTION_COLOURS[index % DISTRIBUTION_COLOURS.length]}
            style={{ width: total > 0 ? `${(item.count / total) * 100}%` : "0%" }}
            title={`${item.label}: ${item.count.toLocaleString()}`}
          />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
        {values.map((item, index) => (
          <div key={item.label} className="flex items-center gap-1.5 text-[11px] text-ink-muted">
            <span
              className={`h-2 w-2 rounded-full ${DISTRIBUTION_COLOURS[index % DISTRIBUTION_COLOURS.length]}`}
            />
            <span>{item.label}</span>
            <span className="font-mono font-semibold tabular-nums text-ink">
              {item.count.toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function CtrVisualPanel({ data }: { data: ProjectCtrCurves | undefined }) {
  const curves = useMemo(() => data?.curves ?? [], [data?.curves]);
  const intents = useMemo(
    () => [...new Set(curves.map((curve) => curve.searchIntent))].sort(),
    [curves],
  );
  const [selectedIntent, setSelectedIntent] = useState("");
  const [brandScope, setBrandScope] = useState<"brand" | "nonbrand">("nonbrand");
  const activeIntent = intents.includes(selectedIntent)
    ? selectedIntent
    : intents[0] ?? "";
  const selectedCurves = curves.filter(
    (curve) =>
      curve.searchIntent === activeIntent &&
      curve.isBranded === (brandScope === "brand"),
  );
  const devices = [...new Set(selectedCurves.map((curve) => curve.device))];
  const chartRows = ctrChartRows(selectedCurves);
  const points = selectedCurves.flatMap((curve) => curve.points);
  const observed = points.filter((point) => point.source === "gsc").length;
  const impressions = points.reduce((sum, point) => sum + point.impressions, 0);
  const highConfidence = points.filter((point) => point.confidence === "high").length;

  if (curves.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-hairline px-5 py-8 text-center text-sm text-ink-muted">
        No CTR curves were persisted by the latest successful run.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <StatGrid
        items={[
          { label: "Curves", value: number(curves.length) },
          { label: "Observed points", value: number(observed), hint: `${number(points.length - observed)} fallback` },
          { label: "High confidence", value: number(highConfidence) },
          { label: "GSC impressions", value: number(impressions) },
        ]}
      />
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-hairline bg-surface-muted/30 p-3">
        <div className="min-w-[220px] space-y-1">
          <div className="type-eyebrow text-ink-muted">Search intent</div>
          <Select value={activeIntent} onValueChange={setSelectedIntent}>
            <SelectTrigger className="h-9 bg-surface"><SelectValue /></SelectTrigger>
            <SelectContent>
              {intents.map((intent) => (
                <SelectItem key={intent} value={intent}>{humanise(intent)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="min-w-[180px] space-y-1">
          <div className="type-eyebrow text-ink-muted">Brand scope</div>
          <Select value={brandScope} onValueChange={(value) => setBrandScope(value as "brand" | "nonbrand")}>
            <SelectTrigger className="h-9 bg-surface"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="nonbrand">Non-brand</SelectItem>
              <SelectItem value="brand">Branded</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          {devices.map((device) => (
            <Badge key={device} variant="outline" className="capitalize">
              <span className="mr-1.5 h-2 w-2 rounded-full" style={{ background: DEVICE_COLOURS[device] ?? "hsl(var(--signal))" }} />
              {device}
            </Badge>
          ))}
        </div>
      </div>
      {selectedCurves.length === 0 ? (
        <div className="rounded-lg border border-dashed border-hairline px-5 py-8 text-center text-sm text-ink-muted">
          No curve exists for this intent and brand scope.
        </div>
      ) : (
        <>
          <div className="rounded-lg border border-hairline bg-surface p-4">
            <ChartContainer
              className="h-[320px] w-full"
              config={Object.fromEntries(devices.map((device) => [device, { color: DEVICE_COLOURS[device] ?? "hsl(var(--signal))", label: humanise(device) }]))}
            >
              <LineChart data={chartRows} margin={{ bottom: 8, left: 0, right: 16, top: 10 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="rank" tickLine={false} axisLine={false} />
                <YAxis tickFormatter={(value) => `${value}%`} tickLine={false} axisLine={false} width={44} />
                <Tooltip formatter={(value, name) => [`${Number(value).toFixed(2)}%`, humanise(String(name).split(":")[0])]} labelFormatter={(rank) => `Organic rank ${rank}`} />
                <Legend formatter={(value) => humanise(String(value).split(":")[0])} />
                {selectedCurves.map((curve) => {
                  const key = `${curve.device}:${curve.isBranded ? "brand" : "nonbrand"}`;
                  return <Line key={key} dataKey={key} type="monotone" stroke={DEVICE_COLOURS[curve.device] ?? "hsl(var(--signal))"} strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />;
                })}
              </LineChart>
            </ChartContainer>
          </div>
          <div className="overflow-auto rounded-lg border border-hairline">
            <Table>
              <TableHeader><TableRow><TableHead>Device</TableHead><TableHead className="text-right">Rank 1 CTR</TableHead><TableHead className="text-right">Observed</TableHead><TableHead className="text-right">Fallback</TableHead><TableHead className="text-right">Impressions</TableHead></TableRow></TableHeader>
              <TableBody>
                {selectedCurves.map((curve) => {
                  const curveObserved = curve.points.filter((point) => point.source === "gsc");
                  return (
                    <TableRow key={curve.device}>
                      <TableCell className="font-medium capitalize">{curve.device}</TableCell>
                      <TableCell className="text-right font-mono">{percent(curve.points.find((point) => point.rank === 1)?.ctr, 2)}</TableCell>
                      <TableCell className="text-right font-mono">{number(curveObserved.length)}</TableCell>
                      <TableCell className="text-right font-mono">{number(curve.points.length - curveObserved.length)}</TableCell>
                      <TableCell className="text-right font-mono">{number(curve.points.reduce((sum, point) => sum + point.impressions, 0))}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}

export function VolumeVisualPanel({ data }: { data: CalculationControl["volumeHistory"] }) {
  const buckets = volumeCoverageBuckets(data);
  return (
    <div className="space-y-4">
      <StatGrid
        items={[
          { label: "Kept keywords", value: number(data.keptKeywords) },
          { label: "24-month ready", value: number(data.with24Months), hint: `${percent(data.keptKeywords ? data.with24Months / data.keptKeywords : 0)} coverage` },
          { label: "Median history", value: `${number(data.medianMonths, 1)} months` },
          { label: "Stored observations", value: number(data.historyRows) },
        ]}
      />
      <div className="grid gap-3 lg:grid-cols-[1.1fr_0.9fr]">
        <Distribution title="History coverage" values={buckets.map(({ count, label }) => ({ count, label }))} />
        <div className="rounded-lg border border-hairline bg-canvas/40 p-4">
          <div className="text-xs font-semibold text-ink">Available window</div>
          <div className="mt-3 flex items-center gap-3">
            <Database className="h-4 w-4 text-signal" />
            <span className="font-mono text-sm text-ink">{data.earliestMonth ?? "—"}</span>
            <span className="h-px flex-1 bg-hairline" />
            <span className="font-mono text-sm text-ink">{data.latestMonth ?? "—"}</span>
          </div>
          <p className="mt-3 text-[11px] leading-4 text-ink-muted">
            Demand forecasting uses canonical monthly rows and highlights sparse histories before they affect projections.
          </p>
        </div>
      </div>
      {data.sample.length === 0 ? (
        <div className="rounded-lg border border-dashed border-hairline px-5 py-8 text-center text-sm text-ink-muted">No monthly search-volume history is available.</div>
      ) : (
        <div className="max-h-[480px] overflow-auto rounded-lg border border-hairline">
          <Table>
            <TableHeader><TableRow><TableHead>Keyword</TableHead><TableHead className="text-right">Months</TableHead><TableHead>Range</TableHead><TableHead className="text-right">Average</TableHead><TableHead className="text-right">Peak</TableHead><TableHead className="text-right">Latest</TableHead><TableHead>Readiness</TableHead></TableRow></TableHeader>
            <TableBody>
              {data.sample.map((row) => {
                const volumes = row.months.map((month) => month.volume);
                const average = volumes.length ? volumes.reduce((sum, value) => sum + value, 0) / volumes.length : null;
                return (
                  <TableRow key={row.keywordId}>
                    <TableCell className="max-w-[300px] truncate font-medium">{row.keyword}</TableCell>
                    <TableCell className="text-right font-mono">{number(row.monthCount)}</TableCell>
                    <TableCell className="font-mono text-xs">{row.months[0]?.month ?? "—"} → {row.months.at(-1)?.month ?? "—"}</TableCell>
                    <TableCell className="text-right font-mono">{number(average)}</TableCell>
                    <TableCell className="text-right font-mono">{number(volumes.length ? Math.max(...volumes) : null)}</TableCell>
                    <TableCell className="text-right font-mono">{number(row.months.at(-1)?.volume)}</TableCell>
                    <TableCell><Badge variant={row.monthCount >= 24 ? "secondary" : "outline"}>{row.monthCount >= 24 ? "Ready" : row.monthCount >= 12 ? "Partial" : "Sparse"}</Badge></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

export function DemandVisualPanel({ data }: { data: CalculationControl["demand"] }) {
  const trends = Object.entries(data.trendDirections).sort((left, right) => right[1] - left[1]);
  const confidences = Object.entries(data.confidenceDistribution).sort((left, right) => right[1] - left[1]);
  return (
    <div className="space-y-4">
      <StatGrid
        items={[
          { label: "Signals", value: number(data.signals) },
          { label: "Warnings", value: number(data.warnings), hint: percent(data.signals ? data.warnings / data.signals : 0) },
          { label: "Average coverage", value: `${number(data.averageCoverageMonths, 1)} months` },
          { label: "Categories", value: number(data.categories.length) },
        ]}
      />
      <div className="grid gap-3 lg:grid-cols-2">
        <Distribution title="Trend direction" values={trends.map(([label, count]) => ({ count, label: humanise(label) }))} />
        <Distribution title="Signal confidence" values={confidences.map(([label, count]) => ({ count, label: humanise(label) }))} />
      </div>
      {Object.keys(data.warningReasons).length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300/70 bg-amber-50 px-4 py-3 text-amber-950">
          <AlertTriangle className="h-4 w-4" />
          <span className="mr-1 text-xs font-semibold">Warning reasons</span>
          {Object.entries(data.warningReasons).map(([reason, count]) => (
            <Badge key={reason} variant="outline" className="border-amber-300 bg-white/70 text-amber-950">{humanise(reason)} · {number(count)}</Badge>
          ))}
        </div>
      )}
      {data.samples.length > 0 && (
        <div className="max-h-[520px] overflow-auto rounded-lg border border-hairline">
          <Table>
            <TableHeader><TableRow><TableHead>Keyword</TableHead><TableHead>Category</TableHead><TableHead className="text-right">Monthly volume</TableHead><TableHead className="text-right">Trend</TableHead><TableHead>Direction</TableHead><TableHead>Confidence</TableHead><TableHead className="text-right">Coverage</TableHead><TableHead className="text-right">Volatility</TableHead><TableHead>Peak months</TableHead></TableRow></TableHeader>
            <TableBody>
              {data.samples.map((row) => (
                <TableRow key={row.keywordId}>
                  <TableCell className="max-w-[300px] truncate font-medium">{row.keyword}</TableCell>
                  <TableCell>{row.category}</TableCell>
                  <TableCell className="text-right font-mono">{number(row.monthlyVolume)}</TableCell>
                  <TableCell className="text-right font-mono">{row.trendPct == null ? "—" : `${row.trendPct > 0 ? "+" : ""}${percent(row.trendPct, 1)}`}</TableCell>
                  <TableCell><Badge variant="outline">{humanise(row.trendDirection)}</Badge></TableCell>
                  <TableCell><Badge variant={row.trendConfidence === "high" ? "secondary" : "outline"}>{humanise(row.trendConfidence)}</Badge></TableCell>
                  <TableCell className="text-right font-mono">{number(row.coverageMonths)} mo</TableCell>
                  <TableCell className="text-right font-mono">{number(row.volatilityScore, 2)}</TableCell>
                  <TableCell className="font-mono text-xs">{row.peakMonths.length ? row.peakMonths.join(", ") : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {data.categories.length > 0 && (
        <div className="overflow-auto rounded-lg border border-hairline">
          <Table>
            <TableHeader><TableRow><TableHead>Category roll-up</TableHead><TableHead className="text-right">Keywords</TableHead><TableHead className="text-right">Monthly volume</TableHead><TableHead className="text-right">Warnings</TableHead></TableRow></TableHeader>
            <TableBody>{data.categories.map((row) => <TableRow key={row.category}><TableCell className="font-medium">{row.category}</TableCell><TableCell className="text-right font-mono">{number(row.keywordCount)}</TableCell><TableCell className="text-right font-mono">{number(row.monthlyVolume)}</TableCell><TableCell className="text-right font-mono">{number(row.warningCount)}</TableCell></TableRow>)}</TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

export function SerpVisualPanel({ data }: { data: CalculationControl["serpVisibility"] }) {
  const visibilityLoss = data.averageMultiplier == null ? null : 1 - data.averageMultiplier;
  return (
    <div className="space-y-4">
      <StatGrid
        items={[
          { label: "SERP features", value: number(data.featureCount) },
          { label: "Keywords affected", value: number(data.keywordCount) },
          { label: "Owned features", value: number(data.ownedCount) },
          { label: "Visibility retained", value: percent(data.averageMultiplier, 1), hint: visibilityLoss == null ? undefined : `${percent(visibilityLoss, 1)} displaced` },
        ]}
      />
      <Distribution title="Feature mix" values={data.featureTypes.map((feature) => ({ count: feature.count, label: humanise(feature.resultType) }))} />
      <div className="grid gap-3 lg:grid-cols-[0.72fr_1.28fr]">
        <div className="overflow-auto rounded-lg border border-hairline">
          <Table>
            <TableHeader><TableRow><TableHead>Result type</TableHead><TableHead className="text-right">Seen</TableHead><TableHead className="text-right">Owned</TableHead></TableRow></TableHeader>
            <TableBody>{data.featureTypes.map((feature) => <TableRow key={feature.resultType}><TableCell className="font-medium">{humanise(feature.resultType)}</TableCell><TableCell className="text-right font-mono">{number(feature.count)}</TableCell><TableCell className="text-right font-mono">{number(feature.ownedCount)}</TableCell></TableRow>)}</TableBody>
          </Table>
        </div>
        <div className="overflow-auto rounded-lg border border-hairline">
          <Table>
            <TableHeader><TableRow><TableHead>Keyword</TableHead><TableHead>Intent</TableHead><TableHead>Features</TableHead><TableHead className="text-right">Owned</TableHead><TableHead className="min-w-[180px]">Visibility multiplier</TableHead></TableRow></TableHeader>
            <TableBody>
              {data.samples.map((row) => (
                <TableRow key={row.keywordId}>
                  <TableCell className="max-w-[260px] truncate font-medium">{row.keyword}</TableCell>
                  <TableCell><Badge variant="outline">{humanise(row.searchIntent ?? "unknown")}</Badge></TableCell>
                  <TableCell><div className="flex max-w-[360px] flex-wrap gap-1">{row.resultTypes.map((type) => <Badge key={type} variant="secondary" className="text-[10px]">{humanise(type)}</Badge>)}</div></TableCell>
                  <TableCell className="text-right font-mono">{number(row.ownedCount)}/{number(row.featureCount)}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-muted"><div className="h-full rounded-full bg-signal" style={{ width: `${Math.max(0, Math.min(100, (row.multiplier ?? 0) * 100))}%` }} /></div>
                      <span className="w-12 text-right font-mono text-xs">{number(row.multiplier, 3)}</span>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
      {data.featureCount > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-hairline bg-canvas/40 px-4 py-3 text-xs leading-5 text-ink-muted">
          {data.ownedCount > 0 ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-signal" /> : <Eye className="mt-0.5 h-4 w-4 shrink-0 text-signal" />}
          The multiplier is applied to attainable-rank traffic so crowded SERPs do not overstate organic visibility. Owned features are retained separately for QA.
        </div>
      )}
    </div>
  );
}
