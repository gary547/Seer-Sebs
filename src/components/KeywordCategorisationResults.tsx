import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip as RechartsTooltip } from "recharts";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { getProjectSummary } from "@/integrations/gcp/tenancy";
import {
  deleteProjectKeywords,
  listAllProjectKeywords,
} from "@/integrations/gcp/project-data";

const INTENT_COLORS: Record<string, string> = {
  transactional: "hsl(var(--signal))",      // teal
  commercial: "hsl(var(--cat-navy))",       // navy on light, white on dark
  informational: "hsl(var(--signal-3))",    // amber
  navigational: "hsl(var(--signal-2))",     // coral
};

const INTENT_BADGE_CLASSES: Record<string, string> = {
  transactional: "bg-[hsl(var(--signal))] text-white",
  commercial: "bg-[hsl(var(--cat-navy))] text-[hsl(var(--cat-navy-ink))]",
  informational: "bg-[hsl(var(--signal-3))] text-[hsl(var(--obsidian))]",
  navigational: "bg-[hsl(var(--signal-2))] text-white",
};

function getDifficultyColor(d: number): { text: string; bg: string } {
  if (d <= 30) return { text: "text-[hsl(var(--signal))]", bg: "bg-[hsl(var(--signal))]/10" };
  if (d <= 60) return { text: "text-[hsl(var(--signal-3))]", bg: "bg-[hsl(var(--signal-3))]/15" };
  return { text: "text-[hsl(var(--signal-2))]", bg: "bg-[hsl(var(--signal-2))]/10" };
}

function getCompetitionColor(c: string): string {
  const upper = c.toUpperCase();
  if (upper === "LOW") return "bg-[hsl(var(--signal))]/10 text-[hsl(var(--signal))]";
  if (upper === "MEDIUM") return "bg-[hsl(var(--signal-3))]/15 text-[hsl(var(--signal-3))]";
  return "bg-[hsl(var(--signal-2))]/10 text-[hsl(var(--signal-2))]";
}

