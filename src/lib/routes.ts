// Canonical route helpers for Seer® navigation IA.
// Pure string builders — no React, no framework coupling.
// The URL is the authoritative source of active client / active project.

export const PROJECT_VIEW_KEYS = [
  "overview",
  "setup",
  "serpsBacklinks",
  "rankingUrlsTp",
  "forecast",
  "siteArchitecture",
  "roadmap",
  "contentPlans",
] as const;

export type ProjectViewKey = (typeof PROJECT_VIEW_KEYS)[number];

export const PROJECT_VIEW_PATHS: Record<ProjectViewKey, string> = {
  overview: "",
  setup: "setup",
  serpsBacklinks: "serps-backlinks",
  rankingUrlsTp: "ranking-urls-tp",
  forecast: "forecast",
  siteArchitecture: "site-architecture",
  roadmap: "roadmap",
  contentPlans: "content-plans",
};

const enc = (v: string) => encodeURIComponent(v);

// Join segments with single slashes, preserving a leading "/".
const join = (...segments: Array<string | undefined | null>): string => {
  const cleaned = segments
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .map((s) => s.replace(/^\/+|\/+$/g, ""))
    .filter((s) => s.length > 0);
  return "/" + cleaned.join("/");
};

// ── Global ──────────────────────────────────────────────────────────────────
export const dashboardPath = (): string => "/dashboard";
export const clientsPath = (): string => "/clients";
export const audienceInsightsPath = (): string => "/audience-insights";
export const urlMonitorPath = (): string => "/tools/url-monitor";
export const globalContentPlansPath = (): string => "/content-plans";
export const contentPlanDetailPath = (contentPlanId: string): string =>
  join("content-plans", enc(contentPlanId));

export const captureWindowPath = (params?: { clientId?: string }): string => {
  const base = "/capture-window";
  if (params?.clientId) {
    return `${base}?clientId=${enc(params.clientId)}`;
  }
  return base;
};

// ── Client-scoped ───────────────────────────────────────────────────────────
export const clientHome = (clientId: string): string => join("clients", enc(clientId));
export const clientEdit = (clientId: string): string => join("clients", enc(clientId), "edit");
export const clientProjects = (clientId: string): string =>
  join("clients", enc(clientId), "projects");
export const newClientProject = (clientId: string): string =>
  join("clients", enc(clientId), "projects", "new");

// ── Project-scoped (Seer® forecasting projects, not URL Monitor campaigns) ──
export const projectHome = (clientId: string, projectId: string): string =>
  join("clients", enc(clientId), "projects", enc(projectId));

export const projectView = (
  clientId: string,
  projectId: string,
  view: ProjectViewKey,
): string => {
  const sub = PROJECT_VIEW_PATHS[view];
  return sub ? join("clients", enc(clientId), "projects", enc(projectId), sub)
             : projectHome(clientId, projectId);
};

// ── Archive (admin / super_admin only) ──────────────────────────────────────
export const archivePath = (): string => "/archive";
export const archiveClient = (clientId: string): string =>
  join("archive", "clients", enc(clientId));
export const archiveClientProject = (clientId: string, projectId: string): string =>
  join("archive", "clients", enc(clientId), "projects", enc(projectId));

// ── Legacy (kept for redirect mapping in later phases) ──────────────────────
export const legacyNavigatorPath = (): string => "/navigator";
export const legacyNavigatorProjectPath = (projectId: string): string =>
  join("navigator", enc(projectId));
