import { useMemo, useState } from "react";
import { Link, useSearchParams, useNavigate } from "react-router";
import { Archive, ArrowRight, Building2, FolderOpen, RotateCcw, Trash2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Shimmer } from "@/components/ui/shimmer";
import { SeerBreadcrumbs } from "@/components/SeerBreadcrumbs";
import {
  useArchivedClients,
  useArchivedProjects,
  type ArchivedClientSummary,
  type ArchivedProjectSummary,
} from "@/hooks/useArchive";
import { useRestoreClient, useRestoreProject } from "@/hooks/useArchiveActions";
import { useHardDeleteClient, useHardDeleteProject } from "@/hooks/useArchiveHardDelete";
import { HardDeleteDialog } from "@/components/archive/HardDeleteDialog";
import { archiveClient, archiveClientProject, dashboardPath } from "@/lib/routes";
import { useClientLogoUrl } from "@/hooks/useClientLogoUrl";

function relative(d?: string | null) {
  if (!d) return "—";
  try {
    return `${formatDistanceToNow(new Date(d))} ago`;
  } catch {
    return "—";
  }
}

function ClientLogo({ logoPath, name }: { logoPath: string | null; name: string }) {
  const { data: logoUrl } = useClientLogoUrl(logoPath);
  return (
    <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted">
      {logoUrl ? (
        <img src={logoUrl} alt={`${name} logo`} className="h-full w-full object-contain p-1.5" />
      ) : (
        <Building2 className="h-5 w-5 text-muted-foreground" />
      )}
    </div>
  );
}

interface RestoreDialogState {
  scope: "client" | "project";
  id: string;
  name: string;
}

interface HardDeleteState {
  scope: "client" | "project";
  id: string;
  name: string;
}

export default function ArchivePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const tab = searchParams.get("tab") === "projects" ? "projects" : "clients";

  const { clients, isLoading: loadingClients, error: clientsError } = useArchivedClients();
  const { projects, isLoading: loadingProjects, error: projectsError } = useArchivedProjects();

  const restoreClient = useRestoreClient();
  const restoreProject = useRestoreProject();
  const hardDeleteClient = useHardDeleteClient();
  const hardDeleteProject = useHardDeleteProject();

  const [restoreTarget, setRestoreTarget] = useState<RestoreDialogState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HardDeleteState | null>(null);

  const setTab = (t: string) => {
    const next = new URLSearchParams(searchParams);
    if (t === "clients") next.delete("tab");
    else next.set("tab", t);
    setSearchParams(next, { replace: true });
  };

  const restorePending = restoreClient.isPending || restoreProject.isPending;
  const deletePending = hardDeleteClient.isPending || hardDeleteProject.isPending;

  const handleRestore = async () => {
    if (!restoreTarget) return;
    if (restoreTarget.scope === "client") {
      await restoreClient.mutateAsync({ clientId: restoreTarget.id, clientName: restoreTarget.name });
    } else {
      await restoreProject.mutateAsync({ projectId: restoreTarget.id, projectName: restoreTarget.name });
    }
    setRestoreTarget(null);
  };

  const handleHardDelete = async () => {
    if (!deleteTarget) return;
    if (deleteTarget.scope === "client") {
      await hardDeleteClient.mutateAsync({ clientId: deleteTarget.id, clientName: deleteTarget.name });
    } else {
      await hardDeleteProject.mutateAsync({ projectId: deleteTarget.id, projectName: deleteTarget.name });
    }
    setDeleteTarget(null);
  };

  return (
    <div className="flex flex-col gap-6">
      <SeerBreadcrumbs
        items={[{ label: "Dashboard", to: dashboardPath() }, { label: "Archive" }]}
      />

      <header className="space-y-1">
        <h1 className="font-serif text-3xl text-foreground flex items-center gap-2">
          <Archive className="h-6 w-6 text-amber-600" aria-hidden="true" />
          Archive
        </h1>
        <p className="text-sm text-muted-foreground">
          Restore or permanently delete archived clients and projects. Archived items are hidden
          from the live workspace for everyone.
        </p>
      </header>

      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <TabsList>
          <TabsTrigger value="clients">
            Clients{clients.length ? ` (${clients.length})` : ""}
          </TabsTrigger>
          <TabsTrigger value="projects">
            Projects{projects.length ? ` (${projects.length})` : ""}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="clients" className="space-y-4">
          <ClientsTab
            clients={clients}
            isLoading={loadingClients}
            error={clientsError}
            onRestore={(c) => setRestoreTarget({ scope: "client", id: c.id, name: c.company_name })}
            onDelete={(c) => setDeleteTarget({ scope: "client", id: c.id, name: c.company_name })}
          />
        </TabsContent>

        <TabsContent value="projects" className="space-y-4">
          <ProjectsTab
            projects={projects}
            isLoading={loadingProjects}
            error={projectsError}
            onRestore={(p) =>
              setRestoreTarget({ scope: "project", id: p.id, name: p.project_name })
            }
            onDelete={(p) => setDeleteTarget({ scope: "project", id: p.id, name: p.project_name })}
          />
        </TabsContent>
      </Tabs>

      {/* Restore confirm dialog */}
      <AlertDialog
        open={!!restoreTarget}
        onOpenChange={(o) => !restorePending && !o && setRestoreTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Restore {restoreTarget?.scope} "{restoreTarget?.name}"?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {restoreTarget?.scope === "client"
                ? "All projects archived in the same action will be restored back to the live workspace."
                : "The project will return to the live workspace. Its parent client must already be active."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restorePending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleRestore();
              }}
              disabled={restorePending}
            >
              {restorePending ? "Restoring…" : "Restore"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <HardDeleteDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !deletePending && !o && setDeleteTarget(null)}
        scope={deleteTarget?.scope ?? "client"}
        entityName={deleteTarget?.name ?? ""}
        isPending={deletePending}
        onConfirm={handleHardDelete}
      />
    </div>
  );
}

