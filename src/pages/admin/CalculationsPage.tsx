import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  Calculator,
  ExternalLink,
  TriangleAlert,
} from "lucide-react";
import { Link, Navigate, useSearchParams } from "react-router";
import { toast } from "sonner";

import CalculationControlPanels from "@/components/admin/CalculationControlPanels";
import AutonomousPipelinePanel from "@/components/admin/AutonomousPipelinePanel";
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
  getProjectPipelineReadiness,
  markProjectKeywordsPrecurated,
  resolvePipelineFailure,
  startProjectPipeline,
  updateProjectPipelinePolicy,
  type PipelineRun,
  type PipelineReadiness,
} from "@/integrations/gcp/pipeline";
import {
  listProjects,
  updateClientBrandTerms,
} from "@/integrations/gcp/tenancy";

function dateTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString("en-GB") : "—";
}

export default function CalculationsPage() {
  const { canManageUsers } = useAuth();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [showArchived, setShowArchived] = useState(false);
  const [running, setRunning] = useState(false);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [savingBrandTerms, setSavingBrandTerms] = useState(false);
  const [stampingPrecurated, setStampingPrecurated] = useState(false);
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
        ? 5_000
        : false;
    },
  });
  const readiness = useQuery({
    queryKey: ["admin", "pipeline-readiness", projectId],
    queryFn: () => getProjectPipelineReadiness(projectId),
    enabled: Boolean(projectId) && !archived,
  });

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
      queryClient.invalidateQueries({ queryKey: ["admin", "pipeline-readiness", projectId] }),
      queryClient.invalidateQueries({ queryKey: ["admin", "calculation-inspector", projectId] }),
      queryClient.invalidateQueries({ queryKey: ["admin", "link-power-inspector", projectId] }),
    ]);
  };

  const terminalRunId =
    latestPipeline.data?.run?.status === "succeeded" ||
    latestPipeline.data?.run?.status === "failed"
      ? latestPipeline.data.run.id
      : null;

  useEffect(() => {
    if (!terminalRunId || !projectId) return;
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin", "calculation-control", projectId] }),
      queryClient.invalidateQueries({ queryKey: ["admin", "calculation-summary", projectId] }),
      queryClient.invalidateQueries({ queryKey: ["admin", "calculation-ctr", projectId] }),
      queryClient.invalidateQueries({ queryKey: ["admin", "pipeline-readiness", projectId] }),
      queryClient.invalidateQueries({ queryKey: ["admin", "calculation-inspector", projectId] }),
      queryClient.invalidateQueries({ queryKey: ["admin", "link-power-inspector", projectId] }),
    ]);
  }, [projectId, queryClient, terminalRunId]);

  if (!canManageUsers) return <Navigate to="/clients" replace />;

  const runPipeline = async (mode: "full" | "recalculate" | "resume") => {
    if (!projectId || archived || running) return;
    setRunning(true);
    try {
      await startProjectPipeline(projectId, mode);
      await refreshQueries();
      toast.success(
        mode === "recalculate"
          ? "Forecast recalculation started"
          : mode === "resume"
            ? "Pipeline resume started"
            : "Full autonomous pipeline started",
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Calculation run failed");
    } finally {
      setRunning(false);
    }
  };

  const savePolicy = async (policy: PipelineReadiness["policy"]) => {
    if (!projectId || archived || savingPolicy) return;
    setSavingPolicy(true);
    try {
      await updateProjectPipelinePolicy(projectId, policy);
      await refreshQueries();
      toast.success("Pipeline policy saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Policy update failed");
    } finally {
      setSavingPolicy(false);
    }
  };

  const stampPrecurated = async () => {
    if (!projectId || archived || stampingPrecurated) return;
    setStampingPrecurated(true);
    try {
      const result = await markProjectKeywordsPrecurated(projectId);
      await refreshQueries();
      toast.success(`${result.stampedKeywordCount} manual keywords marked as pre-curated`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Pre-curated action failed");
    } finally {
      setStampingPrecurated(false);
    }
  };

  const saveBrandTerms = async (brandTerms: string[]) => {
    if (!selectedProject?.client_id || archived || savingBrandTerms) return;
    setSavingBrandTerms(true);
    try {
      await updateClientBrandTerms(selectedProject.client_id, brandTerms);
      await refreshQueries();
      toast.success("Brand terms saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Brand terms update failed");
    } finally {
      setSavingBrandTerms(false);
    }
  };

  const latestRun = latestPipeline.data?.run ?? null;
  const pipelineFailure = latestRun ? resolvePipelineFailure(latestRun) : null;
  const failedStage = pipelineFailure
    ? latestRun?.stages.find((stage) => stage.id === pipelineFailure.stageId) ??
      latestRun?.stages.find((stage) => stage.state === "failed")
    : null;

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
            <span>
              Latest completion {dateTime(latestRun?.completedAt)}
            </span>
            <span className="font-mono">
              {latestRun?.id.slice(0, 8) ?? "—"}
            </span>
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
          <AlertDescription>
            {pipelineFailure?.message ??
              `The stage exhausted ${failedStage.attempts} attempts. The next run can resume safely.`}
          </AlertDescription>
        </Alert>
      )}

      {control.isError && (
        <Alert variant="destructive">
          <TriangleAlert className="h-4 w-4" />
          <AlertTitle>Calculation data could not be loaded</AlertTitle>
          <AlertDescription>{control.error instanceof Error ? control.error.message : "Unknown API error"}</AlertDescription>
        </Alert>
      )}

      {projectId && !archived && (
        <AutonomousPipelinePanel
          archived={archived}
          onSaveBrandTerms={saveBrandTerms}
          onRun={runPipeline}
          onSavePolicy={savePolicy}
          onStampPrecurated={stampPrecurated}
          readiness={readiness.data}
          run={latestRun}
          running={running}
          savingPolicy={savingPolicy}
          savingBrandTerms={savingBrandTerms}
          stampingPrecurated={stampingPrecurated}
        />
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
          onRun={(source) =>
            runPipeline(source.toLowerCase().includes("revenue") ? "recalculate" : "full")
          }
          projectId={projectId}
          running={running}
          summary={summary.data}
        />
      )}
    </div>
  );
}
