import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link2, CheckCircle2, XCircle } from "lucide-react";
import RankingUrlResults from "@/components/RankingUrlResults";
import SyncStaleBanner from "@/components/SyncStaleBanner";
import { listProjectKeywords } from "@/integrations/gcp/project-data";

interface Props {
  projectId: string;
}

/**
 * Read-only view of ranking URLs resolved per keyword. The actual lookup is
 * orchestrated by the project-wide Sync Now pipeline (Phase: Ranking URLs) —
 * users no longer trigger it from this tab.
 */
export default function RankingUrlSection({ projectId }: Props) {
  const { data: stats } = useQuery({
    queryKey: ["ranking_url_stats", projectId],
    queryFn: async () => {
      const [kept, ranked] = await Promise.all([
        listProjectKeywords(projectId, { detoxStatus: "keep", limit: 1 }),
        listProjectKeywords(projectId, {
          detoxStatus: "keep",
          limit: 1,
          rankingUrlOnly: true,
        }),
      ]);
      return { total: kept.total, withUrl: ranked.total };
    },
    refetchInterval: 15000,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Link2 className="h-5 w-5 text-accent" />
          Ranking URL Lookup
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <SyncStaleBanner
          projectId={projectId}
          message="Ranking URLs are refreshed by the Sync Now pipeline. Press Sync Now in the header to resolve any missing URLs."
        />

        {stats && stats.total > 0 && (
          <div className="flex items-center gap-4 text-sm">
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4 text-success" />
              <span>{stats.withUrl} with ranking URL</span>
            </div>
            <div className="flex items-center gap-1.5">
              <XCircle className="h-4 w-4 text-muted-foreground" />
              <span>{stats.total - stats.withUrl} without</span>
            </div>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Ranking URLs and positions are resolved automatically via DataForSEO during the Sync Now pipeline.
        </p>

        {stats && stats.withUrl > 0 && <RankingUrlResults projectId={projectId} />}
      </CardContent>
    </Card>
  );
}
