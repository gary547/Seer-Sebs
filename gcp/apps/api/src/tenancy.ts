import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { withTransaction } from "../../../packages/runtime/src/database.js";
import { HttpError, requireString } from "../../../packages/runtime/src/http.js";
import type { AuthenticatedUser } from "../../../packages/runtime/src/local-auth.js";
import {
  assertAdministrator,
  assertClientAccess,
  assertProjectAccessByRole,
  assertWriteAccess,
  getUserRole,
} from "./authorization.js";
import type { ObjectStore } from "./object-store-client.js";

interface ClientRow {
  analytics_connected: boolean;
  archive_reason: string | null;
  archived_at: Date | null;
  archived_by: string | null;
  brand_terms: string[];
  brand_type: string | null;
  campaign_type: string | null;
  company_name: string;
  created_at: Date;
  domain: string;
  domain_normalized: string | null;
  gsc_connected: boolean;
  id: string;
  industry: string | null;
  logo_url: string | null;
  team_members: unknown;
  updated_at: Date;
}

interface ProjectSummaryRow {
  aov: number | string | null;
  archive_reason: string | null;
  archived_at: Date | null;
  archived_by: string | null;
  calculations_v2_compute_enabled: boolean;
  calculations_v2_visible_enabled: boolean;
  category_focus: string | null;
  client_archived_at: Date | null;
  client_domain: string;
  client_id: string;
  client_logo_url: string | null;
  client_name: string;
  conversion_rate: number | string | null;
  created_at: Date;
  ctr: number | string | null;
  duplicated_from: string | null;
  har_status: string;
  id: string;
  inputs_dirty: boolean;
  keywords_dirty: boolean;
  last_dirty_at: Date | null;
  last_synced_at: Date | null;
  project_name: string;
  ranking_lookup_status: string;
  seasonality_end: string | null;
  seasonality_start: string | null;
  serp_dirty: boolean;
  status: string;
  updated_at: Date;
}

interface CompetitorInput {
  competitorDomain: string;
  competitorName: string;
  verified: boolean;
}

interface KeywordRuleInput {
  keywordCategorisation: string;
  ruleType: "blacklist" | "competitor_brand" | "own_brand" | "whitelist";
}

const MAXIMUM_LOGO_BYTES = 5 * 1_024 * 1_024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT_COUNT_TABLES = [
  "calibration_snapshots",
  "content_plans",
  "ctr_curves",
  "gsc_uploads",
  "har_forecasts",
  "keyword_clusters",
  "keyword_demand_signals",
  "keywords",
  "link_power_scores",
  "local_provider_keyword_inputs",
  "local_provider_serp_keywords",
  "local_provider_site_architecture_inputs",
  "project_keyword_rules",
  "project_conversion_overrides",
  "project_roadmaps",
  "project_serp_features",
  "revenue_forecasts",
  "serp_results",
  "site_architecture",
  "slide_exports",
  "provider_work_items",
] as const;

function bodyRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", "The request body is invalid.");
  }
  return value as Record<string, unknown>;
}

function optionalString(
  value: unknown,
  field: string,
  maximumLength: number,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requireString(value, field, maximumLength);
}

function optionalBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new HttpError(400, "invalid_request", `${field} is invalid.`);
  }
  return value;
}

function optionalNumber(
  value: unknown,
  field: string,
  maximum: number,
): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw new HttpError(400, "invalid_request", `${field} is invalid.`);
  }
  return value;
}

function optionalDate(value: unknown, field: string): string | null {
  const candidate = optionalString(value, field, 10);
  if (candidate === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
    throw new HttpError(400, "invalid_request", `${field} is invalid.`);
  }
  const year = Number(candidate.slice(0, 4));
  const month = Number(candidate.slice(5, 7));
  const day = Number(candidate.slice(8, 10));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new HttpError(400, "invalid_request", `${field} is invalid.`);
  }
  return candidate;
}

function uuid(value: unknown, field: string): string {
  const candidate = requireString(value, field, 36);
  if (!UUID_PATTERN.test(candidate)) {
    throw new HttpError(400, "invalid_request", `${field} is invalid.`);
  }
  return candidate;
}

function domain(value: unknown): { canonical: string; original: string } {
  const original = requireString(value, "domain", 2_048);
  let candidate = original.toLowerCase().trim();
  try {
    const url = candidate.includes("://")
      ? new URL(candidate)
      : new URL(`https://${candidate}`);
    candidate = url.hostname;
  } catch {
    throw new HttpError(400, "invalid_domain", "domain is invalid.");
  }
  const canonical = candidate.replace(/^www\./, "").replace(/\.$/, "");
  if (
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
      canonical,
    )
  ) {
    throw new HttpError(400, "invalid_domain", "domain is invalid.");
  }
  return { canonical, original };
}

function teamMembers(value: unknown): Array<{ email: string; name: string }> | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > 100) {
    throw new HttpError(400, "invalid_request", "teamMembers is invalid.");
  }
  return value.map((member, index) => {
    const record = bodyRecord(member);
    const name = requireString(record.name, `teamMembers[${index}].name`, 200);
    const email = requireString(record.email, `teamMembers[${index}].email`, 254).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new HttpError(
        400,
        "invalid_request",
        `teamMembers[${index}].email is invalid.`,
      );
    }
    return { email, name };
  });
}

function competitors(value: unknown): CompetitorInput[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 1_000) {
    throw new HttpError(400, "invalid_request", "competitors is invalid.");
  }
  return value.map((item, index) => {
    const record = bodyRecord(item);
    return {
      competitorDomain: domain(record.competitorDomain).canonical,
      competitorName: requireString(
        record.competitorName,
        `competitors[${index}].competitorName`,
        200,
      ),
      verified: optionalBoolean(
        record.verified,
        `competitors[${index}].verified`,
        false,
      ),
    };
  });
}

function keywordRules(value: unknown): KeywordRuleInput[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 5_000) {
    throw new HttpError(400, "invalid_request", "keywordRules is invalid.");
  }
  const validTypes = new Set([
    "blacklist",
    "competitor_brand",
    "own_brand",
    "whitelist",
  ]);
  return value.map((item, index) => {
    const record = bodyRecord(item);
    const ruleType = requireString(
      record.ruleType,
      `keywordRules[${index}].ruleType`,
      32,
    );
    if (!validTypes.has(ruleType)) {
      throw new HttpError(
        400,
        "invalid_request",
        `keywordRules[${index}].ruleType is invalid.`,
      );
    }
    return {
      keywordCategorisation: requireString(
        record.keywordCategorisation,
        `keywordRules[${index}].keywordCategorisation`,
        500,
      ),
      ruleType: ruleType as KeywordRuleInput["ruleType"],
    };
  });
}

