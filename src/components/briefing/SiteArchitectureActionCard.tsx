import * as React from "react";
import { Link } from "react-router";
import { ArrowRight, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import { ShareBar } from "./ShareBar";
import { EditorialSection } from "./EditorialSection";
import { useSiteArchitectureSummary } from "@/hooks/useSiteArchitectureSummary";
import { projectView } from "@/lib/routes";

/**
 * Full-width Site Architecture action queue, modelled on `CaptureWindowCard`.
 * Hero number = total open actions across the portfolio. Right column lists
 * the top 3 clients by action count, each linking into their most recent
 * project's Site Architecture section.
 */
export function SiteArchitectureActionCard() {
  const { data, isLoading } = useSiteArchitectureSummary();

  const totals = data?.totals ?? { gaps: 0, optimise: 0, create: 0, watch: 0, openActions: 0, clientCount: 0 };
  const topClients = data?.topClients ?? [];

  if (!isLoading && totals.openActions === 0) {
    return (
      <EditorialSection
        eyebrow="Site Architecture · Action Queue"
        title="No open Site Architecture actions"
        dek="Actions appear here once a Seer® project has been scored — Gaps, Optimise, Create and Watch counts roll up by client."
        bare
        className="animate-briefing-rise"
      >
        <div className="rounded-xl border border-hairline bg-surface p-6 text-[13px] text-ink-muted">
          Sync a project to refresh Site Architecture scoring.
        </div>
      </EditorialSection>
    );
  }

  const firstLink = topClients[0]
    ? projectView(topClients[0].clientId, topClients[0].latestProjectId, "siteArchitecture")
    : null;

  return (
    <article className="relative overflow-hidden rounded-xl border border-hairline bg-surface shadow-card animate-briefing-rise">
      {/* Brand wash on the right — coral + amber to echo the action tones */}
      <div aria-hidden className="pointer-events-none absolute inset-0 z-0">
        <div
          className="absolute inset-0 opacity-90"
          style={{
            background: [
              "radial-gradient(ellipse 40% 90% at 100% 0%, hsl(9 78% 62% / 0.18), transparent 60%)",
              "radial-gradient(ellipse 35% 80% at 100% 100%, hsl(44 99% 55% / 0.18), transparent 65%)",
            ].join(", "),
          }}
        />
      </div>

      <div className="relative z-10 grid gap-6 p-6 lg:grid-cols-[1.1fr,1fr]">
        {/* Left — hero + 4-cell mini grid */}
        <div className="min-w-0">
          <div className="flex items-center justify-between gap-3">
            <div className="type-eyebrow inline-flex items-center gap-1.5">
              <Layers className="h-3 w-3" /> Site Architecture · Action Queue
            </div>
          </div>

          <div
            className="mt-3 type-display tabular-nums leading-[1] text-[64px] text-ink text-gradient-signal"
            data-tabular
          >
            {isLoading ? "—" : totals.openActions.toLocaleString()}
          </div>
          <p className="mt-2 text-[15px] font-medium text-ink leading-snug">
            open {totals.openActions === 1 ? "action" : "actions"} across{" "}
            <span className="text-signal-ink">
              {totals.clientCount} {totals.clientCount === 1 ? "client" : "clients"}
            </span>
          </p>

          <div className="mt-5 grid grid-cols-4 gap-3 max-w-lg">
            <MiniCell label="Gaps" value={totals.gaps} tone="coral" />
            <MiniCell label="Optimise" value={totals.optimise} tone="amber" />
            <MiniCell label="Create" value={totals.create} tone="coral" />
            <MiniCell label="Watch" value={totals.watch} tone="amber" />
          </div>
        </div>

        {/* Right — top 3 clients */}
        <div className="min-w-0 lg:border-l lg:border-hairline lg:pl-6">
          <div className="type-eyebrow">Top clients by actions</div>
          <ul className="mt-3 divide-y divide-hairline">
            {topClients.length === 0 ? (
              <li className="py-4 text-[12.5px] text-ink-muted">
                {isLoading ? "Loading…" : "No qualifying clients yet."}
              </li>
            ) : (
              topClients.map((c) => (
                <li key={c.clientId}>
                  <Link
                    to={projectView(c.clientId, c.latestProjectId, "siteArchitecture")}
                    className="group/row flex items-center gap-3 py-2.5 text-ink hover:text-signal transition-colors"
                  >
                    <ArrowRight className="h-3.5 w-3.5 text-ink-muted group-hover/row:text-signal group-hover/row:translate-x-0.5 transition-all" />
                    <span className="flex-1 truncate text-[13px] font-medium">{c.clientName}</span>
                    <span className="type-mono text-[12px] font-semibold tabular-nums text-ink shrink-0">
                      {c.total.toLocaleString()}
                    </span>
                    <ShareBar share={c.sharePct} width={72} />
                  </Link>
                </li>
              ))
            )}
          </ul>

          {firstLink && (
            <Link
              to={firstLink}
              className="group mt-4 inline-flex items-center gap-1.5 text-[12px] font-semibold text-signal-ink hover:text-signal transition-colors"
            >
              View Site Architecture by client
              <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
            </Link>
          )}
        </div>
      </div>
    </article>
  );
}

function MiniCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "coral" | "amber";
}) {
  const valueClass =
    tone === "coral" ? "text-[hsl(var(--signal-2))]" : "text-[hsl(var(--signal-3))]";
  return (
    <div className="rounded-md border border-hairline bg-surface px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.12em] text-ink-muted font-semibold">
        {label}
      </div>
      <div className={cn("type-display tabular-nums text-[20px] leading-tight mt-1", valueClass)}>
        {value.toLocaleString()}
      </div>
    </div>
  );
}
