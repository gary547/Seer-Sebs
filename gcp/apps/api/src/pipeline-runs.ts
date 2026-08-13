import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { withTransaction } from "../../../packages/runtime/src/database.js";
import { HttpError } from "../../../packages/runtime/src/http.js";
import type { AuthenticatedUser } from "../../../packages/runtime/src/local-auth.js";
import {
  PIPELINE_STAGES,
  type PipelineStageId,
} from "../../../packages/pipeline/src/definition.js";
import { assertProjectAccessByRole } from "./authorization.js";

interface PipelineRunRow {
  completed_at: Date | null;
  created_at: Date;
  id: string;
  input: unknown;
  started_at: Date | null;
  status: string;
  user_id: string;
}

interface PipelineStageRow {
  attempts: number;
  completed_at: Date | null;
  output: unknown;
  stage_id: PipelineStageId;
  started_at: Date | null;
  state: string;
}

interface EventCountRow {
  count: string;
}

export type PipelineRunMode = "full" | "recalculate" | "resume";

function pipelineRunMode(value: unknown): PipelineRunMode {
  if (value === undefined) return "full";
  if (value === "full" || value === "resume" || value === "recalculate") {
    return value;
  }
  throw new HttpError(
    400,
    "invalid_pipeline_mode",
    "Pipeline mode must be full, resume, or recalculate.",
  );
}

interface ReadinessRow {
  aov: string | null;
  authority_backlinks: string;
  authority_domain_rating: string;
  authority_referring_domains: number;
  brand_terms: string[];
  competitor_count: string;
  competitive_enrichment_volume_floor: number;
  conversion_rate: string | null;
  domain: string;
  gsc_promotion_impressions_floor: number;
  inputs_dirty: boolean;
  kept_keyword_count: string;
  keywords_dirty: boolean;
  latest_gsc_query_count: string;
  manual_keyword_count: string;
  paid_eligible_keyword_count: string;
  duplicate_gsc_query_count: string;
  promotable_gsc_query_count: string;
  scoring_config_count: string;
  serp_dirty: boolean;
}