function ClientsTab({
  clients,
  isLoading,
  error,
  onRestore,
  onDelete,
}: {
  clients: ArchivedClientSummary[];
  isLoading: boolean;
  error: Error | null;
  onRestore: (c: ArchivedClientSummary) => void;
  onDelete: (c: ArchivedClientSummary) => void;
}) {
  if (isLoading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Shimmer key={i} className="h-28 w-full rounded-xl" />
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <EmptyState
        title="Failed to load archived clients"
        description={error.message}
      />
    );
  }
  if (!clients.length) {
    return (
      <EmptyState
        icon={<Archive className="h-6 w-6" />}
        title="No archived clients"
        description="Archived clients will show up here. Restore them at any time."
      />
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {clients.map((c) => (
        <Card key={c.id} className="group relative border-dashed bg-muted/20">
          <Link
            to={archiveClient(c.id)}
            className="block rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Open archived ${c.company_name}`}
          >
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <ClientLogo logoPath={c.logo_url} name={c.company_name} />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-[15px] font-semibold text-foreground">
                      {c.company_name}
                    </h2>
                    <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
                      Archived
                    </Badge>
                  </div>
                  {c.domain && (
                    <p className="truncate text-xs text-muted-foreground">{c.domain}</p>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    Archived {relative(c.archived_at)}
                  </p>
                  {c.archive_reason && (
                    <p className="text-[11px] italic text-muted-foreground line-clamp-2">
                      "{c.archive_reason}"
                    </p>
                  )}
                </div>
              </div>
            </CardContent>
          </Link>
          <div className="absolute right-2 top-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Archived client actions"
                  className="h-7 w-7"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="sr-only">Actions</span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                <DropdownMenuItem asChild>
                  <Link to={archiveClient(c.id)}>
                    <ArrowRight className="mr-2 h-4 w-4" /> Open
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={(e) => { e.preventDefault(); onRestore(c); }}>
                  <RotateCcw className="mr-2 h-4 w-4" /> Restore client
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={(e) => { e.preventDefault(); onDelete(c); }}
                >
                  <Trash2 className="mr-2 h-4 w-4" /> Permanently delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </Card>
      ))}
    </div>
  );
}

function ProjectsTab({
  projects,
  isLoading,
  error,
  onRestore,
  onDelete,
}: {
  projects: ArchivedProjectSummary[];
  isLoading: boolean;
  error: Error | null;
  onRestore: (p: ArchivedProjectSummary) => void;
  onDelete: (p: ArchivedProjectSummary) => void;
}) {
  if (isLoading) {
    return <Shimmer className="h-48 w-full rounded-xl" />;
  }
  if (error) {
    return <EmptyState title="Failed to load archived projects" description={error.message} />;
  }
  if (!projects.length) {
    return (
      <EmptyState
        icon={<FolderOpen className="h-6 w-6" />}
        title="No archived projects"
        description="Projects archived individually or as part of a client archive will appear here."
      />
    );
  }
  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Project</TableHead>
            <TableHead>Client</TableHead>
            <TableHead>Archived</TableHead>
            <TableHead>Reason</TableHead>
            <TableHead className="w-[80px] text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {projects.map((p) => {
            const parentArchived = !!p.client_archived_at;
            return (
              <TableRow key={p.id}>
                <TableCell>
                  <Link
                    to={archiveClientProject(p.client_id, p.id)}
                    className="font-medium text-foreground hover:underline"
                  >
                    {p.project_name}
                  </Link>
                  {p.category_focus && (
                    <p className="text-[11px] text-muted-foreground">{p.category_focus}</p>
                  )}
                </TableCell>
                <TableCell className="text-sm">
                  <span className="text-muted-foreground">{p.client_name ?? "—"}</span>
                  {parentArchived && (
                    <Badge variant="outline" className="ml-2 text-[10px]">
                      Client archived
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                  {relative(p.archived_at)}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground max-w-[260px]">
                  <span className="line-clamp-2 italic">
                    {p.archive_reason || "—"}
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm" aria-label="Project actions">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem asChild>
                        <Link to={archiveClientProject(p.client_id, p.id)}>
                          <ArrowRight className="mr-2 h-4 w-4" /> Open
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={parentArchived}
                        onSelect={(e) => { e.preventDefault(); if (!parentArchived) onRestore(p); }}
                      >
                        <RotateCcw className="mr-2 h-4 w-4" /> Restore project
                      </DropdownMenuItem>
                      {parentArchived && (
                        <p className="px-2 py-1 text-[11px] text-muted-foreground max-w-[220px]">
                          Restore the parent client first.
                        </p>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onSelect={(e) => { e.preventDefault(); onDelete(p); }}
                      >
                        <Trash2 className="mr-2 h-4 w-4" /> Permanently delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
