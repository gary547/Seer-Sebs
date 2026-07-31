import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Activity, Plus, AlertTriangle, AlertCircle, Eye, Info } from "lucide-react";
import {
  getUrlMonitorOverview,
  type MonitorCampaign,
  type UrlMonitorOverview,
} from "@/integrations/gcp/url-monitor";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { EditorialSection } from "@/components/briefing/EditorialSection";

type Campaign = MonitorCampaign;

type Kpis = {
  campaigns: number;
  urls: number;
  critical: number;
  warning: number;
  good: number;
};

type IssueRow = UrlMonitorOverview["issues"][number];

const severityBadge = (s: string) => {
  if (s === "critical") return <Badge variant="destructive">Critical</Badge>;
  return <Badge className="bg-warn text-warn-foreground hover:bg-warn">Warning</Badge>;
};

export default function UrlMonitorOverviewPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [issues, setIssues] = useState<IssueRow[]>([]);
  const [kpis, setKpis] = useState<Kpis>({ campaigns: 0, urls: 0, critical: 0, warning: 0, good: 0 });
  const [search, setSearch] = useState("");
  const [severityFilter, setSeverityFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const overview = await getUrlMonitorOverview();
        setCampaigns(overview.campaigns);
        setIssues(overview.issues);
        setKpis(overview.kpis);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const filtered = useMemo(() => {
    return issues.filter((i) => {
      if (severityFilter !== "all" && i.severity !== severityFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!i.monitored_url?.url.toLowerCase().includes(q)
          && !i.monitored_url?.campaign?.name.toLowerCase().includes(q)
          && !i.monitored_url?.campaign?.client?.company_name?.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [issues, severityFilter, search]);

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="type-eyebrow flex items-center gap-2">
            <span>Tools / URL Monitor</span>
            <Badge variant="outline" className="text-[10px] uppercase tracking-wider">Global tool</Badge>
          </div>
          <h1 className="type-headline-lg mt-1 flex items-center gap-2">
            <Activity className="h-5 w-5 text-signal" />
            Campaign URL Monitoring
          </h1>
          <p className="text-sm text-ink-muted mt-1">Track URL status, redirects, and on-page changes across active campaigns.</p>
        </div>
        <Button asChild>
          <Link to="/tools/url-monitor/campaigns/new">
            <Plus className="h-4 w-4 mr-1.5" /> New campaign
          </Link>
        </Button>
      </header>

      <TooltipProvider delayDuration={150}>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {[
            { label: "Campaigns", value: kpis.campaigns, icon: Activity },
            { label: "URLs tracked", value: kpis.urls, icon: Eye },
            { label: "Critical", value: kpis.critical, tone: "critical", tip: "URLs that are currently down or returning an error: HTTP 4xx/5xx, no response, or status changed into an error range." },
            { label: "Warning", value: kpis.warning, tone: "warning", tip: "URLs still resolving but with a meaningful change since the last check: HTTP status changed within the OK range, new redirect added, final destination changed, or page title / canonical URL changed." },
            { label: "Good", value: kpis.good, tone: "good", tip: "URLs currently returning HTTP 200 with no open warning or critical issues." },
          ].map((k) => (
            <Card key={k.label} className="p-4">
              <div className="type-eyebrow flex items-center gap-1.5">
                <span>{k.label}</span>
                {k.tip && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button type="button" className="text-ink-muted hover:text-ink transition-colors" aria-label={`About ${k.label}`}>
                        <Info className="h-3 w-3" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-xs text-xs leading-relaxed">
                      {k.tip}
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
              <div className={`mt-1 type-display text-[28px] tabular-nums ${
                k.tone === "critical" ? "text-neg" : k.tone === "warning" ? "text-warn" : k.tone === "good" ? "text-signal" : "text-ink"
              }`}>
                {k.value}
              </div>
            </Card>
          ))}
        </div>
      </TooltipProvider>

      <EditorialSection eyebrow="Campaigns" title="Active monitoring campaigns">
        {campaigns.length === 0 ? (
          <Card className="p-8 text-center text-ink-muted">
            {loading ? "Loading…" : "No campaigns yet. Create your first one to start monitoring URLs."}
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {campaigns.map((c) => (
              <Link key={c.id} to={`/tools/url-monitor/campaigns/${c.id}`}>
                <Card className="p-4 hover:shadow-raised transition-shadow h-full">
                  <div className="type-eyebrow">{c.clients?.company_name || "—"}</div>
                  <div className="mt-1 font-semibold text-ink truncate">{c.name}</div>
                  <div className="mt-2 flex items-center gap-2 flex-wrap">
                    <Badge variant={c.status === "active" ? "default" : "secondary"} className="capitalize">{c.status}</Badge>
                    <Badge variant="outline">Every {c.check_frequency}</Badge>
                    {c.navigator_projects && (
                      <Badge variant="outline" className="gap-1">
                        <Eye className="h-3 w-3" /> {c.navigator_projects.project_name}
                      </Badge>
                    )}
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </EditorialSection>

      <EditorialSection eyebrow="Issues feed" title="Open URL issues">
        <div className="flex gap-2 mb-3">
          <Input
            placeholder="Search url, campaign, client…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-sm"
          />
          <Select value={severityFilter} onValueChange={setSeverityFilter}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All severities</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
              <SelectItem value="warning">Warning</SelectItem>
              
            </SelectContent>
          </Select>
        </div>
        {filtered.length === 0 ? (
          <Card className="p-6 text-center text-ink-muted text-sm">No open issues.</Card>
        ) : (
          <Card className="divide-y divide-hairline">
            {filtered.map((i) => (
              <div key={i.id} className="p-3 flex items-start gap-3">
                <div className="mt-0.5">
                  {i.severity === "critical"
                    ? <AlertCircle className="h-4 w-4 text-neg" />
                    : <AlertTriangle className={`h-4 w-4 ${i.severity === "warning" ? "text-warn" : "text-ink-muted"}`} />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    {severityBadge(i.severity)}
                    <span className="text-xs text-ink-muted">{i.issue_type.replace(/_/g, " ")}</span>
                    <span className="text-xs text-ink-muted">· {new Date(i.detected_at).toLocaleString()}</span>
                  </div>
                  <Link
                    to={i.monitored_url?.campaign ? `/tools/url-monitor/campaigns/${i.monitored_url.campaign.id}` : "#"}
                    className="block mt-1 text-sm font-medium text-ink truncate hover:text-signal"
                  >
                    {i.monitored_url?.url}
                  </Link>
                  <div className="text-xs text-ink-muted mt-0.5">
                    {i.monitored_url?.campaign?.client?.company_name} · {i.monitored_url?.campaign?.name}
                  </div>
                  {(i.previous_value || i.current_value) && (
                    <div className="text-xs text-ink-muted mt-1 truncate">
                      <span className="line-through">{i.previous_value || "—"}</span>
                      {" → "}
                      <span className="text-ink">{i.current_value || "—"}</span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </Card>
        )}
      </EditorialSection>
    </div>
  );
}
