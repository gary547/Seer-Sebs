import { randomUUID } from "node:crypto";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { withTransaction } from "../../../packages/runtime/src/database.js";
import { HttpError, requireString } from "../../../packages/runtime/src/http.js";
import type { AuthenticatedUser } from "../../../packages/runtime/src/local-auth.js";
import {
  assertAdministrator,
  assertClientAccess,
  assertProjectAccessByRole,
} from "./authorization.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTENT_LABELS = new Set([
  "commercial",
  "informational",
  "navigational",
  "transactional",
]);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", "The request body is invalid.");
  }
  return value as Record<string, unknown>;
}

function uuid(value: unknown, field: string): string {
  const candidate = requireString(value, field, 36);
  if (!UUID_PATTERN.test(candidate)) {
    throw new HttpError(400, "invalid_request", `${field} is invalid.`);
  }
  return candidate;
}

function optionalString(
  value: unknown,
  field: string,
  maximumLength: number,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requireString(value, field, maximumLength);
}

function optionalNumber(
  value: unknown,
  field: string,
  maximum: number,
): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > maximum
  ) {
    throw new HttpError(400, "invalid_request", `${field} is invalid.`);
  }
  return value;
}

function featureInput(value: unknown): {
  resultType: string;
  serpFeatureRaw: string;
  serpIntent: string;
} {
  const input = record(value);
  return {
    resultType: requireString(
      input.resultType ?? input.result_type,
      "resultType",
      200,
    ),
    serpFeatureRaw: requireString(
      input.serpFeatureRaw ?? input.serp_feature_raw,
      "serpFeatureRaw",
      1_000,
    ),
    serpIntent: requireString(
      input.serpIntent ?? input.serp_intent,
      "serpIntent",
      200,
    ),
  };
}

export async function getReferenceData(
  pool: DatabasePool,
): Promise<Record<string, unknown>> {
  const [features, config] = await Promise.all([
    pool.query(
      `
        SELECT id, serp_feature_raw, result_type, serp_intent
        FROM serp_feature_index
        ORDER BY result_type, serp_feature_raw, id
      `,
    ),
    pool.query(
      `
        SELECT id, version, weights_json, thresholds_json, notes, updated_at
        FROM har_scoring_config
        WHERE is_active
        LIMIT 1
      `,
    ),
  ]);
  return {
    harScoringConfig: config.rows[0] ?? null,
    serpFeatures: features.rows,
  };
}

export async function createSerpFeatures(
  pool: DatabasePool,
  user: AuthenticatedUser,
  body: unknown,
): Promise<Record<string, unknown>> {
  await assertAdministrator(pool, user.id);
  const input = record(body);
  const rawRecords = Array.isArray(input.records) ? input.records : [input];
  if (rawRecords.length === 0 || rawRecords.length > 5_000) {
    throw new HttpError(400, "invalid_request", "records is invalid.");
  }
  const features = rawRecords.map(featureInput);
  let affected = 0;
  await withTransaction(pool, async (client) => {
    for (const feature of features) {
      const result = await client.query(
        `
          INSERT INTO serp_feature_index (
            serp_feature_raw, result_type, serp_intent
          )
          VALUES ($1, $2, $3)
          ON CONFLICT (serp_feature_raw) DO UPDATE
          SET
            result_type = EXCLUDED.result_type,
            serp_intent = EXCLUDED.serp_intent,
            updated_at = now()
          RETURNING id
        `,
        [feature.serpFeatureRaw, feature.resultType, feature.serpIntent],
      );
      affected += result.rowCount ?? 0;
    }
  });
  return { affected };
}

export async function updateSerpFeature(
  pool: DatabasePool,
  user: AuthenticatedUser,
  featureId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  await assertAdministrator(pool, user.id);
  const feature = featureInput(body);
  try {
    const result = await pool.query(
      `
        UPDATE serp_feature_index
        SET
          serp_feature_raw = $2,
          result_type = $3,
          serp_intent = $4,
          updated_at = now()
        WHERE id = $1
        RETURNING id, serp_feature_raw, result_type, serp_intent
      `,
      [
        featureId,
        feature.serpFeatureRaw,
        feature.resultType,
        feature.serpIntent,
      ],
    );
    if (!result.rows[0]) {
      throw new HttpError(404, "serp_feature_not_found", "SERP feature not found.");
    }
    return result.rows[0];
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "23505"
    ) {
      throw new HttpError(
        409,
        "serp_feature_conflict",
        "This SERP feature already exists.",
      );
    }
    throw error;
  }
}

