import { useMemo, useState } from "react";
import { Navigate, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  CheckCircle2,
  CircleDashed,
  Database,
  Gauge,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";

import GscUploadPanel from "@/components/GscUploadPanel";
import CalculationInspectors from "@/components/admin/CalculationInspectors";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { useAuth } from "@/contexts/AuthContext";
import {
  getProjectCalculationSummary,
  getProjectCtrCurves,
} from "@/integrations/gcp/calculations";
import { getProjectData } from "@/integrations/gcp/project-data";
import {
  getLatestProjectPipelineRun,
  getPipelineRun,
  startProjectPipeline,
  type PipelineRun,
  type PipelineStageState,
} from "@/integrations/gcp/pipeline";
import { listProjects } from "@/integrations/gcp/tenancy";

function dateTime(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-GB");
}

function money(value: number | null | undefined): string {
  if (value == null) return "—";
  return new Intl.NumberFormat("en-GB", {
    currency: "GBP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(value);
}

function stageVariant(
  state: PipelineStageState,
): "default" | "destructive" | "outline" | "secondary" {
  if (state === "succeeded") return "default";
  if (state === "failed") return "destructive";
  if (state === "running") return "secondary";
  return "outline";
}

export default function CalculationsPage() {
  const { canManageUsers } = useAuth();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [running, setRunning] = useState(false);
  const selectedProjectId = searchParams.get("projectId") ?? "";
  const { data: projects = [], isLoading: projectsLoading } = useQuery({
    queryKey: ["admin", "calculation-projects"],
    queryFn: () => listProjects(),
  });
  const projectId =
    projects.some((project) => project.id === selectedProjectId)
      ? selectedProjectId
      : projects[0]?.id ?? "";

  const { data: projectData, isLoading: dataLoading } = useQuery({
    queryKey: ["admin", "calculation-data", projectId],
    queryFn: () => getProjectData(projectId),
    enabled: Boolean(projectId),
  });
  const { data: calculationSummary, isLoading: summaryLoading } = useQuery({
    queryKey: ["admin", "calculation-summary", projectId],
    queryFn: () => getProjectCalculationSummary(projectId),
    enabled: Boolean(projectId),
  });
  const { data: ctrCurves } = useQuery({
    queryKey: ["admin", "calculation-ctr", projectId],
    queryFn: () => getProjectCtrCurves(projectId),
    enabled: Boolean(projectId),
  });
  const { data: latestPipeline } = useQuery({
    queryKey: ["admin", "calculation-pipeline", projectId],
    queryFn: () => getLatestProjectPipelineRun(projectId),
    enabled: Boolean(projectId),
    refetchInterval: (query) => {
      const value = query.state.data as
        | { run: PipelineRun | null }
        | undefined;
      return value?.run?.status === "pending" ||
        value?.run?.status === "running"
        ? 1_000
        : false;
    },
  });

  const selectedProject = projects.find((project) => project.id === projectId);
  const latestRun = latestPipeline?.run ?? null;
  const failedStage = latestRun?.stages.find(
    (stage) => stage.state === "failed",
  );
  const calculations = projectData?.calculationCounts;
  const totalCalculationRows = calculations
    ? Object.values(calculations).reduce((total, value) => total + value, 0)
    : 0;
  const observedCtrPoints = useMemo(
    () =>
      (ctrCurves?.curves ?? [])
        .flatMap((curve) => curve.points)
        .filter((point) => point.source === "gsc").length,
    [ctrCurves?.curves],
  );

  if (!canManageUsers) return <Navigate to="/clients" replace />;

  const chooseProject = (value: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("projectId", value);
    setSearchParams(next, { replace: true });
  };

  const refreshQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["admin", "calculation-data", projectId],
      }),
      queryClient.invalidateQueries({
        queryKey: ["admin", "calculation-summary", projectId],
      }),
      queryClient.invalidateQueries({
        queryKey: ["admin", "calculation-ctr", projectId],
      }),
      queryClient.invalidateQueries({
        queryKey: ["admin", "calculation-pipeline", projectId],
      }),
      queryClient.invalidateQueries({
        queryKey: ["admin", "calculation-inspector", projectId],
      }),
      queryClient.invalidateQueries({
        queryKey: ["admin", "link-power-inspector", projectId],
      }),
    ]);
  };

  const runPipeline = async () => {
    if (!projectId) return;
    setRunning(true);
    try {
      const created = await startProjectPipeline(projectId);
      const deadline = Date.now() + 15 * 60_000;
      let terminal: PipelineRun | null = null;
      while (Date.now() < deadline) {
        const run = await getPipelineRun(created.id);
        if (run.status === "succeeded" || run.status === "failed") {
          terminal = run;
          break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      }
      if (!terminal) {
        throw new Error("Pipeline did not finish before the timeout.");
      }
      if (terminal.status === "failed") {
        const stage = terminal.stages.find(
          (candidate) => candidate.state === "failed",
        );
        throw new Error(
          stage
            ? `${stage.id} failed after ${stage.attempts} attempts.`
            : "Pipeline failed.",
        );
      }
      await refreshQueries();
      toast.success("All calculation stages completed");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Calculation run failed",
      );
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="type-eyebrow text-signal">Operations</div>
          <h1 className="mt-1 text-3xl font-semibold text-ink">
            Calculation control room
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-muted">
            One view of the canonical 19-stage pipeline, persisted outputs and
            model health. Every count below comes from the target GCP contract.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={projectId}
            onValueChange={chooseProject}
            disabled={projectsLoading || projects.length === 0}
          >
            <SelectTrigger className="w-[300px] bg-surface">
              <SelectValue placeholder="Select a project" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.project_name}
                  {project.client_name ? ` · ${project.client_name}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="signal"
            onClick={runPipeline}
            disabled={!projectId || running}
          >
            <RefreshCw
              className={`h-4 w-4 ${running ? "animate-spin" : ""}`}
            />
            {running ? "Running all stages…" : "Run all calculations"}
          </Button>
        </div>
      </header>

      {!projectsLoading && projects.length === 0 && (
        <Alert>
          <TriangleAlert className="h-4 w-4" />
          <AlertTitle>No projects available</AlertTitle>
          <AlertDescription>
            Create a client project before running calculations.
          </AlertDescription>
        </Alert>
      )}

      {failedStage && (
        <Alert variant="destructive">
          <TriangleAlert className="h-4 w-4" />
          <AlertTitle>Latest pipeline failed at {failedStage.id}</AlertTitle>
          <AlertDescription>
            The stage exhausted {failedStage.attempts} attempts. Upstream
            outputs remain persisted and the next run will resume safely.
          </AlertDescription>
        </Alert>
      )}

      {projectId && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <Metric
              icon={Database}
              label="Persisted outputs"
              loading={dataLoading}
              value={totalCalculationRows.toLocaleString()}
              hint="Across calculation tables"
            />
            <Metric
              icon={Activity}
              label="Revenue forecasts"
              loading={dataLoading}
              value={(calculations?.revenueForecasts ?? 0).toLocaleString()}
              hint="All scenarios"
            />
            <Metric
              icon={Gauge}
              label="HAR forecasts"
              loading={dataLoading}
              value={(calculations?.harForecasts ?? 0).toLocaleString()}
              hint="Attainable-rank model"
            />
            <Metric
              icon={ShieldCheck}
              label="CTR observations"
              loading={summaryLoading}
              value={observedCtrPoints.toLocaleString()}
              hint={`${ctrCurves?.curves.length ?? 0} curves`}
            />
            <Metric
              icon={CheckCircle2}
              label="Calibration"
              loading={summaryLoading}
              value={
                calculationSummary?.calibration?.status
                  ? calculationSummary.calibration.status.replace(/_/g, " ")
                  : "—"
              }
              hint={
                calculationSummary?.calibration
                  ? `${calculationSummary.calibration.matched} matched pairs`
                  : "No completed snapshot"
              }
            />
          </div>

          <div className="grid gap-5 xl:grid-cols-[1.45fr_0.85fr]">
            <Card className="border-hairline shadow-card">
              <CardHeader className="flex-row items-start justify-between gap-3">
                <div>
                  <div className="type-eyebrow text-ink-muted">
                    Pipeline execution
                  </div>
                  <CardTitle className="mt-1 text-lg">
                    Ordered stage ledger
                  </CardTitle>
                </div>
                <div className="text-right text-xs text-ink-muted">
                  <Badge
                    variant={
                      latestRun?.status === "succeeded"
                        ? "default"
                        : latestRun?.status === "failed"
                          ? "destructive"
                          : "outline"
                    }
                  >
                    {latestRun?.status ?? "not run"}
                  </Badge>
                  <div className="mt-1">
                    {dateTime(latestRun?.completedAt)}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {!latestRun ? (
                  <div className="rounded-lg border border-dashed border-hairline p-8 text-center text-sm text-ink-muted">
                    This project has no pipeline run yet.
                  </div>
                ) : (
                  <div className="max-h-[560px] overflow-auto rounded-lg border border-hairline">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-12">#</TableHead>
                          <TableHead>Stage</TableHead>
                          <TableHead>Execution</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead className="text-right">
                            Attempts
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {latestRun.stages.map((stage, index) => (
                          <TableRow key={stage.id}>
                            <TableCell className="font-mono text-xs text-ink-muted">
                              {String(index + 1).padStart(2, "0")}
                            </TableCell>
                            <TableCell className="font-medium">
                              {stage.id}
                            </TableCell>
                            <TableCell className="text-xs uppercase tracking-wide text-ink-muted">
                              {stage.execution}
                            </TableCell>
                            <TableCell>
                              <Badge variant={stageVariant(stage.state)}>
                                {stage.state}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-right font-mono tabular-nums">
                              {stage.attempts}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>

            <div className="space-y-5">
              <Card className="border-hairline shadow-card">
                <CardHeader>
                  <div className="type-eyebrow text-ink-muted">
                    Current project
                  </div>
                  <CardTitle className="text-lg">
                    {selectedProject?.project_name ?? "Project"}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <Fact
                    label="Keywords"
                    value={`${projectData?.keywordCount ?? 0}`}
                  />
                  <Fact
                    label="GSC observations"
                    value={`${projectData?.gscRowCount ?? 0}`}
                  />
                  <Fact
                    label="SERP results"
                    value={`${projectData?.serpResultCount ?? 0}`}
                  />
                  <Fact
                    label="Site architecture rows"
                    value={`${calculations?.siteArchitecture ?? 0}`}
                  />
                  <Fact
                    label="Link power scores"
                    value={`${calculations?.linkPowerScores ?? 0}`}
                  />
                  <Fact
                    label="Demand signals"
                    value={`${calculations?.demandSignals ?? 0}`}
                  />
                </CardContent>
              </Card>

              <Card className="border-hairline shadow-card">
                <CardHeader>
                  <div className="type-eyebrow text-ink-muted">
                    Model totals
                  </div>
                  <CardTitle className="text-lg">
                    Realistic scenario
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <Fact
                    label="Expected uplift"
                    value={money(
                      calculationSummary?.revenue.find(
                        (row) => row.scenario === "realistic",
                      )?.expectedIncremental,
                    )}
                  />
                  <Fact
                    label="Target uplift"
                    value={money(
                      calculationSummary?.revenue.find(
                        (row) => row.scenario === "realistic",
                      )?.targetIncremental,
                    )}
                  />
                  <Fact
                    label="Top opportunities"
                    value={`${calculationSummary?.opportunities.length ?? 0}`}
                  />
                  <Fact
                    label="Completed"
                    value={dateTime(calculationSummary?.completedAt)}
                  />
                </CardContent>
              </Card>
            </div>
          </div>

          <Card className="border-hairline shadow-card">
            <CardHeader>
              <div className="type-eyebrow text-ink-muted">Source evidence</div>
              <CardTitle className="text-lg">
                Import Search Console data
              </CardTitle>
              <p className="text-sm leading-6 text-ink-muted">
                A validated upload marks the project dirty. Run all
                calculations afterwards to rebuild CTR, demand, HAR, revenue
                and calibration in sequence.
              </p>
            </CardHeader>
            <CardContent>
              <GscUploadPanel projectId={projectId} />
            </CardContent>
          </Card>

          <CalculationInspectors
            projectId={projectId}
            summary={calculationSummary}
          />

          <Card className="border-hairline shadow-card">
            <CardHeader>
              <div className="type-eyebrow text-ink-muted">
                Highest expected impact
              </div>
              <CardTitle className="text-lg">
                Forecast opportunity sample
              </CardTitle>
            </CardHeader>
            <CardContent>
              {(calculationSummary?.opportunities.length ?? 0) === 0 ? (
                <div className="flex items-center gap-2 rounded-lg border border-dashed border-hairline p-6 text-sm text-ink-muted">
                  <CircleDashed className="h-4 w-4" />
                  No forecast opportunity is available yet.
                </div>
              ) : (
                <div className="overflow-auto rounded-lg border border-hairline">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Keyword</TableHead>
                        <TableHead className="text-right">
                          Current rank
                        </TableHead>
                        <TableHead className="text-right">
                          Attainable rank
                        </TableHead>
                        <TableHead className="text-right">
                          Probability
                        </TableHead>
                        <TableHead className="text-right">
                          Expected uplift
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {calculationSummary?.opportunities
                        .slice(0, 20)
                        .map((row) => (
                          <TableRow key={row.keywordId}>
                            <TableCell className="font-medium">
                              {row.keyword}
                            </TableCell>
                            <TableCell className="text-right font-mono">
                              {row.baseRank ?? "—"}
                            </TableCell>
                            <TableCell className="text-right font-mono">
                              {row.harPosition ?? "—"}
                            </TableCell>
                            <TableCell className="text-right font-mono">
                              {row.rankAttainmentProbability == null
                                ? "—"
                                : `${Math.round(
                                    row.rankAttainmentProbability * 100,
                                  )}%`}
                            </TableCell>
                            <TableCell className="text-right font-mono">
                              {money(row.expectedIncremental)}
                            </TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Metric({
  hint,
  icon: Icon,
  label,
  loading,
  value,
}: {
  hint: string;
  icon: typeof Database;
  label: string;
  loading: boolean;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-hairline bg-surface p-4 shadow-card">
      <div className="flex items-center gap-2 text-ink-muted">
        <Icon className="h-3.5 w-3.5" />
        <span className="type-eyebrow">{label}</span>
      </div>
      <div className="mt-2 font-mono text-xl font-semibold capitalize tabular-nums text-ink">
        {loading ? "…" : value}
      </div>
      <p className="mt-1 text-[11px] text-ink-muted">{hint}</p>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-hairline pb-2 last:border-0 last:pb-0">
      <span className="text-ink-muted">{label}</span>
      <span className="text-right font-mono tabular-nums text-ink">{value}</span>
    </div>
  );
}
