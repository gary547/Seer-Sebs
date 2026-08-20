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
import { resolveBrandTerms } from "../../../packages/pipeline/src/brand-terms.js";
import { assertProjectAccessByRole } from "./authorization.js";
import {
  buildStageProgress,
  type StageWorkCounts,
} from "./stage-progress.js";

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

interface StageWorkRow {
  failed: string;
  last_error: string | null;
  pending: string;
  stage_id: PipelineStageId;
  submitted: string;
  succeeded: string;
  total: string;
}

export type PipelineRunMode = "full" | "recalculate" | "resume";

export const PIPELINE_OUTPUT_BATCH_LIMIT = 1;

export interface PipelineRunFailure {
  attempts: number;
  message: string | null;
  stageId: PipelineStageId;
}

function outputRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function resolvePipelineRunFailure(
  stages: ReadonlyArray<{
    attempts: number;
    id: PipelineStageId;
    output?: unknown;
    state: string;
  }>,
): PipelineRunFailure | null {
  const failed = stages.filter((stage) => stage.state === "failed");
  if (failed.length === 0) return null;
  const recorded = failed
    .map((stage) => {
      const failedStage = outputRecord(stage.output)?.failedStage;
      return typeof failedStage === "string" ? failedStage : null;
    })
    .find((stageId): stageId is string => Boolean(stageId));
  const actual =
    stages.find((stage) => stage.id === recorded) ??
    failed.find((stage) => stage.attempts > 0) ??
    failed[0]!;
  const message = outputRecord(actual.output)?.message;
  return {
    attempts: actual.attempts,
    message: typeof message === "string" && message.trim() ? message : null,
    stageId: actual.id,
  };
}

const PIPELINE_STAGE_ID_SET = new Set<string>(
  PIPELINE_STAGES.map((stage) => stage.id),
);