export async function listConversionOverrides(
  pool: DatabasePool,
  user: AuthenticatedUser,
  projectId: string,
): Promise<Record<string, unknown>> {
  await assertProjectAccessByRole(pool, user.id, projectId);
  const result = await pool.query(
    `
      SELECT
        override.*,
        creator.email AS created_by_email,
        updater.email AS updated_by_email
      FROM project_conversion_overrides AS override
      LEFT JOIN profiles AS creator ON creator.user_id = override.created_by
      LEFT JOIN profiles AS updater ON updater.user_id = override.updated_by
      WHERE override.project_id = $1
      ORDER BY override.scope_type, override.updated_at DESC, override.id
    `,
    [projectId],
  );
  return { overrides: result.rows };
}

function overrideInput(body: unknown): {
  averageOrderValue: number | null;
  confidence: string;
  conversionRate: number | null;
  note: string | null;
  projectId: string;
  scopeType: string;
  scopeValue: string | null;
} {
  const input = record(body);
  const projectId = uuid(input.projectId ?? input.project_id, "projectId");
  const scopeType = requireString(
    input.scopeType ?? input.scope_type,
    "scopeType",
    16,
  );
  if (!new Set(["category", "intent", "project", "url"]).has(scopeType)) {
    throw new HttpError(400, "invalid_request", "scopeType is invalid.");
  }
  const scopeValue =
    scopeType === "project"
      ? null
      : optionalString(
          input.scopeValue ?? input.scope_value,
          "scopeValue",
          2_048,
        );
  if (scopeType !== "project" && !scopeValue) {
    throw new HttpError(400, "invalid_request", "scopeValue is required.");
  }
  const confidence =
    optionalString(input.confidence, "confidence", 16) ?? "medium";
  if (!new Set(["high", "low", "medium"]).has(confidence)) {
    throw new HttpError(400, "invalid_request", "confidence is invalid.");
  }
  const note = optionalString(input.note, "note", 5_000);
  if ((scopeType === "category" || scopeType === "url") && !note) {
    throw new HttpError(
      400,
      "invalid_request",
      "A note is required for category and URL overrides.",
    );
  }
  return {
    averageOrderValue: optionalNumber(
      input.averageOrderValue ?? input.average_order_value,
      "averageOrderValue",
      Number.MAX_SAFE_INTEGER,
    ),
    confidence,
    conversionRate: optionalNumber(
      input.conversionRate ?? input.conversion_rate,
      "conversionRate",
      1,
    ),
    note,
    projectId,
    scopeType,
    scopeValue,
  };
}

export async function upsertConversionOverride(
  pool: DatabasePool,
  user: AuthenticatedUser,
  body: unknown,
): Promise<Record<string, unknown>> {
  await assertAdministrator(pool, user.id);
  const inputRecord = record(body);
  const input = overrideInput(body);
  await assertProjectAccessByRole(pool, user.id, input.projectId, true);
  const id =
    inputRecord.id === undefined ? randomUUID() : uuid(inputRecord.id, "id");
  try {
    return await withTransaction(pool, async (client) => {
      const result = await client.query(
        `
          INSERT INTO project_conversion_overrides (
            id,
            project_id,
            scope_type,
            scope_value,
            conversion_rate,
            average_order_value,
            confidence,
            note,
            source,
            created_by,
            updated_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'manual', $9, $9)
          ON CONFLICT (id) DO UPDATE
          SET
            project_id = EXCLUDED.project_id,
            scope_type = EXCLUDED.scope_type,
            scope_value = EXCLUDED.scope_value,
            conversion_rate = EXCLUDED.conversion_rate,
            average_order_value = EXCLUDED.average_order_value,
            confidence = EXCLUDED.confidence,
            note = EXCLUDED.note,
            source = 'manual',
            updated_by = EXCLUDED.updated_by,
            updated_at = now()
          RETURNING *
        `,
        [
          id,
          input.projectId,
          input.scopeType,
          input.scopeValue,
          input.conversionRate,
          input.averageOrderValue,
          input.confidence,
          input.note,
          user.id,
        ],
      );
      await client.query(
        `
          UPDATE navigator_projects
          SET inputs_dirty = true, last_dirty_at = now(), updated_at = now()
          WHERE id = $1
        `,
        [input.projectId],
      );
      return result.rows[0];
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "23505"
    ) {
      throw new HttpError(
        409,
        "conversion_override_conflict",
        "An override already exists for this scope and value.",
      );
    }
    throw error;
  }
}

export async function deleteConversionOverride(
  pool: DatabasePool,
  user: AuthenticatedUser,
  overrideId: string,
): Promise<Record<string, unknown>> {
  await assertAdministrator(pool, user.id);
  return withTransaction(pool, async (client) => {
    const result = await client.query<{ project_id: string }>(
      `
        DELETE FROM project_conversion_overrides
        WHERE id = $1
        RETURNING project_id
      `,
      [overrideId],
    );
    const projectId = result.rows[0]?.project_id;
    if (!projectId) {
      throw new HttpError(
        404,
        "conversion_override_not_found",
        "Conversion override not found.",
      );
    }
    await client.query(
      `
        UPDATE navigator_projects
        SET inputs_dirty = true, last_dirty_at = now(), updated_at = now()
        WHERE id = $1
      `,
      [projectId],
    );
    return { id: overrideId };
  });
}

function normalizedCategory(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\b([a-z]{4,})s\b/g, "$1");
}

