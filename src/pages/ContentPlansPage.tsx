import { useMemo } from "react";
import { Link, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, FileText, Sparkles } from "lucide-react";

import {
  listContentPlans,
  type ContentPlanListItem,
} from "@/integrations/gcp/content-plans";
import {
  getClient,
  getProjectSummary,
} from "@/integrations/gcp/tenancy";
import { EditorialSection } from "@/components/briefing/EditorialSection";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { captureWindowPath } from "@/lib/routes";

const compactGBP = (n: number) =>
  new Intl.NumberFormat("en-GB", { notation: "compact", maximumFractionDigits: 1, style: "currency", currency: "GBP" }).format(n || 0);

function usePlans(projectId?: string) {
  return useQuery({
    queryKey: ["content-plans-list", projectId ?? "all"],
    queryFn: (): Promise<ContentPlanListItem[]> => listContentPlans(projectId),
  });
}

const FORMAT_LABEL: Record<string, string> = { hero: "Hero", blog: "Blog", page: "Page", category: "Category", product: "Product" };

export default function ContentPlansPage() {
  // When rendered under /clients/:clientId/projects/:id/content-plans, scope to that project.
  const params = useParams<{ id?: string; clientId?: string }>();
  const scopedProjectId = params.id;
  const scopedClientId = params.clientId;
  const { data: plans = [], isLoading } = usePlans(scopedProjectId);

  // Resolve display name for the scope badge — single lightweight query.
  const { data: scopeMeta } = useQuery({
    queryKey: ["content-plans-scope", scopedClientId ?? null, scopedProjectId ?? null],
    enabled: !!scopedProjectId || !!scopedClientId,
    queryFn: async () => {
      const [proj, client] = await Promise.all([
        scopedProjectId
          ? getProjectSummary(scopedProjectId)
          : Promise.resolve(null),
        scopedClientId
          ? getClient(scopedClientId)
          : Promise.resolve(null),
      ]);
      return {
        projectName: proj?.project_name,
        clientName: client?.company_name,
      };
    },
  });

  const scopeBadge = scopedProjectId
    ? `Project: ${scopeMeta?.projectName ?? "…"}`
    : scopedClientId
      ? `Client: ${scopeMeta?.clientName ?? "…"}`
      : "Global";

  const captureHref = captureWindowPath(scopedClientId ? { clientId: scopedClientId } : undefined);

  const totalRevenue = useMemo(() => plans.reduce((s, p) => s + (p.total_revenue_gain ?? 0), 0), [plans]);

  return (
    <div className="space-y-6 max-w-[1400px] mx-auto pb-12">
      <EditorialSection
        eyebrow={<span className="inline-flex items-center gap-1.5"><FileText className="h-3 w-3" /> Editorial calendar</span>}
        title={scopedProjectId ? "Content Plans · This project" : "Content Plans"}
        dek={scopedProjectId
          ? "Editorial calendars generated for this project only."
          : "Briefed, dated, SERP-aware editorial calendars built from Capture Window opportunities."}
        bare
        actions={
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10.5px] uppercase tracking-wider">{scopeBadge}</Badge>
            <Button asChild variant="outline" size="sm">
              <Link to={captureHref}>Generate from Content Planner →</Link>
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KpiTile label="Plans" value={plans.length.toLocaleString()} />
        <KpiTile label="Pieces in flight" value={plans.reduce((s, p) => s + p.item_count, 0).toLocaleString()} />
        <KpiTile label="Combined revenue gain" value={compactGBP(totalRevenue)} sub="/ yr at rank 1" />
      </div>

      <div className="rounded-xl border border-hairline bg-surface shadow-card overflow-hidden">
        {isLoading ? (
          <div className="p-12 text-center text-ink-muted text-[13px]">Loading content plans…</div>
        ) : plans.length === 0 ? (
          <div className="p-12 text-center">
            <div className="mx-auto h-10 w-10 rounded-full bg-secondary flex items-center justify-center mb-3">
              <Sparkles className="h-4 w-4 text-ink-muted" />
            </div>
            <p className="text-[13px] text-ink-muted max-w-md mx-auto">
              {scopedProjectId
                ? `No content plans for ${scopeMeta?.projectName ?? "this project"} yet. Open the Content Planner to brief one from this project's keywords.`
                : "No content plans yet. Head to Content Planner, select keywords, and generate a 3-month plan."}
            </p>
            <Button asChild variant="signal" size="sm" className="mt-4">
              <Link to={captureHref}>
                {scopedProjectId
                  ? `Create a content plan for ${scopeMeta?.projectName ?? "this project"}`
                  : "Open Content Planner"}
              </Link>
            </Button>
          </div>
        ) : (
          <ul className="divide-y divide-hairline">
            {plans.map((p) => (
              <li key={p.id}>
                <Link to={`/content-plans/${p.id}`} className="group flex items-center gap-4 p-4 hover:bg-secondary/40 transition-colors">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-ink">{p.name}</span>
                      <Badge variant="outline" className="text-[10px] uppercase tracking-wider">{p.status}</Badge>
                    </div>
                    <p className="text-[12px] text-ink-muted mt-0.5">
                      {p.client_name} · {p.project_name} · {p.item_count} pieces
                      {p.next_deadline ? ` · next deadline ${p.next_deadline}` : ""}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {Object.entries(p.format_mix).map(([k, v]) => (
                        <span key={k} className="text-[10.5px] rounded-full px-2 py-0.5 bg-secondary text-ink-muted">
                          {FORMAT_LABEL[k] ?? k} · {v}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="type-display tabular-nums text-[18px] text-ink">{compactGBP(p.total_revenue_gain ?? 0)}</div>
                    <div className="text-[10.5px] uppercase tracking-wider text-ink-muted">Rev gain</div>
                  </div>
                  <ArrowRight className="h-4 w-4 text-ink-muted group-hover:text-signal-ink transition-colors" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function KpiTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-hairline bg-surface p-4 shadow-card">
      <div className="text-[10.5px] uppercase tracking-wider text-ink-muted">{label}</div>
      <div className="type-display tabular-nums text-[28px] text-ink leading-tight mt-1">{value}</div>
      {sub && <div className="text-[11px] text-ink-muted">{sub}</div>}
    </div>
  );
}
