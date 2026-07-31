import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router";
import {
  Building2,
  Eye,
  Users,
  Database,
  Shield,
  User as UserIcon,
  Plus,
  ArrowRight,
  LayoutDashboard,
  CalendarClock,
  FileText,
  Activity,
  Tags,
  LayoutGrid,
  Archive,
} from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { useCommandPalette } from "@/hooks/useCommandPalette";
import { useAuth } from "@/contexts/AuthContext";
import { useClients } from "@/hooks/useClients";
import { useNavigatorProjects } from "@/hooks/useNavigatorProjects";
import { useSeerRouteContext } from "@/hooks/useSeerRouteContext";
import { useCanArchive } from "@/hooks/useCanArchive";
import { useArchivedClients } from "@/hooks/useArchive";
import {
  dashboardPath,
  clientsPath,
  clientHome,
  newClientProject,
  audienceInsightsPath,
  urlMonitorPath,
  captureWindowPath,
  globalContentPlansPath,
  projectHome,
  projectView,
  archivePath,
  archiveClient,
  PROJECT_VIEW_KEYS,
  type ProjectViewKey,
} from "@/lib/routes";

const RECENT_KEY_V2 = "seer:recent-nav:v2";
const RECENT_KEY_LEGACY = "seer:recent-nav";
const RECENT_MAX = 8;

type RecentKind = "client" | "project" | "project-view" | "global" | "admin" | "tool";

interface RecentItem {
  label: string;
  path: string;
  clientName?: string;
  projectName?: string;
  kind?: RecentKind;
}

function isRecentItem(value: unknown): value is RecentItem {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.label !== "string" || typeof v.path !== "string") return false;
  if (v.clientName !== undefined && typeof v.clientName !== "string") return false;
  if (v.projectName !== undefined && typeof v.projectName !== "string") return false;
  if (v.kind !== undefined && typeof v.kind !== "string") return false;
  return true;
}

function readRecents(): RecentItem[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY_V2);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isRecentItem) : [];
  } catch {
    return [];
  }
}

