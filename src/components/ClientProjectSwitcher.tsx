import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Building2, FolderKanban, Plus, ChevronsUpDown } from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import { useClients } from "@/hooks/useClients";
import { useNavigatorProjects } from "@/hooks/useNavigatorProjects";
import { useSeerRouteContext } from "@/hooks/useSeerRouteContext";
import { ensureProjectReadiness } from "@/hooks/useProjectReadiness";
import { rememberLastView, readLastView } from "@/lib/lastView";
import { useCanArchive } from "@/hooks/useCanArchive";
import { useArchivedClients, useArchivedProjects } from "@/hooks/useArchive";
import { Badge } from "@/components/ui/badge";
import {
  clientHome,
  projectHome,
  projectView,
  newClientProject,
  archiveClient as archiveClientPath,
  archiveClientProject,
  PROJECT_VIEW_PATHS,
  type ProjectViewKey,
} from "@/lib/routes";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

// Reverse lookup: URL segment -> ProjectViewKey.
const SEGMENT_TO_VIEW: Record<string, ProjectViewKey> = Object.entries(
  PROJECT_VIEW_PATHS,
).reduce((acc, [key, segment]) => {
  if (segment) acc[segment] = key as ProjectViewKey;
  return acc;
}, {} as Record<string, ProjectViewKey>);

// Map a project sub-view to the capability it requires. Views absent from
// this map are always allowed (overview, setup).
const VIEW_REQUIREMENT: Partial<
  Record<ProjectViewKey, "hasKeywords" | "hasForecasts">
> = {
  forecast: "hasForecasts",
  siteArchitecture: "hasForecasts",
  roadmap: "hasForecasts",
  rankingUrlsTp: "hasForecasts",
  serpsBacklinks: "hasKeywords",
  contentPlans: "hasKeywords",
};

const PROBE_TIMEOUT_MS = 400;

function detectActiveViewFromPath(pathname: string): ProjectViewKey | null {
  // /clients/:clientId/projects/:id[/:view]
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "clients" || parts[2] !== "projects") return null;
  const seg = parts[4];
  if (!seg) return "overview";
  return SEGMENT_TO_VIEW[seg] ?? null;
}

function isAtClientHome(pathname: string, clientId: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return (
    parts.length === 2 && parts[0] === "clients" && parts[1] === clientId
  );
}

interface SelectorsProps {
  selectedClientId: string | null;
  onClientChange: (clientId: string) => void;
  selectedProjectId: string | null;
  onProjectChange: (projectId: string) => void;
  canEdit: boolean;
  onCreateProject: () => void;
  layout?: "row" | "stack";
  projectSwitching?: boolean;
}

