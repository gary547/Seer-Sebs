import { useQuery } from "@tanstack/react-query";
import { getProjectData } from "@/integrations/gcp/project-data";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Circle, Play, Loader2, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  projectId: string;
  /** Number of kept keywords (passed in from parent so we don't double-fetch) */
  keptKeywordsCount: number;
  /** True while the pipeline is mid-run — CTA disables to prevent double-click */
  running: boolean;
  /** Switch the parent's active step into the CTR Curves tab */
  onConfigureCtr: () => void;
  /** Trigger the shared sync pipeline */
  onBuild: () => void;
}

/**
 * First-run setup card shown on the Keywords tab of brand-new projects
 * (gated upstream on `last_synced_at IS NULL`). Communicates the two
 * pre-requisites to a successful first forecast: keywords loaded, CTR curve
 * configured. The CTA fires the *same* sync pipeline the header button uses,
 * so there is zero divergence between entry points.
 */
export default function KeywordSetupCard({
  projectId,
  keptKeywordsCount,
  running,
  onConfigureCtr,
  onBuild,
}: Props) {
  const { data: projectData } = useQuery({
    queryKey: ["project-data", projectId],
    queryFn: () => getProjectData(projectId),
    enabled: !!projectId,
  });
  const ctrCurveCount = projectData?.calculationCounts.ctrCurves ?? 0;
  const totalKeywordsCount = projectData?.keywordCount ?? 0;

  const hasKeywords = totalKeywordsCount > 0;
  const hasCtr = ctrCurveCount > 0;
  const canBuild = hasKeywords && !running;

  const Step = ({
    n,
    title,
    done,
    detail,
    action,
  }: {
    n: number;
    title: string;
    done: boolean;
    detail: string;
    action?: React.ReactNode;
  }) => (
    <div className="flex items-start gap-3">
      <div
        className={cn(
          "mt-0.5 flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold shrink-0",
          done
            ? "bg-accent text-accent-foreground"
            : "bg-muted text-muted-foreground border border-border"
        )}
      >
        {done ? <CheckCircle2 className="h-3.5 w-3.5" /> : n}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-sm font-medium text-foreground">{title}</p>
          {done ? (
            <span className="text-[11px] text-accent font-medium">{detail}</span>
          ) : (
            <span className="text-[11px] text-muted-foreground">{detail}</span>
          )}
        </div>
        {action && <div className="mt-1.5">{action}</div>}
      </div>
    </div>
  );

  return (
    <Card className="p-5 border-primary/30 bg-gradient-to-br from-primary/5 via-background to-background shadow-sm">
      <div className="flex items-center gap-2 mb-1">
        <h3 className="text-base font-semibold">Set up your forecast</h3>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Two quick steps and we'll build the full forecast for this project.
      </p>

      <div className="space-y-4">
        <Step
          n={1}
          title="Add your keywords"
          done={hasKeywords}
          detail={
            hasKeywords
              ? `${totalKeywordsCount} added${keptKeywordsCount > 0 ? ` · ${keptKeywordsCount} kept` : ""}`
              : "Paste below — optionally with priority + your own categories"
          }
        />

        <Step
          n={2}
          title="Choose a CTR curve"
          done={hasCtr}
          detail={
            hasCtr
              ? `${ctrCurveCount} row${ctrCurveCount === 1 ? "" : "s"} saved`
              : "Optional — use the standard preset, or copy from another project under this client"
          }
          action={
            !hasCtr ? (
              <Button variant="outline" size="sm" onClick={onConfigureCtr} className="gap-1.5 h-7 text-xs">
                <Settings2 className="h-3.5 w-3.5" />
                Customise CTR curve
              </Button>
            ) : null
          }
        />
      </div>

      <div className="mt-5 pt-4 border-t border-border flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <p className="text-[11px] text-muted-foreground">Takes about 5–10 minutes.</p>
        <Button
          onClick={onBuild}
          disabled={!canBuild}
          size="sm"
          className="gap-1.5"
          title={
            !hasKeywords
              ? "Add keywords below to enable build"
              : "Run the full pipeline (⌘/Ctrl + S)"
          }
        >
          {running ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Building…
            </>
          ) : (
            <>
              <Play className="h-4 w-4" />
              Build my forecast
            </>
          )}
        </Button>
      </div>

      {!hasKeywords && (
        <p className="mt-3 text-[11px] text-muted-foreground">
          <Circle className="inline h-2.5 w-2.5 mr-1 text-warning" />
          Paste keywords in the panel below first.
        </p>
      )}
    </Card>
  );
}
