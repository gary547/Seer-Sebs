import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowUpCircle, Download, ExternalLink } from "lucide-react";
import { toast } from "sonner";

import {
  getContentPlan,
  promoteContentPlanItemToHero,
  updateContentPlanItem,
  type ContentPlanItem,
} from "@/integrations/gcp/content-plans";
import { EditorialSection } from "@/components/briefing/EditorialSection";
import { SeerBreadcrumbs } from "@/components/SeerBreadcrumbs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

const compactGBP = (n: number) =>
  new Intl.NumberFormat("en-GB", { notation: "compact", maximumFractionDigits: 1, style: "currency", currency: "GBP" }).format(n || 0);
const fullGBP = (n: number) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 }).format(n || 0);

const FORMATS = ["hero", "blog", "page", "category", "product"] as const;
const STATUSES = ["queued", "in_progress", "review", "approved", "live", "archived"] as const;

type Item = ContentPlanItem;

function usePlan(planId: string | undefined) {
  return useQuery({
    queryKey: ["content-plan", planId],
    enabled: !!planId,
    queryFn: () => getContentPlan(planId as string),
  });
}

export default function ContentPlanDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const { data, isLoading } = usePlan(id);

  const items = data?.items ?? [];
  const plan = data?.plan;

  const overdue = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return items.filter((it) => it.first_draft_deadline && it.first_draft_deadline < today && it.status !== "live").length;
  }, [items]);

  async function patch(itemId: string, patchData: Partial<Item>) {
    try {
      await updateContentPlanItem(itemId, patchData);
      await qc.invalidateQueries({ queryKey: ["content-plan", id] });
    } catch (updateError) {
      toast.error("Update failed", {
        description:
          updateError instanceof Error
            ? updateError.message
            : "The item could not be updated.",
      });
    }
  }

  async function promoteToHero(itemId: string) {
    try {
      const result = await promoteContentPlanItemToHero(itemId);
      const swapped = result.swappedItemId
        ? items.find((item) => item.id === result.swappedItemId)
        : null;
      toast.success("Promoted to hero", {
        description: swapped
          ? `Swapped with "${swapped.page_title_h1 ?? swapped.primary_keyword_text}"`
          : undefined,
      });
      await qc.invalidateQueries({ queryKey: ["content-plan", id] });
    } catch (promotionError) {
      toast.error("Promotion failed", {
        description:
          promotionError instanceof Error
            ? promotionError.message
            : "The item could not be promoted.",
      });
    }
  }

  function exportXlsx() {
    // CSV export with the existing template columns + new Revenue gain + SERP top 3.
    const header = [
      "Position", "Format", "Action", "Publish month", "First draft deadline",
      "Page title / H1", "Recommended URL", "Primary keyword", "Secondary keywords",
      "Audience", "Journey stage", "Business area", "Responsibility", "Status",
      "Meta title", "Meta description", "Synopsis",
      "Potential revenue gain (£/yr)",
      "SERP rank 1", "SERP rank 2", "SERP rank 3",
    ];
    const lines = [header.map(csv).join(",")];
    for (const it of items) {
      const serp = (it.serp_top3 ?? []) as any[];
      lines.push([
        it.position, it.content_format, it.content_action ?? "",
        it.publish_month ?? "", it.first_draft_deadline ?? "",
        csv(it.page_title_h1 ?? ""), csv(it.recommended_url ?? ""),
        csv(it.primary_keyword_text ?? ""), csv((it.secondary_keyword_text ?? []).join(" | ")),
        csv(it.audience ?? ""), csv(it.journey_stage ?? ""), csv(it.business_area ?? ""),
        csv(it.responsibility ?? ""), it.status,
        csv(it.meta_title ?? ""), csv(it.meta_description ?? ""), csv(it.synopsis ?? ""),
        it.potential_revenue_gain ?? "",
        csv(serp[0]?.url ?? ""), csv(serp[1]?.url ?? ""), csv(serp[2]?.url ?? ""),
      ].join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(plan?.name ?? "content-plan").replace(/\s+/g, "-")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (isLoading) return <div className="p-12 text-center text-ink-muted text-[13px]">Loading plan…</div>;
  if (!plan) return <div className="p-12 text-center text-ink-muted text-[13px]">Plan not found.</div>;

  return (
    <div className="space-y-6 max-w-[1600px] mx-auto pb-12">
      <SeerBreadcrumbs
        items={[
          { label: "Dashboard", to: "/dashboard" },
          { label: "Content Plans", to: "/content-plans" },
          { label: plan.name },
        ]}
      />
      <div>
        <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2">
          <Link to="/content-plans"><ArrowLeft className="h-3.5 w-3.5" /> All content plans</Link>
        </Button>
        <EditorialSection
          eyebrow={<span>{plan.clients?.company_name} · {plan.navigator_projects?.project_name}</span>}
          title={plan.name}
          dek={`${items.length} pieces · ${plan.status} · briefed by default`}
          bare
          actions={
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-[10.5px] uppercase tracking-wider">
                Project: {plan.navigator_projects?.project_name ?? "—"}
              </Badge>
              <Button variant="outline" size="sm" onClick={exportXlsx}><Download className="h-3.5 w-3.5" /> Export CSV</Button>
            </div>
          }
        />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Kpi label="Pieces" value={items.length.toLocaleString()} />
        <Kpi label="Combined rev gain" value={fullGBP(Number(plan.total_revenue_gain ?? 0))} />
        <Kpi label="Overdue" value={overdue.toLocaleString()} />
        <Kpi label="Hero / Blog / Page / Cat / PDP" value={
          ["hero", "blog", "page", "category", "product"].map((f) => items.filter((i: any) => i.content_format === f).length).join(" / ")
        } />
      </div>

      <div className="rounded-xl border border-hairline bg-surface shadow-card overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead className="bg-secondary/40 text-[10.5px] uppercase tracking-wider text-ink-muted">
            <tr>
              <th className="px-3 py-2 text-left w-10">#</th>
              <th className="px-3 py-2 text-left">Format</th>
              <th className="px-3 py-2 text-left">Title / H1</th>
              <th className="px-3 py-2 text-left">Primary keyword</th>
              <th className="px-3 py-2 text-left">URL</th>
              <th className="px-3 py-2 text-right">Rev gain (£/yr)</th>
              <th className="px-3 py-2 text-left">SERP top 3</th>
              <th className="px-3 py-2 text-left">Synopsis (sections + gaps)</th>
              <th className="px-3 py-2 text-left">Journey</th>
              <th className="px-3 py-2 text-left">Draft by</th>
              <th className="px-3 py-2 text-left">Publish</th>
              <th className="px-3 py-2 text-left">Owner</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id} className="border-t border-hairline align-top hover:bg-secondary/20">
                <td className="px-3 py-3 text-ink-muted tabular-nums">{it.position}</td>
                <td className="px-3 py-3">
                  <Select value={it.content_format} onValueChange={(v) => patch(it.id, { content_format: v })}>
                    <SelectTrigger className="h-8 w-[110px] text-[12px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {FORMATS.map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {it.hero_promoted && <Badge variant="outline" className="mt-1 text-[9.5px]">promoted</Badge>}
                </td>
                <td className="px-3 py-3 max-w-[280px]">
                  <Input
                    defaultValue={it.page_title_h1 ?? ""}
                    onBlur={(e) => e.target.value !== (it.page_title_h1 ?? "") && patch(it.id, { page_title_h1: e.target.value })}
                    className="h-8 text-[12.5px]"
                  />
                  {it.meta_title && <p className="text-[11px] text-ink-muted mt-1 truncate" title={it.meta_title}>Meta: {it.meta_title}</p>}
                </td>
                <td className="px-3 py-3 max-w-[180px]">
                  <div className="text-ink">{it.primary_keyword_text}</div>
                  {it.secondary_keyword_text?.length > 0 && (
                    <div className="text-[10.5px] text-ink-muted mt-0.5 line-clamp-2">+ {it.secondary_keyword_text.join(", ")}</div>
                  )}
                </td>
                <td className="px-3 py-3 max-w-[180px]">
                  {it.recommended_url ? (
                    <a href={it.recommended_url} target="_blank" rel="noreferrer" className="text-[11.5px] text-signal-ink hover:underline truncate inline-flex items-center gap-1 max-w-full">
                      <span className="truncate">{it.recommended_url}</span><ExternalLink className="h-2.5 w-2.5 shrink-0" />
                    </a>
                  ) : <span className="text-ink-muted text-[11.5px]">—</span>}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">
                  {it.potential_revenue_gain ? compactGBP(Number(it.potential_revenue_gain)) : <span className="text-ink-muted">—</span>}
                </td>
                <td className="px-3 py-3 max-w-[200px]">
                  <ul className="space-y-1">
                    {((it.serp_top3 ?? []) as any[]).slice(0, 3).map((s: any, i: number) => (
                      <li key={i} className="text-[10.5px] text-ink-muted flex items-start gap-1">
                        <span className="font-mono text-ink-muted/70 shrink-0">{i + 1}.</span>
                        <a href={s.url} target="_blank" rel="noreferrer" className="hover:text-signal-ink truncate" title={s.title}>{s.domain ?? s.url}</a>
                      </li>
                    ))}
                    {(!it.serp_top3 || (it.serp_top3 as any[]).length === 0) && <li className="text-[10.5px] text-ink-muted">—</li>}
                  </ul>
                </td>
                <td className="px-3 py-3 max-w-[320px]">
                  <Textarea
                    defaultValue={it.synopsis ?? ""}
                    onBlur={(e) => e.target.value !== (it.synopsis ?? "") && patch(it.id, { synopsis: e.target.value })}
                    className="min-h-[80px] text-[11.5px] leading-snug"
                  />
                </td>
                <td className="px-3 py-3 text-[11.5px]">{it.journey_stage ?? "—"}</td>
                <td className="px-3 py-3">
                  <Input type="date" defaultValue={it.first_draft_deadline ?? ""} onBlur={(e) => e.target.value !== (it.first_draft_deadline ?? "") && patch(it.id, { first_draft_deadline: e.target.value || null })} className="h-8 text-[11.5px] w-[130px]" />
                </td>
                <td className="px-3 py-3">
                  <Input type="date" defaultValue={it.publish_month ?? ""} onBlur={(e) => e.target.value !== (it.publish_month ?? "") && patch(it.id, { publish_month: e.target.value || null })} className="h-8 text-[11.5px] w-[130px]" />
                </td>
                <td className="px-3 py-3">
                  <Input defaultValue={it.responsibility ?? ""} onBlur={(e) => e.target.value !== (it.responsibility ?? "") && patch(it.id, { responsibility: e.target.value })} className="h-8 text-[11.5px] w-[120px]" placeholder="Owner" />
                </td>
                <td className="px-3 py-3">
                  <Select value={it.status} onValueChange={(v) => patch(it.id, { status: v })}>
                    <SelectTrigger className="h-8 w-[120px] text-[12px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </td>
                <td className="px-3 py-3">
                  {it.content_format !== "hero" && (
                    <Button size="sm" variant="ghost" onClick={() => promoteToHero(it.id)} title="Promote to hero">
                      <ArrowUpCircle className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function csv(s: any): string {
  const v = String(s ?? "");
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-hairline bg-surface p-3 shadow-card">
      <div className="text-[10.5px] uppercase tracking-wider text-ink-muted">{label}</div>
      <div className="type-display tabular-nums text-[20px] text-ink leading-tight mt-1">{value}</div>
    </div>
  );
}
