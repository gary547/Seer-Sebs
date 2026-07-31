import {
  Building2,
  CalendarClock,
  Eye,
  Users,
  Database,
  Shield,
  Search,
  LayoutDashboard,
  Activity,
  Tags,
  FileText,
  Compass,
  ListChecks,
  BarChart3,
  Sparkles,
  Map as MapIcon,
  Settings,
  Network,
  Archive,
  Cpu,
} from "lucide-react";
import { NavLink } from "@/components/NavLink";
import { useAuth } from "@/contexts/AuthContext";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AccountMenu } from "@/components/AccountMenu";
// Sidebar is STATIC and GLOBAL by design. Client/project context lives in the
// AppLayout header (ClientProjectSwitcher) and the in-project sub-nav.
// Do not introduce client/project-aware items here — see Phase 8 spec.
//
// Phase C exception: the "In context" group below is the *single* sanctioned
// dynamic group. It is driven exclusively by `useSeerRouteContext` (URL is
// the source of truth — no local state, no prop drilling) and only renders
// when both a :clientId and :projectId are present in the URL.
import { useCommandPalette } from "@/hooks/useCommandPalette";
import { useAdminPendingCount } from "@/hooks/useAdminPendingCount";
import { useSeerRouteContext } from "@/hooks/useSeerRouteContext";
import {
  dashboardPath,
  clientsPath,
  captureWindowPath,
  globalContentPlansPath,
  audienceInsightsPath,
  urlMonitorPath,
  archivePath,
  projectView,
  type ProjectViewKey,
} from "@/lib/routes";
import { useCanArchive } from "@/hooks/useCanArchive";
import { Shimmer } from "@/components/ui/shimmer";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
  useSidebar,
} from "@/components/ui/sidebar";

type NavItem = {
  title: string;
  url: string;
  icon: typeof Eye;
  end?: boolean;
  badge?: number;
};

const IN_CONTEXT_VIEWS: Array<{ key: ProjectViewKey; title: string; icon: typeof Eye; end?: boolean }> = [
  { key: "overview", title: "Overview", icon: LayoutDashboard, end: true },
  { key: "setup", title: "Setup", icon: Settings },
  { key: "serpsBacklinks", title: "SERPs & Backlinks", icon: Network },
  { key: "rankingUrlsTp", title: "Ranking URLs & TP", icon: ListChecks },
  { key: "forecast", title: "Forecast", icon: BarChart3 },
  { key: "siteArchitecture", title: "Site Architecture", icon: Compass },
  { key: "roadmap", title: "Roadmap", icon: MapIcon },
  { key: "contentPlans", title: "Content Plans", icon: Sparkles },
];

