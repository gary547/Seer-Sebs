import { useEffect } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router";
import { useSeerRouteContext } from "@/hooks/useSeerRouteContext";
import { projectView } from "@/lib/routes";
import { SeerBreadcrumbs, type SeerCrumb } from "@/components/SeerBreadcrumbs";
import { ShimmerCard } from "@/components/ui/shimmer";

const VIEW_LABELS: Record<string, string> = {
  setup: "Setup",
  "serps-backlinks": "SERPs & Backlinks",
  "ranking-urls-tp": "Ranking URLs & TP",
  forecast: "Forecast",
  "site-architecture": "Site Architecture",
  roadmap: "Roadmap",
  "content-plans": "Content Plans",
};

function StateShell({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto max-w-2xl px-6 py-24 text-center">
      <h1 className="font-serif text-3xl text-foreground">{title}</h1>
      <p className="mt-3 text-sm text-muted-foreground">{body}</p>
      <Link
        to="/dashboard"
        className="mt-6 inline-flex items-center text-sm text-primary hover:underline"
      >
        ← Back to dashboard
      </Link>
    </div>
  );
}

export default function ProjectWorkspaceLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const ctx = useSeerRouteContext();

  // Legacy hash deep-link (e.g. /clients/.../projects/...#site-architecture)
  // → canonical /site-architecture route. Runs once the workspace knows the
  // active client/project.
  useEffect(() => {
    if (location.hash !== "#site-architecture") return;
    if (!ctx.activeClient || !ctx.activeProject) return;
    navigate(
      projectView(ctx.activeClient.id, ctx.activeProject.id, "siteArchitecture"),
      { replace: true },
    );
  }, [location.hash, ctx.activeClient, ctx.activeProject, navigate]);

  if (ctx.isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <ShimmerCard />
      </div>
    );
  }

  if (ctx.accessDenied) {
    return (
      <StateShell
        title="403 — Access denied"
        body="You don't have access to this project, or the project doesn't belong to this client."
      />
    );
  }

  if (ctx.notFound || !ctx.activeClient || !ctx.activeProject) {
    return (
      <StateShell
        title="404 — Project not found"
        body="We couldn't find this project. It may have been deleted or moved."
      />
    );
  }

  // Determine current view from the trailing path segment.
  const segments = location.pathname.split("/").filter(Boolean);
  // /clients/:clientId/projects/:id[/:view]
  const viewSegment = segments[4];
  const currentViewLabel = viewSegment ? VIEW_LABELS[viewSegment] ?? null : "Overview";

  const crumbs: SeerCrumb[] = [
    { label: "Dashboard", to: ctx.urls.dashboard },
    { label: ctx.activeClient.company_name, to: ctx.urls.clientHome ?? "/clients" },
  ];
  if (currentViewLabel && currentViewLabel !== "Overview") {
    crumbs.push({
      label: ctx.activeProject.project_name,
      to: ctx.urls.projectHome ?? undefined,
    });
    crumbs.push({ label: currentViewLabel });
  } else {
    crumbs.push({ label: ctx.activeProject.project_name });
  }

  return (
    <div className="flex flex-col gap-4">
      <SeerBreadcrumbs items={crumbs} />
      {/* NOTE: project sub-nav is intentionally deferred to Prompt 10 to avoid
          rendering double chrome alongside NavigatorProjectDetailPage's
          internal stepper. BackgroundJobsRail is also deferred — it depends
          on sync state owned by the detail page. */}
      <Outlet />
    </div>
  );
}
