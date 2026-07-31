import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BarChart3,
  CheckCircle2,
  Layers3,
  Link2,
  RefreshCw,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  importProjectSerpCsv,
  listProjectSerpFeatures,
  listProjectSerpResults,
  type ProjectSerpImportKind,
  type ProjectSerpImportResult,
} from "@/integrations/gcp/serp";
import { useRecomputeForecasts } from "@/hooks/useRecomputeForecasts";

interface SerpDataSectionProps {
  clientDomain: string;
  projectId: string;
}

const IMPORTS: Array<{
  columns: string;
  description: string;
  icon: typeof BarChart3;
  kind: ProjectSerpImportKind;
  title: string;
}> = [
  {
    columns:
      "keyword, rank_position, ranking_url, ranking_domain; authority metrics are optional",
    description:
      "Adds or replaces organic positions for tracked keywords.",
    icon: BarChart3,
    kind: "rankings",
    title: "SERP rankings",
  },
  {
    columns:
      "ranking_url, url_rating, domain_rating, referring_domains, backlinks_total",
    description:
      "Enriches existing ranking URLs with authority evidence.",
    icon: Link2,
    kind: "backlinks",
    title: "Backlink metrics",
  },
  {
    columns:
      "keyword, device, serp_feature_raw, result_type, feature_url",
    description:
      "Records feature ownership such as AIO, snippets and local packs.",
    icon: Layers3,
    kind: "features",
    title: "SERP features",
  },
];

export default function SerpDataSection({
  clientDomain,
  projectId,
}: SerpDataSectionProps) {
  const queryClient = useQueryClient();
  const fileRefs = useRef<
    Partial<Record<ProjectSerpImportKind, HTMLInputElement | null>>
  >({});
  const [loadingKind, setLoadingKind] =
    useState<ProjectSerpImportKind | null>(null);
  const [results, setResults] = useState<
    Partial<Record<ProjectSerpImportKind, ProjectSerpImportResult>>
  >({});
  const { recompute, isRecomputing } = useRecomputeForecasts(projectId);
  const { data: rankingPage } = useQuery({
    queryKey: ["serp_results_count", projectId],
    queryFn: () =>
      listProjectSerpResults(projectId, { limit: 1, offset: 0 }),
  });
  const { data: featurePage } = useQuery({
    queryKey: ["serp_features_count", projectId],
    queryFn: () =>
      listProjectSerpFeatures(projectId, { limit: 1, offset: 0 }),
  });

  const importFile = async (
    kind: ProjectSerpImportKind,
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setLoadingKind(kind);
    try {
      const result = await importProjectSerpCsv(
        projectId,
        kind,
        await file.text(),
      );
      setResults((current) => ({ ...current, [kind]: result }));
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["serp_results_count", projectId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["serp_features_count", projectId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["project_sync_state", projectId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["serp_results", projectId],
        }),
      ]);
      toast.success(
        `${result.importedRowCount.toLocaleString()} ${kind} rows imported`,
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : `${kind} import failed`,
      );
    } finally {
      setLoadingKind(null);
    }
  };

  const runPipeline = async () => {
    const result = await recompute(false);
    if (result.ok) {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["serp_results_count", projectId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["serp_features_count", projectId],
        }),
      ]);
    }
  };

  return (
    <div className="space-y-4">
      <Alert>
        <CheckCircle2 className="h-4 w-4" />
        <AlertTitle>Canonical import path</AlertTitle>
        <AlertDescription>
          Files are validated by the backend and written to the same dataset
          used by the GCP pipeline. Domain ownership is checked against{" "}
          <strong>{clientDomain}</strong>.
        </AlertDescription>
      </Alert>

      <Card className="border-hairline shadow-card">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Upload className="h-5 w-5 text-signal" />
                Manual SERP evidence
              </CardTitle>
              <CardDescription className="mt-1 max-w-2xl">
                Use these imports when the live provider is unavailable or when
                an analyst needs to supplement the automated collection.
              </CardDescription>
            </div>
            <Button
              size="sm"
              variant="signal"
              onClick={runPipeline}
              disabled={isRecomputing}
            >
              <RefreshCw
                className={`h-4 w-4 ${isRecomputing ? "animate-spin" : ""}`}
              />
              {isRecomputing ? "Calculating…" : "Process imported data"}
            </Button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Badge variant="outline">
              {(rankingPage?.total ?? 0).toLocaleString()} ranking rows
            </Badge>
            <Badge variant="outline">
              {(featurePage?.total ?? 0).toLocaleString()} feature rows
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 lg:grid-cols-3">
            {IMPORTS.map((definition) => {
              const Icon = definition.icon;
              const summary = results[definition.kind];
              const isLoading = loadingKind === definition.kind;
              return (
                <div
                  key={definition.kind}
                  className="flex min-h-[230px] flex-col rounded-xl border border-hairline bg-surface p-4"
                >
                  <div className="flex items-center gap-2 font-semibold text-ink">
                    <span className="rounded-md bg-signal/10 p-1.5 text-signal">
                      <Icon className="h-4 w-4" />
                    </span>
                    {definition.title}
                  </div>
                  <p className="mt-3 text-xs leading-5 text-ink-muted">
                    {definition.description}
                  </p>
                  <div className="mt-3 rounded-md bg-surface-muted/50 p-2 font-mono text-[10px] leading-4 text-ink-muted">
                    {definition.columns}
                  </div>
                  <div className="mt-auto pt-4">
                    {isLoading ? (
                      <div className="space-y-2">
                        <div className="text-xs text-ink-muted">
                          Validating and importing…
                        </div>
                        <Progress className="h-1.5" />
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          fileRefs.current[definition.kind]?.click()
                        }
                        disabled={loadingKind !== null}
                      >
                        <Upload className="h-4 w-4" />
                        Choose CSV
                      </Button>
                    )}
                    <input
                      ref={(element) => {
                        fileRefs.current[definition.kind] = element;
                      }}
                      type="file"
                      accept=".csv,.txt,text/csv"
                      className="hidden"
                      onChange={(event) =>
                        importFile(definition.kind, event)
                      }
                    />
                    {summary && (
                      <p className="mt-2 text-xs leading-5 text-signal">
                        {summary.importedRowCount.toLocaleString()} imported
                        {summary.unmatchedRowCount > 0
                          ? ` · ${summary.unmatchedRowCount.toLocaleString()} unmatched`
                          : ""}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
