import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Building2, FolderOpen, Trash2 } from "lucide-react";
import { getArchivedProjectDetail } from "@/integrations/gcp/tenancy";
import { SeerBreadcrumbs } from "@/components/SeerBreadcrumbs";
import { ArchiveBanner } from "@/components/archive/ArchiveBanner";
import { EmptyState } from "@/components/ui/empty-state";
import { Shimmer } from "@/components/ui/shimmer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { archiveClient, archivePath, dashboardPath } from "@/lib/routes";
import { useCanArchive } from "@/hooks/useCanArchive";
import { useRestoreProject } from "@/hooks/useArchiveActions";
import { useHardDeleteProject } from "@/hooks/useArchiveHardDelete";
import { HardDeleteDialog } from "@/components/archive/HardDeleteDialog";

function fmt(d?: string | null) {
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

export default function ArchiveProjectPage() {
  const { clientId, projectId } = useParams<{ clientId: string; projectId: string }>();
  const navigate = useNavigate();
  const { canArchive } = useCanArchive();
  const restoreProject = useRestoreProject();
  const hardDeleteProject = useHardDeleteProject();
  const [deleteOpen, setDeleteOpen] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["archive", "project-detail", projectId],
    enabled: !!projectId && !!clientId && canArchive,
    queryFn: () => getArchivedProjectDetail(projectId as string),
  });

  const handleRestore = async () => {
    if (!projectId) return;
    try {
      await restoreProject.mutateAsync({ projectId, projectName: data?.project.project_name ?? null });
      navigate(`/clients/${clientId}/projects/${projectId}`);
    } catch {
      // toast handled in hook
    }
  };

  const handleHardDelete = async () => {
    if (!projectId) return;
    await hardDeleteProject.mutateAsync({ projectId, projectName: data?.project.project_name ?? null });
    setDeleteOpen(false);
    navigate(archiveClient(clientId as string));
  };

  if (isLoading) return <Shimmer className="h-64 w-full rounded-xl" />;
  if (error || !data?.project) {
    return (
      <EmptyState
        title="Archived project not found"
        description={error?.message ?? "It may have been permanently deleted."}
        action={
          <Button variant="outline" asChild>
            <Link to={archivePath()}>Back to archive</Link>
          </Button>
        }
      />
    );
  }
  const p = data.project;
  const parentArchived = !!p.client_archived_at;

  return (
    <div className="flex flex-col gap-6">
      <SeerBreadcrumbs
        items={[
          { label: "Dashboard", to: dashboardPath() },
          { label: "Archive", to: archivePath() },
          { label: p.client_name ?? "Client", to: archiveClient(clientId as string) },
          { label: p.project_name },
        ]}
      />

      <ArchiveBanner
        scope="project"
        archivedAt={p.archived_at}
        reason={p.archive_reason}
        onRestore={parentArchived ? undefined : handleRestore}
        restoreDisabled={restoreProject.isPending}
        restoreLabel={restoreProject.isPending ? "Restoring…" : "Restore project"}
      />

      {parentArchived && (
        <div className="rounded-lg border border-dashed bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          The parent client is also archived. Restore the client first to bring this project back to
          the live workspace.
        </div>
      )}

      <header className="flex items-start gap-4">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border bg-muted">
          <FolderOpen className="h-5 w-5 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-serif text-3xl text-foreground">{p.project_name}</h1>
            <Badge variant="outline">Archived</Badge>
            <Badge variant="secondary" className="capitalize">{p.status}</Badge>
          </div>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
            <Building2 className="h-3.5 w-3.5" />
            <Link to={archiveClient(clientId as string)} className="hover:underline">
              {p.client_name ?? "Unknown client"}
            </Link>
          </p>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            {p.category_focus && (
              <span className="rounded-md bg-muted px-2 py-1 text-muted-foreground">
                {p.category_focus}
              </span>
            )}
            {p.client_domain && (
              <span className="rounded-md bg-muted px-2 py-1 text-muted-foreground">
                {p.client_domain}
              </span>
            )}
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={() => setDeleteOpen(true)}
        >
          <Trash2 className="mr-2 h-4 w-4" /> Permanently delete
        </Button>
      </header>

      <section className="grid gap-3 sm:grid-cols-3">
        <KpiCard label="Keywords" value={data.kpis.keywords} />
        <KpiCard label="Roadmaps" value={data.kpis.roadmaps} />
        <KpiCard label="Content plans" value={data.kpis.contentPlans} />
      </section>

      <section className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">Read-only snapshot</p>
        <p className="mt-1">
          Project archived on {fmt(p.archived_at)}. Live workspace tabs are intentionally
          unavailable while the project is archived to prevent accidental edits or background
          jobs from running. Restore the project to access the full workspace.
        </p>
      </section>

      <HardDeleteDialog
        open={deleteOpen}
        onOpenChange={(o) => !hardDeleteProject.isPending && setDeleteOpen(o)}
        scope="project"
        entityName={p.project_name}
        isPending={hardDeleteProject.isPending}
        onConfirm={handleHardDelete}
      />
    </div>
  );
}

function KpiCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className="mt-1 font-serif text-2xl text-foreground">{value.toLocaleString()}</p>
      </CardContent>
    </Card>
  );
}
