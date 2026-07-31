import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart3, Users, TrendingUp } from "lucide-react";
import SerpFeatureOwnershipReport from "./SerpFeatureOwnershipReport";
import CompetitorLandscapeReport from "./CompetitorLandscapeReport";
import RankingDistributionReport from "./RankingDistributionReport";
import SyncStaleBanner from "./SyncStaleBanner";
import CollapsibleSection from "./navigator/CollapsibleSection";

interface Props {
  projectId: string;
  clientDomain: string;
}

const STORAGE_KEY_PREFIX = "seer-serp-sections";

export default function SerpReportsSection({ projectId, clientDomain }: Props) {
  const storageKey = `${STORAGE_KEY_PREFIX}:${projectId}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-accent" />
          SERP Reports & Dashboards
        </CardTitle>
        <CardDescription className="text-xs">
          SERP-level competitive intelligence — who owns the SERP, what features dominate, and where the link-strength gaps sit. Powered automatically by the TP run; no manual uploads required.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <SyncStaleBanner
          projectId={projectId}
          message="SERP reports below reflect the last sync. Press Sync Now in the header to refresh with the latest SERP data."
        />

        <CollapsibleSection
          id="features"
          storageKey={storageKey}
          title="SERP Feature Ownership"
          icon={<BarChart3 className="h-4 w-4 text-accent" />}
          defaultOpen
        >
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Who owns the SERP features (AI Overviews, People Also Ask, Featured Snippets, Image Packs, etc.) for each keyword — broken down by competitor.
            </p>
            <SerpFeatureOwnershipReport projectId={projectId} clientDomain={clientDomain} />
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          id="competitors"
          storageKey={storageKey}
          title="Competitor Landscape"
          icon={<Users className="h-4 w-4 text-accent" />}
          defaultOpen
        >
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              How your link strength compares to competitors. Shows whether you're matched, slightly behind, or behind on each one — plus share of voice and overall visibility.
            </p>
            <CompetitorLandscapeReport projectId={projectId} clientDomain={clientDomain} />
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          id="distribution"
          storageKey={storageKey}
          title="Ranking Distribution"
          icon={<TrendingUp className="h-4 w-4 text-accent" />}
          defaultOpen={false}
        >
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              How your kept keywords spread across rank buckets (1–3, 4–10, 11–20…) and search intent.
            </p>
            <RankingDistributionReport projectId={projectId} />
          </div>
        </CollapsibleSection>
      </CardContent>
    </Card>
  );
}