export function parsePipelineStageIds(value: string | null): PipelineStageId[] {
  const ids = [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  ];
  if (ids.length === 0) {
    throw new HttpError(
      400,
      "invalid_pipeline_stages",
      "Provide at least one pipeline stage id.",
    );
  }
  if (ids.length > PIPELINE_OUTPUT_BATCH_LIMIT) {
    throw new HttpError(
      400,
      "pipeline_stage_batch_too_large",
      `Request at most ${PIPELINE_OUTPUT_BATCH_LIMIT} stages per batch.`,
    );
  }
  for (const id of ids) {
    if (!PIPELINE_STAGE_ID_SET.has(id)) {
      throw new HttpError(
        400,
        "invalid_pipeline_stage",
        `Unknown pipeline stage: ${id}.`,
      );
    }
  }
  return ids as PipelineStageId[];
}

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
  configuration: {
    brandTerms: string[];
    brandTermsSource: "domain_fallback" | "explicit" | "missing";
    explicitBrandTerms: string[];
  };
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
  const brandTerms = resolveBrandTerms(row.brand_terms, row.domain);
  const hasStoredAuthority =
    Number(row.authority_domain_rating) > 0 ||
    row.authority_referring_domains > 0 ||
    Number(row.authority_backlinks) > 0;
  const hasManualKeywords = Number(row.manual_keyword_count) > 0;
  const hasQualifiedKeywords = Number(row.kept_keyword_count) > 0;
  const gates = [
    { id: "client_domain", label: "Client domain", ready: row.domain.trim().length > 0 },
    { id: "competitor_domains", label: "Competitor domains", ready: Number(row.competitor_count) > 0 },
    { id: "explicit_brand_terms", label: "Brand terms", ready: brandTerms.terms.length > 0 },
    { id: "conversion_rate", label: "Conversion rate", ready: row.conversion_rate !== null },
    { id: "average_order_value", label: "Average order value", ready: row.aov !== null },
    {
      id: "client_domain_authority",
      label: "Client authority",
      ready: hasStoredAuthority || row.domain.trim().length > 0,
    },
    {
      id: "qualified_keywords",
      label: "Qualified keywords",
      ready: hasQualifiedKeywords || !hasManualKeywords,
    },
    { id: "active_scoring_config", label: "Scoring configuration", ready: Number(row.scoring_config_count) > 0 },
  ];
  return {
    configuration: {
      brandTerms: brandTerms.terms,
      brandTermsSource: brandTerms.source,
      explicitBrandTerms: row.brand_terms,
    },
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

async function loadAuthorizedPipelineRun(
  pool: DatabasePool,
  user: AuthenticatedUser,
  id: string,
): Promise<PipelineRunRow> {
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
  return run;
}

export async function getPipelineRun(
  pool: DatabasePool,
  user: AuthenticatedUser,
  id: string,
  includeOutput = true,
): Promise<Record<string, unknown>> {
  const run = await loadAuthorizedPipelineRun(pool, user, id);

  const [stageResult, eventResult, workResult] = await Promise.all([
    pool.query<PipelineStageRow>(
      `
        SELECT
          stage_id,
          state,
          attempts,
          ${
            includeOutput
              ? "output"
              : `CASE
            WHEN state = 'failed' THEN jsonb_strip_nulls(jsonb_build_object(
              'failedStage', output->>'failedStage',
              'message', left(output->>'message', 500),
              'reason', output->>'reason'
            ))
            ELSE NULL
          END AS output`
          },
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
    pool.query<StageWorkRow>(
      `
        SELECT
          stage_id,
          count(*)::text AS total,
          count(*) FILTER (WHERE state = 'pending')::text AS pending,
          count(*) FILTER (WHERE state = 'submitted')::text AS submitted,
          count(*) FILTER (WHERE state = 'succeeded')::text AS succeeded,
          count(*) FILTER (WHERE state = 'failed')::text AS failed,
          (
            SELECT item.last_error
            FROM provider_work_items AS item
            WHERE item.pipeline_run_id = $1
              AND item.stage_id = provider_work_items.stage_id
              AND item.last_error IS NOT NULL
            ORDER BY item.updated_at DESC
            LIMIT 1
          ) AS last_error
        FROM provider_work_items
        WHERE pipeline_run_id = $1
        GROUP BY stage_id
      `,
      [id],
    ),
  ]);
  const rowsByStage = new Map(stageResult.rows.map((stage) => [stage.stage_id, stage]));
  const workByStage = new Map<PipelineStageId, StageWorkCounts>(
    workResult.rows.map((row) => [
      row.stage_id,
      {
        failed: Number(row.failed),
        lastError: row.last_error,
        pending: Number(row.pending),
        submitted: Number(row.submitted),
        succeeded: Number(row.succeeded),
        total: Number(row.total),
      },
    ]),
  );
  const now = new Date();
  const stages = PIPELINE_STAGES.map((definition) => {
    const stage = rowsByStage.get(definition.id);

    if (!stage) {
      throw new Error(`Missing stage row for ${definition.id}.`);
    }

    const compactFailure = !includeOutput && stage.state === "failed" && outputRecord(stage.output);
    const waitingOn = definition.dependencies.filter((dependencyId) => {
      const dependency = rowsByStage.get(dependencyId);
      return dependency?.state !== "succeeded";
    });
    return {
      attempts: stage.attempts,
      completedAt: stage.completed_at?.toISOString() ?? null,
      dependencies: definition.dependencies,
      execution: definition.execution,
      id: definition.id,
      ...(includeOutput || compactFailure ? { output: stage.output } : {}),
      progress: buildStageProgress({
        attempts: stage.attempts,
        completedAt: stage.completed_at,
        id: definition.id,
        now,
        outputMessage:
          typeof outputRecord(stage.output)?.message === "string"
            ? String(outputRecord(stage.output)?.message)
            : null,
        startedAt: stage.started_at,
        state: stage.state,
        waitingOn,
        work: workByStage.get(definition.id) ?? null,
      }),
      startedAt: stage.started_at?.toISOString() ?? null,
      state: stage.state,
    };
  });

  return {
    completedAt: run.completed_at?.toISOString() ?? null,
    createdAt: run.created_at.toISOString(),
    deliveredEventCount: Number(eventResult.rows[0]?.count ?? "0"),
    failure: resolvePipelineRunFailure(stages),
    id: run.id,
    input: run.input,
    stages,
    startedAt: run.started_at?.toISOString() ?? null,
    status: run.status,
  };
}

export async function getPipelineRunStageOutputs(
  pool: DatabasePool,
  user: AuthenticatedUser,
  id: string,
  stageIds: readonly PipelineStageId[],
): Promise<Record<string, unknown>> {
  await loadAuthorizedPipelineRun(pool, user, id);
  const stageResult = await pool.query<PipelineStageRow>(
    `
      SELECT
        stage_id,
        state,
        attempts,
        output,
        started_at,
        completed_at
      FROM pipeline_stage_runs
      WHERE run_id = $1
        AND stage_id = ANY($2::text[])
    `,
    [id, stageIds],
  );
  const rowsByStage = new Map(
    stageResult.rows.map((stage) => [stage.stage_id, stage]),
  );

  return {
    runId: id,
    stages: stageIds.map((stageId) => {
      const stage = rowsByStage.get(stageId);
      if (!stage) {
        throw new HttpError(
          404,
          "pipeline_stage_not_found",
          `Pipeline stage ${stageId} was not found.`,
        );
      }
      return {
        attempts: stage.attempts,
        completedAt: stage.completed_at?.toISOString() ?? null,
        id: stage.stage_id,
        output: stage.output,
        startedAt: stage.started_at?.toISOString() ?? null,
        state: stage.state,
      };
    }),
  };
}

export async function cancelPipelineRun(
  pool: DatabasePool,
  user: AuthenticatedUser,
  id: string,
  reason = "Cancelled by operator.",
): Promise<Record<string, unknown>> {
  const run = await loadAuthorizedPipelineRun(pool, user, id);
  const input =
    run.input && typeof run.input === "object" && !Array.isArray(run.input)
      ? (run.input as Record<string, unknown>)
      : {};
  if (typeof input.projectId === "string") {
    await assertProjectAccessByRole(pool, user.id, input.projectId, true);
  } else if (run.user_id !== user.id) {
    throw new HttpError(403, "forbidden", "You cannot cancel this pipeline run.");
  }

  await withTransaction(pool, async (client) => {
    const stages = await client.query<{ stage_id: PipelineStageId; state: string }>(
      `
        SELECT stage_id, state
        FROM pipeline_stage_runs
        WHERE run_id = $1
        ORDER BY stage_id
      `,
      [id],
    );
    const failedStage =
      stages.rows.find((stage) => stage.state === "running" || stage.state === "queued")
        ?.stage_id ??
      stages.rows.find((stage) => stage.state === "pending")?.stage_id ??
      "intake";
    await client.query(
      `
        UPDATE pipeline_stage_runs
        SET state = 'failed',
            output = COALESCE(
              output,
              jsonb_build_object(
                'reason', 'pipeline_cancelled',
                'failedStage', $2::text,
                'message', $3::text
              )
            ),
            completed_at = COALESCE(completed_at, now())
        WHERE run_id = $1
          AND state <> 'succeeded'
      `,
      [id, failedStage, reason],
    );
    const result = await client.query(
      `
        UPDATE pipeline_runs
        SET status = 'failed',
            completed_at = COALESCE(completed_at, now())
        WHERE id = $1
          AND status IN ('pending', 'running')
      `,
      [id],
    );
    if ((result.rowCount ?? 0) === 0 && run.status !== "failed") {
      throw new HttpError(
        409,
        "pipeline_run_not_cancellable",
        "Only pending or running pipeline runs can be cancelled.",
      );
    }
  });

  return getPipelineRun(pool, user, id, false);
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
