import { useDeferredValue, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Banknote,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Eye,
  Link2,
  Search,
  SlidersHorizontal,
} from "lucide-react";

import {
  calculationFlags,
  type DiagnosticFlag,
  humanise,
} from "@/components/admin/calculationDiagnostics";
import CollapsibleSection from "@/components/navigator/CollapsibleSection";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type CalculationInspectorFilter,
  type CalculationInspectorRow,
  type ForecastScenario,
  getProjectCalculationInspector,
  getProjectLinkPowerInspector,
  type ProjectCalculationSummary,
} from "@/integrations/gcp/calculations";

const PAGE_SIZE = 50;
const SCENARIOS: ForecastScenario[] = [
  "conservative",
  "realistic",
  "stretch",
];
const FILTERS: Array<{ key: CalculationInspectorFilter; label: string }> = [
  { key: "delta", label: "HAR Δ > 2" },
  { key: "overrides", label: "Overrides" },
  { key: "missing_lps", label: "Missing LPS" },
  { key: "synthetic_lps", label: "Synthetic LPS" },
  { key: "clamped", label: "Clamped" },
];

const FLAG_LABELS: Record<DiagnosticFlag, string> = {
  clamped: "Clamped",
  delta: "HAR Δ > 2",
  missing_content_fit: "Missing fit",
  missing_lps: "Missing LPS",
  override: "Override",
  synthetic_lps: "Synthetic LPS",
};

interface Props {
  projectId: string;
  summary: ProjectCalculationSummary | undefined;
}

function number(value: number | null | undefined, digits = 1): string {
  return value == null
    ? "—"
    : new Intl.NumberFormat("en-GB", {
        maximumFractionDigits: digits,
      }).format(value);
}

function money(value: number | null | undefined): string {
  return value == null
    ? "—"
    : new Intl.NumberFormat("en-GB", {
        currency: "GBP",
        maximumFractionDigits: 0,
        notation: Math.abs(value) >= 1_000_000 ? "compact" : "standard",
        style: "currency",
      }).format(value);
}

