import { type ComponentType, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ChevronDown,
  Download,
  HelpCircle,
  Image,
  Link,
  List,
  MapPin,
  Megaphone,
  MessageSquareText,
  Newspaper,
  PanelTop,
  PlaySquare,
  Quote,
  Search,
  ShoppingCart,
  Sparkles,
  Video,
} from "lucide-react";
import { listAllProjectKeywords } from "@/integrations/gcp/project-data";
import { listAllProjectSerpFeatures } from "@/integrations/gcp/serp";

interface Props {
  projectId: string;
  clientDomain: string;
}

const TOP_N_COMPETITORS = 8;

const FEATURE_TYPE_META: Record<string, { label: string; Icon: ComponentType<{ className?: string }> }> = {
  featured_snippet: { label: "Featured snippet", Icon: Quote },
  ai_overview: { label: "AI Overview", Icon: Sparkles },
  aio: { label: "AI Overview", Icon: Sparkles },
  local_pack: { label: "Local pack", Icon: MapPin },
  sitelinks: { label: "Sitelinks", Icon: Link },
  top_stories: { label: "Top stories", Icon: Newspaper },
  image_pack: { label: "Image pack", Icon: Image },
  images: { label: "Image pack", Icon: Image },
  videos: { label: "Videos", Icon: Video },
  video: { label: "Video preview", Icon: PlaySquare },
  discussions_and_forums: { label: "Discussions and forums", Icon: MessageSquareText },
  discussions: { label: "Discussions and forums", Icon: MessageSquareText },
  x_twitter: { label: "X (Twitter)", Icon: MessageSquareText },
  twitter: { label: "X (Twitter)", Icon: MessageSquareText },
  top_ads: { label: "Top ads", Icon: Megaphone },
  bottom_ads: { label: "Bottom ads", Icon: Megaphone },
  paid_sitelinks: { label: "Paid sitelinks", Icon: Link },
  shopping_ads: { label: "Shopping ads", Icon: ShoppingCart },
  shopping: { label: "Shopping", Icon: ShoppingCart },
  knowledge_card: { label: "Knowledge card", Icon: PanelTop },
  knowledge_panel: { label: "Knowledge panel", Icon: List },
  people_also_ask: { label: "People also ask", Icon: HelpCircle },
  thumbnail: { label: "Thumbnail", Icon: Image },
  organic: { label: "Organic result", Icon: Search },
};

