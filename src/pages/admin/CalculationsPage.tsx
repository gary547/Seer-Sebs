import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  Calculator,
  ExternalLink,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { Link, Navigate, useSearchParams } from "react-router";
import { toast } from "sonner";

import CalculationControlPanels from "@/components/admin/CalculationControlPanels";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/contexts/AuthContext";
import { getProjectCalculationControl } from "@/integrations/gcp/calculation-control";
import {
  getProjectCalculationSummary,
  getProjectCtrCurves,
} from "@/integrations/gcp/calculations";
import {
  getLatestProjectPipelineRun,
  getPipelineRun,
  startProjectPipeline,
  type PipelineRun,
} from "@/integrations/gcp/pipeline";
import { listProjects } from "@/integrations/gcp/tenancy";

function dateTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString("en-GB") : "—";
}

export default function CalculationsPage() {
  const { canManageUsers } = useAuth();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [showArchived, setShowArchived] = useState(false);
  const [running, setRunning] = useState(false);
  const selectedProjectId = searchParams.get("projectId") ?? "";

  const projects = useQuery({
    queryKey: ["admin", "calculation-projects", showArchived],
    queryFn: () => listProjects(undefined, showArchived),
  });
  const projectId = projects.data?.some((project) => project.id === selectedProjectId)
    ? selectedProjectId
    : projects.data?.[0]?.id ?? "";
  const selectedProject = projects.data?.find((project) => project.id === projectId);
  const archived = Boolean(selectedProject?.archived_at || selectedProject?.client_archived_at);

  const control = useQuery({
    queryKey: ["admin", "calculation-control", projectId],
    queryFn: () => getProjectCalculationControl(projectId),
    enabled: Boolean(projectId),
  });
  const summary = useQuery({
    queryKey: ["admin", "calculation-summary", projectId],
    queryFn: () => getProjectCalculationSummary(projectId),
    enabled: Boolean(projectId) && !archived,
  });
  const ctrCurves = useQuery({
    queryKey: ["admin", "calculation-ctr", projectId],
    queryFn: () => getProjectCtrCurves(projectId),
    enabled: Boolean(projectId) && !archived,
  });
  const latestPipeline = useQuery({
    queryKey: ["admin", "calculation-pipeline", projectId],
    queryFn: () => getLatestProjectPipelineRun(projectId),
    enabled: Boolean(projectId) && !archived,
    refetchInterval: (query) => {
      const value = query.state.data as { run: PipelineRun | null } | undefined;
      return value?.run?.status === "pending" || value?.run?.status === "running"
        ? 1_000
        : false;
    },
  });

  if (!canManageUsers) return <Navigate to="/clients" replace />;

  const chooseProject = (value: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("projectId", value);
    setSearchParams(next, { replace: true });
  };

  const refreshQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin", "calculation-control", projectId] }),
      queryClient.invalidateQueries({ queryKey: ["admin", "calculation-summary", projectId] }),
      queryClient.invalidateQueries({ queryKey: ["admin", "calculation-ctr", projectId] }),
      queryClient.invalidateQueries({ queryKey: ["admin", "calculation-pipeline", projectId] }),
      queryClient.invalidateQueries({ queryKey: ["admin", "calculation-inspector", projectId] }),
      queryClient.invalidateQueries({ queryKey: ["admin", "link-power-inspector", projectId] }),
    ]);
  };

  const runPipeline = async (source: string) => {
    if (!projectId || archived || running) return;
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
      if (!terminal) throw new Error("Pipeline did not finish before the timeout.");
      if (terminal.status === "failed") {
        const failed = terminal.stages.find((stage) => stage.state === "failed");
        throw new Error(failed ? `${failed.id} failed after ${failed.attempts} attempts.` : "Pipeline failed.");
      }
      await refreshQueries();
      toast.success(`${source} completed through the canonical pipeline`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Calculation run failed");
    } finally {
      setRunning(false);
    }
  };

  const latestRun = latestPipeline.data?.run ?? null;
  const failedStage = latestRun?.stages.find((stage) => stage.state === "failed");

  return (
    <div className="mx-auto max-w-[1380px] space-y-5 pb-12">
      <header className="rounded-xl border border-hairline bg-surface px-5 py-5 shadow-card lg:px-6">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="flex items-start gap-3">
            <div className="mt-1 rounded-lg border border-hairline bg-canvas p-2 text-signal">
              <Calculator className="h-4 w-4" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-ink">
                Calculation Runs (v2)
              </h1>
              <p className="mt-1 max-w-xl text-sm leading-6 text-ink-muted">
                Inspect calculation inputs, model outputs and recent runs. GCP executes each action through one dependency-safe pipeline.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <label className="mr-2 flex items-center gap-2 text-xs text-ink-muted">
              <Switch checked={showArchived} onCheckedChange={setShowArchived} />
              Show archived
            </label>
            <Select
              value={projectId}
              onValueChange={chooseProject}
              disabled={projects.isLoading || !projects.data?.length}
            >
              <SelectTrigger className="w-[280px] bg-surface">
                <SelectValue placeholder="Select project" />
              </SelectTrigger>
              <SelectContent>
                {projects.data?.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.project_name}
                    {project.client_name ? ` · ${project.client_name}` : ""}
                    {project.archived_at ? " · archived" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="signal" disabled={!projectId || archived || running} onClick={() => void runPipeline("HAR v2 + Revenue v2")}>
              <RefreshCw className={`h-4 w-4 ${running ? "animate-spin" : ""}`} />
              {running ? "Running…" : "Run HAR v2 + Revenue v2"}
            </Button>
            <Button variant="outline" disabled={!projectId || archived || running} onClick={() => void runPipeline("HAR v2 composite")}>
              Run HAR v2 (composite)
            </Button>
            <Button variant="outline" disabled={!projectId || archived || running || !control.data?.latestSuccessfulRun} onClick={() => void runPipeline("Revenue v2")}>
              Run Revenue v2
            </Button>
            {projectId && !archived && (
              <Button variant="outline" asChild>
                <Link to={`/admin/projects/${projectId}/conversion-overrides`}>
                  Conversion overrides
                  <ExternalLink className="h-3.5 w-3.5" />
                </Link>
              </Button>
            )}
          </div>
        </div>

        {projectId && (
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-hairline pt-4 text-xs text-ink-muted">
            <span className="font-medium text-ink">{selectedProject?.project_name}</span>
            {archived ? (
              <Badge variant="outline"><Archive className="mr-1 h-3 w-3" />Read-only archive</Badge>
            ) : (
              <Badge variant={latestRun?.status === "succeeded" ? "default" : latestRun?.status === "failed" ? "destructive" : "outline"}>
                {latestRun?.status ?? "not run"}
              </Badge>
            )}
            <span>Latest completion {dateTime(control.data?.latestSuccessfulRun?.completedAt)}</span>
            <span className="font-mono">{control.data?.latestSuccessfulRun?.id.slice(0, 8) ?? "—"}</span>
          </div>
        )}
      </header>

      {!projects.isLoading && projects.data?.length === 0 && (
        <Alert>
          <TriangleAlert className="h-4 w-4" />
          <AlertTitle>No projects available</AlertTitle>
          <AlertDescription>Create a client project before running calculations.</AlertDescription>
        </Alert>
      )}

      {failedStage && (
        <Alert variant="destructive">
          <TriangleAlert className="h-4 w-4" />
          <AlertTitle>Latest pipeline failed at {failedStage.id}</AlertTitle>
          <AlertDescription>The stage exhausted {failedStage.attempts} attempts. The next run can resume safely.</AlertDescription>
        </Alert>
      )}

      {control.isError && (
        <Alert variant="destructive">
          <TriangleAlert className="h-4 w-4" />
          <AlertTitle>Calculation data could not be loaded</AlertTitle>
          <AlertDescription>{control.error instanceof Error ? control.error.message : "Unknown API error"}</AlertDescription>
        </Alert>
      )}

      {projectId && control.isLoading && (
        <div className="space-y-3" aria-label="Loading calculation controls">
          {Array.from({ length: 8 }, (_, index) => <div key={index} className="h-[72px] animate-pulse rounded-xl border border-hairline bg-surface" />)}
        </div>
      )}

      {control.data && (
        <CalculationControlPanels
          control={control.data}
          ctrCurves={ctrCurves.data}
          onRun={runPipeline}
          projectId={projectId}
          running={running}
          summary={summary.data}
        />
      )}
    </div>
  );
}
