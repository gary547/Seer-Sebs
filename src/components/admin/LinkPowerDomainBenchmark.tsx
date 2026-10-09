import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Download } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { downloadLinkPowerDomains, getProjectLinkPowerDomains, type DomainSort, type DomainDirection } from "@/integrations/gcp/link-power-domains";

const PAGE_SIZE = 10;
const number = (value: number, digits = 1) => new Intl.NumberFormat("en-GB", { maximumFractionDigits: digits }).format(value);

export default function LinkPowerDomainBenchmark({ projectId, runId }: { projectId: string; runId: string }) {
  const [sort, setSort] = useState<DomainSort>("meanScore");
  const [direction, setDirection] = useState<DomainDirection>("desc");
  const [offset, setOffset] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const benchmark = useQuery({
    queryKey: ["admin", "link-power-domains", projectId, runId, sort, direction, offset],
    queryFn: () => getProjectLinkPowerDomains(projectId, { runId, sort, direction, limit: PAGE_SIZE, offset }),
  });
  const total = benchmark.data?.total ?? 0;
  const changeSort = (column: DomainSort) => {
    setDirection(column === sort && direction === "desc" ? "asc" : "desc");
    setSort(column);
    setOffset(0);
  };
  const download = async () => {
    setDownloading(true);
    try {
      const count = await downloadLinkPowerDomains(projectId, runId, sort, direction);
      toast.success(`${count.toLocaleString()} domains exported`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Domain results could not be downloaded.");
    } finally { setDownloading(false); }
  };
  const sortHeading = (column: DomainSort, label: string) => {
    const active = column === sort;
    const Icon = active ? direction === "asc" ? ArrowUp : ArrowDown : ArrowUpDown;
    return (
      <TableHead className="text-right" aria-sort={active ? direction === "asc" ? "ascending" : "descending" : "none"}>
        <button type="button" onClick={() => changeSort(column)}
          className="inline-flex items-center justify-end gap-2 rounded py-2 hover:text-signal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
          aria-label={`Sort by ${label}: ${active && direction === "desc" ? "lowest to highest" : "highest to lowest"}`}>
          {label}<Icon className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </TableHead>
    );
  };
  return (
    <div className="space-y-3" aria-busy={benchmark.isFetching}>
      <div className="flex flex-wrap items-center justify-between gap-3" aria-busy={downloading}>
        <p className="text-xs text-ink-muted">{number(total, 0)} domains · Click Mean LPS or Appearances to change the order. CSV includes all domains.</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void download()} disabled={downloading || !total}>
          <Download className="mr-1 h-4 w-4" />{downloading ? `Preparing ${number(total, 0)} domains…` : "Export domains (CSV)"}
        </Button>
      </div>
      <div className="overflow-auto rounded-lg border border-hairline">
        <Table aria-label="Top domain benchmark" className="min-w-[640px]">
          <TableHeader><TableRow>
            <TableHead>Top domain benchmark</TableHead>
            {sortHeading("meanScore", "Mean LPS")}
            <TableHead className="text-right">Best rank</TableHead>
            {sortHeading("appearances", "Appearances")}
          </TableRow></TableHeader>
          <TableBody>
            {benchmark.data?.domains.map(domain => <TableRow key={domain.domain}>
              <TableCell className="whitespace-nowrap font-medium">{domain.domain} {domain.isClientDomain && <Badge className="ml-2" variant="secondary">Client</Badge>}</TableCell>
              <TableCell className="text-right font-mono">{number(domain.meanScore)}</TableCell>
              <TableCell className="text-right font-mono">{number(domain.bestRank, 0)}</TableCell>
              <TableCell className="text-right font-mono">{number(domain.appearances, 0)}</TableCell>
            </TableRow>)}
            {!benchmark.data?.domains.length && <TableRow><TableCell colSpan={4} className="py-6 text-center text-ink-muted">
              {benchmark.isPending ? "Loading domains…" : benchmark.isError ? "Domain results could not be loaded." : "No scored domains in this run."}
              {benchmark.isError && <Button type="button" variant="ghost" size="sm" className="ml-2" onClick={() => void benchmark.refetch()}>Retry</Button>}
            </TableCell></TableRow>}
          </TableBody>
        </Table>
      </div>
      {total > PAGE_SIZE && <div className="flex items-center justify-between text-xs text-ink-muted">
        <span>{number(offset + 1, 0)}–{number(Math.min(offset + PAGE_SIZE, total), 0)} of {number(total, 0)} domains</span>
        <div className="flex gap-1">
          <Button type="button" variant="outline" size="icon" className="h-8 w-8" disabled={offset === 0 || benchmark.isFetching} onClick={() => setOffset(offset - PAGE_SIZE)} aria-label="Previous domains"><ChevronLeft className="h-4 w-4" /></Button>
          <Button type="button" variant="outline" size="icon" className="h-8 w-8" disabled={offset + PAGE_SIZE >= total || benchmark.isFetching} onClick={() => setOffset(offset + PAGE_SIZE)} aria-label="Next domains"><ChevronRight className="h-4 w-4" /></Button>
        </div>
      </div>}
    </div>
  );
}
