import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, Plus, Upload, Eye, Trash2, RefreshCw, AlertCircle, AlertTriangle, CheckCircle2, LayoutGrid } from "lucide-react";
import {
  addMonitoredUrls,
  deleteMonitoredUrl,
  getMonitoredUrlHistory,
  getMonitorCampaign,
  getMonitorCampaignHistory,
  resolveMonitorIssue,
  runMonitorCampaign,
  updateMonitorAlerts,
  updateMonitorCampaign,
  type MonitorAlertSettings,
  type MonitorCampaign,
  type MonitoredUrl,
  type UrlMonitorIssue,
  type UrlMonitorSnapshot,
} from "@/integrations/gcp/url-monitor";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import UrlMonitorTrendCharts from "@/components/url-monitor/UrlMonitorTrendCharts";
import UrlMonitorActivityCard from "@/components/url-monitor/UrlMonitorActivityCard";
import { useClientLogoUrl } from "@/hooks/useClientLogoUrl";
import { SeerBreadcrumbs } from "@/components/SeerBreadcrumbs";

type Campaign = MonitorCampaign;
type Snapshot = UrlMonitorSnapshot;
type Issue = UrlMonitorIssue;
type AlertSettings = MonitorAlertSettings;

const statusPill = (status: string | null, code: number | null) => {
  const tone = status === "ok" ? "bg-pos/10 text-pos border-pos/30"
    : status === "warning" ? "bg-warn/10 text-warn border-warn/30"
    : status === "critical" ? "bg-neg/10 text-neg border-neg/30"
    : "bg-muted text-ink-muted border-hairline";
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-xs font-medium ${tone}`}>
      <span className="capitalize">{status || "Unknown"}</span>
      {code !== null && <span className="font-mono opacity-80">{code}</span>}
    </span>
  );
};

export default function UrlMonitorCampaignDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const { data: clientLogoUrl } = useClientLogoUrl(campaign?.clients?.logo_url ?? null);
  const [urls, setUrls] = useState<MonitoredUrl[]>([]);
  const [alertSettings, setAlertSettings] = useState<AlertSettings | null>(null);
  const [openAdd, setOpenAdd] = useState(false);
  const [bulk, setBulk] = useState("");
  const [singleUrl, setSingleUrl] = useState({ url: "", label: "", notes: "" });
  const [activeUrlId, setActiveUrlId] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [running, setRunning] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"all" | "critical" | "warning" | "good">("all");

  const load = async () => {
    if (!id) return;
    const detail = await getMonitorCampaign(id);
    setCampaign(detail.campaign);
    setUrls(detail.urls);
    setAlertSettings(detail.alertSettings);
  };

  useEffect(() => { load(); }, [id]);

  const openDrawer = async (urlId: string) => {
    setActiveUrlId(urlId);
    const history = await getMonitoredUrlHistory(urlId);
    setSnapshots(history.snapshots);
    setIssues(history.issues);
  };

  const addUrls = async (rows: { url: string; label?: string; notes?: string }[]) => {
    if (!id || rows.length === 0) return;

    const submitted = rows.length;
    const seen = new Set<string>();
    const deduped: { url: string; label?: string; notes?: string }[] = [];
    let inListDupes = 0;
    let invalid = 0;
    for (const r of rows) {
      const url = r.url.trim();
      if (!url) { invalid++; continue; }
      try { new URL(url); } catch { invalid++; continue; }
      const key = url.toLowerCase();
      if (seen.has(key)) { inListDupes++; continue; }
      seen.add(key);
      deduped.push({ ...r, url });
    }

    // Check against existing URLs already in this campaign
    const existingSet = new Set(urls.map((u) => u.url.toLowerCase()));
    const toInsert = deduped.filter((r) => !existingSet.has(r.url.toLowerCase()));
    const existingDupes = deduped.length - toInsert.length;

    if (toInsert.length === 0) {
      toast({
        title: "No new URLs to add",
        description: `${submitted} submitted · ${inListDupes} duplicate in list · ${existingDupes} already monitored${invalid ? ` · ${invalid} invalid` : ""}`,
        variant: "destructive",
      });
      return;
    }

    let result;
    try {
      result = await addMonitoredUrls(id, toInsert);
    } catch (error) {
      toast({
        title: "Could not add URLs",
        description: error instanceof Error ? error.message : "The URLs could not be added.",
        variant: "destructive",
      });
      return;
    }
    const added = result.added;
    const removedDupes = inListDupes + existingDupes + result.duplicates;
    invalid += result.invalid;
    const parts: string[] = [];
    if (removedDupes) parts.push(`${removedDupes} duplicate${removedDupes === 1 ? "" : "s"} removed (${inListDupes} in list, ${existingDupes} already monitored)`);
    if (invalid) parts.push(`${invalid} invalid skipped`);
    toast({
      title: `Added ${added} of ${submitted} URL${submitted === 1 ? "" : "s"}`,
      description: parts.join(" · ") || "All URLs were unique.",
    });
    setOpenAdd(false);
    setSingleUrl({ url: "", label: "", notes: "" });
    setBulk("");
    load();
  };

  const handleCsv = async (file: File) => {
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length === 0) return;
    const header = lines[0].toLowerCase().split(",").map((h) => h.trim());
    const urlIdx = header.indexOf("url");
    const labelIdx = header.indexOf("label");
    const notesIdx = header.indexOf("notes");
    if (urlIdx === -1) {
      toast({ title: "CSV missing 'url' header", variant: "destructive" });
      return;
    }
    const rows = lines.slice(1).map((l) => {
      const cols = l.split(",");
      return {
        url: cols[urlIdx]?.trim() || "",
        label: labelIdx >= 0 ? cols[labelIdx]?.trim() : "",
        notes: notesIdx >= 0 ? cols[notesIdx]?.trim() : "",
      };
    }).filter((r) => r.url);
    addUrls(rows);
  };

  const handleBulkPaste = () => {
    const rows = bulk.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((url) => ({ url }));
    addUrls(rows);
  };

  const removeUrl = async (urlId: string) => {
    if (!confirm("Remove this URL from monitoring? History will be deleted.")) return;
    await deleteMonitoredUrl(urlId);
    load();
  };

  const updateAlertSetting = async (patch: Partial<AlertSettings>) => {
    if (!id || !alertSettings) return;
    setAlertSettings({ ...alertSettings, ...patch });
    await updateMonitorAlerts(id, {
      alertOnCritical: patch.alert_on_critical,
      alertOnWarning: patch.alert_on_warning,
      alertOnWatch: patch.alert_on_watch,
      weeklySummary: patch.weekly_summary,
    });
  };

  const updateCampaign = async (patch: Partial<Pick<Campaign, "status" | "check_frequency" | "daily_check_time" | "name" | "description" | "owner">>) => {
    if (!id || !campaign) return;
    setCampaign({ ...campaign, ...patch });
    await updateMonitorCampaign(id, {
      checkFrequency: patch.check_frequency,
      dailyCheckTime: patch.daily_check_time,
      description: patch.description,
      name: patch.name,
      owner: patch.owner,
      status: patch.status,
    });
  };

  const runNow = async () => {
    setRunning(true);
    try {
      const result = await runMonitorCampaign(id as string);
      toast({
        title: "Check completed",
        description: `${result.checked} URL${result.checked === 1 ? "" : "s"} checked.`,
      });
      await load();
    } catch (error) {
      toast({
        title: "Check failed",
        description: error instanceof Error ? error.message : "The URL check failed.",
        variant: "destructive",
      });
    } finally {
      setRunning(false);
    }
  };

  // Latest-run diff summary across all URLs in the campaign (top 2 snapshots per URL).
  const [latestRun, setLatestRun] = useState<{
    checkedAt: string | null;
    counted: number;
    ok: number;
    warning: number;
    critical: number;
    newRedirects: number;
    destinationChanged: number;
    titleChanged: number;
    canonicalChanged: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!id || urls.length === 0) {
        setLatestRun(null);
        return;
      }
      const history = await getMonitorCampaignHistory(id, 90);
      if (cancelled) return;
      const ordered = [...history.snapshots].sort((left, right) =>
        right.checked_at.localeCompare(left.checked_at),
      );
      const byUrl = new Map<string, UrlMonitorSnapshot[]>();
      for (const s of ordered) {
        const arr = byUrl.get(s.monitored_url_id) ?? [];
        if (arr.length < 2) arr.push(s);
        byUrl.set(s.monitored_url_id, arr);
      }
      let checkedAt: string | null = null;
      let counted = 0, ok = 0, warning = 0, critical = 0;
      let newRedirects = 0, destinationChanged = 0, titleChanged = 0, canonicalChanged = 0;
      for (const snaps of byUrl.values()) {
        const latest = snaps[0];
        const prev = snaps[1];
        if (!latest) continue;
        counted++;
        if (!checkedAt || latest.checked_at > checkedAt) checkedAt = latest.checked_at;
        const code = latest.http_status as number | null;
        if (code === null || code >= 400) critical++;
        else if (code >= 300) warning++;
        else ok++;
        if (prev) {
          const prevLen = Array.isArray(prev.redirect_chain) ? prev.redirect_chain.length : 0;
          const newLen = Array.isArray(latest.redirect_chain) ? latest.redirect_chain.length : 0;
          if (newLen > prevLen) newRedirects++;
          if (latest.final_url !== prev.final_url) destinationChanged++;
          if (latest.page_title !== prev.page_title) titleChanged++;
          if (latest.canonical_url !== prev.canonical_url) canonicalChanged++;
        }
      }
      setLatestRun({ checkedAt, counted, ok, warning, critical, newRedirects, destinationChanged, titleChanged, canonicalChanged });
    };
    run();
    return () => { cancelled = true; };
  }, [id, urls]);

  const activeUrl = useMemo(() => urls.find((u) => u.id === activeUrlId), [urls, activeUrlId]);

  if (!campaign) return <div className="text-ink-muted">Loading…</div>;

  const backHref = campaign.client_id
    ? `/tools/url-monitor?clientId=${encodeURIComponent(campaign.client_id)}`
    : "/tools/url-monitor";
  const backLabel = campaign.clients?.company_name
    ? `${campaign.clients.company_name} campaigns`
    : "All campaigns";

  return (
    <div className="space-y-6">
      <SeerBreadcrumbs
        items={[
          { label: "Tools", to: "/tools/url-monitor" },
          { label: "URL Monitor", to: "/tools/url-monitor" },
          ...(campaign.clients?.company_name
            ? [{ label: campaign.clients.company_name, to: backHref }]
            : []),
          { label: campaign.name },
        ]}
      />
      <Button variant="ghost" size="sm" onClick={() => navigate(backHref)} className="-ml-2">
        <ArrowLeft className="h-4 w-4 mr-1" /> Back to {backLabel}
      </Button>

      <header className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-4 min-w-0">
          {clientLogoUrl ? (
            <img
              src={clientLogoUrl}
              alt={`${campaign.clients?.company_name ?? "Client"} logo`}
              className="h-12 w-12 rounded-lg object-contain bg-surface border border-hairline p-1 shrink-0"
            />
          ) : (
            <div className="h-12 w-12 rounded-lg bg-muted border border-hairline shrink-0 flex items-center justify-center text-xs font-semibold text-ink-muted">
              {campaign.clients?.company_name?.slice(0, 2).toUpperCase() ?? "—"}
            </div>
          )}
          <div className="min-w-0">
            <div className="type-eyebrow">{campaign.clients?.company_name}</div>
            <h1 className="type-headline-lg mt-1">{campaign.name}</h1>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <Badge variant={campaign.status === "active" ? "default" : "secondary"} className="capitalize">{campaign.status}</Badge>
              <Badge variant="outline">Every {campaign.check_frequency}{campaign.check_frequency === "24h" ? ` @ ${campaign.daily_check_time.slice(0, 5)} UK` : ""}</Badge>
              {campaign.navigator_projects && (
                <Badge variant="outline" className="gap-1"><Eye className="h-3 w-3" /> {campaign.navigator_projects.project_name}</Badge>
              )}
              {campaign.owner && <span className="text-xs text-ink-muted">Owner: {campaign.owner}</span>}
            </div>
            {campaign.description && <p className="text-sm text-ink-muted mt-2 max-w-2xl">{campaign.description}</p>}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button variant="outline" onClick={runNow} disabled={running}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${running ? "animate-spin" : ""}`} /> Run check now
          </Button>
          {(() => {
            const lastRun = urls
              .map((u) => u.last_checked_at)
              .filter(Boolean)
              .sort()
              .pop();
            return (
              <span className="text-xs text-ink-muted">
                {running
                  ? "Running…"
                  : lastRun
                    ? `Last run ${new Date(lastRun).toLocaleString()}`
                    : "Never run"}
              </span>
            );
          })()}
        </div>
      </header>

      {latestRun && latestRun.counted > 0 && (
        <Card className="p-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div className="type-eyebrow">Latest run</div>
              <div className="text-sm text-ink mt-1">
                {latestRun.checkedAt
                  ? <>Checked <span title={new Date(latestRun.checkedAt).toLocaleString()}>{new Date(latestRun.checkedAt).toLocaleString()}</span> · {latestRun.counted} URL{latestRun.counted === 1 ? "" : "s"}</>
                  : "Awaiting first check"}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-xs font-medium bg-pos/10 text-pos border-pos/30">
                <CheckCircle2 className="h-3 w-3" /> {latestRun.ok} OK
              </span>
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-xs font-medium bg-warn/10 text-warn border-warn/30">
                <AlertTriangle className="h-3 w-3" /> {latestRun.warning} warning
              </span>
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-xs font-medium bg-neg/10 text-neg border-neg/30">
                <AlertCircle className="h-3 w-3" /> {latestRun.critical} critical
              </span>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <DiffPill label="New redirects" value={latestRun.newRedirects} />
            <DiffPill label="Destination changed" value={latestRun.destinationChanged} />
            <DiffPill label="Title changed" value={latestRun.titleChanged} />
            <DiffPill label="Canonical changed" value={latestRun.canonicalChanged} />
          </div>
        </Card>
      )}


      <Tabs defaultValue="urls">
        <TabsList>
          <TabsTrigger value="urls">URLs ({urls.length})</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="urls" className="space-y-3">
          <div className="flex justify-end">
            <Dialog open={openAdd} onOpenChange={setOpenAdd}>
              <DialogTrigger asChild>
                <Button><Plus className="h-4 w-4 mr-1.5" /> Add URLs</Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl">
                <DialogHeader><DialogTitle>Add URLs to monitor</DialogTitle></DialogHeader>
                <Tabs defaultValue="single">
                  <TabsList>
                    <TabsTrigger value="single">Single</TabsTrigger>
                    <TabsTrigger value="paste">Paste list</TabsTrigger>
                    <TabsTrigger value="csv">CSV upload</TabsTrigger>
                  </TabsList>
                  <TabsContent value="single" className="space-y-3 pt-2">
                    <div className="space-y-1.5"><Label>URL *</Label><Input value={singleUrl.url} onChange={(e) => setSingleUrl({ ...singleUrl, url: e.target.value })} placeholder="https://…" /></div>
                    <div className="space-y-1.5"><Label>Label</Label><Input value={singleUrl.label} onChange={(e) => setSingleUrl({ ...singleUrl, label: e.target.value })} /></div>
                    <div className="space-y-1.5"><Label>Notes</Label><Textarea value={singleUrl.notes} onChange={(e) => setSingleUrl({ ...singleUrl, notes: e.target.value })} rows={2} /></div>
                    <DialogFooter><Button onClick={() => addUrls([singleUrl])} disabled={!singleUrl.url}>Add URL</Button></DialogFooter>
                  </TabsContent>
                  <TabsContent value="paste" className="space-y-3 pt-2">
                    <Label>One URL per line</Label>
                    <Textarea rows={8} value={bulk} onChange={(e) => setBulk(e.target.value)} placeholder="https://example.com/a&#10;https://example.com/b" />
                    <DialogFooter><Button onClick={handleBulkPaste} disabled={!bulk.trim()}>Add URLs</Button></DialogFooter>
                  </TabsContent>
                  <TabsContent value="csv" className="space-y-3 pt-2">
                    <p className="text-sm text-ink-muted">Required header row: <code className="font-mono text-xs">url,label,notes</code></p>
                    <label className="block">
                      <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleCsv(f); }} />
                      <div className="border-2 border-dashed border-hairline rounded-lg p-6 text-center cursor-pointer hover:border-signal/50">
                        <Upload className="h-6 w-6 mx-auto text-ink-muted" />
                        <div className="mt-2 text-sm">Click to upload CSV</div>
                      </div>
                    </label>
                  </TabsContent>
                </Tabs>
              </DialogContent>
            </Dialog>
          </div>

          {urls.length === 0 ? (
            <Card className="p-8 text-center text-ink-muted">No URLs yet. Add some to start monitoring.</Card>
          ) : (
            <>
              <UrlMonitorActivityCard campaignId={id!} refreshKey={urls.reduce((acc, u) => acc + (u.last_checked_at ? new Date(u.last_checked_at).getTime() : 0), 0)} />
              <UrlMonitorTrendCharts campaignId={id!} refreshKey={urls.reduce((acc, u) => acc + (u.last_checked_at ? new Date(u.last_checked_at).getTime() : 0), 0)} />
              {(() => {
                const counts = {
                  all: urls.length,
                  critical: urls.filter((u) => u.current_status === "critical").length,
                  warning: urls.filter((u) => u.current_status === "warning").length,
                  good: urls.filter((u) => u.current_status === "ok").length,
                };
                const filterCards = [
                  { key: "all" as const, label: "All", count: counts.all, icon: <LayoutGrid className="h-4 w-4" />, tone: "ink" },
                  { key: "critical" as const, label: "Critical", count: counts.critical, icon: <AlertCircle className="h-4 w-4" />, tone: "neg" },
                  { key: "warning" as const, label: "Warning", count: counts.warning, icon: <AlertTriangle className="h-4 w-4" />, tone: "warn" },
                  { key: "good" as const, label: "Good", count: counts.good, icon: <CheckCircle2 className="h-4 w-4" />, tone: "signal" },
                ];
                const toneClasses: Record<string, { color: string; ring: string }> = {
                  ink: { color: "text-ink", ring: "ring-ink/30" },
                  neg: { color: "text-neg", ring: "ring-neg/40" },
                  warn: { color: "text-warn", ring: "ring-warn/40" },
                  signal: { color: "text-signal", ring: "ring-signal/40" },
                };
                return (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {filterCards.map((c) => {
                      const active = statusFilter === c.key;
                      const t = toneClasses[c.tone];
                      return (
                        <button
                          key={c.key}
                          onClick={() => setStatusFilter(c.key)}
                          className={`rounded-xl border border-hairline bg-surface p-4 text-left transition-all ${
                            active ? `ring-2 ${t.ring}` : "hover:bg-muted/40"
                          }`}
                        >
                          <div className={`flex items-center gap-2 ${t.color}`}>
                            {c.icon}
                            <span className="type-eyebrow">{c.label}</span>
                          </div>
                          <div className={`mt-1 type-display text-[28px] tabular-nums ${t.color}`}>
                            {c.count}
                          </div>
                          <div className="text-[10px] text-ink-muted mt-0.5">URLs</div>
                        </button>
                      );
                    })}
                  </div>
                );
              })()}

              {(() => {
                const filteredUrls = statusFilter === "all"
                  ? urls
                  : statusFilter === "good"
                    ? urls.filter((u) => u.current_status === "ok")
                    : urls.filter((u) => u.current_status === statusFilter);

                if (filteredUrls.length === 0) {
                  return (
                    <Card className="p-8 text-center text-ink-muted text-sm">
                      No URLs in this category.
                    </Card>
                  );
                }

                return (
                  <Card className="divide-y divide-hairline">
                    {filteredUrls.map((u) => (
                      <div key={u.id} className="p-3 flex items-center gap-3 hover:bg-muted/30">
                        <div className="flex-1 min-w-0 cursor-pointer" onClick={() => openDrawer(u.id)}>
                          <div className="flex items-center gap-2">
                            {statusPill(u.current_status, u.current_http_status)}
                            {u.label && <span className="text-xs text-ink-muted">{u.label}</span>}
                          </div>
                          <div className="text-sm font-medium text-ink truncate mt-1">{u.url}</div>
                          <div className="text-xs text-ink-muted mt-0.5">
                            {u.last_checked_at ? `Last checked ${new Date(u.last_checked_at).toLocaleString()}` : "Not checked yet"}
                          </div>
                        </div>
                        <Button variant="ghost" size="icon" onClick={() => removeUrl(u.id)}>
                          <Trash2 className="h-4 w-4 text-ink-muted" />
                        </Button>
                      </div>
                    ))}
                  </Card>
                );
              })()}
            </>
          )}
        </TabsContent>

        <TabsContent value="settings" className="space-y-4">
          <Card className="p-5 space-y-4">
            <h3 className="font-semibold">Schedule</h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Status</Label>
                <select className="w-full border rounded-md px-3 py-2 bg-background text-sm" value={campaign.status} onChange={(e) => updateCampaign({ status: e.target.value })}>
                  <option value="active">Active</option>
                  <option value="paused">Paused</option>
                  <option value="archived">Archived</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label>Cadence</Label>
                <select className="w-full border rounded-md px-3 py-2 bg-background text-sm" value={campaign.check_frequency} onChange={(e) => updateCampaign({ check_frequency: e.target.value })}>
                  <option value="1h">Every hour</option>
                  <option value="6h">Every 6 hours</option>
                  <option value="24h">Daily</option>
                </select>
              </div>
              {campaign.check_frequency === "24h" && (
                <div className="space-y-1.5">
                  <Label>Daily check time (UK)</Label>
                  <Input type="time" value={campaign.daily_check_time.slice(0, 5)} onChange={(e) => updateCampaign({ daily_check_time: `${e.target.value}:00` })} />
                </div>
              )}
            </div>
          </Card>

          {alertSettings && (
            <Card className="p-5 space-y-3">
              <h3 className="font-semibold">Alert preferences</h3>
              <p className="text-xs text-ink-muted">Recipients: all internal team members + view-only users granted access to <strong>{campaign.clients?.company_name}</strong>.</p>
              {[
                { k: "alert_on_critical" as const, label: "Email on critical issues (HTTP errors, page down)" },
                { k: "alert_on_warning" as const, label: "Email on warnings (status code change, new redirect, destination changed)" },
                { k: "alert_on_watch" as const, label: "Email on watch issues (title or canonical changes)" },
                { k: "weekly_summary" as const, label: "Send weekly summary (Mondays 09:00 UK)" },
              ].map((opt) => (
                <div key={opt.k} className="flex items-center justify-between py-1.5">
                  <Label className="text-sm font-normal">{opt.label}</Label>
                  <Switch checked={alertSettings[opt.k]} onCheckedChange={(v) => updateAlertSetting({ [opt.k]: v } as any)} />
                </div>
              ))}
            </Card>
          )}
        </TabsContent>
      </Tabs>

      <Sheet open={!!activeUrlId} onOpenChange={(open) => { if (!open) setActiveUrlId(null); }}>
        <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
          <SheetHeader><SheetTitle className="break-all">{activeUrl?.url}</SheetTitle></SheetHeader>
          {activeUrl && (
            <div className="mt-4 space-y-5">
              <div>
                <div className="type-eyebrow">Current</div>
                <div className="mt-1 flex items-center gap-2">{statusPill(activeUrl.current_status, activeUrl.current_http_status)}</div>
              </div>

              <div>
                <div className="type-eyebrow mb-2">Open issues</div>
                {issues.filter((i) => !i.resolved_at).length === 0 ? (
                  <div className="text-sm text-ink-muted">None</div>
                ) : (
                  <div className="space-y-2">
                    {issues.filter((i) => !i.resolved_at).map((i) => (
                      <div key={i.id} className="flex items-start gap-2 p-2 border border-hairline rounded">
                        {i.severity === "critical" ? <AlertCircle className="h-4 w-4 text-neg mt-0.5" /> : <AlertTriangle className={`h-4 w-4 mt-0.5 ${i.severity === "warning" ? "text-warn" : "text-ink-muted"}`} />}
                        <div className="flex-1 text-xs">
                          <div className="font-medium">{i.issue_type.replace(/_/g, " ")}</div>
                          <div className="text-ink-muted">{new Date(i.detected_at).toLocaleString()}</div>
                          {(i.previous_value || i.current_value) && (
                            <div className="mt-1 truncate"><span className="line-through opacity-60">{i.previous_value || "—"}</span> → <span>{i.current_value || "—"}</span></div>
                          )}
                          <Button size="sm" variant="ghost" className="h-6 text-xs mt-1 px-1" onClick={async () => {
                            await resolveMonitorIssue(i.id);
                            openDrawer(activeUrl.id);
                          }}>Resolve</Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <div className="type-eyebrow mb-2">Latest snapshot</div>
                {snapshots[0] ? (
                  <div className="text-xs space-y-1">
                    <div><span className="text-ink-muted">Status:</span> <span className="font-mono">{snapshots[0].http_status ?? "error"}</span></div>
                    <div><span className="text-ink-muted">Final URL:</span> <span className="break-all">{snapshots[0].final_url || "—"}</span></div>
                    <div><span className="text-ink-muted">Title:</span> {snapshots[0].page_title || "—"}</div>
                    <div><span className="text-ink-muted">Canonical:</span> <span className="break-all">{snapshots[0].canonical_url || "—"}</span></div>
                    <div><span className="text-ink-muted">Response:</span> {snapshots[0].response_time_ms}ms</div>
                    {snapshots[0].error_message && <div className="text-neg">Error: {snapshots[0].error_message}</div>}
                    {Array.isArray(snapshots[0].redirect_chain) && snapshots[0].redirect_chain.length > 1 && (
                      <div className="mt-2">
                        <div className="text-ink-muted">Redirect chain:</div>
                        {snapshots[0].redirect_chain.map((h: any, i: number) => (
                          <div key={i} className="font-mono break-all">{h.status} → {h.url}</div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : <div className="text-sm text-ink-muted">No checks yet</div>}
              </div>

              <div>
                <div className="type-eyebrow mb-2">History ({snapshots.length})</div>
                <div className="space-y-1 max-h-64 overflow-y-auto text-xs">
                  {snapshots.map((s) => (
                    <div key={s.id} className="flex items-center justify-between p-1.5 border-b border-hairline last:border-b-0">
                      <span className="text-ink-muted">{new Date(s.checked_at).toLocaleString()}</span>
                      <span className={`font-mono ${(s.http_status ?? 0) >= 400 || s.http_status === null ? "text-neg" : (s.http_status ?? 0) >= 300 ? "text-warn" : "text-pos"}`}>
                        {s.http_status ?? "ERR"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function DiffPill({ label, value }: { label: string; value: number }) {
  const tone = value > 0 ? "bg-warn/10 text-warn border-warn/30" : "bg-muted text-ink-muted border-hairline";
  return (
    <div className={`rounded-md border px-2 py-1.5 flex items-center justify-between ${tone}`}>
      <span className="truncate">{label}</span>
      <span className="font-mono tabular-nums font-semibold ml-2">{value}</span>
    </div>
  );
}
