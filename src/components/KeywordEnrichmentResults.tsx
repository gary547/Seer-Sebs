import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip as RechartsTooltip } from "recharts";
import { listAllProjectKeywords } from "@/integrations/gcp/project-data";

const INTENT_COLORS: Record<string, string> = {
  transactional: "hsl(177, 62%, 40%)",
  commercial: "hsl(197, 29%, 18%)",
  informational: "hsl(45, 90%, 55%)",
  navigational: "hsl(0, 84%, 60%)",
};

interface EnrichmentSummary {
  enriched: number;
  volume_updated: number;
  difficulty_updated: number;
  intent_overridden: number;
  intent_retained: number;
}

export default function KeywordEnrichmentResults({
  projectId,
  summary,
}: {
  projectId: string;
  summary: EnrichmentSummary | null;
}) {
  const { data: keywords = [] } = useQuery({
    queryKey: ["keywords_enriched_intents", projectId],
    queryFn: () =>
      listAllProjectKeywords(projectId, { detoxStatus: "keep" }),
    enabled: !!summary,
  });

  const intentData = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const k of keywords) {
      if (k.searchIntent) {
        counts[k.searchIntent] = (counts[k.searchIntent] || 0) + 1;
      }
    }
    return Object.entries(counts).map(([name, value]) => ({ name, value }));
  }, [keywords]);

  const total = intentData.reduce((s, d) => s + d.value, 0);

  if (!summary) return null;

  return (
    <div className="space-y-6">
      {/* Summary Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="rounded-md border p-4">
          <p className="text-xs text-muted-foreground">Keywords Enriched</p>
          <p className="text-2xl type-display text-foreground">{summary.enriched}</p>
        </div>
        <div className="rounded-md border p-4">
          <p className="text-xs text-muted-foreground">Volume Updated</p>
          <p className="text-2xl type-display text-foreground">{summary.volume_updated}</p>
        </div>
        <div className="rounded-md border p-4">
          <p className="text-xs text-muted-foreground">Intent Overridden</p>
          <p className="text-2xl type-display text-foreground">{summary.intent_overridden}</p>
        </div>
        <div className="rounded-md border p-4">
          <p className="text-xs text-muted-foreground">LLM Intent Retained</p>
          <p className="text-2xl type-display text-foreground">{summary.intent_retained}</p>
        </div>
      </div>

      {/* Intent Distribution Chart */}
      {intentData.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold mb-3 text-foreground">
            Intent Distribution (Post-Enrichment)
          </h4>
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
                    `${name} (${Math.round((value / total) * 100)}%)`
                  }
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
      )}
    </div>
  );
}
