import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { startProjectPipeline } from "@/integrations/gcp/pipeline";

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
        await startProjectPipeline(projectId, "recalculate");
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["tp_revenue_by_keyword", projectId] }),
          queryClient.invalidateQueries({ queryKey: ["performance_dashboard", projectId] }),
          queryClient.invalidateQueries({ queryKey: ["keyword_forecasts", projectId] }),
          queryClient.invalidateQueries({ queryKey: ["project-overview-stats-v2", projectId] }),
          queryClient.invalidateQueries({ queryKey: ["project_has_forecasts", projectId] }),
          queryClient.invalidateQueries({ queryKey: ["project-data", projectId] }),
          queryClient.invalidateQueries({ queryKey: ["project_calculations", projectId] }),
          queryClient.invalidateQueries({ queryKey: ["forecast_rows", projectId] }),
          queryClient.invalidateQueries({ queryKey: ["project-pipeline", projectId] }),
        ]);
        if (!silent) toast.success("Forecast recalculation started");
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