export function AppSidebar() {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const { canEdit, canManageUsers } = useAuth();
  const { setOpen: openPalette } = useCommandPalette();
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const route = useSeerRouteContext();

  // Re-ordered by usage frequency per UX_AUDIT §2.2.
  // URL Monitor is promoted here from the legacy Tools group so the most-used
  // surfaces sit together.
  const workItems: NavItem[] = [
    { title: "Dashboard", url: dashboardPath(), icon: LayoutDashboard, end: true },
    { title: "Clients", url: clientsPath(), icon: Building2, end: true },
    { title: "Content Opportunities", url: captureWindowPath(), icon: CalendarClock, end: true },
    { title: "Content Plans", url: globalContentPlansPath(), icon: FileText },
    { title: "URL Monitor", url: urlMonitorPath(), icon: Activity },
    { title: "Audience Insights", url: audienceInsightsPath(), icon: Users },
  ];

  const { count: pendingCount } = useAdminPendingCount(canManageUsers);

  const { canArchive } = useCanArchive();
  const adminItems: NavItem[] = [
    ...(canEdit ? [{ title: "Reference Data", url: "/reference-data", icon: Database } as NavItem] : []),
    ...(canManageUsers ? [{ title: "Users", url: "/admin/users", icon: Shield, badge: pendingCount } as NavItem] : []),
    ...(canManageUsers ? [{ title: "Categories", url: "/admin/categories", icon: Tags } as NavItem] : []),
    ...(canManageUsers ? [{ title: "Calculations", url: "/admin/calculations", icon: Cpu } as NavItem] : []),
    ...(canArchive ? [{ title: "Archive", url: archivePath(), icon: Archive, end: true } as NavItem] : []),
  ];

  // UX-005 (Phase H3): While the route context is still resolving the active
  // client/project for a deep-linked URL, render the "In context" group as a
  // shimmer block so the sub-nav doesn't flicker in/out during navigation.
  const hasContextUrl = !!route.clientId && !!route.projectId;
  const showInContextLoading =
    hasContextUrl && route.isLoading && !route.accessDenied && !route.notFound;
  const showInContext =
    hasContextUrl &&
    !!route.activeClient &&
    !!route.activeProject &&
    !route.accessDenied &&
    !route.notFound;

  const inContextItems: NavItem[] = showInContext
    ? IN_CONTEXT_VIEWS.map((v) => ({
        title: v.title,
        url: projectView(route.clientId as string, route.projectId as string, v.key),
        icon: v.icon,
        end: v.end,
      }))
    : [];


  const renderItem = (item: NavItem) => (
    <SidebarMenuItem key={item.title}>
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarMenuButton asChild>
            <NavLink
              to={item.url}
              end={item.end}
              className="relative text-ink-muted hover:bg-sidebar-accent hover:text-ink rounded-md transition-all duration-150 font-medium"
              activeClassName="bg-signal-soft text-ink font-semibold rail-signal hover:bg-signal-soft"
            >
              <item.icon className="h-[17px] w-[17px]" />
              {!collapsed && <span className="text-[13px]">{item.title}</span>}
              {!collapsed && item.badge && item.badge > 0 ? (
                <span className="ml-auto inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-amber-500 px-1.5 text-[10px] font-semibold text-white">
                  {item.badge}
                </span>
              ) : null}
              {collapsed && item.badge && item.badge > 0 ? (
                <span className="absolute top-0 right-0 h-2 w-2 rounded-full bg-amber-500" />
              ) : null}
            </NavLink>
          </SidebarMenuButton>
        </TooltipTrigger>
        {collapsed && (
          <TooltipContent side="right" className="text-xs">
            {item.title}{item.badge && item.badge > 0 ? ` · ${item.badge} pending` : ""}
          </TooltipContent>
        )}
      </Tooltip>
    </SidebarMenuItem>
  );

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className={collapsed ? "p-2" : "p-3"}>
        <div
          className={
            collapsed
              ? "flex h-8 items-center justify-center"
              : "flex h-8 items-center px-1"
          }
          aria-label="Seer"
        >
          {collapsed ? (
            <span className="font-serif text-lg leading-none text-foreground">S</span>
          ) : (
            <span className="font-serif text-[18px] leading-none tracking-tight text-foreground">
              Seer<sup className="text-[10px] text-muted-foreground ml-0.5">®</sup>
            </span>
          )}
        </div>
      </SidebarHeader>

      <div className={collapsed ? "px-2 pb-2" : "px-3 pb-2"}>
        {collapsed ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => openPalette(true)}
                className="mx-auto flex h-8 w-8 items-center justify-center rounded-lg text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors"
                aria-label="Search"
              >
                <Search className="h-[18px] w-[18px]" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs">
              Search ({isMac ? "⌘" : "Ctrl"}+K)
            </TooltipContent>
          </Tooltip>
        ) : (
          <button
            onClick={() => openPalette(true)}
            className="flex w-full items-center gap-2 rounded-lg border border-sidebar-foreground/10 bg-sidebar-accent/40 px-2.5 py-1.5 text-left text-xs text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors"
          >
            <Search className="h-3.5 w-3.5" />
            <span className="flex-1">Search…</span>
            <kbd className="rounded border border-sidebar-foreground/15 bg-sidebar/50 px-1.5 py-0.5 text-[10px] font-mono text-sidebar-foreground/50">
              {isMac ? "⌘" : "Ctrl"}K
            </kbd>
          </button>
        )}
      </div>

      <SidebarContent className="px-2 pr-3">
        <SidebarGroup>
          {!collapsed && (
            <SidebarGroupLabel className="px-2 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/40">
              Work
            </SidebarGroupLabel>
          )}
          <SidebarGroupContent>
            <SidebarMenu className="space-y-0.5">{workItems.map(renderItem)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {(showInContext || showInContextLoading) && (
          <>
            {collapsed && <Separator className="my-2 mx-auto w-6 bg-sidebar-foreground/10" />}
            <SidebarGroup>
              {!collapsed && (
                <SidebarGroupLabel
                  className="px-2 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/40 truncate"
                  title={route.activeProject?.project_name ?? undefined}
                >
                  {route.activeProject?.project_name
                    ? `In context · ${route.activeProject.project_name}`
                    : "In context"}
                </SidebarGroupLabel>
              )}
              <SidebarGroupContent>
                {showInContextLoading ? (
                  <div
                    className={collapsed ? "space-y-1.5 py-1" : "space-y-1 px-2 py-1"}
                    aria-busy="true"
                    aria-label="Loading project navigation"
                  >
                    {Array.from({ length: IN_CONTEXT_VIEWS.length }).map((_, i) => (
                      <Shimmer
                        key={i}
                        className={collapsed ? "h-7 w-7 mx-auto" : "h-7 w-full"}
                      />
                    ))}
                  </div>
                ) : (
                  <SidebarMenu className="space-y-0.5">{inContextItems.map(renderItem)}</SidebarMenu>
                )}
              </SidebarGroupContent>
            </SidebarGroup>
          </>
        )}


        {adminItems.length > 0 && (
          <>
            {collapsed && <Separator className="my-2 mx-auto w-6 bg-sidebar-foreground/10" />}
            <SidebarGroup>
              {!collapsed && (
                <SidebarGroupLabel className="px-2 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/40">
                  Data & Admin
                </SidebarGroupLabel>
              )}
              <SidebarGroupContent>
                <SidebarMenu className="space-y-0.5">{adminItems.map(renderItem)}</SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </>
        )}
      </SidebarContent>

      <SidebarFooter className="p-3">
        <Separator className="mb-3" />
        <AccountMenu collapsed={collapsed} />
        {!collapsed && (
          <p className="text-[9px] text-sidebar-foreground/30 mt-2 leading-tight text-left">
            © No Brainer Agency {new Date().getFullYear()}
          </p>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}