function Selectors({
  selectedClientId,
  onClientChange,
  selectedProjectId,
  onProjectChange,
  canEdit,
  onCreateProject,
  layout = "row",
  projectSwitching = false,
}: SelectorsProps) {
  const { canArchive } = useCanArchive();
  const { clients, isLoading: clientsLoading } = useClients();
  const { projects, isLoading: projectsLoading } = useNavigatorProjects({
    clientId: selectedClientId ?? undefined,
    enabled: !!selectedClientId,
  });
  const { clients: archivedClients } = useArchivedClients();
  const { projects: allArchivedProjects } = useArchivedProjects();
  const archivedProjects = useMemo(
    () =>
      selectedClientId
        ? allArchivedProjects.filter((p) => p.client_id === selectedClientId)
        : [],
    [allArchivedProjects, selectedClientId],
  );

  const projectDisabled = !selectedClientId;
  const noProjects = !!selectedClientId && !projectsLoading && projects.length === 0;

  return (
    <div
      className={cn(
        "flex gap-2",
        layout === "stack" ? "flex-col w-full" : "items-center",
      )}
    >
      <div className={layout === "stack" ? "w-full" : "min-w-[180px]"}>
        {layout === "stack" && (
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Client
          </label>
        )}
        <Select
          value={selectedClientId ?? undefined}
          onValueChange={onClientChange}
          disabled={clientsLoading}
        >
          <SelectTrigger
            aria-label="Select client"
            className="h-8 text-[13px]"
          >
            <Building2 className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
            <SelectValue placeholder={clientsLoading ? "Loading…" : "Select client"} />
          </SelectTrigger>
          <SelectContent>
            {clients.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                No clients available
              </div>
            ) : (
              clients.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.company_name}
                </SelectItem>
              ))
            )}
            {canArchive && archivedClients.length > 0 && (
              <>
                <div className="mt-1 border-t border-hairline px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Archived
                </div>
                {archivedClients.map((c) => (
                  <SelectItem key={`archived:${c.id}`} value={`archived:${c.id}`}>
                    <span className="flex items-center gap-2">
                      <span className="truncate">{c.company_name}</span>
                      <Badge variant="outline" className="h-4 px-1 text-[9px] uppercase tracking-wider">
                        Archived
                      </Badge>
                    </span>
                  </SelectItem>
                ))}
              </>
            )}
          </SelectContent>
        </Select>
      </div>

      <div className={layout === "stack" ? "w-full" : "min-w-[200px]"}>
        {layout === "stack" && (
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Project
          </label>
        )}
        <Select
          value={selectedProjectId ?? undefined}
          onValueChange={onProjectChange}
          disabled={projectDisabled || projectsLoading || projectSwitching}
        >
          <SelectTrigger
            aria-label="Select project"
            aria-busy={projectSwitching || undefined}
            className={cn("h-8 text-[13px]", projectSwitching && "opacity-70")}
          >
            <FolderKanban className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
            <SelectValue
              placeholder={
                projectDisabled
                  ? "Select a client first"
                  : projectsLoading
                  ? "Loading…"
                  : projectSwitching
                  ? "Switching…"
                  : noProjects
                  ? "No projects"
                  : "Select project"
              }
            />
          </SelectTrigger>
          <SelectContent>
            {projects.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                {projectDisabled
                  ? "Select a client first"
                  : "No projects for this client"}
              </div>
            ) : (
              projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.project_name}
                </SelectItem>
              ))
            )}
            {canArchive && archivedProjects.length > 0 && (
              <>
                <div className="mt-1 border-t border-hairline px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Archived
                </div>
                {archivedProjects.map((p) => (
                  <SelectItem key={`archived:${p.id}`} value={`archived:${p.id}`}>
                    <span className="flex items-center gap-2">
                      <span className="truncate">{p.project_name}</span>
                      <Badge variant="outline" className="h-4 px-1 text-[9px] uppercase tracking-wider">
                        Archived
                      </Badge>
                    </span>
                  </SelectItem>
                ))}
              </>
            )}
          </SelectContent>
        </Select>
        {noProjects && canEdit && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-1 h-7 w-full justify-start text-[12px]"
            onClick={onCreateProject}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            New project
          </Button>
        )}
      </div>
    </div>
  );
}

