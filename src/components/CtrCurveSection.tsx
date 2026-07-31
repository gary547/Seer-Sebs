import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Activity,
  CheckCircle2,
  Database,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

import GscUploadPanel from "@/components/GscUploadPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { getProjectCtrCurves } from "@/integrations/gcp/calculations";
import { useRecomputeForecasts } from "@/hooks/useRecomputeForecasts";

interface CtrCurveSectionProps {
  projectId: string;
}

const INTENTS = [
  "transactional",
  "commercial",
  "informational",
  "navigational",
  "generic",
] as const;

const DEVICE_COLOURS: Record<string, string> = {
  desktop: "hsl(var(--signal-2))",
  mobile: "hsl(var(--signal))",
  tablet: "hsl(var(--signal-3))",
};

function label(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function percent(value: number | null | undefined): string {
  return value == null ? "—" : `${(value * 100).toFixed(2)}%`;
}

export default function CtrCurveSection({
  projectId,
}: CtrCurveSectionProps) {
  const [activeIntent, setActiveIntent] = useState<string>("transactional");
  const [brandScope, setBrandScope] = useState<"branded" | "unbranded">(
    "unbranded",
  );
  const { recompute, isRecomputing } = useRecomputeForecasts(projectId);
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["ctr_curves", projectId],
    queryFn: () => getProjectCtrCurves(projectId),
  });

  const availableIntents = useMemo(() => {
    const values = new Set(
      (data?.curves ?? []).map((curve) => curve.searchIntent),
    );
    return INTENTS.filter((intent) => values.has(intent));
  }, [data?.curves]);

  const displayIntent =
    availableIntents.includes(activeIntent as (typeof INTENTS)[number])
      ? activeIntent
      : availableIntents[0] ?? activeIntent;

  const selectedCurves = useMemo(
    () =>
      (data?.curves ?? []).filter(
        (curve) =>
          curve.searchIntent === displayIntent &&
          curve.isBranded === (brandScope === "branded"),
      ),
    [brandScope, data?.curves, displayIntent],
  );

  const devices = useMemo(
    () => Array.from(new Set(selectedCurves.map((curve) => curve.device))),
    [selectedCurves],
  );

  const chartRows = useMemo(() => {
    const rows = Array.from({ length: 20 }, (_, index) => ({
      rank: index + 1,
    })) as Array<Record<string, number>>;
    for (const curve of selectedCurves) {
      for (const point of curve.points) {
        const row = rows[point.rank - 1];
        if (row) row[curve.device] = point.ctr * 100;
      }
    }
    return rows;
  }, [selectedCurves]);

  const pointRows = useMemo(() => {
    const byRank = new Map<
      number,
      Record<
        string,
        {
          confidence: string;
          ctr: number;
          impressions: number;
          source: string;
        }
      >
    >();
    for (const curve of selectedCurves) {
      for (const point of curve.points) {
        const row = byRank.get(point.rank) ?? {};
        row[curve.device] = point;
        byRank.set(point.rank, row);
      }
    }
    return [...byRank.entries()].sort(([left], [right]) => left - right);
  }, [selectedCurves]);

  const allPoints = selectedCurves.flatMap((curve) => curve.points);
  const observedPoints = allPoints.filter(
    (point) => point.source === "gsc",
  ).length;
  const totalImpressions = allPoints.reduce(
    (total, point) => total + point.impressions,
    0,
  );
  const highConfidencePoints = allPoints.filter(
    (point) => point.confidence === "high",
  ).length;

  const runCalculation = async () => {
    const result = await recompute(false);
    if (result.ok) await refetch();
  };

  return (
    <div className="space-y-5">
      <Card className="overflow-hidden border-hairline shadow-card">
        <CardHeader className="border-b border-hairline bg-surface-muted/40 pb-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-2xl">
              <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-signal">
                <Activity className="h-3.5 w-3.5" />
                Search demand model
              </div>
              <CardTitle className="text-xl text-ink">
                CTR curves from observed search behaviour
              </CardTitle>
              <p className="mt-2 text-sm leading-6 text-ink-muted">
                Search Console observations are grouped by intent, brand scope
                and device. Missing ranks use the canonical fallback curve so
                every forecast remains complete and reproducible.
              </p>
            </div>
            <Button
              size="sm"
              variant="signal"
              onClick={runCalculation}
              disabled={isRecomputing}
            >
              <RefreshCw
                className={`h-4 w-4 ${isRecomputing ? "animate-spin" : ""}`}
              />
              {isRecomputing ? "Calculating…" : "Refresh calculations"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-5 pt-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric
              icon={Database}
              label="Curves available"
              value={String(data?.curves.length ?? 0)}
              hint={data?.runId ? `Run ${data.runId.slice(0, 8)}` : "No completed run"}
            />
            <Metric
              icon={CheckCircle2}
              label="Observed points"
              value={observedPoints.toLocaleString()}
              hint={`${allPoints.length - observedPoints} fallback points`}
            />
            <Metric
              icon={ShieldCheck}
              label="High confidence"
              value={highConfidencePoints.toLocaleString()}
              hint={`${allPoints.length.toLocaleString()} points in selection`}
            />
            <Metric
              icon={Activity}
              label="GSC impressions"
              value={totalImpressions.toLocaleString()}
              hint={
                data?.completedAt
                  ? `Calculated ${new Date(data.completedAt).toLocaleDateString("en-GB")}`
                  : "Awaiting first calculation"
              }
            />
          </div>

          <div className="flex flex-wrap items-end gap-3 rounded-lg border border-hairline bg-surface-muted/30 p-3">
            <div className="min-w-[210px] space-y-1">
              <div className="type-eyebrow text-ink-muted">Search intent</div>
              <Select
                value={displayIntent}
                onValueChange={setActiveIntent}
                disabled={availableIntents.length === 0}
              >
                <SelectTrigger className="h-9 bg-surface">
                  <SelectValue placeholder="No intent data" />
                </SelectTrigger>
                <SelectContent>
                  {(availableIntents.length > 0
                    ? availableIntents
                    : INTENTS
                  ).map((intent) => (
                    <SelectItem key={intent} value={intent}>
                      {label(intent)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-[180px] space-y-1">
              <div className="type-eyebrow text-ink-muted">Brand scope</div>
              <Select
                value={brandScope}
                onValueChange={(value) =>
                  setBrandScope(value as "branded" | "unbranded")
                }
              >
                <SelectTrigger className="h-9 bg-surface">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unbranded">Unbranded</SelectItem>
                  <SelectItem value="branded">Branded</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="ml-auto flex flex-wrap gap-2">
              {devices.map((device) => (
                <Badge key={device} variant="outline" className="capitalize">
                  <span
                    className="mr-1.5 h-2 w-2 rounded-full"
                    style={{ background: DEVICE_COLOURS[device] }}
                  />
                  {device}
                </Badge>
              ))}
            </div>
          </div>

          {isLoading ? (
            <div className="flex h-80 items-center justify-center text-sm text-ink-muted">
              Loading CTR evidence…
            </div>
          ) : selectedCurves.length === 0 ? (
            <div className="rounded-xl border border-dashed border-hairline bg-surface-muted/20 px-6 py-12 text-center">
              <p className="font-medium text-ink">
                No curve exists for this selection yet.
              </p>
              <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-ink-muted">
                Import a Search Console performance export, then refresh the
                calculation pipeline. The fallback model will cover ranks with
                insufficient observations.
              </p>
            </div>
          ) : (
            <>
              <div className="rounded-xl border border-hairline bg-surface p-4">
                <ChartContainer
                  className="h-[360px] w-full"
                  config={Object.fromEntries(
                    devices.map((device) => [
                      device,
                      {
                        color: DEVICE_COLOURS[device],
                        label: label(device),
                      },
                    ]),
                  )}
                >
                  <LineChart
                    data={chartRows}
                    margin={{ bottom: 8, left: 4, right: 16, top: 12 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis
                      dataKey="rank"
                      tickLine={false}
                      axisLine={false}
                      label={{
                        value: "Organic rank",
                        position: "insideBottom",
                        offset: -4,
                      }}
                    />
                    <YAxis
                      tickFormatter={(value) => `${value}%`}
                      tickLine={false}
                      axisLine={false}
                      width={48}
                    />
                    <ChartTooltip
                      formatter={(value, name) => [
                        `${Number(value).toFixed(2)}%`,
                        label(String(name)),
                      ]}
                      labelFormatter={(rank) => `Rank ${rank}`}
                    />
                    <Legend />
                    {devices.map((device) => (
                      <Line
                        key={device}
                        type="monotone"
                        dataKey={device}
                        name={label(device)}
                        stroke={DEVICE_COLOURS[device]}
                        strokeWidth={2.5}
                        dot={false}
                        activeDot={{ r: 4 }}
                      />
                    ))}
                  </LineChart>
                </ChartContainer>
              </div>

              <div className="max-h-[440px] overflow-auto rounded-xl border border-hairline">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-20">Rank</TableHead>
                      {devices.map((device) => (
                        <TableHead key={device} className="capitalize">
                          {device}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pointRows.map(([rank, points]) => (
                      <TableRow key={rank}>
                        <TableCell className="font-mono font-semibold tabular-nums">
                          {rank}
                        </TableCell>
                        {devices.map((device) => {
                          const point = points[device];
                          return (
                            <TableCell key={device}>
                              {point ? (
                                <div className="flex items-center gap-2">
                                  <span className="min-w-[62px] font-mono tabular-nums text-ink">
                                    {percent(point.ctr)}
                                  </span>
                                  <Badge
                                    variant={
                                      point.source === "gsc"
                                        ? "default"
                                        : "outline"
                                    }
                                    className="text-[10px]"
                                  >
                                    {point.source === "gsc"
                                      ? `${point.impressions.toLocaleString()} imp`
                                      : "fallback"}
                                  </Badge>
                                  <span className="text-[11px] capitalize text-ink-muted">
                                    {point.confidence}
                                  </span>
                                </div>
                              ) : (
                                "—"
                              )}
                            </TableCell>
                          );
                        })}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="border-hairline shadow-card">
        <CardHeader className="pb-3">
          <div className="type-eyebrow text-ink-muted">Source data</div>
          <CardTitle className="text-base text-ink">
            Import Search Console evidence
          </CardTitle>
          <p className="text-sm leading-6 text-ink-muted">
            Upload the standard Performance export in CSV or XLSX format.
            Importing marks the project for recalculation; the pipeline
            validates the rows before they affect any forecast.
          </p>
        </CardHeader>
        <CardContent>
          <GscUploadPanel projectId={projectId} />
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({
  hint,
  icon: Icon,
  label: metricLabel,
  value,
}: {
  hint: string;
  icon: typeof Activity;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-hairline bg-surface p-3">
      <div className="flex items-center gap-2 text-ink-muted">
        <Icon className="h-3.5 w-3.5" />
        <span className="type-eyebrow">{metricLabel}</span>
      </div>
      <div className="mt-2 font-mono text-xl font-semibold tabular-nums text-ink">
        {value}
      </div>
      <p className="mt-1 truncate text-[11px] text-ink-muted" title={hint}>
        {hint}
      </p>
    </div>
  );
}