async function distinctClientCategories(
  pool: DatabasePool,
  clientId: string,
): Promise<{ distinctTags: Array<{ count: number; tag: string }>; nullCount: number }> {
  const result = await pool.query<{
    category: string | null;
    count: string;
  }>(
    `
      SELECT keyword.category, count(*)::text AS count
      FROM keywords AS keyword
      JOIN navigator_projects AS project ON project.id = keyword.project_id
      WHERE project.client_id = $1
        AND keyword.detox_status = 'keep'
      GROUP BY keyword.category
      ORDER BY count(*) DESC, keyword.category
    `,
    [clientId],
  );
  return {
    distinctTags: result.rows
      .filter((row): row is typeof row & { category: string } => Boolean(row.category))
      .map((row) => ({ count: Number(row.count), tag: row.category })),
    nullCount: Number(
      result.rows.find((row) => row.category === null)?.count ?? 0,
    ),
  };
}

export async function getLastCategoryBatch(
  pool: DatabasePool,
  user: AuthenticatedUser,
  clientId: string,
): Promise<Record<string, unknown>> {
  await assertClientAccess(pool, user.id, clientId);
  const result = await pool.query(
    `
      SELECT batch_id, changed_at
      FROM keyword_category_history
      WHERE client_id = $1
        AND source = 'consolidate'
      ORDER BY changed_at DESC, id DESC
      LIMIT 1
    `,
    [clientId],
  );
  return { batch: result.rows[0] ?? null };
}

