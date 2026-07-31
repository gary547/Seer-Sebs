import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listAllProjectSerpResults } from "@/integrations/gcp/serp";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ExternalLink, Database, Upload as UploadIcon } from "lucide-react";
import { MetricHelp } from "@/components/briefing/MetricHelp";

interface Props {
  projectId: string;
  keywordId: string;
  clientUr: number | null;
  harCompetitorUrl: string | null;
}

type CompetitorRow = {
  rank: number;
  url: string;
  domain: string;
  url_rating: number | null;
  domain_rating: number | null;
  referring_domains: number | null;
  backlinks: number | null;
  source: "api" | "manual";
};

export default function CompetitorBacklinkLandscape({
  projectId,
  keywordId,
  clientUr,
  harCompetitorUrl,
}: Props) {
  const [belowClientOnly, setBelowClientOnly] = useState(false);

  const { data: serpResults = [] } = useQuery({
    queryKey: ["serp_results", projectId, keywordId],
    queryFn: () => listAllProjectSerpResults(projectId, keywordId),
  });

  const merged: CompetitorRow[] = useMemo(() => {
    return serpResults.map((r) => ({
      rank: r.rankAbsolute,
      url: r.url,
      domain: r.domain,
      url_rating: r.urlRating,
      domain_rating: r.domainRating,
      referring_domains: r.referringDomains,
      backlinks: r.backlinks,
      source: r.metricSource?.includes("manual") ? "manual" : "api",
    } satisfies CompetitorRow))
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 20);
  }, [serpResults]);

  const filtered = useMemo(() => {
    if (!belowClientOnly || clientUr == null) return merged;
    return merged.filter((r) => r.url_rating != null && r.url_rating < clientUr);
  }, [merged, belowClientOnly, clientUr]);

  if (merged.length === 0) {
    return (
      <div className="text-xs text-muted-foreground py-4 text-center">
        No competitor backlink data yet — run TP calculation or upload backlink metrics CSV.
      </div>
    );
  }

  const harUrlNorm = harCompetitorUrl?.toLowerCase() ?? null;

  // Detect "UR/DR present but no link counts" — usually means DataForSEO Backlinks
  // subscription is inactive. Show a one-line notice rather than silently leaving "—".
  const hasAnyUr = merged.some((r) => r.url_rating != null);
  const hasAnyRefDoms = merged.some((r) => r.referring_domains != null);
  const hasAnyBacklinks = merged.some((r) => r.backlinks != null);
  const linkCountsMissing = hasAnyUr && !hasAnyRefDoms && !hasAnyBacklinks;

  return (
    <div className="space-y-2 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-muted-foreground">
          Top {merged.length} pages ranking for this keyword • Client UR:{" "}
          <span className="font-semibold text-foreground">{clientUr ?? "—"}</span>
          {clientUr != null && (
            <span className="ml-1">
              · cells in <span className="text-[hsl(var(--signal))] font-medium">teal</span> have lower UR than your site (realistically outrankable)
            </span>
          )}
        </div>
        {clientUr != null && (
          <div className="flex items-center gap-2">
            <Switch
              id={`below-${keywordId}`}
              checked={belowClientOnly}
              onCheckedChange={setBelowClientOnly}
            />
            <Label htmlFor={`below-${keywordId}`} className="text-xs cursor-pointer">
              Only show URs below client
            </Label>
          </div>
        )}
      </div>

      {linkCountsMissing && (
        <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-[11px] text-warning-foreground">
          UR/DR loaded from Ahrefs. Ref Doms &amp; Backlinks columns are empty because the
          DataForSEO Backlinks subscription is not active — UR/DR alone is sufficient for TP
          &amp; Performance Output formulas. Upload a CSV via the Backlinks tab to fill these
          columns manually.
        </div>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12 text-center">#</TableHead>
              <TableHead>URL</TableHead>
              <TableHead className="text-right w-16"><MetricHelp metric="UR" align="right" label="UR" /></TableHead>
              <TableHead className="text-right w-16"><MetricHelp metric="DR" align="right" label="DR" /></TableHead>
              <TableHead className="text-right w-20"><MetricHelp metric="RefDoms" align="right" label="Ref Doms" /></TableHead>
              <TableHead className="text-right w-24"><MetricHelp metric="Backlinks" align="right" label="Backlinks" /></TableHead>
              <TableHead className="w-16 text-center">Src</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((row) => {
              const isHar = harUrlNorm && row.url.toLowerCase() === harUrlNorm;
              const belowClient =
                clientUr != null && row.url_rating != null && row.url_rating < clientUr;
              return (
                <TableRow
                  key={`${row.rank}-${row.url}`}
                  className={isHar ? "bg-accent/10 border-l-2 border-l-accent" : ""}
                >
                  <TableCell className="text-center text-xs font-medium">{row.rank}</TableCell>
                  <TableCell className="max-w-[280px]">
                    <a
                      href={row.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-xs text-primary hover:underline truncate"
                    >
                      <span className="truncate">
                        {row.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 50)}
                      </span>
                      <ExternalLink className="h-3 w-3 flex-shrink-0" />
                    </a>
                  </TableCell>
                  <TableCell
                    className={`text-right text-xs font-medium ${
                      belowClient ? "text-[hsl(var(--signal))]" : ""
                    }`}
                  >
                    {row.url_rating ?? "—"}
                  </TableCell>
                  <TableCell className="text-right text-xs">
                    {row.domain_rating ?? "—"}
                  </TableCell>
                  <TableCell className="text-right text-xs">
                    {row.referring_domains?.toLocaleString() ?? "—"}
                  </TableCell>
                  <TableCell className="text-right text-xs">
                    {row.backlinks?.toLocaleString() ?? "—"}
                  </TableCell>
                  <TableCell className="text-center">
                    {row.source === "api" ? (
                      <Badge variant="outline" className="h-5 px-1.5 gap-1 text-[10px]">
                        <Database className="h-2.5 w-2.5" />
                        API
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="h-5 px-1.5 gap-1 text-[10px]">
                        <UploadIcon className="h-2.5 w-2.5" />
                        CSV
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-xs text-muted-foreground py-4">
                  No competitors match the filter.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {harUrlNorm && (
        <p className="text-[10px] text-muted-foreground">
          <span className="inline-block w-2 h-2 rounded-sm bg-accent mr-1 align-middle" />
          Highlighted row = competitor that determined TP
        </p>
      )}
    </div>
  );
}
