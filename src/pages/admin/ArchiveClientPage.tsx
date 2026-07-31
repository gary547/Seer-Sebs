import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Building2, FolderOpen, Globe, Trash2 } from "lucide-react";
import { getClient, listProjects } from "@/integrations/gcp/tenancy";
import { SeerBreadcrumbs } from "@/components/SeerBreadcrumbs";
import { ArchiveBanner } from "@/components/archive/ArchiveBanner";
import { EmptyState } from "@/components/ui/empty-state";
import { Shimmer } from "@/components/ui/shimmer";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { archiveClientProject, archivePath, dashboardPath } from "@/lib/routes";
import { useCanArchive } from "@/hooks/useCanArchive";
import { useRestoreClient } from "@/hooks/useArchiveActions";
import { useHardDeleteClient } from "@/hooks/useArchiveHardDelete";
import { HardDeleteDialog } from "@/components/archive/HardDeleteDialog";
import { useClientLogoUrl } from "@/hooks/useClientLogoUrl";

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

export default function ArchiveClientPage() {
  const { clientId } = useParams<{ clientId: string }>();
  const navigate = useNavigate();
  const { canArchive } = useCanArchive();
  const restoreClient = useRestoreClient();
  const hardDeleteClient = useHardDeleteClient();
  const [deleteOpen, setDeleteOpen] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["archive", "client-detail", clientId],
    enabled: !!clientId && canArchive,
    queryFn: async () => {
      const [client, projects] = await Promise.all([
        getClient(clientId as string),
        listProjects(clientId as string, true),
      ]);
      return { client, projects };
    },
  });

  const { data: logoUrl } = useClientLogoUrl(data?.client?.logo_url ?? null);

  const handleRestore = async () => {
    if (!clientId) return;
    await restoreClient.mutateAsync({ clientId, clientName: data?.client?.company_name ?? null });
    navigate(`/clients/${clientId}`);
  };

  const handleHardDelete = async () => {
    if (!clientId) return;
    await hardDeleteClient.mutateAsync({ clientId, clientName: data?.client?.company_name ?? null });
    setDeleteOpen(false);
    navigate(archivePath());
  };

  if (isLoading) {
    return <Shimmer className="h-64 w-full rounded-xl" />;
  }
  if (error || !data?.client) {
    return (
      <EmptyState
        title="Archived client not found"
        description={error?.message ?? "It may have been permanently deleted."}
        action={
          <Button variant="outline" asChild>
            <Link to={archivePath()}>Back to archive</Link>
          </Button>
        }
      />
    );
  }
  const c = data.client;
  const archivedProjects = data.projects.filter((p) => p.archived_at);

  return (
    <div className="flex flex-col gap-6">
      <SeerBreadcrumbs
        items={[
          { label: "Dashboard", to: dashboardPath() },
          { label: "Archive", to: archivePath() },
          { label: c.company_name },
        ]}
      />

      <ArchiveBanner
        scope="client"
        archivedAt={c.archived_at}
        reason={c.archive_reason}
        onRestore={handleRestore}
        restoreDisabled={restoreClient.isPending}
        restoreLabel={restoreClient.isPending ? "Restoring…" : "Restore client"}
      />

      <header className="flex items-start gap-4">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border bg-muted">
          {logoUrl ? (
            <img src={logoUrl} alt={`${c.company_name} logo`} className="h-full w-full object-contain p-2" />
          ) : (
            <Building2 className="h-6 w-6 text-muted-foreground" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-serif text-3xl text-foreground">{c.company_name}</h1>
            <Badge variant="outline">Archived</Badge>
          </div>
          {c.domain && (
            <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
              <Globe className="h-3.5 w-3.5" />
              {c.domain}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            {c.industry && (
              <span className="rounded-md bg-muted px-2 py-1 text-muted-foreground">{c.industry}</span>
            )}
            {c.campaign_type && (
              <span className="rounded-md bg-muted px-2 py-1 capitalize text-muted-foreground">
                {c.campaign_type}
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

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Projects ({archivedProjects.length})
        </h2>
        {archivedProjects.length === 0 ? (
          <EmptyState
            icon={<FolderOpen className="h-5 w-5" />}
            title="No archived projects for this client"
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {archivedProjects.map((p) => (
              <Card key={p.id} className="border-dashed bg-muted/20">
                <Link
                  to={archiveClientProject(c.id, p.id)}
                  className="block rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <CardContent className="p-4 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="truncate text-sm font-semibold text-foreground">
                        {p.project_name}
                      </h3>
                      <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                    </div>
                    {p.category_focus && (
                      <p className="text-xs text-muted-foreground truncate">{p.category_focus}</p>
                    )}
                    <p className="text-[11px] text-muted-foreground">
                      Archived {fmt(p.archived_at)}
                    </p>
                    {p.archive_reason && (
                      <p className="text-[11px] italic text-muted-foreground line-clamp-2">
                        "{p.archive_reason}"
                      </p>
                    )}
                  </CardContent>
                </Link>
              </Card>
            ))}
          </div>
        )}
      </section>

      <HardDeleteDialog
        open={deleteOpen}
        onOpenChange={(o) => !hardDeleteClient.isPending && setDeleteOpen(o)}
        scope="client"
        entityName={c.company_name}
        isPending={hardDeleteClient.isPending}
        onConfirm={handleHardDelete}
      />
    </div>
  );
}