export async function consolidateCategories(
  pool: DatabasePool,
  user: AuthenticatedUser,
  clientId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  await assertAdministrator(pool, user.id);
  await assertClientAccess(pool, user.id, clientId, true);
  const input = record(body);
  const mode = requireString(input.mode, "mode", 16);
  if (mode === "preview") {
    const categories = await distinctClientCategories(pool, clientId);
    const mapping: Record<string, string | null> = {};
    const groups = new Map<string, Array<{ count: number; tag: string }>>();
    for (const category of categories.distinctTags) {
      if (INTENT_LABELS.has(category.tag.toLowerCase())) {
        mapping[category.tag] = null;
        continue;
      }
      const key = normalizedCategory(category.tag);
      groups.set(key, [...(groups.get(key) ?? []), category]);
    }
    for (const values of groups.values()) {
      if (values.length < 2) continue;
      const sorted = [...values].sort(
        (left, right) =>
          right.count - left.count || left.tag.localeCompare(right.tag),
      );
      const canonical = sorted[0]?.tag;
      if (!canonical) continue;
      for (const duplicate of sorted.slice(1)) {
        mapping[duplicate.tag] = canonical;
      }
    }
    return {
      ...categories,
      aiRenames: 0,
      intentMerges: Object.values(mapping).filter((value) => value === null).length,
      mapping,
      mode,
      normalizedRenames: Object.values(mapping).filter(
        (value) => value !== null,
      ).length,
      totalAffected: Object.keys(mapping).reduce(
        (sum, tag) =>
          sum +
          (categories.distinctTags.find((category) => category.tag === tag)
            ?.count ?? 0),
        0,
      ),
    };
  }

  if (mode === "undo") {
    return withTransaction(pool, async (client) => {
      const latest = await client.query<{ batch_id: string }>(
        `
          SELECT batch_id
          FROM keyword_category_history
          WHERE client_id = $1
            AND source = 'consolidate'
          ORDER BY changed_at DESC, id DESC
          LIMIT 1
        `,
        [clientId],
      );
      const batchId = latest.rows[0]?.batch_id;
      if (!batchId) return { mode, restored: 0 };
      const restored = await client.query(
        `
          UPDATE keywords AS keyword
          SET
            category = history.category_before,
            updated_at = now()
          FROM keyword_category_history AS history
          WHERE history.batch_id = $1
            AND history.keyword_id = keyword.id
        `,
        [batchId],
      );
      await client.query(
        `
          UPDATE navigator_projects AS project
          SET inputs_dirty = true, last_dirty_at = now(), updated_at = now()
          WHERE project.client_id = $1
            AND EXISTS (
              SELECT 1
              FROM keywords AS keyword
              WHERE keyword.project_id = project.id
                AND keyword.id IN (
                  SELECT history.keyword_id
                  FROM keyword_category_history AS history
                  WHERE history.batch_id = $2
                )
            )
        `,
        [clientId, batchId],
      );
      await client.query(
        "DELETE FROM keyword_category_history WHERE batch_id = $1",
        [batchId],
      );
      return {
        batch_id: batchId,
        mode,
        restored: restored.rowCount ?? 0,
      };
    });
  }

  if (mode !== "apply") {
    throw new HttpError(400, "invalid_request", "mode is invalid.");
  }
  if (
    !input.mapping ||
    typeof input.mapping !== "object" ||
    Array.isArray(input.mapping)
  ) {
    throw new HttpError(400, "invalid_request", "mapping is invalid.");
  }
  const rawMapping = input.mapping as Record<string, unknown>;
  if (Object.keys(rawMapping).length > 1_000) {
    throw new HttpError(400, "invalid_request", "mapping is too large.");
  }
  const mapping = new Map<string, string | null>();
  for (const [source, destination] of Object.entries(rawMapping)) {
    const from = requireString(source, "mapping key", 500);
    const to =
      destination === null
        ? null
        : requireString(destination, `mapping.${source}`, 500);
    if (to !== from) mapping.set(from, to);
  }
  const batchId = randomUUID();
  const applied = await withTransaction(pool, async (client) => {
    let total = 0;
    for (const [from, to] of mapping) {
      const affected = await client.query<{ id: string }>(
        `
          SELECT keyword.id
          FROM keywords AS keyword
          JOIN navigator_projects AS project ON project.id = keyword.project_id
          WHERE project.client_id = $1
            AND keyword.category = $2
          FOR UPDATE OF keyword
        `,
        [clientId, from],
      );
      if (affected.rows.length === 0) continue;
      await client.query(
        `
          INSERT INTO keyword_category_history (
            keyword_id,
            client_id,
            changed_by,
            source,
            batch_id,
            category_before,
            category_after
          )
          SELECT
            unnest($1::uuid[]),
            $2,
            $3,
            'consolidate',
            $4,
            $5,
            $6
        `,
        [
          affected.rows.map((row) => row.id),
          clientId,
          user.id,
          batchId,
          from,
          to,
        ],
      );
      const update = await client.query(
        `
          UPDATE keywords
          SET category = $2, updated_at = now()
          WHERE id = ANY($1::uuid[])
        `,
        [affected.rows.map((row) => row.id), to],
      );
      total += update.rowCount ?? 0;
    }
    if (total > 0) {
      await client.query(
        `
          UPDATE navigator_projects
          SET inputs_dirty = true, last_dirty_at = now(), updated_at = now()
          WHERE client_id = $1
            AND id IN (
              SELECT DISTINCT keyword.project_id
              FROM keywords AS keyword
              JOIN keyword_category_history AS history
                ON history.keyword_id = keyword.id
              WHERE history.batch_id = $2
            )
        `,
        [clientId, batchId],
      );
    }
    return total;
  });
  return { applied, batch_id: batchId, mode };
}