function percent(value: number | null | undefined): string {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function scenarioLabel(scenario: ForecastScenario): string {
  if (scenario === "conservative") return "Cons.";
  if (scenario === "realistic") return "Real.";
  return "Stretch";
}

function Pager({
  offset,
  setOffset,
  total,
}: {
  offset: number;
  setOffset: (value: number) => void;
  total: number;
}) {
  if (total <= PAGE_SIZE) return null;
  const start = offset + 1;
  const end = Math.min(total, offset + PAGE_SIZE);
  return (
    <div className="flex items-center justify-between border-t border-hairline pt-3 text-xs text-ink-muted">
      <span>
        {start.toLocaleString()}–{end.toLocaleString()} of {total.toLocaleString()}
      </span>
      <div className="flex gap-1">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-8 w-8"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          aria-label="Previous page"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-8 w-8"
          disabled={offset + PAGE_SIZE >= total}
          onClick={() => setOffset(offset + PAGE_SIZE)}
          aria-label="Next page"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function EmptyInspector({ model }: { model: string }) {
  return (
    <div className="rounded-lg border border-dashed border-hairline bg-canvas/50 px-5 py-8 text-center">
      <p className="text-sm font-medium text-ink">No {model} output was persisted</p>
      <p className="mx-auto mt-1 max-w-xl text-xs leading-5 text-ink-muted">
        The latest pipeline may be marked complete, but this model produced no
        inspectable rows. Review the upstream data counts before relying on the run.
      </p>
    </div>
  );
}

function SearchField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="relative w-full max-w-sm">
      <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-ink-muted" />
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Filter by keyword or domain"
        className="h-9 bg-surface pl-9"
      />
    </div>
  );
}

function FlagBadges({ flags }: { flags: DiagnosticFlag[] }) {
  if (flags.length === 0) return <span className="text-xs text-ink-muted">—</span>;
  return (
    <div className="flex min-w-[150px] flex-wrap gap-1">
      {flags.map((flag) => (
        <Badge
          key={flag}
          variant={flag.startsWith("missing") ? "destructive" : "outline"}
          className="whitespace-nowrap text-[10px]"
        >
          {FLAG_LABELS[flag]}
        </Badge>
      ))}
    </div>
  );
}

export default function CalculationInspectors({ projectId, summary }: Props) {
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const [forecastOffset, setForecastOffset] = useState(0);
  const [linkPowerOffset, setLinkPowerOffset] = useState(0);
  const [selected, setSelected] = useState<CalculationInspectorRow | null>(null);
  const [filters, setFilters] = useState<CalculationInspectorFilter[]>([]);

  useEffect(() => {
    setForecastOffset(0);
    setLinkPowerOffset(0);
  }, [deferredSearch, filters, projectId]);

  const forecast = useQuery({
    queryKey: [
      "admin",
      "calculation-inspector",
      projectId,
      deferredSearch,
      filters,
      forecastOffset,
    ],
    queryFn: () =>
      getProjectCalculationInspector(projectId, {
        filters,
        limit: PAGE_SIZE,
        offset: forecastOffset,
        search: deferredSearch,
      }),
    enabled: Boolean(projectId),
  });
  const linkPower = useQuery({
    queryKey: [
      "admin",
      "link-power-inspector",
      projectId,
      deferredSearch,
      linkPowerOffset,
    ],
    queryFn: () =>
      getProjectLinkPowerInspector(projectId, {
        limit: PAGE_SIZE,
        offset: linkPowerOffset,
        search: deferredSearch,
      }),
    enabled: Boolean(projectId),
  });

  const forecastRows = forecast.data?.items ?? [];
  const lpsSummary = linkPower.data?.summary;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="type-eyebrow text-signal">Calculation inspection</div>
          <h2 className="mt-1 text-xl font-semibold text-ink">Model output panels</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-muted">
            Inspect the stored result of the latest successful run. These panels are
            read-only and never trigger or alter calculations.
          </p>
        </div>
        <SearchField value={search} onChange={setSearch} />
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-hairline bg-surface-muted/30 px-3 py-2.5">
        <SlidersHorizontal className="h-4 w-4 text-signal" />
        <span className="mr-1 text-xs font-medium text-ink">Diagnostic filters</span>
        {FILTERS.map((filter) => {
          const active = filters.includes(filter.key);
          return (
            <Button
              key={filter.key}
              type="button"
              size="sm"
              variant={active ? "default" : "outline"}
              className="h-7 px-2.5 text-[11px]"
              aria-pressed={active}
              onClick={() => setFilters((current) => active ? current.filter((value) => value !== filter.key) : [...current, filter.key])}
            >
              {filter.label}
            </Button>
          );
        })}
        {filters.length > 0 && (
          <Button type="button" size="sm" variant="ghost" className="h-7 text-[11px]" onClick={() => setFilters([])}>
            Clear
          </Button>
        )}
      </div>

      <CollapsibleSection
        id="har-inspector"
        storageKey={`seer-admin-calc-sections:${projectId}`}
        title="HAR scenario inspector"
        icon={<BarChart3 className="h-4 w-4 text-signal" />}
        badge={
          <Badge variant={forecast.data?.total ? "secondary" : "destructive"}>
            {(forecast.data?.total ?? 0).toLocaleString()} keywords
          </Badge>
        }
        summary="Attainable ranks, confidence and model inputs"
        defaultOpen
      >
        <div className="pt-4">
          {forecast.isLoading ? (
            <div className="h-40 animate-pulse rounded-lg bg-muted/50" />
          ) : forecast.isError ? (
            <EmptyInspector model="HAR" />
          ) : forecastRows.length === 0 ? (
            <EmptyInspector model="HAR" />
          ) : (
            <div className="space-y-3">
              <div className="overflow-auto rounded-lg border border-hairline">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Keyword</TableHead>
                      <TableHead className="text-right">Base</TableHead>
                      <TableHead className="text-right">V1 HAR</TableHead>
                      {SCENARIOS.map((scenario) => (
                        <TableHead key={scenario} className="text-right">
                          {scenarioLabel(scenario)} HAR
                        </TableHead>
                      ))}
                      <TableHead className="text-right">Client LPS</TableHead>
                      <TableHead className="text-right">Confidence</TableHead>
                      <TableHead>Diagnostics</TableHead>
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {forecastRows.map((row) => {
                      const realistic = row.scenarios.realistic;
                      return (
                        <TableRow key={row.keywordId}>
                          <TableCell>
                            <div className="max-w-[340px] truncate font-medium">{row.keyword}</div>
                            <div className="mt-0.5 text-[11px] uppercase tracking-wide text-ink-muted">
                              {[row.category, row.searchIntent, row.device].filter(Boolean).join(" · ")}
                            </div>
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums">
                            {number(row.baseRank, 0)}
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums">
                            <div>{number(row.harV1, 0)}</div>
                            {row.harIsManualV1 && <div className="text-[10px] text-ink-muted">manual</div>}
                          </TableCell>
                          {SCENARIOS.map((scenario) => (
                            <TableCell key={scenario} className="text-right font-mono tabular-nums">
                              {number(row.scenarios[scenario]?.harPosition, 0)}
                            </TableCell>
                          ))}
                          <TableCell className="text-right font-mono tabular-nums">
                            {number(realistic?.linkPowerScore)}
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums">
                            {percent(realistic?.harConfidence)}
                          </TableCell>
                          <TableCell><FlagBadges flags={calculationFlags(row)} /></TableCell>
                          <TableCell>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => setSelected(row)}
                              aria-label={`Inspect ${row.keyword}`}
                            >
                              <Eye className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              <Pager
                offset={forecastOffset}
                setOffset={setForecastOffset}
                total={forecast.data?.total ?? 0}
              />
            </div>
          )}
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        id="revenue-inspector"
        storageKey={`seer-admin-calc-sections:${projectId}`}
        title="Revenue forecast inspector"
        icon={<Banknote className="h-4 w-4 text-signal" />}
        badge={
          <Badge variant={summary?.revenue.length ? "secondary" : "destructive"}>
            {summary?.revenue.reduce((total, item) => total + item.forecastCount, 0).toLocaleString() ?? "0"} rows
          </Badge>
        }
        summary="Scenario totals and keyword-level forecasts"
      >
        <div className="space-y-4 pt-4">
          <div className="grid gap-2 sm:grid-cols-3">
            {SCENARIOS.map((scenario) => {
              const total = summary?.revenue.find((row) => row.scenario === scenario);
              return (
                <div key={scenario} className="rounded-lg border border-hairline bg-canvas/50 p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                    {scenario}
                  </div>
                  <div className="mt-2 text-xl font-semibold tabular-nums text-ink">
                    {money(total?.expectedIncremental)}
                  </div>
                  <div className="mt-1 text-xs text-ink-muted">Expected annual uplift</div>
                </div>
              );
            })}
          </div>
          {forecastRows.length === 0 ? (
            <EmptyInspector model="revenue" />
          ) : (
            <div className="overflow-auto rounded-lg border border-hairline">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Keyword</TableHead>
                    <TableHead className="text-right">V1 current</TableHead>
                    <TableHead className="text-right">V2 current</TableHead>
                    {SCENARIOS.map((scenario) => (
                      <TableHead key={scenario} className="text-right">
                        {scenarioLabel(scenario)} expected
                      </TableHead>
                    ))}
                    <TableHead className="text-right">V1 uplift</TableHead>
                    <TableHead className="text-right">Real. target</TableHead>
                    <TableHead>Diagnostics</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {forecastRows.map((row) => (
                    <TableRow key={row.keywordId}>
                      <TableCell className="max-w-[340px] truncate font-medium">
                        {row.keyword}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">
                        {money(row.currentRevenueV1)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">
                        {money(row.scenarios.realistic?.currentRevenueAnnual)}
                      </TableCell>
                      {SCENARIOS.map((scenario) => (
                        <TableCell key={scenario} className="text-right font-mono text-xs tabular-nums">
                          {money(row.scenarios[scenario]?.expectedIncrementalAnnual)}
                        </TableCell>
                      ))}
                      <TableCell className="text-right font-mono text-xs tabular-nums">
                        {money(row.targetIncrementalRevenueV1)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">
                        {money(row.scenarios.realistic?.targetAbsoluteRevenueAnnual)}
                      </TableCell>
                      <TableCell><FlagBadges flags={calculationFlags(row)} /></TableCell>
                      <TableCell>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => setSelected(row)}
                          aria-label={`Inspect ${row.keyword}`}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        id="link-power-inspector"
        storageKey={`seer-admin-calc-sections:${projectId}`}
        title="Link Power Score inspector"
        icon={<Link2 className="h-4 w-4 text-signal" />}
        badge={
          <Badge variant={lpsSummary?.scoredCount ? "secondary" : "destructive"}>
            {(lpsSummary?.scoredCount ?? 0).toLocaleString()} scored URLs
          </Badge>
        }
        summary="Authority coverage, score distribution and source rows"
      >
        <div className="space-y-4 pt-4">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-6">
            {[
              ["Scored URLs", number(lpsSummary?.scoredCount, 0)],
              ["Mean", number(lpsSummary?.averageScore)],
              ["P10", number(lpsSummary?.p10)],
              ["Median", number(lpsSummary?.p50)],
              ["P90", number(lpsSummary?.p90)],
              ["Keywords", number(lpsSummary?.keywordCount, 0)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-hairline bg-canvas/50 px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted">{label}</div>
                <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-ink">{value}</div>
              </div>
            ))}
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-lg border border-hairline bg-canvas/40 p-4">
              <div className="text-xs font-semibold text-ink">Confidence distribution</div>
              {lpsSummary ? (
                <div className="mt-3 space-y-2">
                  {(["high", "medium", "low"] as const).map((level) => {
                    const total = lpsSummary.confidence.high + lpsSummary.confidence.medium + lpsSummary.confidence.low;
                    const value = lpsSummary.confidence[level];
                    return (
                      <div key={level} className="grid grid-cols-[70px_1fr_48px] items-center gap-2 text-[11px]">
                        <span className="capitalize text-ink-muted">{level}</span>
                        <div className="h-2 overflow-hidden rounded-full bg-surface-muted"><div className="h-full rounded-full bg-signal" style={{ width: `${total ? (value / total) * 100 : 0}%` }} /></div>
                        <span className="text-right font-mono font-semibold tabular-nums text-ink">{number(value, 0)}</span>
                      </div>
                    );
                  })}
                </div>
              ) : <div className="mt-3 text-xs text-ink-muted">No confidence data.</div>}
            </div>
            <div className="rounded-lg border border-hairline bg-canvas/40 p-4">
              <div className="text-xs font-semibold text-ink">Authority input coverage</div>
              <div className="mt-3 flex flex-wrap gap-2">
                {lpsSummary && Object.entries(lpsSummary.missingComponents).map(([component, count]) => (
                  <Badge key={component} variant={count > 0 ? "destructive" : "secondary"}>
                    {humanise(component)} · {number(count, 0)} missing
                  </Badge>
                ))}
              </div>
            </div>
          </div>

          {linkPower.data?.clientAuthority && (
            <div className="rounded-lg border border-signal/25 bg-signal/5 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-signal">Client authority benchmark</div>
                  <div className="mt-1 font-medium text-ink">{linkPower.data.clientAuthority.domain}</div>
                </div>
                <Badge variant="outline">{humanise(linkPower.data.clientAuthority.metricSource)}</Badge>
              </div>
              <dl className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
                <Detail label="UR" value={number(linkPower.data.clientAuthority.urlRating)} />
                <Detail label="DR" value={number(linkPower.data.clientAuthority.domainRating)} />
                <Detail label="Ahrefs rank" value={number(linkPower.data.clientAuthority.ahrefsRank, 0)} />
                <Detail label="Ref. domains" value={number(linkPower.data.clientAuthority.referringDomains, 0)} />
                <Detail label="Backlinks" value={number(linkPower.data.clientAuthority.backlinks, 0)} />
                <Detail label="Fetched" value={new Date(linkPower.data.clientAuthority.fetchedAt).toLocaleDateString("en-GB")} />
              </dl>
            </div>
          )}

          {(linkPower.data?.domains.length ?? 0) > 0 && (
            <div className="overflow-auto rounded-lg border border-hairline">
              <Table>
                <TableHeader><TableRow><TableHead>Top domain benchmark</TableHead><TableHead className="text-right">Mean LPS</TableHead><TableHead className="text-right">Best rank</TableHead><TableHead className="text-right">Appearances</TableHead></TableRow></TableHeader>
                <TableBody>{linkPower.data?.domains.map((domain) => <TableRow key={domain.domain}><TableCell className="font-medium">{domain.domain} {domain.isClientDomain && <Badge className="ml-2" variant="secondary">Client</Badge>}</TableCell><TableCell className="text-right font-mono">{number(domain.meanScore)}</TableCell><TableCell className="text-right font-mono">{number(domain.bestRank, 0)}</TableCell><TableCell className="text-right font-mono">{number(domain.appearances, 0)}</TableCell></TableRow>)}</TableBody>
              </Table>
            </div>
          )}

          {(linkPower.data?.items.length ?? 0) === 0 ? (
            <EmptyInspector model="Link Power Score" />
          ) : (
            <div className="space-y-3">
              <div className="overflow-auto rounded-lg border border-hairline">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Keyword</TableHead>
                      <TableHead className="text-right">Rank</TableHead>
                      <TableHead>Domain</TableHead>
                      <TableHead className="text-right">LPS</TableHead>
                      <TableHead className="text-right">UR</TableHead>
                      <TableHead className="text-right">DR</TableHead>
                      <TableHead className="text-right">Ref. domains</TableHead>
                      <TableHead className="text-right">Backlinks</TableHead>
                      <TableHead>Confidence</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {linkPower.data?.items.map((row) => (
                      <TableRow key={`${row.keywordId}:${row.url}`}>
                        <TableCell className="max-w-[280px] truncate font-medium">{row.keyword}</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{row.rank}</TableCell>
                        <TableCell>
                          <a
                            href={row.url}
                            target="_blank"
                            rel="noreferrer"
                            className="block max-w-[260px] truncate text-signal hover:underline"
                          >
                            {row.domain}
                          </a>
                        </TableCell>
                        <TableCell className="text-right font-mono font-semibold tabular-nums">{number(row.score)}</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{number(row.urlRating)}</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{number(row.domainRating)}</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{number(row.referringDomains, 0)}</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{number(row.backlinks, 0)}</TableCell>
                        <TableCell><Badge variant="outline">{row.confidence}</Badge></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <Pager
                offset={linkPowerOffset}
                setOffset={setLinkPowerOffset}
                total={linkPower.data?.total ?? 0}
              />
            </div>
          )}
        </div>
      </CollapsibleSection>

      <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-h-[88vh] max-w-5xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{selected?.keyword ?? "Keyword detail"}</DialogTitle>
            <DialogDescription>
              {[selected?.category, selected?.searchIntent, selected?.device].filter(Boolean).join(" · ")} · latest successful run
            </DialogDescription>
          </DialogHeader>
          {selected && (
            <div className="grid gap-3 rounded-lg border border-hairline bg-surface-muted/30 p-4 sm:grid-cols-2 lg:grid-cols-5">
              <Detail label="Base rank" value={number(selected.baseRank, 0)} />
              <Detail label="Legacy HAR" value={number(selected.harV1, 0)} />
              <Detail label="Legacy current" value={money(selected.currentRevenueV1)} />
              <Detail label="Legacy uplift" value={money(selected.targetIncrementalRevenueV1)} />
              <div><div className="text-[11px] text-ink-muted">Diagnostics</div><div className="mt-1"><FlagBadges flags={calculationFlags(selected)} /></div></div>
            </div>
          )}
          <div className="grid gap-3 lg:grid-cols-3">
            {SCENARIOS.map((scenario) => {
              const item = selected?.scenarios[scenario];
              return (
                <div key={scenario} className="rounded-lg border border-hairline bg-canvas/50 p-4">
                  <div className="text-xs font-semibold uppercase tracking-[0.14em] text-signal">{scenario}</div>
                  <dl className="mt-3 space-y-2 text-xs">
                    <Detail label="HAR" value={number(item?.harPosition, 0)} />
                    <Detail label="Confidence" value={percent(item?.harConfidence)} />
                    <Detail label="Attainment" value={percent(item?.rankAttainmentProbability)} />
                    <Detail label="LPS" value={number(item?.linkPowerScore)} />
                    <Detail label="Content fit" value={number(item?.contentFitScore, 2)} />
                    <Detail label="SERP multiplier" value={number(item?.serpVisibilityMultiplier, 3)} />
                    <Detail label="Annual volume" value={number(item?.annualVolume, 0)} />
                    <Detail label="Forward volume" value={number(item?.volumeForward, 0)} />
                    <Detail label="Current revenue" value={money(item?.currentRevenueAnnual)} />
                    <Detail label="Target revenue" value={money(item?.targetAbsoluteRevenueAnnual)} />
                    <Detail label="Expected uplift" value={money(item?.expectedIncrementalAnnual)} />
                    <Detail label="Expected range" value={`${money(item?.expectedIncrementalLowAnnual)} – ${money(item?.expectedIncrementalHighAnnual)}`} />
                    <Detail label="Applied factor" value={number(item?.factorApplied, 3)} />
                    <Detail label="CTR" value={`${percent(item?.ctrNow)} → ${percent(item?.ctrTarget)}`} />
                    <Detail label="HAR model" value={item?.harModelVersion ?? "—"} />
                    <Detail label="Revenue model" value={item?.revenueModelVersion ?? "—"} />
                  </dl>
                  {(item?.warnings.length ?? 0) > 0 && (
                    <div className="mt-4 rounded-md border border-amber-300/70 bg-amber-50 px-3 py-2 text-[11px] leading-4 text-amber-950">
                      <div className="flex items-center gap-1.5 font-semibold"><AlertTriangle className="h-3.5 w-3.5" />Model warnings</div>
                      <div className="mt-1">{item?.warnings.map(humanise).join(" · ")}</div>
                    </div>
                  )}
                  <details className="mt-4">
                    <summary className="cursor-pointer text-xs font-medium text-ink-muted">Raw model explanation</summary>
                    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-ink p-3 font-mono text-[10px] leading-4 text-white">
                      {JSON.stringify(item?.explanation ?? {}, null, 2)}
                    </pre>
                  </details>
                </div>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="font-mono tabular-nums text-ink">{value}</dd>
    </div>
  );
}
