import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import type { AuthenticatedUser } from "../../../packages/runtime/src/local-auth.js";
import { getUserRole } from "./authorization.js";

interface CaptureWindowRow {
  average_monthly_volume: number | null;
  base_rank: number | null;
  client_id: string;
  client_name: string;
  har_revenue_gain: string | null;
  is_in_capture_window: boolean;
  keyword: string;
  keyword_id: string;
  keyword_priority: number | null;
  months_to_peak: number;
  peak_month: number;
  project_id: string;
  project_name: string;
  revenue_at_rank_1: string | null;
  seasonal_urgency: string;
}

interface ProjectForecastRow {
  forecast_clicks: string;
  keyword_count: string;
  project_id: string;
  revenue_uplift_rank_1: string;
  tp_revenue_uplift: string;
}

interface PortfolioRoadmapRow {
  generated_at: Date;
  id: string;
  project_id: string;
  roadmap_markdown: string;
}

interface SeasonalityRow {
  month: number;
  project_id: string;
  volume: string;
}

interface UrlMonitorStatsRow {
  critical: string;
  good: string;
  total: string;
  warning: string;
}

function accessParameters(
  role: string | null,
  user: AuthenticatedUser,
): [string, string] {
  return [role ?? "view_only", user.id];
}

export async function listCaptureWindowRows(
  pool: DatabasePool,
  user: AuthenticatedUser,
  inWindowOnly: boolean,
): Promise<Record<string, unknown>> {
  const role = await getUserRole(pool, user.id);
  const result = await pool.query<CaptureWindowRow>(
    `
      WITH accessible_projects AS (
        SELECT project.id, project.client_id, project.project_name
        FROM navigator_projects AS project
        JOIN clients AS client ON client.id = project.client_id
        WHERE project.archived_at IS NULL
          AND client.archived_at IS NULL
          AND (
            $1::text IN ('super_admin', 'admin', 'user')
            OR EXISTS (
              SELECT 1
              FROM user_client_access AS access
              WHERE access.user_id = $2
                AND access.client_id = project.client_id
            )
          )
      ),
      latest_runs AS (
        SELECT project.id AS project_id, run.id AS run_id
        FROM accessible_projects AS project
        JOIN LATERAL (
          SELECT pipeline.id
          FROM pipeline_runs AS pipeline
          WHERE pipeline.input->>'projectId' = project.id::text
            AND pipeline.status = 'succeeded'
          ORDER BY pipeline.completed_at DESC, pipeline.id DESC
          LIMIT 1
        ) AS run ON true
      ),
      seasonal_keywords AS (
        SELECT
          keyword.id AS keyword_id,
          keyword.keyword,
          keyword.avg_monthly_volume AS average_monthly_volume,
          keyword.keyword_priority,
          project.id AS project_id,
          project.project_name,
          project.client_id,
          client.company_name AS client_name,
          har.base_rank,
          revenue.target_incremental_revenue_annual::text
            AS revenue_at_rank_1,
          revenue.expected_incremental_annual::text AS har_revenue_gain,
          peak.peak_month,
          (
            (
              peak.peak_month
              - extract(month FROM current_date)::integer
              + 12
            ) % 12
          )::integer AS months_to_peak,
          demand.seasonality_strength
        FROM latest_runs AS latest
        JOIN accessible_projects AS project ON project.id = latest.project_id
        JOIN clients AS client ON client.id = project.client_id
        JOIN keyword_demand_signals AS demand
          ON demand.project_id = latest.project_id
         AND demand.pipeline_run_id = latest.run_id
        JOIN keywords AS keyword ON keyword.id = demand.keyword_id
        JOIN revenue_forecasts AS revenue
          ON revenue.pipeline_run_id = latest.run_id
         AND revenue.keyword_id = keyword.id
         AND revenue.scenario = 'realistic'
        JOIN har_forecasts AS har
          ON har.pipeline_run_id = revenue.pipeline_run_id
         AND har.keyword_id = revenue.keyword_id
         AND har.scenario = revenue.scenario
        JOIN LATERAL (
          SELECT candidate AS peak_month
          FROM unnest(demand.peak_months) AS candidate
          ORDER BY
            (
              candidate
              - extract(month FROM current_date)::integer
              + 12
            ) % 12
          LIMIT 1
        ) AS peak ON true
      )
      SELECT
        keyword_id,
        keyword,
        average_monthly_volume,
        keyword_priority,
        project_id,
        project_name,
        client_id,
        client_name,
        base_rank,
        revenue_at_rank_1,
        har_revenue_gain,
        peak_month,
        months_to_peak,
        months_to_peak BETWEEN 2 AND 4 AS is_in_capture_window,
        (
          seasonality_strength
          * CASE
              WHEN months_to_peak BETWEEN 2 AND 4
                THEN 1 - abs(months_to_peak - 3)::numeric / 4
              ELSE 0
            END
        )::text AS seasonal_urgency
      FROM seasonal_keywords
      WHERE NOT $3::boolean OR months_to_peak BETWEEN 2 AND 4
      ORDER BY
        15 DESC,
        revenue_at_rank_1::numeric DESC NULLS LAST,
        keyword
      LIMIT 2_000
    `,
    [...accessParameters(role, user), inWindowOnly],
  );
  return {
    items: result.rows.map((row) => ({
      averageMonthlyVolume: row.average_monthly_volume,
      baseRank: row.base_rank,
      clientId: row.client_id,
      clientName: row.client_name,
      harRevenueGain: Number(row.har_revenue_gain ?? 0),
      isInCaptureWindow: row.is_in_capture_window,
      keyword: row.keyword,
      keywordId: row.keyword_id,
      keywordPriority: row.keyword_priority,
      monthsToPeak: row.months_to_peak,
      peakMonth: String(row.peak_month),
      projectId: row.project_id,
      projectName: row.project_name,
      revenueAtRank1: Number(row.revenue_at_rank_1 ?? 0),
      seasonalUrgency: Number(row.seasonal_urgency),
      weeksToPeak: Math.round(row.months_to_peak * 4.345),
    })),
  };
}

