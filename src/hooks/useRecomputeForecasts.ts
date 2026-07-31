import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getPipelineRun,
  startProjectPipeline,
} from "@/integrations/gcp/pipeline";

/**
 * Shared trigger for the `compute-forecasts` edge function. Used by both
 * HarAnalysisSection (auto-heal + manual button) and ForecastTabHeader
 * (above-the-fold recovery card) so the two surfaces never race each other.
 */
export function useRecomputeForecasts(projectId: string | undefined) {
  const queryClient = useQueryClient();
  const [isRecomputing, setIsRecomputing] = useState(false);

  const recompute = useCallback(
    async (silent = false): Promise<{ ok: boolean; error?: string }> => {
      if (!projectId) return { ok: false, error: "Missing project id" };
      setIsRecomputing(true);
      try {
        const created = await startProjectPipeline(projectId);
        const deadline = Date.now() + 15 * 60_000;
        let completed = false;
        while (Date.now() < deadline) {
          const run = await getPipelineRun(created.id);
          if (run.status === "succeeded") {
            completed = true;
            break;
          }
          if (run.status === "failed") {
            const failed = run.stages.find((stage) => stage.state === "failed");
            throw new Error(
              failed
                ? `${failed.id} failed after ${failed.attempts} attempts`
                : "The project pipeline failed.",
            );
          }
          await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        }
        if (!completed) {
          throw new Error("The project pipeline did not finish before the timeout.");
        }
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["tp_revenue_by_keyword", projectId] }),
          queryClient.invalidateQueries({ queryKey: ["performance_dashboard", projectId] }),
          queryClient.invalidateQueries({ queryKey: ["keyword_forecasts", projectId] }),
          queryClient.invalidateQueries({ queryKey: ["project-overview-stats-v2", projectId] }),
          queryClient.invalidateQueries({ queryKey: ["project_has_forecasts", projectId] }),
          queryClient.invalidateQueries({ queryKey: ["project-data", projectId] }),
          queryClient.invalidateQueries({ queryKey: ["project_calculations", projectId] }),
          queryClient.invalidateQueries({ queryKey: ["forecast_rows", projectId] }),
        ]);
        if (!silent) toast.success("TP revenue recalculated");
        return { ok: true };
      } catch (err: any) {
        const message = err?.message || "Recompute failed";
        if (!silent) toast.error(message);
        console.warn("compute-forecasts invoke failed", err);
        return { ok: false, error: message };
      } finally {
        setIsRecomputing(false);
      }
    },
    [projectId, queryClient],
  );

  return { recompute, isRecomputing };
}
