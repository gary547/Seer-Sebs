import type { PoolClient, QueryResultRow } from "pg";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { withTransaction } from "../../../packages/runtime/src/database.js";
import { HttpError } from "../../../packages/runtime/src/http.js";
import type { AuthenticatedUser } from "../../../packages/runtime/src/local-auth.js";
import { assertAdministrator } from "./authorization.js";

interface ProjectRow extends QueryResultRow {
  archived_at: Date | null;
  brand_terms: string[];
  id: string;
}

interface LatestRunRow extends QueryResultRow {
  completed_at: Date;
  id: string;
}

interface GscUploadRow extends QueryResultRow {
  created_at: Date;
  date_range_end: Date | null;
  date_range_start: Date | null;
  device: string;
  id: string;
  original_filename: string | null;
  page_count: string;
  query_count: string;
  row_count: number;
  source_name: string;
}

interface KeywordOverviewRow extends QueryResultRow {
  base_rank_sources: Record<string, number>;
  branded_count: string;
  kept_count: string;
  missing_base_rank_count: string;
  total_count: string;
  unbranded_count: string;
  unclassified_brand_count: string;
  with_base_rank_count: string;
}

interface VolumeSummaryRow extends QueryResultRow {
  earliest_month: Date | null;
  history_row_count: string;
  kept_keyword_count: string;
  latest_month: Date | null;
  maximum_months: string | null;
  median_months: string | null;
  minimum_months: string | null;
  with_12_months_count: string;
  with_24_months_count: string;
  with_history_count: string;
}

interface VolumeSampleRow extends QueryResultRow {
  keyword: string;
  keyword_id: string;
  month_count: string;
  months: Array<{ month: string; volume: number }>;
}

interface ClusterSummaryRow extends QueryResultRow {
  canonical_bases: Record<string, number>;
  cluster_count: string;
  largest_cluster: string | null;
  member_count: string;
  multi_member_count: string;
  top_clusters: Array<{
    canonicalKeyword: string;
    clusterKey: string;
    memberCount: number;
  }>;
}

interface DemandSummaryRow extends QueryResultRow {
  average_coverage_months: string | null;
  category_rows: Array<{
    category: string;
    keywordCount: number;
    monthlyVolume: number;
    warningCount: number;
  }>;
  signal_count: string;
  trend_directions: Record<string, number>;
  warning_count: string;
}

interface SerpSummaryRow extends QueryResultRow {
  average_visibility_multiplier: string | null;
  feature_count: string;
  feature_types: Array<{
    count: number;
    ownedCount: number;
    resultType: string;
  }>;
  keyword_count: string;
  owned_count: string;
}

interface ContentFitSummaryRow extends QueryResultRow {
  average_score: string | null;
  matched_count: string;
  missing_count: string;
  scored_count: string;
  total_count: string;
  zero_count: string;
  zero_rows: Array<{
    keyword: string;
    rankingUrl: string | null;
    tacticalStatus: string | null;
  }>;
}

interface ComparisonSummaryRow extends QueryResultRow {
  average_har_delta: string | null;
  comparable_har_count: string;
  comparable_revenue_count: string;
  items: Array<{
    currentRevenueV1: number | null;
    currentRevenueV2: number | null;
    harV1: number | null;
    harV2: number | null;
    keyword: string;
    keywordId: string;
    targetIncrementalRevenueV1: number | null;
    targetIncrementalRevenueV2: number | null;
  }>;
  keyword_count: string;
}

interface RecentRunRow extends QueryResultRow {
  completed_at: Date | null;
  created_at: Date;
  failure_stage: string | null;
  id: string;
  started_at: Date | null;
  status: string;
}