async function projectReadiness(
  client: PoolClient | DatabasePool,
  projectId: string,
): Promise<{
  configuration: { brandTerms: string[] };
  gates: Array<{ id: string; label: string; ready: boolean }>;
  missing: string[];
  policy: {
    competitiveEnrichmentVolumeFloor: number;
    gscPromotionImpressionsFloor: number;
  };
  preview: {
    duplicateGscQueryCount: number;
    keptKeywordCount: number;
    latestGscQueryCount: number;
    manualKeywordCount: number;
    paidEligibleKeywordCount: number;
    promotableGscQueryCount: number;
  };
  dirty: {
    inputs: boolean;
    keywords: boolean;
    serp: boolean;
  };
  ready: boolean;
}> {
  const result = await client.query<ReadinessRow>(
    `
      SELECT
        client.domain,
        client.brand_terms,
        project.conversion_rate::text,
        project.aov::text,
        project.authority_domain_rating::text,
        project.authority_referring_domains,
        project.authority_backlinks::text,
        project.gsc_promotion_impressions_floor,
        project.competitive_enrichment_volume_floor,
        project.inputs_dirty,
        project.keywords_dirty,
        project.serp_dirty,
        (SELECT count(*)::text FROM competitors WHERE client_id = client.id)
          AS competitor_count,
        (SELECT count(*)::text FROM har_scoring_config WHERE is_active)
          AS scoring_config_count,
        (SELECT count(*)::text FROM keywords
          WHERE project_id = project.id AND detox_status = 'keep')
          AS kept_keyword_count,
        (SELECT count(*)::text FROM keywords
          WHERE project_id = project.id AND sources @> ARRAY['source']::text[])
          AS manual_keyword_count,
        (SELECT count(*)::text FROM keywords
          WHERE project_id = project.id
            AND detox_status = 'keep'
            AND COALESCE(avg_monthly_volume, 0) >= project.competitive_enrichment_volume_floor)
          AS paid_eligible_keyword_count,
        COALESCE((
          SELECT count(DISTINCT row.normalised_query)::text
          FROM gsc_upload_keywords AS row
          WHERE row.upload_id = (
            SELECT upload.id
            FROM gsc_uploads AS upload
            WHERE upload.project_id = project.id
            ORDER BY upload.created_at DESC, upload.id DESC
            LIMIT 1
          )
        ), '0') AS latest_gsc_query_count,
        COALESCE((
          SELECT count(DISTINCT row.normalised_query)::text
          FROM gsc_upload_keywords AS row
          WHERE row.upload_id = (
            SELECT upload.id
            FROM gsc_uploads AS upload
            WHERE upload.project_id = project.id
            ORDER BY upload.created_at DESC, upload.id DESC
            LIMIT 1
          )
            AND EXISTS (
              SELECT 1
              FROM keywords AS keyword
              WHERE keyword.project_id = project.id
                AND keyword.normalised_keyword = row.normalised_query
            )
        ), '0') AS duplicate_gsc_query_count,
        COALESCE((
          SELECT count(*)::text
          FROM (
            SELECT row.normalised_query
            FROM gsc_upload_keywords AS row
            WHERE row.upload_id = (
              SELECT upload.id
              FROM gsc_uploads AS upload
              WHERE upload.project_id = project.id
              ORDER BY upload.created_at DESC, upload.id DESC
              LIMIT 1
            )
            GROUP BY row.normalised_query
            HAVING sum(row.impressions) >= project.gsc_promotion_impressions_floor
          ) AS promotable
        ), '0') AS promotable_gsc_query_count
      FROM navigator_projects AS project
      JOIN clients AS client ON client.id = project.client_id
      WHERE project.id = $1
        AND project.archived_at IS NULL
        AND client.archived_at IS NULL
    `,
    [projectId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new HttpError(404, "project_not_found", "Project not found.");
  }
  const gates = [
    { id: "client_domain", label: "Client domain", ready: row.domain.trim().length > 0 },
    { id: "competitor_domains", label: "Competitor domains", ready: Number(row.competitor_count) > 0 },
    { id: "explicit_brand_terms", label: "Explicit brand terms", ready: row.brand_terms.length > 0 },
    { id: "conversion_rate", label: "Conversion rate", ready: row.conversion_rate !== null },
    { id: "average_order_value", label: "Average order value", ready: row.aov !== null },
    {
      id: "client_domain_authority",
      label: "Client authority",
      ready:
        Number(row.authority_domain_rating) > 0 ||
        row.authority_referring_domains > 0 ||
        Number(row.authority_backlinks) > 0,
    },
    { id: "active_scoring_config", label: "Scoring configuration", ready: Number(row.scoring_config_count) > 0 },
  ];
  return {
    configuration: { brandTerms: row.brand_terms },
    gates,
    dirty: {
      inputs: row.inputs_dirty,
      keywords: row.keywords_dirty,
      serp: row.serp_dirty,
    },
    missing: gates.filter((gate) => !gate.ready).map((gate) => gate.id),
    policy: {
      competitiveEnrichmentVolumeFloor:
        row.competitive_enrichment_volume_floor,
      gscPromotionImpressionsFloor: row.gsc_promotion_impressions_floor,
    },
    preview: {
      duplicateGscQueryCount: Number(row.duplicate_gsc_query_count),
      keptKeywordCount: Number(row.kept_keyword_count),
      latestGscQueryCount: Number(row.latest_gsc_query_count),
      manualKeywordCount: Number(row.manual_keyword_count),
      paidEligibleKeywordCount: Number(row.paid_eligible_keyword_count),
      promotableGscQueryCount: Number(row.promotable_gsc_query_count),
    },
    ready: gates.every((gate) => gate.ready),
  };
}

export async function markProjectKeywordsPrecurated(
  pool: DatabasePool,
  user: AuthenticatedUser,
  projectId: string,
): Promise<Record<string, unknown>> {
  const stamped = await withTransaction(pool, async (client) => {
    await assertProjectAccessByRole(client, user.id, projectId, true);
    const result = await client.query<{ id: string }>(
      `
        UPDATE keywords AS keyword
        SET detox_status = 'keep',
            detox_reason = 'Operator-confirmed pre-curated set',
            detox_rule = 'pre-curated',
            human_reviewed = true,
            category = COALESCE(NULLIF(keyword.category, ''), project.category_focus),
            categorisation_status = 'done',
            categorisation_source = 'client_supplied',
            updated_at = now()
        FROM navigator_projects AS project
        WHERE keyword.project_id = $1
          AND project.id = keyword.project_id
          AND keyword.sources @> ARRAY['source']::text[]
        RETURNING keyword.id
      `,
      [projectId],
    );
    await client.query(
      `
        UPDATE navigator_projects
        SET keywords_dirty = true,
            inputs_dirty = true,
            last_dirty_at = now(),
            updated_at = now()
        WHERE id = $1
      `,
      [projectId],
    );
    return result.rowCount ?? 0;
  });
  return { projectId, stampedKeywordCount: stamped };
}

export async function getProjectPipelineReadiness(
  pool: DatabasePool,
  user: AuthenticatedUser,
  projectId: string,
): Promise<Record<string, unknown>> {
  await assertProjectAccessByRole(pool, user.id, projectId);
  const [rollups, readinessOutputs, providerSummary] = await Promise.all([pool.query<{
    category_rollup: unknown;
    cluster_deduped_expected_incremental_annual: string;
    cluster_rollup: unknown;
    double_count_annual: string;
    naive_expected_incremental_annual: string;
    quarter_rollup: unknown;
    scenario: string;
    trend_rollup: unknown;
  }>(
    `
      SELECT
        rollup.scenario,
        rollup.naive_expected_incremental_annual::text,
        rollup.cluster_deduped_expected_incremental_annual::text,
        rollup.double_count_annual::text,
        rollup.cluster_rollup,
        rollup.category_rollup,
        rollup.quarter_rollup,
        rollup.trend_rollup
      FROM pipeline_rollups AS rollup
      WHERE rollup.project_id = $1::uuid
        AND rollup.pipeline_run_id = (
          SELECT run.id
          FROM pipeline_runs AS run
          WHERE run.input->>'projectId' = $1::text
            AND run.status = 'succeeded'
          ORDER BY run.created_at DESC, run.id DESC
          LIMIT 1
        )
      ORDER BY CASE rollup.scenario
        WHEN 'conservative' THEN 1
        WHEN 'realistic' THEN 2
        ELSE 3
      END
    `,
    [projectId],
  ), pool.query<{ output: unknown; stage_id: string }>(
    `
      SELECT stage.stage_id, stage.output
      FROM pipeline_stage_runs AS stage
      WHERE stage.run_id = (
        SELECT run.id
        FROM pipeline_runs AS run
        WHERE run.input->>'projectId' = $1
        ORDER BY run.created_at DESC, run.id DESC
        LIMIT 1
      )
        AND stage.stage_id IN ('har-readiness', 'revenue-readiness')
        AND stage.state = 'succeeded'
      ORDER BY stage.stage_id
    `,
    [projectId],
  ), pool.query<{
    cache_entries_available: string;
    failed: string;
    max_attempts: number;
    pending: string;
    submitted: string;
    succeeded: string;
  }>(
    `
      WITH latest_run AS (
        SELECT id
        FROM pipeline_runs
        WHERE input->>'projectId' = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      )
      SELECT
        count(*) FILTER (WHERE item.state = 'pending')::text AS pending,
        count(*) FILTER (WHERE item.state = 'submitted')::text AS submitted,
        count(*) FILTER (WHERE item.state = 'succeeded')::text AS succeeded,
        count(*) FILTER (WHERE item.state = 'failed')::text AS failed,
        COALESCE(max(item.attempt_count), 0) AS max_attempts,
        (
          (SELECT count(*) FROM authority_domain_cache
            WHERE fetched_at >= now() - interval '30 days') +
          (SELECT count(*) FROM authority_url_cache
            WHERE fetched_at >= now() - interval '30 days')
        )::text AS cache_entries_available
      FROM provider_work_items AS item
      JOIN latest_run ON latest_run.id = item.pipeline_run_id
    `,
    [projectId],
  )]);
  const provider = providerSummary.rows[0];
  return {
    projectId,
    providerSummary: {
      cacheEntriesAvailable: Number(provider?.cache_entries_available ?? "0"),
      failed: Number(provider?.failed ?? "0"),
      maxAttempts: provider?.max_attempts ?? 0,
      pending: Number(provider?.pending ?? "0"),
      submitted: Number(provider?.submitted ?? "0"),
      succeeded: Number(provider?.succeeded ?? "0"),
    },
    ...(await projectReadiness(pool, projectId)),
    rollups: rollups.rows.map((row) => ({
      categoryRollup: row.category_rollup,
      clusterDedupedExpectedIncrementalAnnual: Number(
        row.cluster_deduped_expected_incremental_annual,
      ),
      clusterRollup: row.cluster_rollup,
      doubleCountAnnual: Number(row.double_count_annual),
      naiveExpectedIncrementalAnnual: Number(
        row.naive_expected_incremental_annual,
      ),
      quarterRollup: row.quarter_rollup,
      scenario: row.scenario,
      trendRollup: row.trend_rollup,
    })),
    substitutions: readinessOutputs.rows.flatMap((row) => {
      const output = row.output && typeof row.output === "object"
        ? row.output as { substitutions?: unknown }
        : {};
      return Array.isArray(output.substitutions)
        ? output.substitutions.map((substitution) => ({
            stageId: row.stage_id,
            ...(substitution as Record<string, unknown>),
          }))
        : [];
    }),
  };
}

export async function updateProjectPipelinePolicy(
  pool: DatabasePool,
  user: AuthenticatedUser,
  projectId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const input =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const promotionFloor = Number(input.gscPromotionImpressionsFloor);
  const competitiveFloor = Number(input.competitiveEnrichmentVolumeFloor);
  if (
    !Number.isInteger(promotionFloor) ||
    promotionFloor < 0 ||
    !Number.isInteger(competitiveFloor) ||
    competitiveFloor < 0
  ) {
    throw new HttpError(
      400,
      "invalid_pipeline_policy",
      "Pipeline thresholds must be non-negative integers.",
    );
  }
  await withTransaction(pool, async (client) => {
    await assertProjectAccessByRole(client, user.id, projectId, true);
    await client.query(
      `
        UPDATE navigator_projects
        SET gsc_promotion_impressions_floor = $2,
            competitive_enrichment_volume_floor = $3,
            pipeline_policy_reviewed_at = now(),
            keywords_dirty = true,
            serp_dirty = true,
            last_dirty_at = now(),
            updated_at = now()
        WHERE id = $1
      `,
      [projectId, promotionFloor, competitiveFloor],
    );
  });
  return getProjectPipelineReadiness(pool, user, projectId);
}

async function insertStages(client: PoolClient, runId: string): Promise<void> {
  for (const stage of PIPELINE_STAGES) {
    await client.query(
      `
        INSERT INTO pipeline_stage_runs (run_id, stage_id)
        VALUES ($1, $2)
      `,
      [runId, stage.id],
    );
  }
}

export async function createPipelineRun(
  pool: DatabasePool,
  user: AuthenticatedUser,
  body: unknown,
): Promise<Record<string, unknown>> {
  const input =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const projectId =
    typeof input.projectId === "string" ? input.projectId : null;
  const mode = pipelineRunMode(input.mode);
  input.mode = mode;
  let id: string = randomUUID();
  let resumed = false;
  let status = "pending";

  await withTransaction(pool, async (client) => {
    if (projectId) {
      await assertProjectAccessByRole(client, user.id, projectId, true);
      const readiness = await projectReadiness(client, projectId);
      if (!readiness.ready) {
        throw new HttpError(
          409,
          "pipeline_not_ready",
          `Pipeline configuration is incomplete: ${readiness.missing.join(", ")}.`,
        );
      }
      if (
        mode === "recalculate" &&
        (readiness.dirty.keywords || readiness.dirty.serp)
      ) {
        throw new HttpError(
          409,
          "provider_data_refresh_required",
          "Keyword or SERP inputs are dirty; run full or resume before recalculating.",
        );
      }
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [projectId],
      );
      const existing = await client.query<{ id: string; status: string }>(
        `
          SELECT id, status
          FROM pipeline_runs
          WHERE input->>'projectId' = $1
            AND status IN ('pending', 'running')
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `,
        [projectId],
      );
      if (existing.rows[0]) {
        id = existing.rows[0].id;
        status = existing.rows[0].status;
        resumed = true;
        return;
      }
    }
    await client.query(
      `
        INSERT INTO pipeline_runs (id, user_id, input)
        VALUES ($1, $2, $3)
      `,
      [id, user.id, JSON.stringify(input)],
    );
    await insertStages(client, id);
  });

  return {
    id,
    resumed,
    stageCount: PIPELINE_STAGES.length,
    status,
  };
}

