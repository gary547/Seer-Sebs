import { useState, useRef, useEffect, useMemo } from "react";
import { useParams, useNavigate, useLocation } from "react-router";
import { projectView, clientHome, type ProjectViewKey } from "@/lib/routes";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Upload, Zap, Plus, ChevronDown, ChevronUp, Tags, Database, Globe, Clock, Presentation, HelpCircle, Pencil, Mail, LineChart, MoreVertical, Archive, Sliders } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useCanArchive } from "@/hooks/useCanArchive";
import { ArchiveProjectDialog } from "@/components/archive/ArchiveProjectDialog";

import CollapsibleSection, { type CollapsibleSectionHandle } from "@/components/navigator/CollapsibleSection";
import { Tooltip as UITooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { exportPerformanceTabToSlides } from "@/lib/exportSlides";
import { format } from "date-fns";
import { toast } from "sonner";
import { Shimmer } from "@/components/ui/shimmer";
import KeywordDetoxResults from "@/components/KeywordDetoxResults";
import KeywordCategorisationResults from "@/components/KeywordCategorisationResults";
import KeywordEnrichmentResults from "@/components/KeywordEnrichmentResults";
import SerpDataSection from "@/components/SerpDataSection";
import CtrCurveSection from "@/components/CtrCurveSection";
import RankingUrlSection from "@/components/RankingUrlSection";
import HarAnalysisSection from "@/components/HarAnalysisSection";
import PerformanceOutputSection from "@/components/PerformanceOutputSection";
import KeywordChallengeSection from "@/components/KeywordChallengeSection";
import PerformanceDashboardSection from "@/components/PerformanceDashboardSection";
import SiteArchitectureSection from "@/components/SiteArchitectureSection";
import SerpReportsSection from "@/components/SerpReportsSection";
import SyncNowPanel from "@/components/SyncNowPanel";
import KeywordSetupCard from "@/components/navigator/KeywordSetupCard";
import BuildProgressPanel from "@/components/navigator/BuildProgressPanel";
import BackgroundJobsRail from "@/components/navigator/BackgroundJobsRail";
import { useNavigatorSync } from "@/hooks/useNavigatorSync";
import { markProjectDirty } from "@/lib/projectSyncState";
import { addKeywordsToProject } from "@/lib/addKeywordsToProject";
import { parseKeywordInput } from "@/lib/parseKeywordInput";
import { useProjectSyncState } from "@/hooks/useProjectSyncState";
import { cn } from "@/lib/utils";
import { useClientLogoUrl } from "@/hooks/useClientLogoUrl";
import { useAuth } from "@/contexts/AuthContext";
import InviteForClientDialog from "@/components/client/InviteForClientDialog";
import ForecastTabHeader from "@/components/forecast/ForecastTabHeader";
import { useProjectNextAction } from "@/hooks/useProjectNextAction";
import { ArrowRight, AlertTriangle } from "lucide-react";
import {
  getProjectSummary,
  updateProject,
} from "@/integrations/gcp/tenancy";
import { getProjectData } from "@/integrations/gcp/project-data";
import {
  decimalToPct,
  pctToDecimal,
} from "@/lib/validation/conversionOverride";


const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const currentYear = new Date().getFullYear();
const YEARS = Array.from({ length: 5 }, (_, i) => currentYear + i);

const splitSeasonDate = (date: string | null | undefined) => {
  if (!date) return { month: "", year: "" };
  const [year, month] = date.split("-");
  return { month: month ?? "", year: year ?? "" };
};

const formatSeasonDate = (month: string, year: string) => {
  if (!month || !year) return null;
  return `${year}-${month}-01`;
};

function MonthYearPicker({
  label,
  month,
  year,
  onMonthChange,
  onYearChange,
}: {
  label: string;
  month: string;
  year: string;
  onMonthChange: (v: string) => void;
  onYearChange: (v: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="grid grid-cols-2 gap-2">
        <Select value={month} onValueChange={onMonthChange}>
          <SelectTrigger>
            <SelectValue placeholder="Month" />
          </SelectTrigger>
          <SelectContent>
            {MONTHS.map((m, i) => (
              <SelectItem key={m} value={String(i + 1).padStart(2, "0")}>{m}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={year} onValueChange={onYearChange}>
          <SelectTrigger>
            <SelectValue placeholder="Year" />
          </SelectTrigger>
          <SelectContent>
            {YEARS.map((y) => (
              <SelectItem key={y} value={String(y)}>{y}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

const STEPS = [
  { key: "setup",            label: "Setup",                       dirtyDomain: "keywords_dirty" as const },
  { key: "serps",            label: "SERPs & Backlinks",           dirtyDomain: "serp_dirty" as const },
  { key: "ranking",          label: "Ranking URLs & TP Keywords",  dirtyDomain: null },
  { key: "forecast",         label: "Forecast",                    dirtyDomain: null },
  { key: "siteArchitecture", label: "Site Architecture",           dirtyDomain: null },
  { key: "roadmap",          label: "Roadmap",                     dirtyDomain: null },
  { key: "contentPlans",     label: "Content Plans",               dirtyDomain: null },
] as const;

type StepKey = (typeof STEPS)[number]["key"];

// URL `:view` segment → internal StepKey. All 7 are first-class tabs now;
// the legacy anchor-redirect for `#site-architecture` is preserved below.
const VIEW_TO_STEP: Record<string, { step: StepKey }> = {
  "setup": { step: "setup" },
  "serps-backlinks": { step: "serps" },
  "ranking-urls-tp": { step: "ranking" },
  "forecast": { step: "forecast" },
  "site-architecture": { step: "siteArchitecture" },
  "roadmap": { step: "roadmap" },
  "content-plans": { step: "contentPlans" },
};

const STEP_TO_VIEW_KEY: Record<StepKey, ProjectViewKey> = {
  setup: "setup",
  serps: "serpsBacklinks",
  ranking: "rankingUrlsTp",
  forecast: "forecast",
  siteArchitecture: "siteArchitecture",
  roadmap: "roadmap",
  contentPlans: "contentPlans",
};

export default function NavigatorProjectDetailPage() {
  const { id, clientId, view } = useParams<{ id: string; clientId: string; view: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { canEdit, canManageUsers, role: callerRole } = useAuth();
  const { canArchive } = useCanArchive();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const overviewRef = useRef<HTMLDivElement>(null);

  // URL is authoritative. Map the trailing :view segment to an internal step.
  const viewMapping = view ? VIEW_TO_STEP[view] : undefined;
  const activeStep: StepKey = viewMapping?.step ?? "setup";

  // Tab/step swaps are replace navigations so the browser back button skips
  // intermediate tabs and returns to the prior non-tab page.
  const goToStep = useMemo(
    () => (key: StepKey) => {
      if (!clientId || !id) return;
      const viewKey = STEP_TO_VIEW_KEY[key];
      navigate(projectView(clientId, id, viewKey), { replace: true });
    },
    [clientId, id, navigate],
  );

  // Legacy hash deep-link (#site-architecture) → canonical route. Still here
  // so email/Slack links saved before Phase B keep landing users on the right
  // tab (now its own first-class entry).
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (location.hash !== "#site-architecture") return;
    if (!clientId || !id) return;
    navigate(projectView(clientId, id, "siteArchitecture"), { replace: true });
  }, [location.hash, clientId, id, navigate]);


  const ctrSectionRef = useRef<CollapsibleSectionHandle>(null);
  const keywordsSectionRef = useRef<CollapsibleSectionHandle>(null);
  const [keywordText, setKeywordText] = useState("");
  const [isSavingKeywords, setIsSavingKeywords] = useState(false);
  const [showInput, setShowInput] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isSavingProject, setIsSavingProject] = useState(false);
  const [editProjectName, setEditProjectName] = useState("");
  const [editCategoryFocus, setEditCategoryFocus] = useState("");
  const [editAov, setEditAov] = useState("");
  const [editConversionRate, setEditConversionRate] = useState("");
  const [editSeasonStartMonth, setEditSeasonStartMonth] = useState("");
  const [editSeasonStartYear, setEditSeasonStartYear] = useState("");
  const [editSeasonEndMonth, setEditSeasonEndMonth] = useState("");
  const [editSeasonEndYear, setEditSeasonEndYear] = useState("");

  const { data: project, isLoading } = useQuery({
    queryKey: ["navigator_project", id],
    queryFn: () => getProjectSummary(id as string),
    enabled: !!id,
  });

  const { data: projectData } = useQuery({
    queryKey: ["project-data", id],
    queryFn: () => getProjectData(id as string),
    enabled: !!id,
  });
  const keptKeywordsCount = projectData?.keywordStatusCounts.keep ?? 0;

  const { data: syncState } = useProjectSyncState(id);
  // First-run flag drives the guided onboarding (setup card + build panel,
  // dimmed downstream tabs). Existing synced projects fall back to today's UI
  // exactly — none of them ever see this branch.
  const isFirstRun = syncState !== undefined && !syncState?.last_synced_at;

  // Lifted shared sync hook — both the header SyncNowPanel and the first-run
  // BuildProgressPanel consume the same state so we can never double-run the
  // pipeline from two surfaces. The pipeline itself is byte-identical to the
  // pre-Section-3 implementation.
  const sharedSync = useNavigatorSync({ projectId: id! });

  const hasForecasts =
    (projectData?.calculationCounts.harForecasts ?? 0) > 0 ||
    (projectData?.calculationCounts.revenueForecasts ?? 0) > 0;

  // Stateful primary action — same source of truth used by ProjectOverviewPage.
  const nextAction = useProjectNextAction(clientId, id);


  // UX-001 (Phase H1): Setup is a destination the user can revisit at will.
  // We intentionally do NOT auto-redirect /setup → /forecast even when the
  // project has forecasts. Project home (`/clients/:clientId/projects/:id`
  // index) already renders ProjectOverviewPage for the "what next" landing.


  const hasKeywords = (projectData?.keywordCount ?? 0) > 0;
  const clientLogoPath = project?.client_logo_url ?? null;
  const { data: clientLogoUrl } = useClientLogoUrl(clientLogoPath);

  useEffect(() => {
    if (!project || !isEditOpen) return;
    const start = splitSeasonDate(project.seasonality_start);
    const end = splitSeasonDate(project.seasonality_end);
    setEditProjectName(project.project_name ?? "");
    setEditCategoryFocus(project.category_focus ?? "");
    setEditAov(project.aov != null ? String(project.aov) : "");
    setEditConversionRate(decimalToPct(project.conversion_rate));
    setEditSeasonStartMonth(start.month);
    setEditSeasonStartYear(start.year);
    setEditSeasonEndMonth(end.month);
    setEditSeasonEndYear(end.year);
  }, [project, isEditOpen]);

  // --- Handlers ---
  const handleCSVUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      // Append raw lines verbatim — parseKeywordInput handles header detection,
      // priority, and pipe-separated categories on save.
      setKeywordText((prev) => (prev ? prev.replace(/\s*$/, "") + "\n" : "") + text.replace(/\r\n/g, "\n").trim());
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  /**
   * Inputs-only handler: inserts user-supplied keywords as `pending` rows and
   * marks the project dirty. Detox itself runs as a phase in Sync Now — there
   * is no longer a per-tab "Run Detox" button.
   */
  const handleSaveKeywords = async () => {
    const parsed = parseKeywordInput(keywordText);
    if (!parsed.rows.length) { toast.error("Paste or upload keywords first"); return; }
    setIsSavingKeywords(true);
    const total = parsed.rows.length;
    const progressToast = total > 2000
      ? toast.loading(`Adding ${total.toLocaleString()} keywords…`)
      : null;
    try {
      const result = await addKeywordsToProject(id!, parsed.rows, {
        onProgress: (done, t) => {
          if (progressToast) {
            toast.loading(`Adding keywords… ${done.toLocaleString()} / ${t.toLocaleString()}`, { id: progressToast });
          }
        },
      });
      if (progressToast) toast.dismiss(progressToast);

      const { inserted, skippedDuplicates, invalid, withPriority, withSeededCategories } = result;
      const extras: string[] = [];
      if (withPriority) extras.push(`${withPriority.toLocaleString()} with priority`);
      if (withSeededCategories) extras.push(`${withSeededCategories.toLocaleString()} with seeded categories`);
      if (parsed.droppedExtraTags) extras.push(`${parsed.droppedExtraTags} line(s) had >3 categories — extras ignored`);
      const extrasStr = extras.length ? ` · ${extras.join(" · ")}` : "";
      const invalidStr = (invalid + parsed.invalidLines) ? ` (${invalid + parsed.invalidLines} invalid entries ignored)` : "";

      if (inserted === 0 && skippedDuplicates > 0) {
        toast.warning(`All ${skippedDuplicates.toLocaleString()} keywords already exist on this project — nothing to add.`);
      } else if (inserted > 0 && skippedDuplicates > 0) {
        toast.success(`Added ${inserted.toLocaleString()} new keywords. ${skippedDuplicates.toLocaleString()} already existed and were skipped.${extrasStr}${invalidStr}`);
      } else if (inserted > 0) {
        toast.success(`Added ${inserted.toLocaleString()} keywords. Press Sync Now to detox & process.${extrasStr}${invalidStr}`);
      } else {
        toast.warning("No valid keywords to add.");
      }

      if (inserted > 0) {
        setKeywordText("");
        setShowInput(false);
        await markProjectDirty(id, ["keywords"]);
        queryClient.invalidateQueries({ queryKey: ["keywords_exist", id] });
        queryClient.invalidateQueries({ queryKey: ["keywords", id] });
        queryClient.invalidateQueries({ queryKey: ["keywords_kept_count", id] });
        queryClient.invalidateQueries({ queryKey: ["project-data", id] });
        queryClient.invalidateQueries({ queryKey: ["project_sync_state", id] });
      }
    } catch (err: any) {
      if (progressToast) toast.dismiss(progressToast);
      toast.error(err.message || "Failed to save keywords");
    } finally {
      setIsSavingKeywords(false);
    }
  };

  const handleExportToSlides = async () => {
    if (!overviewRef.current || !id) return;
    setIsExporting(true);
    const t = toast.loading("Capturing tab and building slide deck…");
    try {
      const result = await exportPerformanceTabToSlides(overviewRef.current, id);
      toast.success("Slide deck created", {
        id: t,
        description: result.name,
        action: {
          label: "Open in Slides",
          onClick: () => window.open(result.url, "_blank"),
        },
      });
    } catch (err: any) {
      toast.error(err.message || "Export failed", { id: t });
    } finally {
      setIsExporting(false);
    }
  };

  const handleSaveProjectDetails = async () => {
    if (!project || !id) return;
    const name = editProjectName.trim();
    if (!name) {
      toast.error("Project name is required");
      return;
    }
    const nextAov = editAov ? Number(editAov) : null;
    const nextConversionRatePct = editConversionRate ? Number(editConversionRate) : null;
    const nextConversionRate = pctToDecimal(editConversionRate);
    if (nextAov != null && nextAov < 0) {
      toast.error("AOV must be 0 or higher");
      return;
    }
    if (
      nextConversionRatePct != null &&
      (nextConversionRatePct < 0 || nextConversionRatePct > 100)
    ) {
      toast.error("Conversion rate must be between 0 and 100");
      return;
    }

    const nextSeasonalityStart = formatSeasonDate(editSeasonStartMonth, editSeasonStartYear);
    const nextSeasonalityEnd = formatSeasonDate(editSeasonEndMonth, editSeasonEndYear);
    const nextCategoryFocus = editCategoryFocus.trim() || null;
    const forecastInputsChanged =
      (project.category_focus ?? null) !== nextCategoryFocus ||
      Number(project.aov ?? NaN) !== Number(nextAov ?? NaN) ||
      Number(project.conversion_rate ?? NaN) !== Number(nextConversionRate ?? NaN) ||
      (project.seasonality_start ?? null) !== nextSeasonalityStart ||
      (project.seasonality_end ?? null) !== nextSeasonalityEnd;

    setIsSavingProject(true);
    try {
      await updateProject(id, {
        aov: nextAov,
        categoryFocus: nextCategoryFocus,
        conversionRate: nextConversionRate,
        projectName: name,
        seasonalityEnd: nextSeasonalityEnd,
        seasonalityStart: nextSeasonalityStart,
      });

      if (forecastInputsChanged && hasKeywords) {
        queryClient.invalidateQueries({ queryKey: ["project_sync_state", id] });
        toast.success("Project updated", { description: "Sync again to refresh forecasts." });
      } else {
        toast.success("Project updated");
      }
      queryClient.invalidateQueries({ queryKey: ["navigator_project", id] });
      setIsEditOpen(false);
    } catch (err: any) {
      toast.error(err.message || "Failed to update project");
    } finally {
      setIsSavingProject(false);
    }
  };

  // --- Loading / Not Found ---
  if (isLoading) {
    return (
      <div className="max-w-6xl mx-auto space-y-4 py-6">
        <Shimmer className="h-8 w-1/3" />
        <Shimmer className="h-12 w-full" />
        <div className="grid grid-cols-3 gap-4">
          <Shimmer className="h-32" />
          <Shimmer className="h-32" />
          <Shimmer className="h-32" />
        </div>
      </div>
    );
  }

  if (!project) {
    return <div className="p-8 text-center text-destructive">Project not found.</div>;
  }

  const clientDomain = project.client_domain;
  const inputVisible = !hasKeywords || showInput;

  return (
    <div className="max-w-6xl mx-auto space-y-0">
      {inviteOpen && (project as any).client_id && (
        <InviteForClientDialog
          clientId={(project as any).client_id}
          callerRole={callerRole}
          onClose={() => setInviteOpen(false)}
        />
      )}
      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Project</DialogTitle>
            <DialogDescription>
              AOV, conversion rate and seasonality affect forecasts. Save changes, then sync again if prompted.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-project-name">Project Name *</Label>
                <Input id="edit-project-name" value={editProjectName} onChange={(e) => setEditProjectName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-category-focus">Category Focus</Label>
                <Input id="edit-category-focus" value={editCategoryFocus} onChange={(e) => setEditCategoryFocus(e.target.value)} placeholder="e.g. Refrigeration" />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <MonthYearPicker label="Seasonality Start" month={editSeasonStartMonth} year={editSeasonStartYear} onMonthChange={setEditSeasonStartMonth} onYearChange={setEditSeasonStartYear} />
              <MonthYearPicker label="Seasonality End" month={editSeasonEndMonth} year={editSeasonEndYear} onMonthChange={setEditSeasonEndMonth} onYearChange={setEditSeasonEndYear} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-aov">Default AOV (£)</Label>
                <Input id="edit-aov" type="number" step="0.01" min="0" value={editAov} onChange={(e) => setEditAov(e.target.value)} placeholder="e.g. 45.00" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-cvr">Default Conversion Rate (%)</Label>
                <Input id="edit-cvr" type="number" step="0.01" min="0" max="100" value={editConversionRate} onChange={(e) => setEditConversionRate(e.target.value)} placeholder="e.g. 2.5" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditOpen(false)} disabled={isSavingProject}>Cancel</Button>
            <Button onClick={handleSaveProjectDetails} disabled={isSavingProject}>{isSavingProject ? "Saving…" : "Save Changes"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Layer 1: Project Header */}
      <div className="sticky top-0 z-10 bg-background/80 backdrop-blur-sm pb-4">
        <div className="flex items-center justify-between gap-2 mb-3">
          <Button variant="ghost" size="sm" onClick={() => navigate(clientId ? `/clients/${clientId}` : "/clients")} className="gap-1 text-muted-foreground">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          <div className="flex items-center gap-2">
            {canEdit && (
              <Button
                onClick={() => setIsEditOpen(true)}
                size="sm"
                variant="outline"
                className="gap-1.5"
                title="Edit Project"
              >
                <Pencil className="h-4 w-4" />
                <span className="hidden sm:inline">Edit Project</span>
              </Button>
            )}
            {canManageUsers && (project as any).client_id && (
              <Button
                onClick={() => setInviteOpen(true)}
                size="sm"
                variant="outline"
                className="gap-1.5"
                title="Invite User"
              >
                <Mail className="h-4 w-4" />
                <span className="hidden sm:inline">Invite User</span>
              </Button>
            )}
            {canManageUsers && (
              <Button
                onClick={() => navigate(`/admin/projects/${project.id}/conversion-overrides`)}
                size="sm"
                variant="outline"
                className="gap-1.5"
                title="Conversion overrides (v2 forecasts)"
              >
                <Sliders className="h-4 w-4" />
                <span className="hidden sm:inline">Overrides</span>
              </Button>
            )}
            {canArchive && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="Project actions" className="h-8 w-8">
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
                    <Archive className="mr-2 h-4 w-4" /> Archive project
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 overflow-hidden rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
              {clientLogoUrl ? (
                <img src={clientLogoUrl} alt={`${project.client_name ?? "Client"} logo`} className="h-full w-full object-contain p-1" />
              ) : (
                <Globe className="h-5 w-5 text-primary" />
              )}
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">{project.project_name}</h1>
              <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                {clientDomain && <span>{clientDomain}</span>}
                {clientDomain && <span>·</span>}
                <Clock className="h-3 w-3" />
                <span>Updated {format(new Date(project.updated_at), "dd MMM yyyy, HH:mm")}</span>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {project.status !== "data collection" && project.status !== "data_collection" && (
              <Badge variant="secondary" className="capitalize text-xs font-medium">
                {project.status}
              </Badge>
            )}
            {activeStep === "forecast" && (
              <Button
                onClick={handleExportToSlides}
                disabled={isExporting}
                size="sm"
                variant="outline"
                className="gap-1.5"
              >
                <Presentation className="h-4 w-4" />
                {isExporting ? "Exporting…" : "Export to Slides"}
              </Button>
            )}
            {nextAction && (
              <Button
                size="sm"
                variant={nextAction.tone === "warn" ? "outline" : "signal"}
                className={`hidden md:inline-flex gap-1.5 ${
                  nextAction.tone === "warn"
                    ? "border-warn/40 text-warn hover:bg-warn/10"
                    : ""
                }`}
                title={nextAction.reason}
                onClick={() => {
                  if (nextAction.triggersSync) {
                    sharedSync.runSync();
                  } else {
                    navigate(nextAction.to);
                  }
                }}
                disabled={nextAction.triggersSync && sharedSync.running}
              >
                {nextAction.tone === "warn" && <AlertTriangle className="h-3.5 w-3.5" />}
                {nextAction.label}
                {!nextAction.triggersSync && <ArrowRight className="h-3.5 w-3.5" />}
              </Button>
            )}
            <SyncNowPanel projectId={project.id} sharedSync={sharedSync} />
          </div>
        </div>

        {/* Background jobs visibility — categorisation, detox, HAR, URL monitor */}
        <div className="mt-3">
          <BackgroundJobsRail projectId={project.id} />
        </div>

        {/* Layer 2: Workflow Stepper — per-tab stale dots mirror the global sync state.
            On first run, steps 2–5 are dimmed with a tooltip until the first build
            completes; the Keywords step (step 1) stays fully interactive. */}
        <div
          className="mt-4 flex gap-0 border-b border-border"
          role="tablist"
          aria-label="Project views"
        >
          {STEPS.map((step, idx) => {
            const isStale = step.dirtyDomain && (syncState as any)?.[step.dirtyDomain] === true;
            const isLockedFirstRun = isFirstRun && idx > 0;
            const isActive = activeStep === step.key;
            const button = (
              <button
                key={step.key}
                onClick={() => goToStep(step.key)}
                disabled={isLockedFirstRun}
                aria-disabled={isLockedFirstRun}
                aria-current={isActive ? "page" : undefined}
                aria-selected={isActive}
                role="tab"
                className={cn(
                  "relative px-4 py-2.5 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm",
                  isActive
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground",
                  isLockedFirstRun && "opacity-40 cursor-not-allowed hover:text-muted-foreground"
                )}
              >
                <span className="flex items-center gap-1.5">
                  <span className={cn(
                    "inline-flex items-center justify-center h-5 w-5 rounded-full text-[10px] font-bold",
                    activeStep === step.key
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground"
                  )} aria-hidden="true">
                    {idx + 1}
                  </span>
                  {step.label}
                  {isStale && (
                    <span
                      title="Inputs changed since last sync"
                      className={cn(
                        "h-1.5 w-1.5 rounded-full bg-warning ring-2 ring-warning/30",
                      )}
                    />
                  )}
                </span>
                {activeStep === step.key && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-t-full" />
                )}
              </button>
            );

            if (isLockedFirstRun) {
              return (
                <TooltipProvider key={step.key}>
                  <UITooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-block">{button}</span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-xs">
                      Available after your first build
                    </TooltipContent>
                  </UITooltip>
                </TooltipProvider>
              );
            }
            return button;
          })}
        </div>
      </div>

      {/* Layer 3: Content Stage */}
      <div className="pt-6">
        {activeStep === "contentPlans" && (
          <div className="mx-auto max-w-2xl rounded-xl border border-hairline bg-surface p-10 text-center">
            <h2 className="font-serif text-2xl text-foreground">Content Plans</h2>
            <p className="mt-3 text-sm text-muted-foreground">
              Scoped content plans for this project are coming soon. In the meantime,
              use the global Content Plans hub.
            </p>
            <button
              type="button"
              onClick={() => navigate("/content-plans")}
              className="mt-5 inline-flex items-center text-sm text-primary hover:underline"
            >
              Open Content Plans →
            </button>
          </div>
        )}
        {activeStep === "siteArchitecture" && (
          <div className="space-y-6">
            <SiteArchitectureSection projectId={id!} />
          </div>
        )}
        {activeStep === "roadmap" && (
          <div className="space-y-6">
            {/* Roadmap to Success generator + history live inside the
                PerformanceDashboardSection. Reused here verbatim so this is
                its dedicated landing surface. */}
            <PerformanceDashboardSection projectId={id!} />
          </div>
        )}
        {activeStep === "forecast" && (
          <div ref={overviewRef} className="space-y-6 bg-background p-2 rounded-lg">
            {/* Above-the-fold recovery card — renders nothing when healthy. */}
            {clientId && (
              <ForecastTabHeader clientId={clientId} projectId={id!} />
            )}

            {/* Project Info Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {[
                { label: "Client", value: project.client_name ?? "—", help: null },
                { label: "Category", value: project.category_focus ?? "—", help: null },
                { label: "AOV", value: project.aov != null ? `£${project.aov}` : "—", help: "Average Order Value: average revenue per converted visitor." },
                { label: "Conv. Rate", value: project.conversion_rate != null ? `${decimalToPct(project.conversion_rate)}%` : "—", help: "Conversion Rate: % of visitors who buy or convert." },
                {
                  label: "Seasonality",
                  value: project.seasonality_start && project.seasonality_end
                    ? `${format(new Date(project.seasonality_start), "MMM yy")} – ${format(new Date(project.seasonality_end), "MMM yy")}`
                    : "—",
                  help: "Reporting window used for monthly volume averages.",
                },
                { label: "Created", value: format(new Date(project.created_at), "dd MMM yyyy"), help: null },
              ].map((d) => (
                <Card key={d.label} className="p-4">
                  <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider flex items-center gap-1">
                    {d.label}
                    {d.help && (
                      <TooltipProvider>
                        <UITooltip>
                          <TooltipTrigger asChild>
                            <HelpCircle className="h-3 w-3 opacity-50 cursor-help" />
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-xs text-xs">{d.help}</TooltipContent>
                        </UITooltip>
                      </TooltipProvider>
                    )}
                  </p>
                  <p className="text-[13px] font-semibold mt-1 whitespace-normal break-words leading-tight">{d.value}</p>
                </Card>
              ))}
            </div>

            {/* Performance Dashboard — summary cards + charts + link profile */}
            <PerformanceDashboardSection projectId={id!} />

            {/* Performance Output — forecast table + score cards */}
            <PerformanceOutputSection projectId={id!} />
          </div>
        )}

        {activeStep === "setup" && (
          <div className="space-y-6">
            {/* First-run guided onboarding. Gated on `last_synced_at IS NULL`
                so existing synced projects never see this UI — they continue
                with today's layout untouched. */}
            {isFirstRun && (
              <>
                {sharedSync.runStartedAt || sharedSync.completedAt ? (
                  <BuildProgressPanel
                    phases={sharedSync.phases}
                    running={sharedSync.running}
                    completedAt={sharedSync.completedAt}
                    runStartedAt={sharedSync.runStartedAt}
                    activePhaseKey={sharedSync.activePhaseKey}
                    activePhaseStartedAt={sharedSync.activePhaseStartedAt}
                    onViewForecast={() => goToStep("forecast")}
                  />
                ) : (
                  <KeywordSetupCard
                    projectId={id!}
                    keptKeywordsCount={keptKeywordsCount}
                    running={sharedSync.running}
                    onConfigureCtr={() => ctrSectionRef.current?.openAndScroll()}
                    onBuild={() => sharedSync.runSync()}
                  />
                )}
              </>
            )}

            {/* Expand / collapse all toolbar */}
            <div className="flex items-center justify-end gap-3 -mb-2 text-xs">
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => {
                  const keys = ["keywords", "ctr", "detox", "categorisation", "enrichment"];
                  for (const k of keys) {
                    try { localStorage.setItem(`seer-setup-sections-${k}:${id}`, "1"); } catch {}
                  }
                  // Force a small reload of state — easiest is to reload the page section refs
                  window.dispatchEvent(new Event("storage"));
                  // Soft refresh: reload to pick up new defaults reliably
                  window.location.reload();
                }}
              >
                Expand all
              </button>
              <span className="text-muted-foreground/40">·</span>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => {
                  const keys = ["keywords", "ctr", "detox", "categorisation", "enrichment"];
                  for (const k of keys) {
                    try { localStorage.setItem(`seer-setup-sections-${k}:${id}`, "0"); } catch {}
                  }
                  window.location.reload();
                }}
              >
                Collapse all
              </button>
            </div>

            {/* Keyword Inputs — paste / upload only. Detox/Categorisation/Enrichment all run via Sync Now. */}
            <CollapsibleSection
              ref={keywordsSectionRef}
              id="keywords"
              storageKey="seer-setup-sections"
              defaultOpen={!hasKeywords}
              icon={<Zap className="h-4 w-4 text-primary" />}
              title="Keyword Inputs"
            >
              <div className="space-y-4">
                <p className="text-xs text-muted-foreground">
                  Paste or upload your keyword list. Detox, categorisation, and enrichment all run automatically when you press
                  {" "}<span className="font-semibold text-foreground">Sync Now</span> in the header.
                </p>
                {hasKeywords && !isSavingKeywords && (
                  <Button variant="outline" size="sm" onClick={() => setShowInput(!showInput)} className="gap-1">
                    <Plus className="h-4 w-4" />
                    Add More Keywords
                    {showInput ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </Button>
                )}
                {inputVisible && !isSavingKeywords && (
                  <>
                    <Textarea
                      placeholder={"One keyword per line. Optionally add priority and your own categories:\n\nwashing machines, primary, Appliances|Laundry|Washing Machines\nsamsung tv 55 inch, secondary, Electronics|Television|Samsung\nhow to clean an oven\ncheap dishwashers, tertiary"}
                      rows={8}
                      value={keywordText}
                      onChange={(e) => setKeywordText(e.target.value)}
                    />
                    <details className="text-xs text-muted-foreground">
                      <summary className="cursor-pointer select-none hover:text-foreground">
                        Format guide — priority &amp; pre-supplied categories (optional)
                      </summary>
                      <div className="mt-2 space-y-2 rounded-md border bg-muted/30 p-3">
                        <p>
                          Each line: <code className="font-mono">keyword, priority, cat1|cat2|cat3</code>
                        </p>
                        <ul className="list-disc pl-5 space-y-1">
                          <li><strong>keyword</strong> — required.</li>
                          <li><strong>priority</strong> — <code>primary</code>, <code>secondary</code>, or <code>tertiary</code>.</li>
                          <li><strong>categories</strong> — pipe-separated. Seer keeps the first 3 and locks them (AI won't overwrite).</li>
                          <li>Lines without commas still work — AI will categorise them.</li>
                        </ul>
                      </div>
                    </details>
                    <div className="flex items-center gap-3">
                      <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                        <Upload className="h-4 w-4 mr-1" />Upload CSV
                      </Button>
                      <input ref={fileInputRef} type="file" accept=".csv,.txt" className="hidden" onChange={handleCSVUpload} />
                      <Button onClick={handleSaveKeywords} disabled={!keywordText.trim()}>
                        <Plus className="h-4 w-4 mr-1" />Save Keywords
                      </Button>
                      {keywordText && (
                        <span className="text-sm text-muted-foreground">
                          {keywordText.split("\n").filter((l) => l.trim()).length} keywords
                        </span>
                      )}
                    </div>
                  </>
                )}
                {isSavingKeywords && (
                  <div className="space-y-2 py-4">
                    <p className="text-sm text-muted-foreground">Saving keywords…</p>
                    <Shimmer className="h-2 w-full" />
                  </div>
                )}
              </div>
            </CollapsibleSection>

            {/* CTR Curve — moved into Setup. Programmatically opened via the
                checklist's "Customise CTR curve" CTA. */}
            <CollapsibleSection
              ref={ctrSectionRef}
              id="ctr"
              storageKey="seer-setup-sections"
              icon={<LineChart className="h-4 w-4 text-primary" />}
              title="CTR Curve"
            >
              <CtrCurveSection projectId={id!} />
            </CollapsibleSection>

            {/* Detox results — read-only */}
            <CollapsibleSection
              id="detox"
              storageKey="seer-setup-sections"
              icon={<Zap className="h-4 w-4 text-primary" />}
              title="Keyword Detox"
            >
              <KeywordDetoxResults projectId={id!} />
            </CollapsibleSection>

            {/* Categorisation results — read-only */}
            <CollapsibleSection
              id="categorisation"
              storageKey="seer-setup-sections"
              icon={<Tags className="h-4 w-4 text-primary" />}
              title="Keyword Categorisation"
              badge={keptKeywordsCount > 0 ? (
                <span className="ml-1 text-xs opacity-70">({keptKeywordsCount} kept)</span>
              ) : null}
            >
              <KeywordCategorisationResults projectId={id!} />
            </CollapsibleSection>

            {/* Enrichment results — read-only */}
            <CollapsibleSection
              id="enrichment"
              storageKey="seer-setup-sections"
              icon={<Database className="h-4 w-4 text-primary" />}
              title="Keyword Enrichment"
            >
              <KeywordEnrichmentResults projectId={id!} summary={null} />
            </CollapsibleSection>
          </div>
        )}

        {activeStep === "serps" && (
          <div className="space-y-6">
            <SerpReportsSection projectId={id!} clientDomain={clientDomain} />
            <SerpDataSection projectId={id!} clientDomain={clientDomain} />
          </div>
        )}

        {activeStep === "ranking" && (
          <div className="space-y-6">
            {/* TP Keywords (HAR analysis) shown first — most important to users. */}
            <HarAnalysisSection projectId={id!} />
            <RankingUrlSection projectId={id!} />
            <KeywordChallengeSection projectId={id!} />
          </div>
        )}

      </div>

      <ArchiveProjectDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        projectId={id ?? null}
        projectName={project?.project_name}
        onArchived={() => {
          if (clientId) navigate(clientHome(clientId));
          else navigate("/clients");
        }}
      />
    </div>
  );
}