export function ClientProjectSwitcher() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { canEdit } = useAuth();
  const ctx = useSeerRouteContext();

  const [sheetOpen, setSheetOpen] = useState(false);
  const [projectSwitching, setProjectSwitching] = useState(false);

  const selectedClientId = ctx.clientId ?? ctx.activeClient?.id ?? null;
  const selectedProjectId = ctx.projectId ?? ctx.activeProject?.id ?? null;
  const activeView = useMemo(
    () => detectActiveViewFromPath(location.pathname),
    [location.pathname],
  );

  // I4 — persist last-visited sub-view per project (skips overview).
  useEffect(() => {
    if (ctx.projectId && activeView && activeView !== "overview") {
      rememberLastView(ctx.projectId, activeView);
    }
  }, [ctx.projectId, activeView]);

  // I2 — goToClient navigates when deeper than client home.
  // Admin can also pick an archived client (value prefixed with "archived:"),
  // which routes to the read-only Archive view rather than the live workspace.
  const goToClient = (rawValue: string) => {
    if (!rawValue) return;
    if (rawValue.startsWith("archived:")) {
      const id = rawValue.slice("archived:".length);
      if (id) navigate(archiveClientPath(id));
      return;
    }
    const clientId = rawValue;
    if (clientId === selectedClientId && isAtClientHome(location.pathname, clientId)) {
      return; // already at this client's home
    }
    navigate(clientHome(clientId));
  };

  // I1 — readiness-gated sub-view carry-over (+ I4 last-view fallback).
  // Archived projects route to the Archive view, never the live workspace.
  const goToProject = async (rawValue: string) => {
    if (!rawValue || !selectedClientId) return;
    if (rawValue.startsWith("archived:")) {
      const projectId = rawValue.slice("archived:".length);
      if (projectId) navigate(archiveClientProject(selectedClientId, projectId));
      return;
    }
    const projectId = rawValue;

    // Candidate view: current active sub-view, or remembered last-view when
    // we're not currently inside a project sub-view.
    const candidate: ProjectViewKey | null =
      activeView && activeView !== "overview"
        ? activeView
        : readLastView(projectId);

    if (!candidate || candidate === "overview") {
      navigate(projectHome(selectedClientId, projectId));
      return;
    }

    const requirement = VIEW_REQUIREMENT[candidate];
    if (!requirement) {
      navigate(projectView(selectedClientId, projectId, candidate));
      return;
    }

    setProjectSwitching(true);
    try {
      const readiness = await Promise.race<
        { hasKeywords: boolean; hasForecasts: boolean } | "timeout"
      >([
        ensureProjectReadiness(queryClient, projectId),
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), PROBE_TIMEOUT_MS),
        ),
      ]);

      if (readiness === "timeout" || !readiness[requirement]) {
        navigate(projectHome(selectedClientId, projectId));
      } else {
        navigate(projectView(selectedClientId, projectId, candidate));
      }
    } catch {
      navigate(projectHome(selectedClientId, projectId));
    } finally {
      setProjectSwitching(false);
    }
  };

  const handleCreateProject = () => {
    if (!selectedClientId) return;
    setSheetOpen(false);
    navigate(newClientProject(selectedClientId));
  };

  const chipLabel = ctx.activeProject?.project_name
    ? `${ctx.activeClient?.company_name ?? "Client"} / ${ctx.activeProject.project_name}`
    : ctx.activeClient?.company_name ?? "Global";

  return (
    <>
      {/* Desktop: two adjacent selectors */}
      <div className="hidden md:flex items-center gap-2">
        <Selectors
          selectedClientId={selectedClientId}
          onClientChange={goToClient}
          selectedProjectId={selectedProjectId}
          onProjectChange={goToProject}
          canEdit={canEdit}
          onCreateProject={handleCreateProject}
          projectSwitching={projectSwitching}
        />
      </div>

      {/* Mobile: chip → sheet */}
      <div className="md:hidden">
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 min-w-11 max-w-[220px] truncate gap-2 text-[12px]"
              aria-label="Switch client or project"
            >
              <span className="truncate">{chipLabel}</span>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                Switch
              </span>
              <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
            </Button>
          </SheetTrigger>
          <SheetContent side="top" className="pt-10">
            <SheetHeader>
              <SheetTitle>Switch workspace</SheetTitle>
            </SheetHeader>
            <div className="mt-4">
              <Selectors
                layout="stack"
                selectedClientId={selectedClientId}
                onClientChange={(id) => {
                  goToClient(id);
                  setSheetOpen(false);
                }}
                selectedProjectId={selectedProjectId}
                onProjectChange={async (id) => {
                  await goToProject(id);
                  setSheetOpen(false);
                }}
                canEdit={canEdit}
                onCreateProject={handleCreateProject}
                projectSwitching={projectSwitching}
              />
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </>
  );
}

export default ClientProjectSwitcher;