/** Tiny inline SVG sparkline */
function Sparkline({
  data,
  seasonStart,
  seasonEnd,
}: {
  data: { month: string; volume: number }[];
  seasonStart?: string | null;
  seasonEnd?: string | null;
}) {
  if (!data.length) return <span className="text-muted-foreground">—</span>;

  const sorted = [...data].sort((a, b) => a.month.localeCompare(b.month));
  const volumes = sorted.map((d) => d.volume);
  const max = Math.max(...volumes);
  const min = Math.min(...volumes);
  const range = max - min || 1;

  const W = 80;
  const H = 24;
  const pad = 2;

  const points = volumes
    .map((v, i) => {
      const x = pad + (i / (volumes.length - 1 || 1)) * (W - pad * 2);
      const y = H - pad - ((v - min) / range) * (H - pad * 2);
      return `${x},${y}`;
    })
    .join(" ");

  // Determine seasonality highlight rects
  const seasonRects: { x: number; w: number }[] = [];
  if (seasonStart && seasonEnd) {
    const sMonth = seasonStart.slice(0, 7); // YYYY-MM
    const eMonth = seasonEnd.slice(0, 7);
    sorted.forEach((d, i) => {
      const m = d.month.slice(0, 7);
      if (m >= sMonth && m <= eMonth) {
        const x = pad + (i / (sorted.length - 1 || 1)) * (W - pad * 2);
        const step = (W - pad * 2) / (sorted.length - 1 || 1);
        seasonRects.push({ x: x - step / 2, w: step });
      }
    });
  }

  return (
    <svg width={W} height={H} className="inline-block">
      {seasonRects.map((r, i) => (
        <rect
          key={i}
          x={Math.max(0, r.x)}
          y={0}
          width={r.w}
          height={H}
          fill="hsl(var(--accent))"
          opacity={0.3}
        />
      ))}
      <polyline
        points={points}
        fill="none"
        stroke="hsl(var(--primary))"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface Keyword {
  id: string;
  keyword: string;
  tag_1: string | null;
  tag_2: string | null;
  tag_3: string | null;
  tag_4: string | null;
  tag_5: string | null;
  kw_cluster: string | null;
  search_intent: string | null;
  intent_confidence: string | null;
  keyword_difficulty: number | null;
  avg_monthly_volume: number | null;
  competition: string | null;
  monthly_volumes: { month: string; volume: number }[];
}

export default function KeywordCategorisationResults({ projectId }: { projectId: string }) {
  const [tagFilter, setTagFilter] = useState<string>("all");
  const [intentFilter, setIntentFilter] = useState<string>("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const queryClient = useQueryClient();

  const { data: keywords = [], isLoading } = useQuery({
    queryKey: ["keywords_categorised", projectId],
    queryFn: async () => {
      const rows = await listAllProjectKeywords(projectId, {
        categorisedOnly: true,
        detoxStatus: "keep",
        sort: "keyword",
      });
      return rows.map((keyword): Keyword => {
        const tags = keyword.tags.filter((tag) => tag !== keyword.category);
        return {
          avg_monthly_volume: keyword.avgMonthlyVolume,
          competition: keyword.competition,
          id: keyword.id,
          intent_confidence: keyword.intentConfidence,
          keyword: keyword.text,
          keyword_difficulty: keyword.keywordDifficulty,
          kw_cluster: keyword.category,
          monthly_volumes: keyword.monthlyVolumes,
          search_intent: keyword.searchIntent,
          tag_1: keyword.category ?? keyword.tags[0] ?? null,
          tag_2: tags[0] ?? null,
          tag_3: tags[1] ?? null,
          tag_4: tags[2] ?? null,
          tag_5: tags[3] ?? null,
        };
      });
    },
  });

  // Fetch project for seasonality dates
  const { data: project } = useQuery({
    queryKey: ["navigator_project_season", projectId],
    queryFn: () => getProjectSummary(projectId),
  });

  const categorisedKeywords = useMemo(
    () => keywords.filter((k) => k.tag_1),
    [keywords]
  );

  const monthlyByKeyword = useMemo(() => {
    const map = new Map<string, { month: string; volume: number }[]>();
    for (const keyword of categorisedKeywords) {
      map.set(keyword.id, keyword.monthly_volumes);
    }
    return map;
  }, [categorisedKeywords]);

  // Category summary
  const categorySummary = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const k of categorisedKeywords) {
      const cat = k.tag_3 || k.tag_1 || "Uncategorised";
      counts[cat] = (counts[cat] || 0) + 1;
    }
    return Object.entries(counts)
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count);
  }, [categorisedKeywords]);

  // Intent distribution
  const intentData = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const k of categorisedKeywords) {
      if (k.search_intent) {
        counts[k.search_intent] = (counts[k.search_intent] || 0) + 1;
      }
    }
    return Object.entries(counts).map(([name, value]) => ({ name, value }));
  }, [categorisedKeywords]);

  // Unique tag_1 values for filter
  const uniqueTags = useMemo(
    () => [...new Set(categorisedKeywords.map((k) => k.tag_1).filter(Boolean))] as string[],
    [categorisedKeywords]
  );

  // Filtered keywords
  const filtered = useMemo(
    () =>
      categorisedKeywords.filter(
        (k) =>
          (tagFilter === "all" || k.tag_1 === tagFilter) &&
          (intentFilter === "all" || k.search_intent === intentFilter)
      ),
    [categorisedKeywords, tagFilter, intentFilter]
  );

  const allFilteredSelected = filtered.length > 0 && filtered.every((k) => selectedIds.has(k.id));

  const toggleSelectAll = () => {
    if (allFilteredSelected) {
      const next = new Set(selectedIds);
      filtered.forEach((k) => next.delete(k.id));
      setSelectedIds(next);
    } else {
      const next = new Set(selectedIds);
      filtered.forEach((k) => next.add(k.id));
      setSelectedIds(next);
    }
  };

  const toggleOne = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["keywords_categorised", projectId] });
    queryClient.invalidateQueries({ queryKey: ["keywords", projectId] });
    queryClient.invalidateQueries({ queryKey: ["project_sync_state", projectId] });
    queryClient.invalidateQueries({ queryKey: ["project-data", projectId] });
    queryClient.invalidateQueries({ queryKey: ["project_readiness", projectId] });
  };

  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: string[]) =>
      deleteProjectKeywords(projectId, { ids }),
    onSuccess: () => {
      toast.success(`Deleted ${selectedIds.size} keywords`);
      setSelectedIds(new Set());
      invalidateAll();
    },
    onError: () => toast.error("Failed to delete keywords"),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading categorisation results…</p>;
  if (!categorisedKeywords.length) return null;

  const totalIntentCount = intentData.reduce((s, d) => s + d.value, 0);

  return (
    <div className="space-y-6">
      {/* Category Summary + Intent Chart side by side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Category Summary */}
        <div>
          <h4 className="text-sm font-semibold mb-3 text-foreground">Categories ({categorySummary.length})</h4>
          <div className="rounded-md border max-h-[300px] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right w-[80px]">Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {categorySummary.map((row) => (
                  <TableRow key={row.category}>
                    <TableCell className="text-sm font-medium">{row.category}</TableCell>
                    <TableCell className="text-right text-sm">{row.count}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>

        {/* Intent Distribution Chart */}
        <div>
          <h4 className="text-sm font-semibold mb-3 text-foreground">Intent Distribution</h4>
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={intentData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={100}
                  paddingAngle={2}
                  label={({ name, value }) =>
                    `${name} (${Math.round((value / totalIntentCount) * 100)}%)`
                  }
                  style={{ fontSize: 9 }}
                >
                  {intentData.map((entry) => (
                    <Cell
                      key={entry.name}
                      fill={INTENT_COLORS[entry.name] || "hsl(var(--muted))"}
                      stroke="hsl(var(--canvas))"
                      strokeWidth={1}
                    />
                  ))}
                </Pie>
                <RechartsTooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <Select value={tagFilter} onValueChange={setTagFilter}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Filter by category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            {uniqueTags.map((t) => (
              <SelectItem key={t} value={t}>{t}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={intentFilter} onValueChange={setIntentFilter}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Filter by intent" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Intents</SelectItem>
            <SelectItem value="transactional">Transactional</SelectItem>
            <SelectItem value="commercial">Commercial</SelectItem>
            <SelectItem value="informational">Informational</SelectItem>
            <SelectItem value="navigational">Navigational</SelectItem>
          </SelectContent>
        </Select>

        <span className="text-sm text-muted-foreground ml-auto">
          {filtered.length} keyword{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Bulk toolbar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-2 p-3 rounded-md bg-muted border">
          <span className="text-sm font-medium">{selectedIds.size} selected</span>
          <div className="ml-auto flex items-center gap-2">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="destructive" disabled={bulkDeleteMutation.isPending}>
                  <Trash2 className="h-4 w-4 mr-1" />
                  Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete {selectedIds.size} keywords?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently remove the selected keywords from this project.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => bulkDeleteMutation.mutate([...selectedIds])}>
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      )}

      {/* Keyword Table */}
      <div className="rounded-md border max-h-[500px] overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[40px]">
                <Checkbox checked={allFilteredSelected} onCheckedChange={toggleSelectAll} />
              </TableHead>
              <TableHead>
                <TooltipProvider><Tooltip><TooltipTrigger className="cursor-default">Keyword</TooltipTrigger>
                <TooltipContent>The search term people type into Google</TooltipContent></Tooltip></TooltipProvider>
              </TableHead>
              <TableHead>
                <TooltipProvider><Tooltip><TooltipTrigger className="cursor-default">Tag 1</TooltipTrigger>
                <TooltipContent>Primary category assigned during categorisation</TooltipContent></Tooltip></TooltipProvider>
              </TableHead>
              <TableHead>
                <TooltipProvider><Tooltip><TooltipTrigger className="cursor-default">Tag 2</TooltipTrigger>
                <TooltipContent>Secondary sub-category for finer grouping</TooltipContent></Tooltip></TooltipProvider>
              </TableHead>
              <TableHead>
                <TooltipProvider><Tooltip><TooltipTrigger className="cursor-default">Tag 3</TooltipTrigger>
                <TooltipContent>Tertiary grouping label for detailed segmentation</TooltipContent></Tooltip></TooltipProvider>
              </TableHead>
              <TableHead>
                <TooltipProvider><Tooltip><TooltipTrigger className="cursor-default">Volume</TooltipTrigger>
                <TooltipContent>Average monthly searches in the UK over the last 12 months</TooltipContent></Tooltip></TooltipProvider>
              </TableHead>
              <TableHead>
                <TooltipProvider><Tooltip><TooltipTrigger className="cursor-default">Trend</TooltipTrigger>
                <TooltipContent>12-month search volume trend. Highlighted area shows the project's seasonality window</TooltipContent></Tooltip></TooltipProvider>
              </TableHead>
              <TableHead>
                <TooltipProvider><Tooltip><TooltipTrigger className="cursor-default">Intent</TooltipTrigger>
                <TooltipContent>The searcher's goal: transactional (buy), commercial (research), informational (learn), or navigational (find a site)</TooltipContent></Tooltip></TooltipProvider>
              </TableHead>
              <TableHead>
                <TooltipProvider><Tooltip><TooltipTrigger className="cursor-default">Competition</TooltipTrigger>
                <TooltipContent>Google Ads advertiser competition level — HIGH, MEDIUM, or LOW. Indicates how many advertisers bid on this keyword</TooltipContent></Tooltip></TooltipProvider>
              </TableHead>
              <TableHead>
                <TooltipProvider><Tooltip><TooltipTrigger className="cursor-default">Difficulty</TooltipTrigger>
                <TooltipContent>How hard it is to rank organically (0–100). 0–30 Easy (green), 31–60 Medium (amber), 61–100 Hard (red)</TooltipContent></Tooltip></TooltipProvider>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((kw) => {
              const diffColors = kw.keyword_difficulty != null ? getDifficultyColor(kw.keyword_difficulty) : null;
              return (
                <TableRow key={kw.id} data-state={selectedIds.has(kw.id) ? "selected" : undefined}>
                  <TableCell>
                    <Checkbox
                      checked={selectedIds.has(kw.id)}
                      onCheckedChange={() => toggleOne(kw.id)}
                    />
                  </TableCell>
                  <TableCell className="font-medium">{kw.keyword}</TableCell>
                  <TableCell className="text-sm">{kw.tag_1 ?? "—"}</TableCell>
                  <TableCell className="text-sm">{kw.tag_2 ?? "—"}</TableCell>
                  <TableCell className="text-sm">{kw.tag_3 ?? "—"}</TableCell>
                  <TableCell className="text-sm text-right">
                    {kw.avg_monthly_volume != null ? kw.avg_monthly_volume.toLocaleString() : "—"}
                  </TableCell>
                  <TableCell>
                    <Sparkline
                      data={monthlyByKeyword.get(kw.id) || []}
                      seasonStart={project?.seasonality_start}
                      seasonEnd={project?.seasonality_end}
                    />
                  </TableCell>
                  <TableCell>
                    {kw.search_intent ? (
                      <Badge className={`capitalize ${INTENT_BADGE_CLASSES[kw.search_intent] || ""}`}>
                        {kw.search_intent}
                      </Badge>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    {kw.competition ? (
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${getCompetitionColor(kw.competition)}`}>
                        {kw.competition}
                      </span>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    {kw.keyword_difficulty != null && diffColors ? (
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${diffColors.text} ${diffColors.bg}`}>
                        {kw.keyword_difficulty}
                      </span>
                    ) : (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger className="cursor-default text-muted-foreground">—</TooltipTrigger>
                          <TooltipContent>Populated after DataForSEO enrichment</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
