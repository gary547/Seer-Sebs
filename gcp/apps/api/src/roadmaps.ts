import { randomUUID } from "node:crypto";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import type { AuthenticatedUser } from "../../../packages/runtime/src/local-auth.js";
import { HttpError } from "../../../packages/runtime/src/http.js";
import { assertProjectAccessByRole } from "./authorization.js";

interface RoadmapRow {
  generated_at: Date;
  generation_source: string;
  id: string;
  model_version: string;
  pipeline_run_id: string | null;
  roadmap_markdown: string;
  synced_at: Date | null;
}

interface RoadmapProjectRow {
  last_synced_at: Date | null;
  project_name: string;
}

interface RoadmapOpportunityRow {
  base_rank: number | null;
  category: string | null;
  competitor_url_rating: string | null;
  expected_incremental_annual: string | null;
  har_position: number | null;
  keyword: string;
  keyword_priority: number | null;
  matched_url: string | null;
  ranking_url: string | null;
  relevancy_score: string | null;
  search_intent: string | null;
  tactical_status: string | null;
}

function safeText(value: string | null, fallback = "not available"): string {
  return (value ?? fallback).replace(/[\r\n|]+/g, " ").trim();
}

function currency(value: string | null): string {
  if (value === null) return "not available";
  return new Intl.NumberFormat("en-GB", {
    currency: "GBP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number(value));
}

function roadmapMarkdown(
  projectName: string,
  rows: RoadmapOpportunityRow[],
): string {
  const actions = rows.slice(0, 5).map((row, index) => {
    const action =
      row.tactical_status === "create_content" ||
      row.tactical_status === "new_content"
        ? "Create a dedicated landing page"
        : row.tactical_status === "optimise_content"
          ? "Improve the existing page"
          : row.competitor_url_rating !== null &&
              Number(row.competitor_url_rating) > 50
            ? "Strengthen authority and supporting links"
            : "Improve relevance and internal linking";
    return [
      `### ${index + 1}. ${action} for "${safeText(row.keyword)}"`,
      `Target: ${safeText(row.ranking_url ?? row.matched_url)} | Rank: ${row.base_rank ?? "unranked"} → ${row.har_position ?? "not available"} | Revenue: ${currency(row.expected_incremental_annual)}`,
      `Evidence: Priority ${row.keyword_priority ?? "unassigned"}; ${safeText(row.category, "uncategorised")}; ${safeText(row.search_intent, "unknown intent")}; content fit ${row.relevancy_score === null ? "not available" : `${Math.round(Number(row.relevancy_score))}%`}.`,
      `Action: ${action}. Keep the page focused on this search need, resolve the indicated architecture action, and measure movement against the target position.`,
      `Expected impact: Protect or unlock ${currency(row.expected_incremental_annual)} in modelled annual incremental revenue.`,
    ].join("\n");
  });
  return [
    `## ${safeText(projectName)} roadmap`,
    "A prioritised action list based on the latest successful forecast, site architecture evidence and attainable-rank model.",
    ...actions,
  ].join("\n\n");
}

function serializeRoadmap(row: RoadmapRow): Record<string, unknown> {
  return {
    generatedAt: row.generated_at.toISOString(),
    generationSource: row.generation_source,
    id: row.id,
    modelVersion: row.model_version,
    pipelineRunId: row.pipeline_run_id,
    roadmapMarkdown: row.roadmap_markdown,
    syncedAt: row.synced_at?.toISOString() ?? null,
  };
}

export async function listProjectRoadmaps(
  pool: DatabasePool,
  user: AuthenticatedUser,
  projectId: string,
): Promise<Record<string, unknown>> {
  await assertProjectAccessByRole(pool, user.id, projectId);
  const result = await pool.query<RoadmapRow>(
    `
      SELECT
        id,
        pipeline_run_id,
        roadmap_markdown,
        generation_source,
        model_version,
        generated_at,
        synced_at
      FROM project_roadmaps
      WHERE project_id = $1
      ORDER BY generated_at DESC, id DESC
      LIMIT 100
    `,
    [projectId],
  );
  return {
    projectId,
    roadmaps: result.rows.map(serializeRoadmap),
  };
}

export async function generateProjectRoadmap(
  pool: DatabasePool,
  user: AuthenticatedUser,
  projectId: string,
): Promise<Record<string, unknown>> {
  await assertProjectAccessByRole(pool, user.id, projectId, true);
  const [projectResult, runResult] = await Promise.all([
    pool.query<RoadmapProjectRow>(
      `
        SELECT project_name, last_synced_at
        FROM navigator_projects
        WHERE id = $1
      `,
      [projectId],
    ),
    pool.query<{ id: string }>(
      `
        SELECT id
        FROM pipeline_runs
        WHERE input->>'projectId' = $1
          AND status = 'succeeded'
        ORDER BY completed_at DESC, id DESC
        LIMIT 1
      `,
      [projectId],
    ),
  ]);
  const project = projectResult.rows[0];
  const run = runResult.rows[0];
  if (!project) {
    throw new HttpError(404, "project_not_found", "Project not found.");
  }
  if (!run) {
    throw new HttpError(
      409,
      "forecast_required",
      "Run the project pipeline before generating a roadmap.",
    );
  }
  const opportunities = await pool.query<RoadmapOpportunityRow>(
    `
      SELECT
        keyword.keyword,
        keyword.keyword_priority,
        keyword.category,
        keyword.search_intent,
        keyword.ranking_url,
        har.base_rank,
        har.har_position,
        revenue.expected_incremental_annual::text,
        architecture.matched_url,
        architecture.relevancy_score::text,
        architecture.tactical_status,
        competitor.url_rating::text AS competitor_url_rating
      FROM revenue_forecasts AS revenue
      JOIN har_forecasts AS har
        ON har.pipeline_run_id = revenue.pipeline_run_id
       AND har.keyword_id = revenue.keyword_id
       AND har.scenario = revenue.scenario
      JOIN keywords AS keyword ON keyword.id = revenue.keyword_id
      LEFT JOIN site_architecture AS architecture
        ON architecture.pipeline_run_id = revenue.pipeline_run_id
       AND architecture.keyword_id = revenue.keyword_id
      LEFT JOIN LATERAL (
        SELECT result.url_rating
        FROM serp_results AS result
        WHERE result.project_id = revenue.project_id
          AND result.keyword_id = revenue.keyword_id
          AND NOT result.is_client_domain
        ORDER BY result.rank_absolute
        LIMIT 1
      ) AS competitor ON true
      WHERE revenue.project_id = $1
        AND revenue.pipeline_run_id = $2
        AND revenue.scenario = 'realistic'
      ORDER BY
        keyword.keyword_priority ASC NULLS LAST,
        revenue.expected_incremental_annual DESC NULLS LAST,
        keyword.normalised_keyword
      LIMIT 40
    `,
    [projectId, run.id],
  );
  if (opportunities.rows.length === 0) {
    throw new HttpError(
      409,
      "forecast_required",
      "No forecast opportunities are available for this roadmap.",
    );
  }
  const id = randomUUID();
  const markdown = roadmapMarkdown(
    project.project_name,
    opportunities.rows,
  );
  const inserted = await pool.query<RoadmapRow>(
    `
      INSERT INTO project_roadmaps (
        id,
        project_id,
        pipeline_run_id,
        roadmap_markdown,
        generation_source,
        model_version,
        generated_by,
        synced_at
      )
      VALUES ($1, $2, $3, $4, 'deterministic', 'roadmap-v1', $5, $6)
      RETURNING
        id,
        pipeline_run_id,
        roadmap_markdown,
        generation_source,
        model_version,
        generated_at,
        synced_at
    `,
    [id, projectId, run.id, markdown, user.id, project.last_synced_at],
  );
  const roadmap = inserted.rows[0];
  if (!roadmap) {
    throw new Error("Roadmap insert did not return the persisted row.");
  }
  return {
    projectId,
    roadmap: serializeRoadmap(roadmap),
  };
}
