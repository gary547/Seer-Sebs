import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronUp, RefreshCw, AlertCircle, CheckCircle2, Loader2, Clock, Calendar } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBackgroundJobs, type BackgroundJob, type JobState } from "@/hooks/useBackgroundJobs";

interface Props {
  projectId: string;
}

const STATE_DOT: Record<JobState, string> = {
  running: "bg-warning animate-pulse",
  queued: "bg-warning/70",
  done: "bg-accent",
  error: "bg-destructive",
  idle: "bg-muted-foreground/40",
  scheduled: "bg-primary/60",
};

const StateIcon = ({ state }: { state: JobState }) => {
  const cls = "h-3.5 w-3.5";
  switch (state) {
    case "running":
      return <Loader2 className={cn(cls, "animate-spin text-warning")} />;
    case "queued":
      return <Clock className={cn(cls, "text-warning")} />;
    case "done":
      return <CheckCircle2 className={cn(cls, "text-accent")} />;
    case "error":
      return <AlertCircle className={cn(cls, "text-destructive")} />;
    case "scheduled":
      return <Calendar className={cn(cls, "text-primary")} />;
    default:
      return <Clock className={cn(cls, "text-muted-foreground")} />;
  }
};

/**
 * Compact strip showing the live status of every background pipeline that
 * affects this Navigator project: detox, categorisation, HAR/SERP/Ahrefs/
 * backlinks, and URL monitoring. Polls every 8s while anything is active.
 */
export default function BackgroundJobsRail({ projectId }: Props) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const { data: jobs = [], refetch, isFetching } = useBackgroundJobs(projectId);

  const anyActive = jobs.some((j) => j.state === "running" || j.state === "queued");
  const anyError = jobs.some((j) => j.state === "error");

  return (
    <Card className="border-border/60 bg-card/60 backdrop-blur-sm">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
        className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted/30 transition-colors rounded-t-lg cursor-pointer"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className={cn("h-2 w-2 rounded-full shrink-0", STATE_DOT[anyError ? "error" : anyActive ? "running" : "done"])} />
          <span className="text-xs font-semibold tracking-wide uppercase text-muted-foreground">
            Background jobs
          </span>
          <span className="text-xs text-muted-foreground/80 truncate">
            {anyError
              ? "Attention needed"
              : anyActive
                ? `${jobs.filter((j) => j.state === "running" || j.state === "queued").length} active`
                : "All caught up"}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={(e) => {
              e.stopPropagation();
              refetch();
            }}
            title="Refresh"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
          </Button>
          {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </div>
      </div>

      {open && (
        <div className="px-3 pb-3 pt-1 space-y-1.5 border-t border-border/40">
          {jobs.map((job) => (
            <JobRow
              key={job.kind}
              job={job}
              expanded={expanded === job.kind}
              onToggle={() => setExpanded((e) => (e === job.kind ? null : job.kind))}
            />
          ))}
          {jobs.length === 0 && (
            <p className="text-xs text-muted-foreground py-2">No background jobs found for this project.</p>
          )}
        </div>
      )}
    </Card>
  );
}

function JobRow({ job, expanded, onToggle }: { job: BackgroundJob; expanded: boolean; onToggle: () => void }) {
  const pct = job.progress != null ? Math.round(job.progress * 100) : null;

  return (
    <div className="rounded-md border border-border/40 bg-background/40">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-2.5 py-1.5 text-left hover:bg-muted/20 transition-colors"
      >
        <StateIcon state={job.state} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-foreground">{job.label}</span>
            <Badge variant="outline" className="text-[10px] h-4 px-1.5 capitalize">
              {job.state}
            </Badge>
          </div>
          <div className="text-[11px] text-muted-foreground truncate">{job.detail}</div>
        </div>
        {pct != null && (
          <div className="flex items-center gap-2 shrink-0">
            <div className="h-1.5 w-24 rounded-full bg-muted overflow-hidden">
              <div
                className={cn(
                  "h-full transition-all",
                  job.state === "done" ? "bg-accent" : job.state === "error" ? "bg-destructive" : "bg-warning",
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-[10px] tabular-nums text-muted-foreground w-9 text-right">{pct}%</span>
          </div>
        )}
      </button>
      {expanded && (
        <div className="px-2.5 pb-2 text-[11px] text-muted-foreground space-y-0.5 border-t border-border/30 pt-1.5">
          {job.jobId && <div>Job ID: <span className="font-mono">{job.jobId}</span></div>}
          {job.staleSeconds != null && <div>Heartbeat: {job.staleSeconds}s ago</div>}
          {job.lastError && <div className="text-destructive">Error: {job.lastError}</div>}
          {!job.jobId && !job.lastError && <div>No additional details.</div>}
        </div>
      )}
    </div>
  );
}