function number(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function getAdminProject(
  database: DatabasePool | PoolClient,
  userId: string,
  projectId: string,
): Promise<ProjectRow> {
  await assertAdministrator(database, userId);
  const result = await database.query<ProjectRow>(
    `
      SELECT project.id, project.archived_at, client.brand_terms
      FROM navigator_projects AS project
      JOIN clients AS client ON client.id = project.client_id
      WHERE project.id = $1
    `,
    [projectId],
  );
  const project = result.rows[0];
  if (!project) {
    throw new HttpError(404, "project_not_found", "Project not found.");
  }
  return project;
}

export async function getProjectCalculationControl(
  pool: DatabasePool,
  user: AuthenticatedUser,
  projectId: string,
): Promise<Record<string, unknown>> {
  const project = await getAdminProject(pool, user.id, projectId);
  const latestRunResult = await pool.query<LatestRunRow>(
    `
      SELECT id, completed_at
      FROM pipeline_runs
      WHERE input->>'projectId' = $1
        AND status = 'succeeded'
      ORDER BY completed_at DESC, id DESC
      LIMIT 1
    `,
    [projectId],
  );
  const latestRun = latestRunResult.rows[0] ?? null;
  const runId = latestRun?.id ?? null;

  const [
    uploads,
    keywordOverview,
    volumeSummary,
    volumeSample,
    clusterSummary,
    demandSummary,
    serpSummary,
    contentFitSummary,
    comparisonSummary,
    recentRuns,
  ] = await Promise.all([
    pool.query<GscUploadRow>(
      `
        SELECT
          upload.id,
          upload.source_name,
          upload.original_filename,
          upload.row_count,
          upload.device,
          upload.date_range_start,
          upload.date_range_end,
          upload.created_at,
          (
            SELECT count(*)::text
            FROM gsc_upload_keywords AS keyword_row
            WHERE keyword_row.upload_id = upload.id
          ) AS query_count,
          (
            SELECT count(*)::text
            FROM gsc_upload_pages AS page_row
            WHERE page_row.upload_id = upload.id
          ) AS page_count
        FROM gsc_uploads AS upload
        WHERE upload.project_id = $1
        ORDER BY upload.created_at DESC, upload.id DESC
        LIMIT 20
      `,
      [projectId],
    ),
    pool.query<KeywordOverviewRow>(
      `
        WITH base_sources AS (
          SELECT
            COALESCE(NULLIF(base_rank_source, ''), 'unknown') AS source,
            count(*)::integer AS count
          FROM keywords
          WHERE project_id = $1
            AND detox_status = 'keep'
            AND base_rank IS NOT NULL
          GROUP BY COALESCE(NULLIF(base_rank_source, ''), 'unknown')
        )
        SELECT
          count(*)::text AS total_count,
          count(*) FILTER (WHERE detox_status = 'keep')::text AS kept_count,
          count(*) FILTER (
            WHERE detox_status = 'keep' AND base_rank IS NOT NULL
          )::text AS with_base_rank_count,
          count(*) FILTER (
            WHERE detox_status = 'keep' AND base_rank IS NULL
          )::text AS missing_base_rank_count,
          count(*) FILTER (WHERE is_branded IS TRUE)::text AS branded_count,
          count(*) FILTER (WHERE is_branded IS FALSE)::text AS unbranded_count,
          count(*) FILTER (WHERE is_branded IS NULL)::text
            AS unclassified_brand_count,
          COALESCE(
            (SELECT jsonb_object_agg(source, count) FROM base_sources),
            '{}'::jsonb
          ) AS base_rank_sources
        FROM keywords
        WHERE project_id = $1
      `,
      [projectId],
    ),
    pool.query<VolumeSummaryRow>(
      `
        WITH history AS (
          SELECT
            keyword.id,
            count(volume.id)::integer AS month_count,
            min(volume.month) AS earliest_month,
            max(volume.month) AS latest_month
          FROM keywords AS keyword
          LEFT JOIN keyword_monthly_volumes AS volume
            ON volume.keyword_id = keyword.id
          WHERE keyword.project_id = $1
            AND keyword.detox_status = 'keep'
          GROUP BY keyword.id
        )
        SELECT
          count(*)::text AS kept_keyword_count,
          count(*) FILTER (WHERE month_count > 0)::text AS with_history_count,
          count(*) FILTER (WHERE month_count >= 12)::text AS with_12_months_count,
          count(*) FILTER (WHERE month_count >= 24)::text AS with_24_months_count,
          sum(month_count)::text AS history_row_count,
          min(month_count)::text AS minimum_months,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY month_count)::text
            AS median_months,
          max(month_count)::text AS maximum_months,
          min(earliest_month) AS earliest_month,
          max(latest_month) AS latest_month
        FROM history
      `,
      [projectId],
    ),
    pool.query<VolumeSampleRow>(
      `
        SELECT
          keyword.id AS keyword_id,
          keyword.keyword,
          count(volume.id)::text AS month_count,
          COALESCE(
            jsonb_agg(
              jsonb_build_object(
                'month', to_char(volume.month, 'YYYY-MM-DD'),
                'volume', volume.volume
              ) ORDER BY volume.month
            ) FILTER (WHERE volume.id IS NOT NULL),
            '[]'::jsonb
          ) AS months
        FROM keywords AS keyword
        LEFT JOIN keyword_monthly_volumes AS volume
          ON volume.keyword_id = keyword.id
        WHERE keyword.project_id = $1
          AND keyword.detox_status = 'keep'
        GROUP BY keyword.id, keyword.keyword, keyword.normalised_keyword
        ORDER BY count(volume.id) DESC, keyword.normalised_keyword
        LIMIT 20
      `,
      [projectId],
    ),
    pool.query<ClusterSummaryRow>(
      `
        WITH clusters AS (
          SELECT
            cluster.id,
            cluster.cluster_key,
            cluster.canonical_basis,
            cluster.member_count,
            keyword.keyword AS canonical_keyword
          FROM keyword_clusters AS cluster
          JOIN keywords AS keyword ON keyword.id = cluster.canonical_keyword_id
          WHERE cluster.project_id = $1
            AND cluster.pipeline_run_id = $2::uuid
        ), bases AS (
          SELECT canonical_basis, count(*)::integer AS count
          FROM clusters
          GROUP BY canonical_basis
        ), top_clusters AS (
          SELECT cluster_key, canonical_keyword, member_count
          FROM clusters
          ORDER BY member_count DESC, cluster_key
          LIMIT 20
        )
        SELECT
          count(*)::text AS cluster_count,
          COALESCE(sum(member_count), 0)::text AS member_count,
          count(*) FILTER (WHERE member_count > 1)::text AS multi_member_count,
          max(member_count)::text AS largest_cluster,
          COALESCE(
            (SELECT jsonb_object_agg(canonical_basis, count) FROM bases),
            '{}'::jsonb
          ) AS canonical_bases,
          COALESCE(
            (
              SELECT jsonb_agg(jsonb_build_object(
                'clusterKey', cluster_key,
                'canonicalKeyword', canonical_keyword,
                'memberCount', member_count
              ) ORDER BY member_count DESC, cluster_key)
              FROM top_clusters
            ),
            '[]'::jsonb
          ) AS top_clusters
        FROM clusters
      `,
      [projectId, runId],
    ),
    pool.query<DemandSummaryRow>(
      `
        WITH signals AS (
          SELECT
            signal.*,
            COALESCE(keyword.category, 'Uncategorised') AS category,
            COALESCE(keyword.avg_monthly_volume, 0) AS monthly_volume
          FROM keyword_demand_signals AS signal
          JOIN keywords AS keyword ON keyword.id = signal.keyword_id
          WHERE signal.project_id = $1
            AND signal.pipeline_run_id = $2::uuid
        ), trends AS (
          SELECT trend_direction, count(*)::integer AS count
          FROM signals
          GROUP BY trend_direction
        ), categories AS (
          SELECT
            category,
            count(*)::integer AS keyword_count,
            sum(monthly_volume)::integer AS monthly_volume,
            count(*) FILTER (WHERE demand_warning)::integer AS warning_count
          FROM signals
          GROUP BY category
          ORDER BY sum(monthly_volume) DESC, category
          LIMIT 50
        )
        SELECT
          count(*)::text AS signal_count,
          count(*) FILTER (WHERE demand_warning)::text AS warning_count,
          avg(coverage_months)::text AS average_coverage_months,
          COALESCE(
            (SELECT jsonb_object_agg(trend_direction, count) FROM trends),
            '{}'::jsonb
          ) AS trend_directions,
          COALESCE(
            (
              SELECT jsonb_agg(jsonb_build_object(
                'category', category,
                'keywordCount', keyword_count,
                'monthlyVolume', monthly_volume,
                'warningCount', warning_count
              ) ORDER BY monthly_volume DESC, category)
              FROM categories
            ),
            '[]'::jsonb
          ) AS category_rows
        FROM signals
      `,
      [projectId, runId],
    ),
    pool.query<SerpSummaryRow>(
      `
        WITH feature_types AS (
          SELECT
            result_type,
            count(*)::integer AS count,
            count(*) FILTER (WHERE owned)::integer AS owned_count
          FROM project_serp_features
          WHERE project_id = $1
          GROUP BY result_type
          ORDER BY count(*) DESC, result_type
          LIMIT 30
        )
        SELECT
          (SELECT count(*)::text FROM project_serp_features
            WHERE project_id = $1) AS feature_count,
          (SELECT count(DISTINCT keyword_id)::text FROM project_serp_features
            WHERE project_id = $1) AS keyword_count,
          (SELECT count(*) FILTER (WHERE owned)::text FROM project_serp_features
            WHERE project_id = $1) AS owned_count,
          (
            SELECT avg(serp_visibility_multiplier)::text
            FROM har_forecasts
            WHERE project_id = $1
              AND pipeline_run_id = $2::uuid
              AND scenario = 'realistic'
          ) AS average_visibility_multiplier,
          COALESCE(
            (
              SELECT jsonb_agg(jsonb_build_object(
                'resultType', result_type,
                'count', count,
                'ownedCount', owned_count
              ) ORDER BY count DESC, result_type)
              FROM feature_types
            ),
            '[]'::jsonb
          ) AS feature_types
      `,
      [projectId, runId],
    ),
    pool.query<ContentFitSummaryRow>(
      `
        WITH rows AS (
          SELECT
            keyword.keyword,
            keyword.ranking_url,
            architecture.relevancy_score,
            architecture.provider_status,
            architecture.tactical_status
          FROM keywords AS keyword
          LEFT JOIN site_architecture AS architecture
            ON architecture.keyword_id = keyword.id
           AND architecture.pipeline_run_id = $2::uuid
          WHERE keyword.project_id = $1
            AND keyword.detox_status = 'keep'
        ), zero_rows AS (
          SELECT keyword, ranking_url, tactical_status
          FROM rows
          WHERE relevancy_score = 0
          ORDER BY keyword
          LIMIT 20
        )
        SELECT
          count(*)::text AS total_count,
          count(*) FILTER (WHERE provider_status = 'matched')::text AS matched_count,
          count(*) FILTER (
            WHERE provider_status IS NULL OR provider_status = 'missing-provider'
          )::text AS missing_count,
          count(relevancy_score)::text AS scored_count,
          count(*) FILTER (WHERE relevancy_score = 0)::text AS zero_count,
          avg(relevancy_score)::text AS average_score,
          COALESCE(
            (
              SELECT jsonb_agg(jsonb_build_object(
                'keyword', keyword,
                'rankingUrl', ranking_url,
                'tacticalStatus', tactical_status
              ) ORDER BY keyword)
              FROM zero_rows
            ),
            '[]'::jsonb
          ) AS zero_rows
        FROM rows
      `,
      [projectId, runId],
    ),
    pool.query<ComparisonSummaryRow>(
      `
        WITH comparison AS (
          SELECT
            keyword.id AS keyword_id,
            keyword.keyword,
            legacy.har AS har_v1,
            har.har_position AS har_v2,
            legacy.current_revenue_annual AS current_revenue_v1,
            revenue.current_revenue_annual AS current_revenue_v2,
            legacy.target_incremental_revenue_annual
              AS target_incremental_revenue_v1,
            revenue.target_incremental_revenue_annual
              AS target_incremental_revenue_v2
          FROM har_forecasts AS har
          JOIN keywords AS keyword ON keyword.id = har.keyword_id
          LEFT JOIN legacy_keyword_forecasts AS legacy
            ON legacy.keyword_id = har.keyword_id
          LEFT JOIN revenue_forecasts AS revenue
            ON revenue.pipeline_run_id = har.pipeline_run_id
           AND revenue.keyword_id = har.keyword_id
           AND revenue.scenario = har.scenario
          WHERE har.project_id = $1
            AND har.pipeline_run_id = $2::uuid
            AND har.scenario = 'realistic'
        ), sample AS (
          SELECT *
          FROM comparison
          ORDER BY keyword
          LIMIT 50
        )
        SELECT
          count(*)::text AS keyword_count,
          count(*) FILTER (
            WHERE har_v1 IS NOT NULL AND har_v2 IS NOT NULL
          )::text AS comparable_har_count,
          avg(abs(har_v2 - har_v1)) FILTER (
            WHERE har_v1 IS NOT NULL AND har_v2 IS NOT NULL
          )::text AS average_har_delta,
          count(*) FILTER (
            WHERE target_incremental_revenue_v1 IS NOT NULL
              AND target_incremental_revenue_v2 IS NOT NULL
          )::text AS comparable_revenue_count,
          COALESCE(
            (
              SELECT jsonb_agg(jsonb_build_object(
                'keywordId', keyword_id,
                'keyword', keyword,
                'harV1', har_v1,
                'harV2', har_v2,
                'currentRevenueV1', current_revenue_v1,
                'currentRevenueV2', current_revenue_v2,
                'targetIncrementalRevenueV1', target_incremental_revenue_v1,
                'targetIncrementalRevenueV2', target_incremental_revenue_v2
              ) ORDER BY keyword)
              FROM sample
            ),
            '[]'::jsonb
          ) AS items
        FROM comparison
      `,
      [projectId, runId],
    ),
    pool.query<RecentRunRow>(
      `
        SELECT
          run.id,
          run.status,
          run.created_at,
          run.started_at,
          run.completed_at,
          failed.stage_id AS failure_stage
        FROM pipeline_runs AS run
        LEFT JOIN LATERAL (
          SELECT stage.stage_id
          FROM pipeline_stage_runs AS stage
          WHERE stage.run_id = run.id
            AND stage.state = 'failed'
          ORDER BY stage.completed_at DESC NULLS LAST, stage.stage_id
          LIMIT 1
        ) AS failed ON true
        WHERE run.input->>'projectId' = $1
        ORDER BY run.created_at DESC, run.id DESC
        LIMIT 20
      `,
      [projectId],
    ),
  ]);

  const keyword = keywordOverview.rows[0];
  const volume = volumeSummary.rows[0];
  const clusters = clusterSummary.rows[0];
  const demand = demandSummary.rows[0];
  const serp = serpSummary.rows[0];
  const contentFit = contentFitSummary.rows[0];
  const comparisons = comparisonSummary.rows[0];
  if (!keyword || !volume || !clusters || !demand || !serp || !contentFit || !comparisons) {
    throw new Error("Calculation control aggregation returned no row.");
  }

  return {
    archived: project.archived_at !== null,
    baseRank: {
      missing: Number(keyword.missing_base_rank_count),
      sources: keyword.base_rank_sources,
      total: Number(keyword.kept_count),
      withRank: Number(keyword.with_base_rank_count),
    },
    brandClassification: {
      brandTerms: project.brand_terms,
      branded: Number(keyword.branded_count),
      total: Number(keyword.total_count),
      unbranded: Number(keyword.unbranded_count),
      unclassified: Number(keyword.unclassified_brand_count),
    },
    clustering: {
      canonicalBases: clusters.canonical_bases,
      clusterCount: Number(clusters.cluster_count),
      largestCluster: number(clusters.largest_cluster),
      memberCount: Number(clusters.member_count),
      multiMemberCount: Number(clusters.multi_member_count),
      topClusters: clusters.top_clusters,
    },
    comparisons: {
      averageHarDelta: number(comparisons.average_har_delta),
      comparableHarCount: Number(comparisons.comparable_har_count),
      comparableRevenueCount: Number(comparisons.comparable_revenue_count),
      items: comparisons.items,
      keywordCount: Number(comparisons.keyword_count),
    },
    contentFit: {
      averageScore: number(contentFit.average_score),
      matched: Number(contentFit.matched_count),
      missing: Number(contentFit.missing_count),
      scored: Number(contentFit.scored_count),
      total: Number(contentFit.total_count),
      zero: Number(contentFit.zero_count),
      zeroRows: contentFit.zero_rows,
    },
    demand: {
      averageCoverageMonths: number(demand.average_coverage_months),
      categories: demand.category_rows,
      signals: Number(demand.signal_count),
      trendDirections: demand.trend_directions,
      warnings: Number(demand.warning_count),
    },
    generatedAt: new Date().toISOString(),
    gscReadiness: {
      uploads: uploads.rows.map((upload) => ({
        createdAt: iso(upload.created_at),
        dateRangeEnd: iso(upload.date_range_end)?.slice(0, 10) ?? null,
        dateRangeStart: iso(upload.date_range_start)?.slice(0, 10) ?? null,
        device: upload.device,
        id: upload.id,
        originalFilename: upload.original_filename,
        pageRows: Number(upload.page_count),
        queryRows: Number(upload.query_count),
        rowCount: upload.row_count,
        sourceName: upload.source_name,
      })),
    },
    latestSuccessfulRun: latestRun
      ? { completedAt: latestRun.completed_at.toISOString(), id: latestRun.id }
      : null,
    projectId,
    recentRuns: recentRuns.rows.map((run) => ({
      completedAt: iso(run.completed_at),
      createdAt: iso(run.created_at),
      failureStage: run.failure_stage,
      id: run.id,
      startedAt: iso(run.started_at),
      status: run.status,
    })),
    serpVisibility: {
      averageMultiplier: number(serp.average_visibility_multiplier),
      featureCount: Number(serp.feature_count),
      featureTypes: serp.feature_types,
      keywordCount: Number(serp.keyword_count),
      ownedCount: Number(serp.owned_count),
    },
    volumeHistory: {
      earliestMonth: iso(volume.earliest_month)?.slice(0, 10) ?? null,
      historyRows: Number(volume.history_row_count ?? "0"),
      keptKeywords: Number(volume.kept_keyword_count),
      latestMonth: iso(volume.latest_month)?.slice(0, 10) ?? null,
      maximumMonths: number(volume.maximum_months),
      medianMonths: number(volume.median_months),
      minimumMonths: number(volume.minimum_months),
      sample: volumeSample.rows.map((row) => ({
        keyword: row.keyword,
        keywordId: row.keyword_id,
        monthCount: Number(row.month_count),
        months: row.months,
      })),
      with12Months: Number(volume.with_12_months_count),
      with24Months: Number(volume.with_24_months_count),
      withHistory: Number(volume.with_history_count),
    },
  };
}

export async function deleteProjectGscUpload(
  pool: DatabasePool,
  user: AuthenticatedUser,
  projectId: string,
  uploadId: string,
): Promise<Record<string, unknown>> {
  return withTransaction(pool, async (client) => {
    const project = await getAdminProject(client, user.id, projectId);
    if (project.archived_at !== null) {
      throw new HttpError(409, "project_archived", "Archived projects are read-only.");
    }
    const deleted = await client.query<{ id: string }>(
      `
        DELETE FROM gsc_uploads
        WHERE id = $1
          AND project_id = $2
        RETURNING id
      `,
      [uploadId, projectId],
    );
    if (deleted.rowCount !== 1) {
      throw new HttpError(404, "gsc_upload_not_found", "GSC upload not found.");
    }
    await client.query(
      `
        UPDATE navigator_projects
        SET
          inputs_dirty = true,
          keywords_dirty = true,
          last_dirty_at = now(),
          updated_at = now()
        WHERE id = $1
      `,
      [projectId],
    );
    return { deleted: true, projectId, uploadId };
  });
}