function normaliseFeatureType(type: string) {
  return type.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function getFeatureTypeMeta(type: string) {
  const key = normaliseFeatureType(type);
  const fallbackLabel = key.split("_").filter(Boolean).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ") || type;
  return FEATURE_TYPE_META[key] ?? { label: fallbackLabel, Icon: Search };
}

export default function SerpFeatureOwnershipReport({ projectId, clientDomain }: Props) {
  const [selectedFeatureTypes, setSelectedFeatureTypes] = useState<string[]>([]);
  const [unownedOnly, setUnownedOnly] = useState(false);

  const { data: features = [], isLoading } = useQuery({
    queryKey: ["serp_features_matrix", projectId],
    queryFn: async () => {
      return (await listAllProjectSerpFeatures(projectId)).map((feature) => ({
        id: feature.id,
        keywords: {
          avg_monthly_volume: feature.averageMonthlyVolume,
          id: feature.keywordId,
          keyword: feature.keyword,
          search_intent: feature.searchIntent,
        },
        result_type: feature.resultType,
        serp_feature_count: 1,
        serp_feature_owned: feature.owned,
        top_serp_feature: feature.featureRaw,
        top_serp_feature_url: feature.featureUrl,
      }));
    },
  });

  // Count kept keywords with no SERP data (typically: DataForSEO returned no
  // ranking match, so har-calculation produced no serp_features rows).
  const { data: unrankedCount = 0 } = useQuery({
    queryKey: ["serp_features_unranked_count", projectId],
    queryFn: async () => {
      const keywords = await listAllProjectKeywords(projectId, {
        detoxStatus: "keep",
      });
      return keywords.filter((keyword) => keyword.baseRank === null).length;
    },
  });

  const clientDomainNorm = useMemo(
    () => clientDomain.toLowerCase().replace(/^www\./, "").replace(/^https?:\/\//, "").split("/")[0],
    [clientDomain]
  );

  const stats = useMemo(() => {
    if (!features.length) return null;

    const normalize = (u: string | null) =>
      (u || "").toLowerCase().replace(/^https?:\/\/(www\.)?/, "").split("/")[0];

    // Filter features
    const filtered = features.filter((f: any) => {
      if (selectedFeatureTypes.length > 0 && !selectedFeatureTypes.includes(f.result_type)) return false;
      return true;
    });

    // Determine top competitor domains by total feature URL count
    const domainCounts: Record<string, number> = {};
    for (const f of filtered) {
      const d = normalize(f.top_serp_feature_url);
      if (!d) continue;
      domainCounts[d] = (domainCounts[d] || 0) + 1;
    }

    const sortedDomains = Object.entries(domainCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([d]) => d);

    const competitorDomains = sortedDomains
      .filter(d => d !== clientDomainNorm)
      .slice(0, TOP_N_COMPETITORS);

    // Columns: client first, then top competitors
    const columns = [clientDomainNorm, ...competitorDomains];

    // Pivot: keyword → { domain → count, totalFeatures, kw meta }
    const matrix = new Map<string, {
      keyword: string;
      keyword_id: string;
      volume: number;
      intent: string | null;
      counts: Record<string, number>;
      totalFeatures: number;
      hasAio: boolean;
    }>();

    for (const f of filtered) {
      const kw = f.keywords;
      if (!kw) continue;
      let row = matrix.get(kw.id);
      if (!row) {
        row = {
          keyword: kw.keyword,
          keyword_id: kw.id,
          volume: kw.avg_monthly_volume ?? 0,
          intent: kw.search_intent,
          counts: {},
          totalFeatures: 0,
          hasAio: false,
        };
        matrix.set(kw.id, row);
      }
      row.totalFeatures++;
      if (f.result_type?.toLowerCase().includes("ai_overview") || f.result_type?.toLowerCase().includes("aio")) {
        row.hasAio = true;
      }
      const d = normalize(f.top_serp_feature_url);
      if (d && columns.includes(d)) {
        row.counts[d] = (row.counts[d] || 0) + 1;
      }
    }

    let rows = Array.from(matrix.values()).sort((a, b) => b.volume - a.volume);
    if (unownedOnly) {
      rows = rows.filter(r => (r.counts[clientDomainNorm] ?? 0) === 0);
    }

    // Header chips: total feature count per column
    const columnTotals: Record<string, number> = {};
    for (const col of columns) columnTotals[col] = 0;
    for (const row of matrix.values()) {
      for (const col of columns) {
        columnTotals[col] += row.counts[col] ?? 0;
      }
    }

    // KPI tiles
    const totalFeatures = filtered.length;
    const clientOwned = filtered.filter((f: any) => normalize(f.top_serp_feature_url) === clientDomainNorm).length;
    const ownershipRate = totalFeatures > 0 ? ((clientOwned / totalFeatures) * 100).toFixed(1) : "0";
    const aioKeywords = Array.from(matrix.values()).filter(r => r.hasAio).length;

    // Available feature types for filter
    const allTypes = Array.from(new Set(features.map((f: any) => f.result_type).filter(Boolean))).sort() as string[];

    return { rows, columns, columnTotals, totalFeatures, clientOwned, ownershipRate, aioKeywords, allTypes };
  }, [features, clientDomainNorm, selectedFeatureTypes, unownedOnly]);

  const exportCsv = () => {
    if (!stats) return;
    const headers = ["Keyword", "Volume", "Intent", ...stats.columns];
    const lines = [headers.join(",")];
    for (const row of stats.rows) {
      const vals = [
        `"${row.keyword.replace(/"/g, '""')}"`,
        row.volume,
        row.intent || "",
        ...stats.columns.map(col => row.counts[col] ?? 0),
      ];
      lines.push(vals.join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "serp-feature-ownership.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  if (isLoading) {
    return <div className="text-center py-8 text-muted-foreground text-sm">Loading SERP feature data…</div>;
  }

  if (!features.length) {
    return (
      <div className="text-center py-8 text-muted-foreground text-sm space-y-2">
        <p>No SERP feature data available.</p>
        <p className="text-xs">Run <strong>TP Calculation</strong> to populate this report — it captures AIOs, PAA, Featured Snippets and other features alongside organic results.</p>
      </div>
    );
  }

  if (!stats) return null;

  return (
    <div className="space-y-4">
      {/* KPI tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">SERP Features Tracked</p>
          <p className="text-xl type-display">{stats.totalFeatures.toLocaleString()}</p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">Client Owned</p>
          <p className="text-xl type-display text-primary">{stats.clientOwned.toLocaleString()}</p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">Ownership Rate</p>
          <p className="text-xl type-display">{stats.ownershipRate}%</p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <Sparkles className="h-3 w-3" /> SERPs with AIO
          </p>
          <p className="text-xl type-display text-accent">{stats.aioKeywords}</p>
        </div>
      </div>

      {unrankedCount > 0 && (
        <p className="text-xs text-muted-foreground italic">
          {unrankedCount} kept keyword{unrankedCount === 1 ? "" : "s"} excluded — DataForSEO returned no SERP match, so feature ownership cannot be measured.
        </p>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 min-w-[220px] justify-between text-xs font-normal">
              <span>{selectedFeatureTypes.length === 0 ? "All feature types" : `${selectedFeatureTypes.length} feature type${selectedFeatureTypes.length === 1 ? "" : "s"} selected`}</span>
              <ChevronDown className="h-3.5 w-3.5 opacity-70" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72 max-h-96 overflow-y-auto">
            <DropdownMenuItem onSelect={() => setSelectedFeatureTypes([])} className="gap-2 text-xs">
              <Search className="h-4 w-4" />
              All feature types
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {stats.allTypes.map((type) => {
              const { label, Icon } = getFeatureTypeMeta(type);
              return (
                <DropdownMenuCheckboxItem
                  key={type}
                  checked={selectedFeatureTypes.includes(type)}
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={(checked) => {
                    setSelectedFeatureTypes((current) => checked ? [...current, type] : current.filter((item) => item !== type));
                  }}
                  className="gap-2 text-xs"
                >
                  <Icon className="h-4 w-4" />
                  <span>{label}</span>
                </DropdownMenuCheckboxItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
        <label className="flex items-center gap-2 text-xs cursor-pointer">
          <Checkbox checked={unownedOnly} onCheckedChange={(v) => setUnownedOnly(!!v)} />
          Show only keywords where client owns 0
        </label>
        <Button size="sm" variant="outline" onClick={exportCsv} className="ml-auto h-8">
          <Download className="h-3.5 w-3.5 mr-1" /> Export CSV
        </Button>
      </div>

      {/* Matrix */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">
            Feature Ownership Matrix
            <span className="text-xs text-muted-foreground font-normal ml-2">
              {stats.rows.length} keywords × {stats.columns.length} domains
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border max-h-[600px] overflow-auto relative">
            <table className="w-full text-xs border-collapse">
              <thead className="sticky top-0 bg-background z-10 shadow-sm">
                <tr className="border-b">
                  <th className="sticky left-0 bg-background text-left p-2 font-medium min-w-[220px] border-r z-20">
                    Keyword
                  </th>
                  <th className="text-right p-2 font-medium">Vol</th>
                  {stats.columns.map((col, i) => (
                    <th key={col} className="text-center p-2 font-medium min-w-[100px]">
                      <div className="flex flex-col items-center gap-1">
                        <span className={`truncate max-w-[120px] ${col === clientDomainNorm ? "text-primary font-semibold" : ""}`} title={col}>
                          {col}
                        </span>
                        <Badge
                          variant={col === clientDomainNorm ? "default" : "secondary"}
                          className="text-[10px] h-4 px-1.5"
                        >
                          {stats.columnTotals[col]}
                        </Badge>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stats.rows.length === 0 && (
                  <tr><td colSpan={stats.columns.length + 2} className="text-center p-6 text-muted-foreground">No keywords match current filters.</td></tr>
                )}
                {stats.rows.map((row) => (
                  <tr key={row.keyword_id} className="border-b hover:bg-muted/30">
                    <td className="sticky left-0 bg-background p-2 font-medium border-r truncate max-w-[220px]" title={row.keyword}>
                      {row.keyword}
                    </td>
                    <td className="text-right p-2 text-muted-foreground">
                      {row.volume.toLocaleString()}
                    </td>
                    {stats.columns.map(col => {
                      const count = row.counts[col] ?? 0;
                      const isClient = col === clientDomainNorm;
                      return (
                        <td key={col} className="text-center p-2">
                          {count > 0 ? (
                            <span className={`inline-flex items-center justify-center min-w-[24px] h-6 px-2 rounded text-xs font-semibold ${
                              isClient ? "bg-primary/15 text-primary" : "bg-muted text-foreground"
                            }`}>
                              {count}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/40">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
