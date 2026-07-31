import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, PieChart, Pie, Cell,
} from "recharts";
import { listAllProjectKeywords } from "@/integrations/gcp/project-data";

interface Props {
  projectId: string;
}

const INTENT_COLORS: Record<string, string> = {
  commercial: "hsl(var(--cat-navy))",
  transactional: "hsl(var(--signal))",
  informational: "hsl(var(--signal-3))",
  navigational: "hsl(var(--signal-2))",
};

const POSITION_BUCKETS = [
  { label: "1-3",    lo: 1,   hi: 3,    fill: "hsl(var(--signal))" },
  { label: "4-10",   lo: 4,   hi: 10,   fill: "hsl(var(--signal) / 0.65)" },
  { label: "11-20",  lo: 11,  hi: 20,   fill: "hsl(var(--signal-3))" },
  { label: "21-50",  lo: 21,  hi: 50,   fill: "hsl(var(--signal-3) / 0.7)" },
  { label: "51-100", lo: 51,  hi: 100,  fill: "hsl(var(--signal-2))" },
  { label: "100+",   lo: 101, hi: 9999, fill: "hsl(var(--ink-subtle))" },
];

export default function RankingDistributionReport({ projectId }: Props) {
  const { data: keywords = [] } = useQuery({
    queryKey: ["ranking_distribution_report", projectId],
    queryFn: async () => {
      const rows = await listAllProjectKeywords(projectId, {
        detoxStatus: "keep",
      });
      return rows.map((keyword) => ({
        avg_monthly_volume: keyword.avgMonthlyVolume,
        base_rank: keyword.baseRank,
        id: keyword.id,
        keyword: keyword.text,
        search_intent: keyword.searchIntent,
        tag_3: keyword.category,
      }));
    },
  });

  const stats = useMemo(() => {
    if (!keywords.length) return null;

    const ranked = keywords.filter((k: any) => k.base_rank != null);
    const unranked = keywords.length - ranked.length;

    // Position bucket distribution
    const bucketData = POSITION_BUCKETS.map(b => ({
      name: b.label,
      fill: b.fill,
      value: ranked.filter((k: any) => k.base_rank >= b.lo && k.base_rank <= b.hi).length,
    }));

    // Position by intent
    const intents = [...new Set(keywords.map((k: any) => k.search_intent).filter(Boolean))];
    const intentBucketData = POSITION_BUCKETS.slice(0, 4).map(b => {
      const entry: Record<string, any> = { position: b.label };
      for (const intent of intents) {
        entry[intent] = ranked.filter(
          (k: any) => k.search_intent === intent && k.base_rank >= b.lo && k.base_rank <= b.hi
        ).length;
      }
      return entry;
    });

    // Avg rank by intent
    const intentStats = intents.map(intent => {
      const kws = ranked.filter((k: any) => k.search_intent === intent);
      const avgRank = kws.length ? kws.reduce((s: number, k: any) => s + k.base_rank, 0) / kws.length : 0;
      const totalVol = kws.reduce((s: number, k: any) => s + (k.avg_monthly_volume || 0), 0);
      return {
        name: (intent as string).charAt(0).toUpperCase() + (intent as string).slice(1),
        intent,
        count: kws.length,
        avgRank: avgRank.toFixed(1),
        totalVolume: totalVol,
      };
    }).sort((a, b) => parseFloat(a.avgRank) - parseFloat(b.avgRank));

    // Category distribution (top 10 tag_3 groups — most granular for variety)
    const catCounts: Record<string, { count: number; avgRank: number; totalRank: number }> = {};
    for (const k of ranked) {
      const cat = k.tag_3 || "Uncategorised";
      if (!catCounts[cat]) catCounts[cat] = { count: 0, avgRank: 0, totalRank: 0 };
      catCounts[cat].count++;
      catCounts[cat].totalRank += k.base_rank;
    }
    const catData = Object.entries(catCounts)
      .map(([name, d]) => ({ name: name.length > 20 ? name.slice(0, 18) + "…" : name, count: d.count, avgRank: (d.totalRank / d.count).toFixed(1) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Quick stats
    const avgRank = ranked.length ? ranked.reduce((s: number, k: any) => s + k.base_rank, 0) / ranked.length : 0;
    const top3 = ranked.filter((k: any) => k.base_rank <= 3).length;
    const top10 = ranked.filter((k: any) => k.base_rank <= 10).length;

    return { bucketData, intentBucketData, intentStats, catData, intents, ranked: ranked.length, unranked, avgRank, top3, top10 };
  }, [keywords]);

  if (!keywords.length) {
    return (
      <div className="text-center py-8 text-muted-foreground text-sm space-y-2">
        <p>No keyword data available.</p>
        <p className="text-xs">Run <strong>Keyword Detox</strong> to mark keywords as "kept" — this report covers your kept keyword set's rank distribution.</p>
      </div>
    );
  }

  if (!stats) return null;

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">Ranked</p>
          <p className="text-xl type-display">{stats.ranked}</p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">Unranked</p>
          <p className="text-xl type-display text-muted-foreground">{stats.unranked}</p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">Avg Rank</p>
          <p className="text-xl type-display">{stats.avgRank.toFixed(1)}</p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">Top 3</p>
          <p className="text-xl type-display text-primary">{stats.top3}</p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">Top 10</p>
          <p className="text-xl type-display">{stats.top10}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Position distribution bar */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Ranking Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={stats.bucketData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis />
                <Tooltip />
                <Bar dataKey="value" name="Keywords">
                  {stats.bucketData.map((d: any, i: number) => (
                    <Cell key={i} fill={d.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Position by intent */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Position by Intent</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={stats.intentBucketData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="position" tick={{ fontSize: 11 }} />
                <YAxis />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {stats.intents.map((intent: string, i: number) => (
                  <Bar key={intent} dataKey={intent} fill={INTENT_COLORS[intent] || `hsl(${i * 60}, 60%, 50%)`} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Category distribution */}
      {stats.catData.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Rankings by Category</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={Math.max(200, stats.catData.length * 30)}>
              <BarChart data={stats.catData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" />
                <YAxis type="category" dataKey="name" width={140} tick={{ fontSize: 11 }} />
                <Tooltip content={({ active, payload }: any) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0].payload;
                  return (
                    <div className="bg-background border rounded p-2 text-xs shadow">
                      <p className="font-medium">{d.name}</p>
                      <p>{d.count} keywords • Avg rank: {d.avgRank}</p>
                    </div>
                  );
                }} />
                <Bar dataKey="count" fill="hsl(var(--primary))" name="Keywords" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
