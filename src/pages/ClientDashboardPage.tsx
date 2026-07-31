import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowRight, Building2, Plus, Pencil, FolderOpen, MoreVertical, Archive } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useSeerRouteContext } from "@/hooks/useSeerRouteContext";
import { useNavigatorProjects } from "@/hooks/useNavigatorProjects";
import { useDashboardData } from "@/hooks/useDashboardData";
import {
  clientEdit,
  newClientProject,
  projectHome,
  dashboardPath,
  clientsPath,
} from "@/lib/routes";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EditorialSection } from "@/components/briefing/EditorialSection";
import { StatusMixBar } from "@/components/briefing/StatusMixBar";
import { useCanArchive } from "@/hooks/useCanArchive";
import { useClientLogoUrl } from "@/hooks/useClientLogoUrl";
import { ArchiveClientDialog } from "@/components/archive/ArchiveClientDialog";

const gbpFmt = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  maximumFractionDigits: 0,
});


function formatDate(d: string | null): string {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

export default function ClientDashboardPage() {
  const { canEdit } = useAuth();
  const { canArchive } = useCanArchive();
  const navigate = useNavigate();
  const [archiveOpen, setArchiveOpen] = useState(false);
  const {
    clientId,
    activeClient,
    isLoading: ctxLoading,
    notFound,
    accessDenied,
  } = useSeerRouteContext();
  const { data: clientLogoUrl } = useClientLogoUrl(activeClient?.logo_url ?? null);

  const {
    projects,
    isLoading: projectsLoading,
  } = useNavigatorProjects({ clientId: clientId ?? undefined, enabled: !!clientId });

  // Reuse the cached portfolio rollup so the TP Revenue figure here matches
  // the project Performance Dashboard and the global Dashboard exactly.
  const { summary } = useDashboardData();
  const clientRollup = useMemo(
    () => summary?.byClient.find((b) => b.clientId === clientId) ?? null,
    [summary, clientId],
  );
  const tpRevenueDisplay =
    clientRollup ? gbpFmt.format(clientRollup.tpRevenueUplift) : "—";

  const statusDistribution = useMemo(() => {
    const dist: Record<string, number> = {};
    for (const p of projects) {
      const k = (p.status ?? "draft").toLowerCase();
      dist[k] = (dist[k] ?? 0) + 1;
    }
    return dist;
  }, [projects]);

  const activeCount = projects.filter((p) => p.status === "active").length;

  const latestSync = useMemo(() => {
    if (!projects.length) return null;
    const ts = projects
      .map((p) => p.updated_at ?? p.created_at)
      .filter(Boolean)
      .sort()
      .reverse()[0];
    return ts ?? null;
  }, [projects]);


  if (!clientId) {
    return (
      <div className="max-w-5xl mx-auto p-8">
        <h1 className="text-2xl font-semibold">Client not specified</h1>
        <p className="mt-2 text-ink-muted">
          <Link to={dashboardPath()} className="text-signal hover:underline">
            Back to dashboard
          </Link>
        </p>
      </div>
    );
  }

  if (ctxLoading) {
    return (
      <div className="max-w-7xl mx-auto p-6 space-y-4">
        <div className="h-24 rounded-xl shimmer" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-[140px] rounded-xl shimmer" />
          ))}
        </div>
      </div>
    );
  }

  if (accessDenied) {
    return (
      <div className="max-w-3xl mx-auto p-8 text-center">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="mt-2 text-ink-muted">
          You don't have permission to view this client.
        </p>
        <Button asChild variant="outline" className="mt-4">
          <Link to={dashboardPath()}>Back to dashboard</Link>
        </Button>
      </div>
    );
  }

  if (notFound || !activeClient) {
    return (
      <div className="max-w-3xl mx-auto p-8 text-center">
        <h1 className="text-2xl font-semibold">Client not found</h1>
        <p className="mt-2 text-ink-muted">
          The client you're looking for doesn't exist or has been removed.
        </p>
        <Button asChild variant="outline" className="mt-4">
          <Link to={dashboardPath()}>Back to dashboard</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6">
      {/* Header */}
      <header className="rounded-xl border border-hairline bg-surface p-6 shadow-card">
        <div className="flex items-start gap-4">
          {clientLogoUrl ? (
            <img
              src={clientLogoUrl}
              alt=""
              className="h-12 w-12 rounded-md border border-hairline object-cover bg-surface-sunk"
            />
          ) : (
            <div className="h-12 w-12 rounded-md border border-hairline bg-surface-sunk flex items-center justify-center text-ink-muted">
              <Building2 className="h-5 w-5" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="type-eyebrow text-ink-muted">Client workspace</div>
            <h1 className="text-2xl font-semibold text-ink truncate">
              {activeClient.company_name}
            </h1>
            {activeClient.domain && (
              <a
                href={`https://${activeClient.domain.replace(/^https?:\/\//, "")}`}
                target="_blank"
                rel="noreferrer noopener"
                className="text-[13px] text-ink-muted hover:text-signal"
              >
                {activeClient.domain}
              </a>
            )}
          </div>
          {canEdit && (
            <div className="flex items-center gap-2 shrink-0">
              <Button asChild variant="outline" size="sm">
                <Link to={clientEdit(activeClient.id)}>
                  <Pencil className="h-3.5 w-3.5" /> Edit client
                </Link>
              </Button>
              <Button asChild variant="signal" size="sm">
                <Link to={newClientProject(activeClient.id)}>
                  <Plus className="h-3.5 w-3.5" /> New project
                </Link>
              </Button>
              {canArchive && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label="Client actions" className="h-8 w-8">
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onSelect={(e) => {
                        e.preventDefault();
                        setArchiveOpen(true);
                      }}
                    >
                      <Archive className="mr-2 h-4 w-4" /> Archive client
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          )}
        </div>

        <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-4 border-t border-hairline pt-4">
          <Stat label="Total TP Revenue" value={tpRevenueDisplay} />
          <Stat label="Projects" value={String(projects.length)} />
          <Stat label="Active" value={String(activeCount)} />
          <Stat label="Latest activity" value={formatDate(latestSync)} />
        </div>

        {projects.length > 0 && (
          <div className="mt-4">
            <div className="type-eyebrow text-ink-muted mb-2">Status mix</div>
            <StatusMixBar distribution={statusDistribution} />
          </div>
        )}

      </header>

      {/* Projects */}
      <EditorialSection
        eyebrow="Projects"
        title="Seer® projects for this client"
        dek="Open a project to manage SERPs, forecasts, roadmap and content plans."
        actions={
          canEdit ? (
            <Button asChild variant="signal" size="sm">
              <Link to={newClientProject(activeClient.id)}>
                <Plus className="h-3.5 w-3.5" /> New project
              </Link>
            </Button>
          ) : null
        }
      >
        {projectsLoading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-[140px] rounded-xl shimmer" />
            ))}
          </div>
        ) : projects.length === 0 ? (
          <div className="rounded-xl border border-hairline bg-surface p-10 text-center shadow-card">
            <div className="mx-auto h-10 w-10 rounded-full bg-secondary text-ink-muted flex items-center justify-center">
              <FolderOpen className="h-4 w-4" />
            </div>
            <p className="mt-3 text-[13px] text-ink-muted max-w-md mx-auto">
              {canEdit
                ? "No projects yet for this client. Create the first one to start forecasting."
                : "No projects available for this client yet."}
            </p>
            {canEdit && (
              <Button asChild variant="signal" size="sm" className="mt-4">
                <Link to={newClientProject(activeClient.id)}>
                  <Plus className="h-3.5 w-3.5" /> Create first project
                </Link>
              </Button>
            )}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <Link
                key={p.id}
                to={projectHome(activeClient.id, p.id)}
                className="group relative flex flex-col rounded-xl border border-hairline bg-surface p-4 shadow-card transition-shadow hover:shadow-raised hover:border-signal/40"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-semibold text-ink truncate group-hover:text-signal-ink transition-colors">
                      {p.project_name}
                    </div>
                    {p.category_focus && (
                      <div className="text-[11px] text-ink-muted truncate">
                        {p.category_focus}
                      </div>
                    )}
                  </div>
                  <ArrowRight className="h-3.5 w-3.5 text-ink-subtle group-hover:text-signal transition-colors shrink-0 mt-1" />
                </div>

                <div className="mt-3 flex items-center justify-between text-[12px]">
                  <Badge variant="outline" className="capitalize">
                    {p.status}
                  </Badge>
                  <span className="text-ink-muted">
                    {formatDate(p.updated_at ?? p.created_at)}
                  </span>
                </div>

                <div className="mt-3 pt-3 border-t border-hairline">
                  <span className="text-[11px] text-ink-muted group-hover:text-signal transition-colors">
                    Open project →
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </EditorialSection>

      <ArchiveClientDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        clientId={activeClient.id}
        clientName={activeClient.company_name}
        onArchived={() => navigate(clientsPath())}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="type-eyebrow text-ink-muted">{label}</div>
      <div className="mt-1 type-mono font-semibold text-ink tabular-nums text-lg">
        {value}
      </div>
    </div>
  );
}