function writeRecents(list: RecentItem[]) {
  try {
    localStorage.setItem(RECENT_KEY_V2, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch {
    /* ignore */
  }
}

function pushRecent(item: RecentItem) {
  const list = readRecents();
  const next = [item, ...list.filter((i) => i.path !== item.path)].slice(0, RECENT_MAX);
  writeRecents(next);
}

// One-time migration of legacy recents → v2. Discards malformed entries silently.
function migrateLegacyRecents() {
  try {
    if (localStorage.getItem(RECENT_KEY_V2) !== null) {
      // v2 already initialised — still clear legacy if present so we never read it again.
      if (localStorage.getItem(RECENT_KEY_LEGACY) !== null) {
        localStorage.removeItem(RECENT_KEY_LEGACY);
      }
      return;
    }
    const raw = localStorage.getItem(RECENT_KEY_LEGACY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const migrated: RecentItem[] = Array.isArray(parsed) ? parsed.filter(isRecentItem) : [];
    writeRecents(migrated);
    localStorage.removeItem(RECENT_KEY_LEGACY);
  } catch {
    /* ignore */
  }
}

const PROJECT_VIEW_LABELS: Record<ProjectViewKey, string> = {
  overview: "Project Overview",
  setup: "Setup",
  serpsBacklinks: "SERPs & Backlinks",
  rankingUrlsTp: "Ranking URLs & TP",
  forecast: "Forecast",
  siteArchitecture: "Site Architecture",
  roadmap: "Roadmap",
  contentPlans: "Project Content Plans",
};

export function CommandPalette() {
  const { open, setOpen } = useCommandPalette();
  const navigate = useNavigate();
  const { canEdit, canManageUsers } = useAuth();
  const { canArchive } = useCanArchive();
  const route = useSeerRouteContext();

  // Migrate once per session.
  useEffect(() => {
    migrateLegacyRecents();
  }, []);

  const { clients } = useClients();
  const { projects } = useNavigatorProjects({ enabled: open });
  const { clients: archivedClients } = useArchivedClients();

  const recents = useMemo(() => (open ? readRecents() : []), [open]);

  const go = (item: RecentItem) => {
    pushRecent(item);
    setOpen(false);
    navigate(item.path);
  };

  // Resolve the active project context (from URL) for "Project Views" group.
  const activeClientId = route.clientId ?? null;
  const activeProjectId = route.projectId ?? null;
  const activeProject = useMemo(() => {
    if (!activeProjectId) return null;
    return projects.find((p) => p.id === activeProjectId) ?? null;
  }, [projects, activeProjectId]);
  const activeClient = useMemo(() => {
    if (!activeClientId) return null;
    return clients.find((c) => c.id === activeClientId) ?? null;
  }, [clients, activeClientId]);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search clients, projects, views, pages…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        {recents.length > 0 && (
          <>
            <CommandGroup heading="Recent">
              {recents.map((r) => (
                <CommandItem
                  key={`recent-${r.path}`}
                  value={`recent ${r.label} ${r.clientName ?? ""} ${r.projectName ?? ""}`}
                  onSelect={() => go(r)}
                >
                  <ArrowRight className="mr-2 h-4 w-4 text-muted-foreground" />
                  <span className="flex-1 truncate">{r.label}</span>
                  {(r.projectName || r.clientName) && (
                    <span className="ml-2 truncate text-xs text-muted-foreground">
                      {[r.clientName, r.projectName].filter(Boolean).join(" · ")}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        {clients && clients.length > 0 && (
          <CommandGroup heading="Clients">
            {clients.slice(0, 8).map((c) => (
              <CommandItem
                key={`client-${c.id}`}
                value={`client ${c.company_name} ${c.domain ?? ""}`}
                onSelect={() =>
                  go({
                    label: c.company_name,
                    path: clientHome(c.id),
                    clientName: c.company_name,
                    kind: "client",
                  })
                }
              >
                <Building2 className="mr-2 h-4 w-4 text-muted-foreground" />
                <span className="flex-1 truncate">{c.company_name}</span>
                {c.domain && (
                  <span className="ml-2 truncate text-xs text-muted-foreground">{c.domain}</span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {projects && projects.length > 0 && (
          <CommandGroup heading="Projects">
            {projects.slice(0, 10).map((p) => (
              <CommandItem
                key={`project-${p.id}`}
                value={`project ${p.project_name} ${p.client_name ?? ""}`}
                onSelect={() =>
                  go({
                    label: p.project_name,
                    path: projectHome(p.client_id, p.id),
                    clientName: p.client_name ?? undefined,
                    projectName: p.project_name,
                    kind: "project",
                  })
                }
              >
                <Eye className="mr-2 h-4 w-4 text-muted-foreground" />
                <span className="flex-1 truncate">{p.project_name}</span>
                {p.client_name && (
                  <span className="ml-2 truncate text-xs text-muted-foreground">{p.client_name}</span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {activeClientId && activeProjectId && (
          <CommandGroup
            heading={
              activeProject?.project_name
                ? `Project Views · ${activeProject.project_name}`
                : "Project Views"
            }
          >
            {PROJECT_VIEW_KEYS.map((view) => (
              <CommandItem
                key={`pv-${view}`}
                value={`project view ${PROJECT_VIEW_LABELS[view]} ${activeProject?.project_name ?? ""}`}
                onSelect={() =>
                  go({
                    label: PROJECT_VIEW_LABELS[view],
                    path: projectView(activeClientId, activeProjectId, view),
                    clientName: activeClient?.company_name ?? activeProject?.client_name ?? undefined,
                    projectName: activeProject?.project_name,
                    kind: "project-view",
                  })
                }
              >
                <LayoutGrid className="mr-2 h-4 w-4 text-muted-foreground" />
                {PROJECT_VIEW_LABELS[view]}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        <CommandSeparator />

        <CommandGroup heading="Global Navigation">
          <CommandItem
            value="nav dashboard briefing"
            onSelect={() => go({ label: "Dashboard", path: dashboardPath(), kind: "global" })}
          >
            <LayoutDashboard className="mr-2 h-4 w-4" />
            Dashboard
          </CommandItem>
          <CommandItem
            value="nav clients"
            onSelect={() => go({ label: "Clients", path: clientsPath(), kind: "global" })}
          >
            <Building2 className="mr-2 h-4 w-4" />
            Clients
          </CommandItem>
          <CommandItem
            value="nav capture window content opportunities"
            onSelect={() =>
              go({ label: "Content Opportunities", path: captureWindowPath(), kind: "global" })
            }
          >
            <CalendarClock className="mr-2 h-4 w-4" />
            Content Opportunities
          </CommandItem>
          <CommandItem
            value="nav content plans"
            onSelect={() =>
              go({ label: "Content Plans", path: globalContentPlansPath(), kind: "global" })
            }
          >
            <FileText className="mr-2 h-4 w-4" />
            Content Plans
          </CommandItem>
          <CommandItem
            value="nav url monitor"
            onSelect={() => go({ label: "URL Monitor", path: urlMonitorPath(), kind: "global" })}
          >
            <Activity className="mr-2 h-4 w-4" />
            URL Monitor
          </CommandItem>
          <CommandItem
            value="nav audience insights"
            onSelect={() =>
              go({ label: "Audience Insights", path: audienceInsightsPath(), kind: "global" })
            }
          >
            <Users className="mr-2 h-4 w-4" />
            Audience Insights
          </CommandItem>
          <CommandItem
            value="nav account settings"
            onSelect={() => go({ label: "Account", path: "/account", kind: "global" })}
          >
            <UserIcon className="mr-2 h-4 w-4" />
            Account
          </CommandItem>
        </CommandGroup>

        {(canEdit || canManageUsers) && (
          <>
            <CommandSeparator />

            <CommandGroup heading="Admin">
              {canEdit && (
                <CommandItem
                  value="admin reference data"
                  onSelect={() =>
                    go({ label: "Reference Data", path: "/reference-data", kind: "admin" })
                  }
                >
                  <Database className="mr-2 h-4 w-4" />
                  Reference Data
                </CommandItem>
              )}
              {canManageUsers && (
                <CommandItem
                  value="admin users"
                  onSelect={() => go({ label: "Users", path: "/admin/users", kind: "admin" })}
                >
                  <Shield className="mr-2 h-4 w-4" />
                  Users
                </CommandItem>
              )}
              {canManageUsers && (
                <CommandItem
                  value="admin categories"
                  onSelect={() => go({ label: "Categories", path: "/admin/categories", kind: "admin" })}
                >
                  <Tags className="mr-2 h-4 w-4" />
                  Categories
                </CommandItem>
              )}
              {canArchive && (
                <CommandItem
                  value="admin archive go to archive"
                  onSelect={() => go({ label: "Archive", path: archivePath(), kind: "admin" })}
                >
                  <Archive className="mr-2 h-4 w-4" />
                  Go to archive
                </CommandItem>
              )}
            </CommandGroup>
          </>
        )}

        {canArchive && archivedClients.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Archived clients">
              {archivedClients.slice(0, 8).map((c) => (
                <CommandItem
                  key={`archived-${c.id}`}
                  value={`archived client ${c.company_name} ${c.domain ?? ""}`}
                  onSelect={() =>
                    go({
                      label: c.company_name,
                      path: archiveClient(c.id),
                      clientName: c.company_name,
                      kind: "admin",
                    })
                  }
                >
                  <Building2 className="mr-2 h-4 w-4 text-muted-foreground" />
                  <span className="flex-1 truncate">{c.company_name}</span>
                  <span className="ml-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                    Archived
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {canEdit && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Quick Actions">
              <CommandItem
                value="action new client"
                onSelect={() => go({ label: "New client", path: "/clients/new", kind: "global" })}
              >
                <Plus className="mr-2 h-4 w-4" />
                New client
              </CommandItem>
              {activeClientId ? (
                <CommandItem
                  value="action new project for current client seer"
                  onSelect={() =>
                    go({
                      label: "New Seer® project (this client)",
                      path: newClientProject(activeClientId),
                      clientName: activeClient?.company_name ?? undefined,
                      kind: "global",
                    })
                  }
                >
                  <Plus className="mr-2 h-4 w-4" />
                  New Seer® project
                  {activeClient?.company_name && (
                    <span className="ml-2 truncate text-xs text-muted-foreground">
                      {activeClient.company_name}
                    </span>
                  )}
                </CommandItem>
              ) : (
                <CommandItem
                  value="action new project seer"
                  onSelect={() =>
                    // TODO(nav-ia): no canonical "new project" route without a client; keep legacy /navigator/new for now.
                    go({ label: "New Seer® project", path: "/navigator/new", kind: "global" })
                  }
                >
                  <Plus className="mr-2 h-4 w-4" />
                  New Seer® project
                </CommandItem>
              )}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
