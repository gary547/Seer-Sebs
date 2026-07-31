import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { AlertTriangle, RefreshCw, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useProjectNextAction } from "@/hooks/useProjectNextAction";
import { useRecomputeForecasts } from "@/hooks/useRecomputeForecasts";
import { listAllProjectForecastRows } from "@/integrations/gcp/calculations";

interface Props {
  clientId: string;
  projectId: string;
}

interface ForecastHealth {
  total: number;
  withHar: number;
  withTpRevenue: number;
}

/**
 * Above-the-fold recovery card for the Forecast tab. Renders `null` when the
 * project is healthy — so it only shows up when a user needs to act. Mirrors
 * the >34% stale heuristic already used by HarAnalysisSection's self-heal.
 */
export default function ForecastTabHeader({ clientId, projectId }: Props) {
  const nextAction = useProjectNextAction(clientId, projectId);
  const { recompute, isRecomputing } = useRecomputeForecasts(projectId);

  // I3 — live-region state for SR announcements on recompute transitions.
  const [announcement, setAnnouncement] = useState("");
  const wasRecomputing = useRef(false);

  // Announce the start of a recompute as soon as isRecomputing flips on.
  // Terminal (success/failure) announcements are emitted directly from
  // handleRecompute so we can attach the actual error message reliably.
  useEffect(() => {
    if (isRecomputing && !wasRecomputing.current) {
      setAnnouncement("Recomputing forecast");
    }
    wasRecomputing.current = isRecomputing;
  }, [isRecomputing]);

  const handleRecompute = async () => {
    const result = await recompute(false);
    if (result.ok) {
      setAnnouncement("Forecast recomputed");
    } else {
      setAnnouncement(`Recompute failed: ${result.error ?? "Unknown error"}`);
    }
  };

  const { data: health } = useQuery({
    queryKey: ["forecast_health", projectId],
    enabled: !!projectId,
    refetchInterval: 30000,
    queryFn: async (): Promise<ForecastHealth> => {
      const rows = await listAllProjectForecastRows(projectId);
      return {
        total: rows.length,
        withHar: rows.filter((row) => row.harPosition != null).length,
        withTpRevenue: rows.filter(
          (row) =>
            row.harPosition != null &&
            (row.expectedIncrementalAnnual ?? 0) > 0,
        ).length,
      };
    },
  });

  const liveRegion = (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {announcement}
    </div>
  );

  // Detox blocked → highest-priority recovery card.
  if (nextAction?.state === "blocked") {
    return (
      <>
        {liveRegion}
        <Card tone="warn">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-4 w-4 text-warn mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-semibold text-ink">
                Detox job blocked
              </p>
              <p className="text-[12px] text-ink-muted mt-0.5">
                {nextAction.reason}
              </p>
            </div>
            <Button asChild size="sm" variant="outline">
              <Link to={nextAction.to}>
                Open Setup <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          </div>
        </Card>
      </>
    );
  }

  if (!health) return liveRegion;

  // Stale: forecasts exist but most rows with a HAR have zero TP revenue.
  const looksStale =
    health.withHar >= 2 && health.withTpRevenue / health.withHar < 0.34;

  // Empty: no forecast rows at all (or none carry a HAR).
  const isEmpty = health.total === 0 || health.withHar === 0;

  if (!looksStale && !isEmpty) return liveRegion;

  return (
    <>
      {liveRegion}
      <Card tone={looksStale ? "warn" : "default"}>
        <div className="flex items-start gap-3">
          {looksStale && (
            <AlertTriangle className="h-4 w-4 text-warn mt-0.5" />
          )}
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-semibold text-ink">
              {looksStale ? "Forecast data looks stale" : "No forecast yet"}
            </p>
            <p className="text-[12px] text-ink-muted mt-0.5">
              {looksStale
                ? "Most TP positions are missing revenue numbers. Recompute to refresh the table below."
                : "Run a recompute to generate TP Revenue from the latest HAR positions, CTR curves, AOV and conversion rate."}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={handleRecompute}
            disabled={isRecomputing}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${isRecomputing ? "animate-spin" : ""}`}
            />
            {isRecomputing ? "Recomputing…" : "Recompute TP Revenue"}
          </Button>
        </div>
      </Card>
    </>
  );
}

function Card({
  tone,
  children,
}: {
  tone: "default" | "warn";
  children: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-xl border p-4 shadow-card ${
        tone === "warn"
          ? "border-warn/30 bg-warn/5"
          : "border-hairline bg-surface"
      }`}
    >
      {children}
    </div>
  );
}
