import { useState, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
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
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Plus, Copy, Trash2, ExternalLink, Building2 } from "lucide-react";
import { format } from "date-fns";
import { useClientLogoUrl } from "@/hooks/useClientLogoUrl";
import {
  deleteProject,
  duplicateProject,
  type ProjectSummary,
} from "@/integrations/gcp/tenancy";
import { useNavigatorProjects } from "@/hooks/useNavigatorProjects";

function ProjectClientLogo({ logoPath, name }: { logoPath: string | null; name: string }) {
  const { data: url } = useClientLogoUrl(logoPath);
  return (
    <div className="h-9 w-9 shrink-0 overflow-hidden rounded-md border border-hairline bg-muted flex items-center justify-center">
      {url ? (
        <img src={url} alt={`${name} logo`} className="h-full w-full object-contain p-0.5" />
      ) : (
        <Building2 className="h-4 w-4 text-muted-foreground" />
      )}
    </div>
  );
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  draft: "secondary",
  "data collection": "outline",
  review: "outline",
  forecast: "default",
  complete: "default",
  active: "default",
};

type SortMode = "newest" | "oldest" | "alpha";

export default function NavigatorPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { canEdit, canDelete } = useAuth();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [clientFilter, setClientFilter] = useState<string>("all");
  const [sortMode, setSortMode] = useState<SortMode>("newest");

  const { projects, isLoading, error } = useNavigatorProjects();

  const clientNames = useMemo(() => {
    const names = new Set<string>();
    for (const p of projects) {
      const name = p.client_name;
      if (name) names.add(name);
    }
    return [...names].sort();
  }, [projects]);

  const filtered = useMemo(() => {
    let list = projects;
    if (clientFilter !== "all") {
      list = list.filter((p) => p.client_name === clientFilter);
    }
    const sorted = [...list];
    switch (sortMode) {
      case "oldest":
        sorted.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
        break;
      case "alpha":
        sorted.sort((a, b) => a.project_name.localeCompare(b.project_name));
        break;
      default: // newest
        sorted.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    }
    return sorted;
  }, [projects, clientFilter, sortMode]);

  const duplicateMutation = useMutation({
    mutationFn: (project: ProjectSummary) => duplicateProject(project.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["navigator_projects"] });
      toast({ title: "Project duplicated" });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Project duplication failed.",
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteProject,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["navigator_projects"] });
      toast({ title: "Project deleted" });
      setDeleteId(null);
    },
    onError: (error) => {
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Project deletion failed.",
        variant: "destructive",
      });
      setDeleteId(null);
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1>Seer® Projects</h1>
        {canEdit && (
          <Button onClick={() => navigate("/navigator/new")}>
            <Plus className="mr-1 h-4 w-4" />
            New Project
          </Button>
        )}
      </div>

      {/* Filter Bar */}
      {projects.length > 0 && (
        <div className="flex items-center gap-3">
          <Select value={clientFilter} onValueChange={setClientFilter}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="All Clients" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Clients</SelectItem>
              {clientNames.map((name) => (
                <SelectItem key={name} value={name}>{name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={sortMode} onValueChange={(v) => setSortMode(v as SortMode)}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Sort by…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Most Recent</SelectItem>
              <SelectItem value="oldest">Oldest First</SelectItem>
              <SelectItem value="alpha">Alphabetical</SelectItem>
            </SelectContent>
          </Select>

          <span className="text-sm text-muted-foreground ml-auto">
            {filtered.length} project{filtered.length !== 1 ? "s" : ""}
          </span>
        </div>
      )}

      {isLoading ? (
        <div className="p-8 text-center text-muted-foreground">Loading projects…</div>
      ) : error ? (
        <div className="p-8 text-center text-destructive">Failed to load projects.</div>
      ) : !projects.length ? (
        <div className="p-8 text-center text-muted-foreground">No Seer® projects yet.</div>
      ) : filtered.length === 0 ? (
        <div className="p-8 text-center text-muted-foreground">No projects match the current filter.</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((p) => (
            <Card key={p.id} className="hover:shadow-md transition-shadow flex flex-col">
              <CardContent className="flex flex-col flex-1 py-5 px-5">
                <div className="flex items-start gap-3 mb-3">
                  <ProjectClientLogo
                    logoPath={p.client_logo_url}
                    name={p.client_name ?? "Client"}
                  />
                  <div className="min-w-0 flex-1">
                    <button
                      onClick={() => navigate(`/navigator/${p.id}`)}
                      className="text-left block w-full"
                    >
                      <p className="font-heading font-semibold text-sm hover:text-primary transition-colors truncate">{p.project_name}</p>
                    </button>
                    <p className="text-xs text-muted-foreground truncate">
                      {p.client_name ?? "—"}
                      {p.category_focus ? ` · ${p.category_focus}` : ""}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 mt-auto">
                  {p.status !== "data collection" && p.status !== "data_collection" && (
                    <Badge variant={STATUS_VARIANT[p.status] ?? "secondary"} className="capitalize whitespace-nowrap text-[10px]">
                      {p.status}
                    </Badge>
                  )}
                  <span className="text-[10px] text-muted-foreground ml-auto">
                    {format(new Date(p.created_at), "dd MMM yyyy")}
                  </span>
                </div>
                <div className="flex gap-1 mt-3 pt-3 border-t">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => navigate(`/navigator/${p.id}`)}
                    title="Open"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </Button>
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => duplicateMutation.mutate(p)}
                      title="Duplicate"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  {canDelete && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      onClick={() => setDeleteId(p.id)}
                      title="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <AlertDialog open={!!deleteId} onOpenChange={(open) => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete project?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this Seer® project and all associated data. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteId && deleteMutation.mutate(deleteId)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