function stringArray(
  value: unknown,
  field: string,
  maximumItems: number,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new HttpError(400, "invalid_request", `${field} is invalid.`);
  }
  return [...new Set(value.map((item, index) =>
    requireString(item, `${field}[${index}]`, 200),
  ))];
}

function projectRules(
  value: unknown,
): Array<{ ruleType: string; value: string }> {
  if (value === undefined) return [];
  const record = bodyRecord(value);
  const definitions = [
    ["whitelist", "whitelist"],
    ["blacklist", "blacklist"],
    ["ownBrands", "own_brand"],
    ["competitorBrands", "competitor_brand"],
    ["relevantTerms", "relevant_term"],
  ] as const;
  return definitions.flatMap(([field, ruleType]) =>
    stringArray(record[field], `rules.${field}`, 1_000).map((ruleValue) => ({
      ruleType,
      value: ruleValue,
    })),
  );
}

function isConflict(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "23505",
  );
}

function publicClient(row: ClientRow): Record<string, unknown> {
  return {
    analytics_connected: row.analytics_connected,
    archive_reason: row.archive_reason,
    archived_at: row.archived_at?.toISOString() ?? null,
    archived_by: row.archived_by,
    brand_terms: row.brand_terms,
    brand_type: row.brand_type,
    campaign_type: row.campaign_type,
    company_name: row.company_name,
    created_at: row.created_at.toISOString(),
    domain: row.domain,
    domain_normalized: row.domain_normalized,
    gsc_connected: row.gsc_connected,
    id: row.id,
    industry: row.industry,
    logo_url: row.logo_url,
    team_members: row.team_members,
    updated_at: row.updated_at.toISOString(),
  };
}

function publicProjectSummary(
  project: ProjectSummaryRow,
): Record<string, unknown> {
  return {
    aov: project.aov === null ? null : Number(project.aov),
    archive_reason: project.archive_reason,
    archived_at: project.archived_at?.toISOString() ?? null,
    archived_by: project.archived_by,
    calculations_v2_compute_enabled:
      project.calculations_v2_compute_enabled,
    calculations_v2_visible_enabled:
      project.calculations_v2_visible_enabled,
    category_focus: project.category_focus,
    client_archived_at: project.client_archived_at?.toISOString() ?? null,
    client_domain: project.client_domain,
    client_id: project.client_id,
    client_logo_url: project.client_logo_url,
    client_name: project.client_name,
    conversion_rate:
      project.conversion_rate === null
        ? null
        : Number(project.conversion_rate),
    created_at: project.created_at.toISOString(),
    ctr: project.ctr === null ? null : Number(project.ctr),
    duplicated_from: project.duplicated_from,
    har_status: project.har_status,
    id: project.id,
    inputs_dirty: project.inputs_dirty,
    keywords_dirty: project.keywords_dirty,
    last_dirty_at: project.last_dirty_at?.toISOString() ?? null,
    last_synced_at: project.last_synced_at?.toISOString() ?? null,
    project_name: project.project_name,
    ranking_lookup_status: project.ranking_lookup_status,
    seasonality_end: project.seasonality_end,
    seasonality_start: project.seasonality_start,
    serp_dirty: project.serp_dirty,
    status: project.status,
    updated_at: project.updated_at.toISOString(),
  };
}