export async function getPortfolioDashboard(
  pool: DatabasePool,
  user: AuthenticatedUser,
): Promise<Record<string, unknown>> {
  const role = await getUserRole(pool, user.id);
  const parameters = accessParameters(role, user);
  const [forecasts, roadmaps, urlMonitor, seasonality, capture] =
    await Promise.all([
      pool.query<ProjectForecastRow>(
        `
          WITH accessible_projects AS (
            SELECT project.id
            FROM navigator_projects AS project
            JOIN clients AS client ON client.id = project.client_id
            WHERE project.archived_at IS NULL
              AND client.archived_at IS NULL
              AND (
                $1::text IN ('super_admin', 'admin', 'user')
                OR EXISTS (
                  SELECT 1
                  FROM user_client_access AS access
                  WHERE access.user_id = $2
                    AND access.client_id = project.client_id
                )
              )
          ),
          latest_runs AS (
            SELECT project.id AS project_id, run.id AS run_id
            FROM accessible_projects AS project
            LEFT JOIN LATERAL (
              SELECT pipeline.id
              FROM pipeline_runs AS pipeline
              WHERE pipeline.input->>'projectId' = project.id::text
                AND pipeline.status = 'succeeded'
              ORDER BY pipeline.completed_at DESC, pipeline.id DESC
              LIMIT 1
            ) AS run ON true
          )
          SELECT
            latest.project_id,
            count(revenue.keyword_id)::text AS keyword_count,
            coalesce(sum(revenue.expected_incremental_annual), 0)::text
              AS tp_revenue_uplift,
            coalesce(sum(revenue.target_incremental_revenue_annual), 0)::text
              AS revenue_uplift_rank_1,
            coalesce(
              sum(
                revenue.annual_volume
                * revenue.ctr_target
                * revenue.svm_used
              ),
              0
            )::text AS forecast_clicks
          FROM latest_runs AS latest
          LEFT JOIN revenue_forecasts AS revenue
            ON revenue.pipeline_run_id = latest.run_id
           AND revenue.scenario = 'realistic'
          GROUP BY latest.project_id
        `,
        parameters,
      ),
      pool.query<PortfolioRoadmapRow>(
        `
          SELECT
            roadmap.id,
            roadmap.project_id,
            roadmap.generated_at,
            roadmap.roadmap_markdown
          FROM project_roadmaps AS roadmap
          JOIN navigator_projects AS project ON project.id = roadmap.project_id
          JOIN clients AS client ON client.id = project.client_id
          WHERE project.archived_at IS NULL
            AND client.archived_at IS NULL
            AND (
              $1::text IN ('super_admin', 'admin', 'user')
              OR EXISTS (
                SELECT 1
                FROM user_client_access AS access
                WHERE access.user_id = $2
                  AND access.client_id = project.client_id
              )
            )
          ORDER BY roadmap.generated_at DESC, roadmap.id DESC
          LIMIT 100
        `,
        parameters,
      ),
      pool.query<UrlMonitorStatsRow>(
        `
          SELECT
            count(*)::text AS total,
            count(*) FILTER (
              WHERE monitored.current_status = 'critical'
            )::text AS critical,
            count(*) FILTER (
              WHERE monitored.current_status = 'warning'
            )::text AS warning,
            count(*) FILTER (
              WHERE monitored.current_status = 'ok'
            )::text AS good
          FROM monitored_urls AS monitored
          JOIN monitor_campaigns AS campaign ON campaign.id = monitored.campaign_id
          JOIN clients AS client ON client.id = campaign.client_id
          WHERE client.archived_at IS NULL
            AND (
              $1::text IN ('super_admin', 'admin', 'user')
              OR EXISTS (
                SELECT 1
                FROM user_client_access AS access
                WHERE access.user_id = $2
                  AND access.client_id = campaign.client_id
              )
            )
        `,
        parameters,
      ),
      pool.query<SeasonalityRow>(
        `
          WITH accessible_projects AS (
            SELECT project.id
            FROM navigator_projects AS project
            JOIN clients AS client ON client.id = project.client_id
            WHERE project.archived_at IS NULL
              AND client.archived_at IS NULL
              AND (
                $1::text IN ('super_admin', 'admin', 'user')
                OR EXISTS (
                  SELECT 1
                  FROM user_client_access AS access
                  WHERE access.user_id = $2
                    AND access.client_id = project.client_id
                )
              )
          ),
          latest_runs AS (
            SELECT project.id AS project_id, run.id AS run_id
            FROM accessible_projects AS project
            JOIN LATERAL (
              SELECT pipeline.id
              FROM pipeline_runs AS pipeline
              WHERE pipeline.input->>'projectId' = project.id::text
                AND pipeline.status = 'succeeded'
              ORDER BY pipeline.completed_at DESC, pipeline.id DESC
              LIMIT 1
            ) AS run ON true
          )
          SELECT
            latest.project_id,
            peak.month,
            sum(coalesce(keyword.avg_monthly_volume, 1))::text AS volume
          FROM latest_runs AS latest
          JOIN keyword_demand_signals AS demand
            ON demand.project_id = latest.project_id
           AND demand.pipeline_run_id = latest.run_id
          JOIN keywords AS keyword ON keyword.id = demand.keyword_id
          CROSS JOIN LATERAL unnest(demand.peak_months) AS peak(month)
          GROUP BY latest.project_id, peak.month
          ORDER BY latest.project_id, peak.month
        `,
        parameters,
      ),
      listCaptureWindowRows(pool, user, true),
    ]);
  const monitor = urlMonitor.rows[0];
  return {
    captureWindow: capture,
    projectForecasts: forecasts.rows.map((row) => ({
      forecastClicks: Number(row.forecast_clicks),
      keywordCount: Number(row.keyword_count),
      projectId: row.project_id,
      revenueUpliftRank1: Number(row.revenue_uplift_rank_1),
      tpRevenueUplift: Number(row.tp_revenue_uplift),
    })),
    roadmaps: roadmaps.rows.map((row) => ({
      generatedAt: row.generated_at.toISOString(),
      id: row.id,
      projectId: row.project_id,
      roadmapMarkdown: row.roadmap_markdown,
    })),
    seasonality: seasonality.rows.map((row) => ({
      month: row.month,
      projectId: row.project_id,
      volume: Number(row.volume),
    })),
    urlMonitor: {
      critical: Number(monitor?.critical ?? 0),
      good: Number(monitor?.good ?? 0),
      total: Number(monitor?.total ?? 0),
      warning: Number(monitor?.warning ?? 0),
    },
  };
}