export async function getPipelineRun(
  pool: DatabasePool,
  user: AuthenticatedUser,
  id: string,
  includeOutput = true,
): Promise<Record<string, unknown>> {
  const runResult = await pool.query<PipelineRunRow>(
    `
      SELECT id, user_id, status, input, created_at, started_at, completed_at
      FROM pipeline_runs
      WHERE id = $1
    `,
    [id],
  );
  const run = runResult.rows[0];

  if (!run) {
    throw new HttpError(404, "pipeline_run_not_found", "Pipeline run not found.");
  }
  const input =
    run.input && typeof run.input === "object" && !Array.isArray(run.input)
      ? (run.input as Record<string, unknown>)
      : {};
  if (run.user_id !== user.id) {
    const projectId = input.projectId;
    if (typeof projectId !== "string") {
      throw new HttpError(
        404,
        "pipeline_run_not_found",
        "Pipeline run not found.",
      );
    }
    await assertProjectAccessByRole(pool, user.id, projectId);
  }

  const [stageResult, eventResult] = await Promise.all([
    pool.query<PipelineStageRow>(
      `
        SELECT
          stage_id,
          state,
          attempts,
          ${includeOutput ? "output" : "NULL::jsonb AS output"},
          started_at,
          completed_at
        FROM pipeline_stage_runs
        WHERE run_id = $1
      `,
      [id],
    ),
    pool.query<EventCountRow>(
      `
        SELECT count(*)::text AS count
        FROM event_deliveries
        WHERE aggregate_id = $1
      `,
      [id],
    ),
  ]);
  const rowsByStage = new Map(stageResult.rows.map((stage) => [stage.stage_id, stage]));

  return {
    completedAt: run.completed_at?.toISOString() ?? null,
    createdAt: run.created_at.toISOString(),
    deliveredEventCount: Number(eventResult.rows[0]?.count ?? "0"),
    id: run.id,
    input: run.input,
    stages: PIPELINE_STAGES.map((definition) => {
      const stage = rowsByStage.get(definition.id);

      if (!stage) {
        throw new Error(`Missing stage row for ${definition.id}.`);
      }

      return {
        attempts: stage.attempts,
        completedAt: stage.completed_at?.toISOString() ?? null,
        dependencies: definition.dependencies,
        execution: definition.execution,
        id: definition.id,
        ...(includeOutput ? { output: stage.output } : {}),
        startedAt: stage.started_at?.toISOString() ?? null,
        state: stage.state,
      };
    }),
    startedAt: run.started_at?.toISOString() ?? null,
    status: run.status,
  };
}

export async function getLatestProjectPipelineRun(
  pool: DatabasePool,
  user: AuthenticatedUser,
  projectId: string,
  includeOutput = false,
): Promise<Record<string, unknown>> {
  await assertProjectAccessByRole(pool, user.id, projectId);
  const result = await pool.query<{ id: string }>(
    `
      SELECT id
      FROM pipeline_runs
      WHERE input->>'projectId' = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [projectId],
  );
  const run = result.rows[0];
  if (!run) {
    return {
      projectId,
      run: null,
    };
  }
  return {
    projectId,
    run: await getPipelineRun(pool, user, run.id, includeOutput),
  };
}