async function replaceClientRelations(
  client: PoolClient,
  clientId: string,
  userId: string,
  nextCompetitors: CompetitorInput[] | null,
  nextRules: KeywordRuleInput[] | null,
): Promise<void> {
  if (nextCompetitors) {
    await client.query("DELETE FROM competitors WHERE client_id = $1", [clientId]);
    for (const competitor of nextCompetitors) {
      await client.query(
        `
          INSERT INTO competitors (
            id,
            client_id,
            competitor_name,
            competitor_domain,
            added_by,
            verified
          )
          VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          randomUUID(),
          clientId,
          competitor.competitorName,
          competitor.competitorDomain,
          userId,
          competitor.verified,
        ],
      );
    }
  }
  if (nextRules) {
    await client.query("DELETE FROM keyword_rules WHERE client_id = $1", [clientId]);
    for (const rule of nextRules) {
      await client.query(
        `
          INSERT INTO keyword_rules (
            id,
            client_id,
            keyword_categorisation,
            rule_type
          )
          VALUES ($1, $2, $3, $4)
        `,
        [randomUUID(), clientId, rule.keywordCategorisation, rule.ruleType],
      );
    }
  }
}

export async function listClients(
  pool: DatabasePool,
  user: AuthenticatedUser,
  includeArchived = false,
): Promise<Record<string, unknown>> {
  if (includeArchived) {
    await assertAdministrator(pool, user.id);
  }
  const role = await getUserRole(pool, user.id);
  const result = await pool.query<ClientRow>(
    `
      SELECT
        client.id,
        client.company_name,
        client.domain,
        client.domain_normalized,
        client.industry,
        client.campaign_type,
        client.brand_type,
        client.logo_url,
        client.team_members,
        client.gsc_connected,
        client.analytics_connected,
        client.brand_terms,
        client.archive_reason,
        client.archived_at,
        client.archived_by,
        client.created_at,
        client.updated_at
      FROM clients AS client
      WHERE ($1::boolean OR client.archived_at IS NULL)
        AND (
          $2::text IN ('super_admin', 'admin', 'user')
          OR EXISTS (
            SELECT 1
            FROM user_client_access AS access
            WHERE access.user_id = $3
              AND access.client_id = client.id
          )
        )
      ORDER BY client.created_at DESC, client.id
    `,
    [includeArchived, role, user.id],
  );
  return { clients: result.rows.map(publicClient) };
}

export async function getClient(
  pool: DatabasePool,
  user: AuthenticatedUser,
  clientId: string,
): Promise<Record<string, unknown>> {
  await assertClientAccess(pool, user.id, clientId);
  const [clientResult, competitorResult, ruleResult] = await Promise.all([
    pool.query<ClientRow>(
      `
        SELECT
          id,
          company_name,
          domain,
          domain_normalized,
          industry,
          campaign_type,
          brand_type,
          logo_url,
          team_members,
          gsc_connected,
          analytics_connected,
          brand_terms,
          archive_reason,
          archived_at,
          archived_by,
          created_at,
          updated_at
        FROM clients
        WHERE id = $1
      `,
      [clientId],
    ),
    pool.query(
      `
        SELECT id, competitor_name, competitor_domain, verified
        FROM competitors
        WHERE client_id = $1
        ORDER BY competitor_name, id
      `,
      [clientId],
    ),
    pool.query(
      `
        SELECT id, keyword_categorisation, rule_type
        FROM keyword_rules
        WHERE client_id = $1
        ORDER BY rule_type, id
      `,
      [clientId],
    ),
  ]);
  const client = clientResult.rows[0];
  if (!client) {
    throw new HttpError(404, "client_not_found", "Client not found.");
  }
  return {
    ...publicClient(client),
    competitors: competitorResult.rows,
    keyword_rules: ruleResult.rows,
  };
}

export async function createClient(
  pool: DatabasePool,
  user: AuthenticatedUser,
  body: unknown,
): Promise<Record<string, unknown>> {
  await assertWriteAccess(pool, user.id);
  const record = bodyRecord(body);
  const clientDomain = domain(record.domain);
  const id = randomUUID();
  const nextCompetitors = competitors(record.competitors);
  const nextRules = keywordRules(record.keywordRules);
  const values = {
    analyticsConnected: optionalBoolean(
      record.analyticsConnected,
      "analyticsConnected",
      false,
    ),
    campaignType: optionalString(record.campaignType, "campaignType", 100),
    companyName: requireString(record.companyName, "companyName", 200),
    gscConnected: optionalBoolean(record.gscConnected, "gscConnected", false),
    industry: optionalString(record.industry, "industry", 200),
    brandTerms: stringArray(record.brandTerms, "brandTerms", 1_000),
    teamMembers: teamMembers(record.teamMembers),
  };

  try {
    await withTransaction(pool, async (client) => {
      await client.query(
        `
          INSERT INTO clients (
            id,
            company_name,
            domain,
            domain_normalized,
            industry,
            campaign_type,
            team_members,
            gsc_connected,
            analytics_connected,
            brand_terms,
            created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `,
        [
          id,
          values.companyName,
          clientDomain.original,
          clientDomain.canonical,
          values.industry,
          values.campaignType,
          values.teamMembers ? JSON.stringify(values.teamMembers) : null,
          values.gscConnected,
          values.analyticsConnected,
          values.brandTerms,
          user.id,
        ],
      );
      await client.query(
        `
          INSERT INTO user_client_access (user_id, client_id, access_role)
          VALUES ($1, $2, 'owner')
        `,
        [user.id, id],
      );
      await replaceClientRelations(
        client,
        id,
        user.id,
        nextCompetitors,
        nextRules,
      );
    });
  } catch (error) {
    if (isConflict(error)) {
      throw new HttpError(
        409,
        "client_domain_conflict",
        "A live client already uses this domain.",
      );
    }
    throw error;
  }
  return getClient(pool, user, id);
}

export async function updateClient(
  pool: DatabasePool,
  user: AuthenticatedUser,
  clientId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const record = bodyRecord(body);
  const clientDomain = domain(record.domain);
  const nextCompetitors = competitors(record.competitors);
  const nextRules = keywordRules(record.keywordRules);
  const values = {
    analyticsConnected: optionalBoolean(
      record.analyticsConnected,
      "analyticsConnected",
      false,
    ),
    campaignType: optionalString(record.campaignType, "campaignType", 100),
    companyName: requireString(record.companyName, "companyName", 200),
    gscConnected: optionalBoolean(record.gscConnected, "gscConnected", false),
    industry: optionalString(record.industry, "industry", 200),
    brandTerms:
      record.brandTerms === undefined
        ? null
        : stringArray(record.brandTerms, "brandTerms", 1_000),
    teamMembers: teamMembers(record.teamMembers),
  };

  try {
    await withTransaction(pool, async (client) => {
      await assertClientAccess(client, user.id, clientId, true);
      const result = await client.query(
        `
          UPDATE clients
          SET
            company_name = $2,
            domain = $3,
            domain_normalized = $4,
            industry = $5,
            campaign_type = $6,
            team_members = $7,
            gsc_connected = $8,
            analytics_connected = $9,
            brand_terms = COALESCE($10, brand_terms),
            updated_at = now()
          WHERE id = $1
            AND archived_at IS NULL
          RETURNING id
        `,
        [
          clientId,
          values.companyName,
          clientDomain.original,
          clientDomain.canonical,
          values.industry,
          values.campaignType,
          values.teamMembers ? JSON.stringify(values.teamMembers) : null,
          values.gscConnected,
          values.analyticsConnected,
          values.brandTerms,
        ],
      );
      if (result.rowCount !== 1) {
        throw new HttpError(404, "client_not_found", "Client not found.");
      }
      await replaceClientRelations(
        client,
        clientId,
        user.id,
        nextCompetitors,
        nextRules,
      );
      await client.query(
        `
          UPDATE navigator_projects
          SET
            inputs_dirty = true,
            last_dirty_at = now(),
            updated_at = now()
          WHERE client_id = $1
            AND archived_at IS NULL
        `,
        [clientId],
      );
    });
  } catch (error) {
    if (isConflict(error)) {
      throw new HttpError(
        409,
        "client_domain_conflict",
        "A live client already uses this domain.",
      );
    }
    throw error;
  }
  return getClient(pool, user, clientId);
}

export async function updateClientBrandTerms(
  pool: DatabasePool,
  user: AuthenticatedUser,
  clientId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  await assertAdministrator(pool, user.id);
  const terms = stringArray(
    bodyRecord(body).brandTerms,
    "brandTerms",
    1_000,
  );
  await withTransaction(pool, async (client) => {
    const result = await client.query(
      `
        UPDATE clients
        SET
          brand_terms = $2,
          updated_at = now()
        WHERE id = $1
          AND archived_at IS NULL
        RETURNING id
      `,
      [clientId, terms],
    );
    if (result.rowCount !== 1) {
      throw new HttpError(404, "client_not_found", "Client not found.");
    }
    await client.query(
      `
        UPDATE navigator_projects
        SET
          inputs_dirty = true,
          last_dirty_at = now(),
          updated_at = now()
        WHERE client_id = $1
          AND archived_at IS NULL
      `,
      [clientId],
    );
  });
  return getClient(pool, user, clientId);
}

function base64(value: unknown): Buffer {
  const encoded = requireString(
    value,
    "contentBase64",
    Math.ceil((MAXIMUM_LOGO_BYTES * 4) / 3) + 4,
  );
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new HttpError(400, "invalid_base64", "contentBase64 is invalid.");
  }
  const content = Buffer.from(encoded, "base64");
  if (content.length > MAXIMUM_LOGO_BYTES) {
    throw new HttpError(413, "logo_too_large", "The logo is too large.");
  }
  return content;
}

function logoContentType(path: string): string {
  if (/\.svg$/i.test(path)) return "image/svg+xml";
  if (/\.webp$/i.test(path)) return "image/webp";
  if (/\.jpe?g$/i.test(path)) return "image/jpeg";
  return "image/png";
}

export async function putClientLogo(
  pool: DatabasePool,
  objectStore: ObjectStore,
  user: AuthenticatedUser,
  clientId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  await assertClientAccess(pool, user.id, clientId, true);
  const record = bodyRecord(body);
  const contentType = requireString(record.contentType, "contentType", 128);
  if (!new Set(["image/jpeg", "image/png", "image/svg+xml", "image/webp"]).has(contentType)) {
    throw new HttpError(400, "invalid_content_type", "The logo content type is invalid.");
  }
  const extension = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/svg+xml": "svg",
    "image/webp": "webp",
  }[contentType];
  const objectKey = `${clientId}/logo-${randomUUID()}.${extension}`;
  await objectStore.put(objectKey, base64(record.contentBase64));
  await pool.query(
    `
      UPDATE clients
      SET logo_url = $2, updated_at = now()
      WHERE id = $1
    `,
    [clientId, objectKey],
  );
  return { path: objectKey };
}

export async function getClientLogo(
  pool: DatabasePool,
  objectStore: ObjectStore,
  user: AuthenticatedUser,
  clientId: string,
): Promise<Record<string, unknown>> {
  await assertClientAccess(pool, user.id, clientId);
  const result = await pool.query<{ logo_url: string | null }>(
    "SELECT logo_url FROM clients WHERE id = $1",
    [clientId],
  );
  let path = result.rows[0]?.logo_url ?? null;
  if (!path) throw new HttpError(404, "logo_not_found", "Client logo not found.");
  const marker = "/storage/v1/object/public/client-logos/";
  if (path.includes(marker)) {
    path = decodeURIComponent(path.split(marker)[1] ?? "");
  }
  if (!path || path.startsWith("/") || path.includes("..")) {
    throw new HttpError(500, "invalid_logo_path", "The client logo path is invalid.");
  }
  const content = await objectStore.get(path);
  return {
    contentBase64: content.toString("base64"),
    contentType: logoContentType(path),
  };
}

export async function listProjects(
  pool: DatabasePool,
  user: AuthenticatedUser,
  clientId: string | null,
  includeArchived = false,
): Promise<Record<string, unknown>> {
  const validatedClientId =
    clientId === null ? null : uuid(clientId, "clientId");
  if (validatedClientId) {
    await assertClientAccess(pool, user.id, validatedClientId);
  }
  if (includeArchived) {
    await assertAdministrator(pool, user.id);
  }
  const role = await getUserRole(pool, user.id);
  const result = await pool.query<ProjectSummaryRow>(
    `
      SELECT
        project.id,
        project.project_name,
        project.category_focus,
        project.status,
        project.aov,
        project.archive_reason,
        project.archived_by,
        project.calculations_v2_compute_enabled,
        project.calculations_v2_visible_enabled,
        project.conversion_rate,
        project.ctr,
        project.duplicated_from,
        project.har_status,
        project.inputs_dirty,
        project.keywords_dirty,
        project.last_dirty_at,
        project.last_synced_at,
        project.ranking_lookup_status,
        project.seasonality_end,
        project.seasonality_start,
        project.serp_dirty,
        project.created_at,
        project.updated_at,
        project.client_id,
        project.archived_at,
        client.company_name AS client_name,
        client.domain AS client_domain,
        client.logo_url AS client_logo_url,
        client.archived_at AS client_archived_at
      FROM navigator_projects AS project
      JOIN clients AS client ON client.id = project.client_id
      WHERE (
          $4::boolean
          OR (
            project.archived_at IS NULL
            AND client.archived_at IS NULL
          )
        )
        AND ($1::uuid IS NULL OR project.client_id = $1)
        AND (
          $2::text IN ('super_admin', 'admin', 'user')
          OR EXISTS (
            SELECT 1
            FROM user_client_access AS access
            WHERE access.user_id = $3
              AND access.client_id = project.client_id
          )
        )
      ORDER BY project.updated_at DESC, project.created_at DESC, project.id
    `,
    [validatedClientId, role, user.id, includeArchived],
  );
  return {
    projects: result.rows.map(publicProjectSummary),
  };
}

export async function createProject(
  pool: DatabasePool,
  user: AuthenticatedUser,
  clientId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const record = bodyRecord(body);
  const projectName = requireString(
    record.projectName ?? record.name,
    "projectName",
    200,
  );
  const categoryFocus = optionalString(
    record.categoryFocus,
    "categoryFocus",
    200,
  );
  const seasonalityStart = optionalDate(
    record.seasonalityStart,
    "seasonalityStart",
  );
  const seasonalityEnd = optionalDate(record.seasonalityEnd, "seasonalityEnd");
  if (
    seasonalityStart &&
    seasonalityEnd &&
    seasonalityStart > seasonalityEnd
  ) {
    throw new HttpError(
      400,
      "invalid_request",
      "seasonalityStart must not be after seasonalityEnd.",
    );
  }
  const aov = optionalNumber(record.aov, "aov", Number.MAX_SAFE_INTEGER);
  const conversionRate = optionalNumber(
    record.conversionRate ??
      (record.economics && typeof record.economics === "object"
        ? (record.economics as Record<string, unknown>).conversionRate
        : undefined),
    "conversionRate",
    1,
  );
  const fullEconomics =
    record.economics && typeof record.economics === "object"
      ? (record.economics as Record<string, unknown>)
      : {};
  const projectAov =
    aov ??
    optionalNumber(
      fullEconomics.averageOrderValue,
      "economics.averageOrderValue",
      Number.MAX_SAFE_INTEGER,
    );
  const gscWindowDays =
    optionalNumber(
      fullEconomics.gscWindowDays,
      "economics.gscWindowDays",
      3_650,
    ) ?? 30;
  if (!Number.isInteger(gscWindowDays) || gscWindowDays < 1) {
    throw new HttpError(
      400,
      "invalid_request",
      "economics.gscWindowDays is invalid.",
    );
  }
  const authority =
    record.authority && typeof record.authority === "object"
      ? (record.authority as Record<string, unknown>)
      : {};
  const domainRating =
    optionalNumber(authority.domainRating, "authority.domainRating", 100) ?? 0;
  const referringDomains =
    optionalNumber(
      authority.referringDomains,
      "authority.referringDomains",
      2_147_483_647,
    ) ?? 0;
  const backlinks =
    optionalNumber(
      authority.backlinks,
      "authority.backlinks",
      Number.MAX_SAFE_INTEGER,
    ) ?? 0;
  const country = optionalString(record.country, "country", 2)?.toUpperCase() ?? null;
  const language = optionalString(record.language, "language", 32)?.toLowerCase() ?? null;
  const currency = optionalString(record.currency, "currency", 3)?.toUpperCase() ?? null;
  if (country && !/^[A-Z]{2}$/.test(country)) {
    throw new HttpError(400, "invalid_request", "country is invalid.");
  }
  if (currency && !/^[A-Z]{3}$/.test(currency)) {
    throw new HttpError(400, "invalid_request", "currency is invalid.");
  }
  const rules = projectRules(record.rules);
  const id = randomUUID();
  try {
    await withTransaction(pool, async (client) => {
      await assertClientAccess(client, user.id, clientId, true);
      await client.query(
        `
          INSERT INTO navigator_projects (
            id,
            client_id,
            project_name,
            category_focus,
            seasonality_start,
            seasonality_end,
            aov,
            conversion_rate,
            country,
            language,
            currency,
            authority_domain_rating,
            authority_referring_domains,
            authority_backlinks,
            gsc_window_days,
            status
          )
          VALUES (
            $1, $2, $3, $4, $5::date, $6::date, $7, $8,
            $9, $10, $11, $12, $13, $14, $15, 'draft'
          )
        `,
        [
          id,
          clientId,
          projectName,
          categoryFocus,
          seasonalityStart,
          seasonalityEnd,
          projectAov,
          conversionRate,
          country,
          language,
          currency,
          domainRating,
          referringDomains,
          backlinks,
          gscWindowDays,
        ],
      );
      for (const rule of rules) {
        await client.query(
          `
            INSERT INTO project_keyword_rules (
              id,
              project_id,
              rule_type,
              value,
              normalised_value
            )
            VALUES ($1, $2, $3, $4, $5)
          `,
          [
            randomUUID(),
            id,
            rule.ruleType,
            rule.value,
            rule.value.trim().toLowerCase().replace(/\s+/g, " "),
          ],
        );
      }
    });
  } catch (error) {
    if (isConflict(error)) {
      throw new HttpError(
        409,
        "project_conflict",
        "A project with this name already exists for the client.",
      );
    }
    throw error;
  }
  return { client_id: clientId, id, project_name: projectName };
}

export async function getProjectSummary(
  pool: DatabasePool,
  user: AuthenticatedUser,
  projectId: string,
): Promise<Record<string, unknown>> {
  const access = await pool.query<{ archived_at: Date | null }>(
    "SELECT archived_at FROM navigator_projects WHERE id = $1",
    [projectId],
  );
  if (!access.rows[0]) {
    throw new HttpError(404, "project_not_found", "Project not found.");
  }
  if (access.rows[0].archived_at) {
    await assertAdministrator(pool, user.id);
  } else {
    await assertProjectAccessByRole(pool, user.id, projectId);
  }
  const result = await pool.query<ProjectSummaryRow>(
    `
      SELECT
        project.id,
        project.project_name,
        project.category_focus,
        project.status,
        project.aov,
        project.archive_reason,
        project.archived_by,
        project.calculations_v2_compute_enabled,
        project.calculations_v2_visible_enabled,
        project.conversion_rate,
        project.ctr,
        project.duplicated_from,
        project.har_status,
        project.inputs_dirty,
        project.keywords_dirty,
        project.last_dirty_at,
        project.last_synced_at,
        project.ranking_lookup_status,
        project.seasonality_end,
        project.seasonality_start,
        project.serp_dirty,
        project.created_at,
        project.updated_at,
        project.client_id,
        project.archived_at,
        client.company_name AS client_name,
        client.domain AS client_domain,
        client.logo_url AS client_logo_url,
        client.archived_at AS client_archived_at
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
  return publicProjectSummary(project);
}

export async function getArchivedProjectDetail(
  pool: DatabasePool,
  user: AuthenticatedUser,
  projectId: string,
): Promise<Record<string, unknown>> {
  await assertAdministrator(pool, user.id);
  const project = await getProjectSummary(pool, user, projectId);
  const counts = await pool.query<{
    keywords: string;
    roadmaps: string;
  }>(
    `
      SELECT
        (SELECT count(*)::text FROM keywords WHERE project_id = $1) AS keywords,
        (SELECT count(*)::text FROM project_roadmaps WHERE project_id = $1) AS roadmaps
    `,
    [projectId],
  );
  return {
    project,
    kpis: {
      contentPlans: 0,
      keywords: Number(counts.rows[0]?.keywords ?? 0),
      roadmaps: Number(counts.rows[0]?.roadmaps ?? 0),
    },
  };
}

export async function updateProject(
  pool: DatabasePool,
  user: AuthenticatedUser,
  projectId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const record = bodyRecord(body);
  const projectName = requireString(record.projectName, "projectName", 200);
  const categoryFocus = optionalString(
    record.categoryFocus,
    "categoryFocus",
    200,
  );
  const seasonalityStart = optionalDate(
    record.seasonalityStart,
    "seasonalityStart",
  );
  const seasonalityEnd = optionalDate(record.seasonalityEnd, "seasonalityEnd");
  if (
    seasonalityStart &&
    seasonalityEnd &&
    seasonalityStart > seasonalityEnd
  ) {
    throw new HttpError(
      400,
      "invalid_request",
      "seasonalityStart must not be after seasonalityEnd.",
    );
  }
  const aov = optionalNumber(record.aov, "aov", Number.MAX_SAFE_INTEGER);
  const conversionRate = optionalNumber(
    record.conversionRate,
    "conversionRate",
    1,
  );

  try {
    await withTransaction(pool, async (client) => {
      await assertProjectAccessByRole(client, user.id, projectId, true);
      const result = await client.query(
        `
          UPDATE navigator_projects
          SET
            inputs_dirty = inputs_dirty OR (
              category_focus IS DISTINCT FROM $3
              OR seasonality_start IS DISTINCT FROM $4::date
              OR seasonality_end IS DISTINCT FROM $5::date
              OR aov IS DISTINCT FROM $6
              OR conversion_rate IS DISTINCT FROM $7
            ),
            last_dirty_at = CASE
              WHEN category_focus IS DISTINCT FROM $3
                OR seasonality_start IS DISTINCT FROM $4::date
                OR seasonality_end IS DISTINCT FROM $5::date
                OR aov IS DISTINCT FROM $6
                OR conversion_rate IS DISTINCT FROM $7
              THEN now()
              ELSE last_dirty_at
            END,
            project_name = $2,
            category_focus = $3,
            seasonality_start = $4::date,
            seasonality_end = $5::date,
            aov = $6,
            conversion_rate = $7,
            updated_at = now()
          WHERE id = $1
            AND archived_at IS NULL
          RETURNING id
        `,
        [
          projectId,
          projectName,
          categoryFocus,
          seasonalityStart,
          seasonalityEnd,
          aov,
          conversionRate,
        ],
      );
      if (result.rowCount !== 1) {
        throw new HttpError(404, "project_not_found", "Project not found.");
      }
    });
  } catch (error) {
    if (isConflict(error)) {
      throw new HttpError(
        409,
        "project_conflict",
        "A project with this name already exists for the client.",
      );
    }
    throw error;
  }
  return getProjectSummary(pool, user, projectId);
}

export async function duplicateProject(
  pool: DatabasePool,
  user: AuthenticatedUser,
  projectId: string,
): Promise<Record<string, unknown>> {
  const duplicateId = randomUUID();
  try {
    await withTransaction(pool, async (client) => {
      await assertProjectAccessByRole(client, user.id, projectId, true);
      const result = await client.query(
        `
          INSERT INTO navigator_projects (
            id,
            client_id,
            project_name,
            category_focus,
            seasonality_start,
            seasonality_end,
            aov,
            conversion_rate,
            ctr,
            duplicated_from,
            status
          )
          SELECT
            $2,
            client_id,
            project_name || ' (copy)',
            category_focus,
            seasonality_start,
            seasonality_end,
            aov,
            conversion_rate,
            ctr,
            id,
            'draft'
          FROM navigator_projects
          WHERE id = $1
            AND archived_at IS NULL
          RETURNING id
        `,
        [projectId, duplicateId],
      );
      if (result.rowCount !== 1) {
        throw new HttpError(404, "project_not_found", "Project not found.");
      }
    });
  } catch (error) {
    if (isConflict(error)) {
      throw new HttpError(
        409,
        "project_conflict",
        "The duplicate project name is already in use.",
      );
    }
    throw error;
  }
  return getProjectSummary(pool, user, duplicateId);
}

export async function markProjectDirty(
  pool: DatabasePool,
  user: AuthenticatedUser,
  projectId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const domains = bodyRecord(body).domains;
  if (
    !Array.isArray(domains) ||
    domains.length > 3 ||
    domains.some(
      (domain) =>
        domain !== "keywords" && domain !== "serp" && domain !== "inputs",
    )
  ) {
    throw new HttpError(400, "invalid_request", "domains is invalid.");
  }
  const selected = new Set(domains);
  await withTransaction(pool, async (client) => {
    await assertProjectAccessByRole(client, user.id, projectId, true);
    await client.query(
      `
        UPDATE navigator_projects
        SET
          keywords_dirty = keywords_dirty OR $2,
          serp_dirty = serp_dirty OR $3,
          inputs_dirty = inputs_dirty OR $4,
          last_dirty_at = now(),
          updated_at = now()
        WHERE id = $1
      `,
      [
        projectId,
        selected.has("keywords"),
        selected.has("serp"),
        selected.has("inputs"),
      ],
    );
  });
  return getProjectSummary(pool, user, projectId);
}

function archiveReason(body: unknown): string | null {
  return optionalString(bodyRecord(body).reason, "reason", 1_000);
}

async function countProjectRows(
  client: PoolClient,
  projectIds: string[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  if (projectIds.length === 0) return counts;
  for (const table of PROJECT_COUNT_TABLES) {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE project_id = ANY($1::uuid[])`,
      [projectIds],
    );
    const count = Number(result.rows[0]?.count ?? 0);
    if (count > 0) counts[table] = count;
  }
  return counts;
}

function logoObjectKey(value: string | null): string | null {
  if (!value) return null;
  const marker = "/storage/v1/object/public/client-logos/";
  if (value.includes(marker)) {
    return decodeURIComponent(value.split(marker)[1]?.split("?")[0] ?? "") || null;
  }
  if (/^https?:\/\//i.test(value)) return null;
  const key = value.replace(/^\/+/, "");
  return key && !key.includes("..") ? key : null;
}

async function removeArchivedObject(
  objectStore: ObjectStore,
  key: string | null,
): Promise<{
  bytes_removed: number;
  objects_removed: number;
  buckets: string[];
  errors: string[];
}> {
  const storage = {
    bytes_removed: 0,
    objects_removed: 0,
    buckets: [] as string[],
    errors: [] as string[],
  };
  if (!key) return storage;
  try {
    const content = await objectStore.get(key);
    await objectStore.delete(key);
    storage.bytes_removed = content.length;
    storage.objects_removed = 1;
    storage.buckets.push("object-store");
  } catch (error) {
    storage.errors.push(error instanceof Error ? error.message : String(error));
  }
  return storage;
}

export async function archiveClient(
  pool: DatabasePool,
  user: AuthenticatedUser,
  clientId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  await assertAdministrator(pool, user.id);
  const reason = archiveReason(body);
  await withTransaction(pool, async (client) => {
    const current = await client.query<{ archived_at: Date | null }>(
      "SELECT archived_at FROM clients WHERE id = $1 FOR UPDATE",
      [clientId],
    );
    if (!current.rows[0]) {
      throw new HttpError(404, "client_not_found", "Client not found.");
    }
    if (current.rows[0].archived_at) return;
    const archivedAt = new Date();
    const projects = await client.query<{ id: string }>(
      `
        UPDATE navigator_projects
        SET
          archived_at = $2,
          archived_by = $3,
          archive_reason = COALESCE($4, 'Cascaded from client archive'),
          updated_at = now()
        WHERE client_id = $1
          AND archived_at IS NULL
        RETURNING id
      `,
      [clientId, archivedAt, user.id, reason],
    );
    await client.query(
      `
        UPDATE clients
        SET
          archived_at = $2,
          archived_by = $3,
          archive_reason = $4,
          updated_at = now()
        WHERE id = $1
      `,
      [clientId, archivedAt, user.id, reason],
    );
    await client.query(
      `
        INSERT INTO archive_audit (
          entity_type, entity_id, client_id, action, actor_id, reason, metadata
        )
        VALUES ('client', $1, $1, 'archive', $2, $3, $4)
      `,
      [
        clientId,
        user.id,
        reason,
        JSON.stringify({
          archivedAt: archivedAt.toISOString(),
          cascadedProjectIds: projects.rows.map((project) => project.id),
        }),
      ],
    );
  });
  return getClient(pool, user, clientId);
}

export async function restoreClient(
  pool: DatabasePool,
  user: AuthenticatedUser,
  clientId: string,
): Promise<Record<string, unknown>> {
  await assertAdministrator(pool, user.id);
  await withTransaction(pool, async (client) => {
    const current = await client.query<{
      archived_at: Date | null;
      domain_normalized: string | null;
    }>(
      `
        SELECT archived_at, domain_normalized
        FROM clients
        WHERE id = $1
        FOR UPDATE
      `,
      [clientId],
    );
    const archivedClient = current.rows[0];
    if (!archivedClient) {
      throw new HttpError(404, "client_not_found", "Client not found.");
    }
    if (!archivedClient.archived_at) return;
    if (archivedClient.domain_normalized) {
      const conflict = await client.query<{ company_name: string }>(
        `
          SELECT company_name
          FROM clients
          WHERE domain_normalized = $1
            AND archived_at IS NULL
            AND id <> $2
          LIMIT 1
        `,
        [archivedClient.domain_normalized, clientId],
      );
      if (conflict.rows[0]) {
        throw new HttpError(
          409,
          "client_domain_conflict",
          `Cannot restore this client because ${conflict.rows[0].company_name} now uses the same domain.`,
        );
      }
    }
    const projects = await client.query<{ id: string }>(
      `
        UPDATE navigator_projects
        SET
          archived_at = NULL,
          archived_by = NULL,
          archive_reason = NULL,
          updated_at = now()
        WHERE client_id = $1
          AND archived_at = $2
        RETURNING id
      `,
      [clientId, archivedClient.archived_at],
    );
    await client.query(
      `
        UPDATE clients
        SET
          archived_at = NULL,
          archived_by = NULL,
          archive_reason = NULL,
          updated_at = now()
        WHERE id = $1
      `,
      [clientId],
    );
    await client.query(
      `
        INSERT INTO archive_audit (
          entity_type, entity_id, client_id, action, actor_id, metadata
        )
        VALUES ('client', $1, $1, 'restore', $2, $3)
      `,
      [
        clientId,
        user.id,
        JSON.stringify({
          matchedArchivedAt: archivedClient.archived_at.toISOString(),
          restoredProjectIds: projects.rows.map((project) => project.id),
        }),
      ],
    );
  });
  return getClient(pool, user, clientId);
}

export async function archiveProject(
  pool: DatabasePool,
  user: AuthenticatedUser,
  projectId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  await assertAdministrator(pool, user.id);
  const reason = archiveReason(body);
  await withTransaction(pool, async (client) => {
    const result = await client.query<{ client_id: string }>(
      `
        UPDATE navigator_projects
        SET
          archived_at = now(),
          archived_by = $2,
          archive_reason = $3,
          updated_at = now()
        WHERE id = $1
          AND archived_at IS NULL
        RETURNING client_id
      `,
      [projectId, user.id, reason],
    );
    if (!result.rows[0]) {
      const exists = await client.query(
        "SELECT 1 FROM navigator_projects WHERE id = $1",
        [projectId],
      );
      if (exists.rowCount !== 1) {
        throw new HttpError(404, "project_not_found", "Project not found.");
      }
      return;
    }
    await client.query(
      `
        INSERT INTO archive_audit (
          entity_type, entity_id, client_id, action, actor_id, reason
        )
        VALUES ('project', $1, $2, 'archive', $3, $4)
      `,
      [projectId, result.rows[0].client_id, user.id, reason],
    );
  });
  return getProjectSummary(pool, user, projectId);
}

export async function restoreProject(
  pool: DatabasePool,
  user: AuthenticatedUser,
  projectId: string,
): Promise<Record<string, unknown>> {
  await assertAdministrator(pool, user.id);
  await withTransaction(pool, async (client) => {
    const current = await client.query<{
      archived_at: Date | null;
      client_archived_at: Date | null;
      client_id: string;
    }>(
      `
        SELECT
          project.archived_at,
          project.client_id,
          client.archived_at AS client_archived_at
        FROM navigator_projects AS project
        JOIN clients AS client ON client.id = project.client_id
        WHERE project.id = $1
        FOR UPDATE OF project
      `,
      [projectId],
    );
    const project = current.rows[0];
    if (!project) {
      throw new HttpError(404, "project_not_found", "Project not found.");
    }
    if (project.client_archived_at) {
      throw new HttpError(
        409,
        "parent_client_archived",
        "Restore the parent client before restoring this project.",
      );
    }
    if (!project.archived_at) return;
    await client.query(
      `
        UPDATE navigator_projects
        SET
          archived_at = NULL,
          archived_by = NULL,
          archive_reason = NULL,
          updated_at = now()
        WHERE id = $1
      `,
      [projectId],
    );
    await client.query(
      `
        INSERT INTO archive_audit (
          entity_type, entity_id, client_id, action, actor_id
        )
        VALUES ('project', $1, $2, 'restore', $3)
      `,
      [projectId, project.client_id, user.id],
    );
  });
  return getProjectSummary(pool, user, projectId);
}

export async function deleteProject(
  pool: DatabasePool,
  objectStore: ObjectStore,
  user: AuthenticatedUser,
  projectId: string,
): Promise<Record<string, unknown>> {
  await assertAdministrator(pool, user.id);
  const summary = await withTransaction(pool, async (client) => {
    const result = await client.query<{
      archived_at: Date | null;
      client_id: string;
      project_name: string;
    }>(
      `
        SELECT archived_at, client_id, project_name
        FROM navigator_projects
        WHERE id = $1
        FOR UPDATE
      `,
      [projectId],
    );
    const project = result.rows[0];
    if (!project) {
      throw new HttpError(404, "project_not_found", "Project not found.");
    }
    if (!project.archived_at) {
      throw new HttpError(
        409,
        "project_not_archived",
        "Archive the project before deleting it permanently.",
      );
    }
    const counts = await countProjectRows(client, [projectId]);
    await client.query(
      `
        INSERT INTO archive_audit (
          entity_type, entity_id, client_id, action, actor_id, metadata
        )
        VALUES ('project', $1, $2, 'hard_delete', $3, $4)
      `,
      [
        projectId,
        project.client_id,
        user.id,
        JSON.stringify({ counts, deletedAt: new Date().toISOString() }),
      ],
    );
    await client.query("DELETE FROM navigator_projects WHERE id = $1", [projectId]);
    return { counts, entityName: project.project_name };
  });
  return {
    ok: true,
    entity_type: "project",
    entity_id: projectId,
    entity_name: summary.entityName,
    storage: await removeArchivedObject(objectStore, null),
    counts: summary.counts,
  };
}

export async function deleteClient(
  pool: DatabasePool,
  objectStore: ObjectStore,
  user: AuthenticatedUser,
  clientId: string,
): Promise<Record<string, unknown>> {
  await assertAdministrator(pool, user.id);
  const summary = await withTransaction(pool, async (client) => {
    const result = await client.query<{
      archived_at: Date | null;
      company_name: string;
      logo_url: string | null;
    }>(
      `
        SELECT archived_at, company_name, logo_url
        FROM clients
        WHERE id = $1
        FOR UPDATE
      `,
      [clientId],
    );
    const archivedClient = result.rows[0];
    if (!archivedClient) {
      throw new HttpError(404, "client_not_found", "Client not found.");
    }
    if (!archivedClient.archived_at) {
      throw new HttpError(
        409,
        "client_not_archived",
        "Archive the client before deleting it permanently.",
      );
    }
    const projects = await client.query<{ id: string }>(
      "SELECT id FROM navigator_projects WHERE client_id = $1",
      [clientId],
    );
    const counts = await countProjectRows(
      client,
      projects.rows.map((project) => project.id),
    );
    counts.navigator_projects = projects.rowCount ?? 0;
    await client.query(
      `
        INSERT INTO archive_audit (
          entity_type, entity_id, client_id, action, actor_id, metadata
        )
        VALUES ('client', $1, $1, 'hard_delete', $2, $3)
      `,
      [
        clientId,
        user.id,
        JSON.stringify({ counts, deletedAt: new Date().toISOString() }),
      ],
    );
    await client.query("DELETE FROM clients WHERE id = $1", [clientId]);
    return {
      counts,
      entityName: archivedClient.company_name,
      logoKey: logoObjectKey(archivedClient.logo_url),
    };
  });
  return {
    ok: true,
    entity_type: "client",
    entity_id: clientId,
    entity_name: summary.entityName,
    storage: await removeArchivedObject(objectStore, summary.logoKey),
    counts: summary.counts,
  };
}

export async function listClientUsers(
  pool: DatabasePool,
  user: AuthenticatedUser,
  clientId: string,
): Promise<Record<string, unknown>> {
  await assertAdministrator(pool, user.id);
  const result = await pool.query(
    `
      SELECT
        profile.user_id,
        profile.email,
        profile.full_name,
        role.role
      FROM user_client_access AS access
      JOIN profiles AS profile ON profile.user_id = access.user_id
      LEFT JOIN LATERAL (
        SELECT user_role.role
        FROM user_roles AS user_role
        WHERE user_role.user_id = profile.user_id
        ORDER BY CASE user_role.role
          WHEN 'super_admin' THEN 1
          WHEN 'admin' THEN 2
          WHEN 'user' THEN 3
          WHEN 'view_only' THEN 4
        END
        LIMIT 1
      ) AS role ON true
      WHERE access.client_id = $1
      ORDER BY profile.full_name NULLS LAST, profile.email, profile.user_id
    `,
    [clientId],
  );
  return { users: result.rows };
}

export async function listEligibleClientOwners(
  pool: DatabasePool,
  user: AuthenticatedUser,
  clientId: string,
): Promise<Record<string, unknown>> {
  await assertClientAccess(pool, user.id, clientId, true);
  const result = await pool.query(
    `
      SELECT DISTINCT
        profile.user_id AS id,
        profile.email,
        profile.full_name
      FROM profiles AS profile
      WHERE profile.approval_status = 'approved'
        AND (
          EXISTS (
            SELECT 1
            FROM user_roles AS role
            WHERE role.user_id = profile.user_id
              AND role.role IN ('super_admin', 'admin', 'user')
          )
          OR EXISTS (
            SELECT 1
            FROM user_client_access AS access
            WHERE access.user_id = profile.user_id
              AND access.client_id = $1
          )
        )
      ORDER BY profile.full_name NULLS LAST, profile.email, profile.user_id
    `,
    [clientId],
  );
  return { users: result.rows };
}

export async function grantClientUser(
  pool: DatabasePool,
  user: AuthenticatedUser,
  clientId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  await assertAdministrator(pool, user.id);
  const targetUserId = uuid(bodyRecord(body).userId, "userId");
  const result = await pool.query(
    `
      INSERT INTO user_client_access (user_id, client_id, access_role)
      SELECT profile.user_id, client.id, 'viewer'
      FROM profiles AS profile
      CROSS JOIN clients AS client
      WHERE profile.user_id = $1
        AND client.id = $2
      ON CONFLICT (user_id, client_id)
      DO NOTHING
      RETURNING user_id
    `,
    [targetUserId, clientId],
  );
  if (result.rowCount !== 1) {
    const existing = await pool.query(
      `
        SELECT 1
        FROM user_client_access
        WHERE user_id = $1
          AND client_id = $2
      `,
      [targetUserId, clientId],
    );
    if (existing.rowCount !== 1) {
      throw new HttpError(404, "user_or_client_not_found", "User or client not found.");
    }
  }
  return { clientId, userId: targetUserId };
}

export async function revokeClientUser(
  pool: DatabasePool,
  user: AuthenticatedUser,
  clientId: string,
  targetUserId: string,
): Promise<Record<string, unknown>> {
  await assertAdministrator(pool, user.id);
  await pool.query(
    `
      DELETE FROM user_client_access
      WHERE user_id = $1
        AND client_id = $2
    `,
    [targetUserId, clientId],
  );
  return { clientId, userId: targetUserId };
}
