import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { normaliseKeyword } from "../../../packages/fixtures/src/representative-project.js";
import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { withTransaction } from "../../../packages/runtime/src/database.js";
import { HttpError, requireString } from "../../../packages/runtime/src/http.js";
import type { AuthenticatedUser } from "../../../packages/runtime/src/local-auth.js";
import {
  assertClientAccess,
  assertProjectAccessByRole,
} from "./authorization.js";

type RuleType =
  | "blacklist"
  | "competitor_brand"
  | "own_brand"
  | "relevant_term"
  | "whitelist";

interface AccessRow {
  access_role: "editor" | "owner" | "viewer";
}

interface ProjectAccessRow extends AccessRow {
  client_id: string;
}

interface ProjectRow {
  archived_at: Date | null;
  authority_backlinks: string;
  authority_domain_rating: string;
  authority_referring_domains: number;
  brand_terms: string[];
  category_focus: string;
  client_id: string;
  company_name: string;
  country: string;
  created_at: Date;
  currency: string;
  domain: string;
  aov: string | null;
  conversion_rate: string | null;
  gsc_window_days: number;
  id: string;
  industry: string;
  language: string;
  project_name: string;
}

interface KeywordRow {
  avg_monthly_volume: number | null;
  base_rank: number | null;
  base_rank_source: string | null;
  brand_confidence: string | null;
  brand_matched_term: string | null;
  brand_source: string | null;
  categorisation_source: string | null;
  categorisation_tier: string | null;
  category: string | null;
  detox_reason: string | null;
  detox_rule: string | null;
  detox_status: string;
  enrichment_source: string | null;
  gsc_clicks: number | null;
  gsc_ctr: string | null;
  gsc_devices: string[] | null;
  gsc_impressions: number | null;
  gsc_position: string | null;
  id: string;
  is_branded: boolean | null;
  keyword: string;
  keyword_difficulty: string | null;
  ranking_url: string | null;
  ranking_lookup_no_match: boolean | null;
  search_intent: string | null;
  sources: string[];
  serp_lookup_no_result: boolean | null;
  serp_provider_missing: boolean | null;
  tags: string[] | null;
}

interface KeywordManagementRow {
  avg_monthly_volume: number | null;
  base_rank: number | null;
  categorisation_source: string | null;
  categorisation_status: string;
  categorisation_tier: string | null;
  category: string | null;
  competition: string | null;
  detox_reason: string | null;
  detox_rule: string | null;
  detox_status: string;
  device: string;
  human_reviewed: boolean;
  id: string;
  intent_confidence: string | null;
  intent_source: string | null;
  keyword: string;
  keyword_difficulty: string | null;
  keyword_priority: number | null;
  ranking_url: string | null;
  search_intent: string | null;
  tags: string[] | null;
}

interface KeywordMonthlyVolumeRow {
  keyword_id: string;
  month: Date;
  volume: number;
}

interface KeywordAggregateRow {
  categorised_count: string;
  keep_count: string;
  pending_count: string;
  ranking_url_count: string;
  remove_count: string;
  review_count: string;
  total_count: string;
}

interface RuleRow {
  rule_type: RuleType;
  value: string;
}

interface CountRow {
  count: string;
}

interface CalculationCountRow {
  calibration_count: string;
  cluster_count: string;
  ctr_curve_count: string;
  demand_signal_count: string;
  har_forecast_count: string;
  link_power_score_count: string;
  revenue_forecast_count: string;
  site_architecture_count: string;
}

interface ClientDomainMetricRow {
  ahrefs_rank: string | null;
  backlinks: string | null;
  domain: string;
  domain_rating: string | null;
  fetched_at: Date;
  metric_source: string;
  referring_domains: string | null;
  url_rating: string | null;
}

interface SerpApiRow {
  ahrefs_rank: string | null;
  backlinks: string | null;
  domain: string;
  domain_rating: string | null;
  fetched_at: Date;
  is_client_domain: boolean;
  keyword: string;
  keyword_id: string;
  metric_source: string | null;
  metrics_fetched_at: Date | null;
  rank_absolute: number;
  referring_domains: string | null;
  url: string;
  url_rating: string | null;
}

interface LatestCalculationRunRow {
  completed_at: Date;
  id: string;
}

interface HarSummaryRow {
  average_confidence: string | null;
  average_har_position: string | null;
  forecast_count: string;
  model_version: string;
  scenario: string;
}

interface RevenueSummaryRow {
  band_method: string;
  expected_incremental: string | null;
  forecast_count: string;
  model_version: string;
  monthly_forecast_count: string;
  scenario: string;
  target_incremental: string | null;
}

interface CalibrationApiRow {
  by_intent: Record<string, unknown>;
  by_rank_band: Record<string, unknown>;
  excluded_noise_floor: number;
  impressions_context: string;
  matched: number;
  median_per_pair_ratio: string | null;
  model_version: string;
  overall_ratio: string | null;
  pair_count: number;
  promotion_eligible: boolean;
  status: string;
  sum_actual_monthly: string;
  sum_modelled_monthly: string;
}

interface SiteActionSummaryRow {
  count: string;
  tactical_status: string | null;
}

interface OpportunityRow {
  base_rank: number | null;
  expected_incremental: string | null;
  har_position: number | null;
  keyword: string;
  keyword_id: string;
  rank_attainment_probability: string | null;
}

interface ForecastDetailRow {
  annual_volume: string | null;
  average_order_value_override_id: string | null;
  average_order_value_used: string | null;
  avg_monthly_volume: number | null;
  base_rank: number | null;
  client_url_rating: string | null;
  competitor_url: string | null;
  competitor_url_rating: string | null;
  content_fit_score: string | null;
  content_status: string | null;
  ctr_now: string | null;
  ctr_target: string | null;
  conversion_rate_override_id: string | null;
  conversion_rate_used: string | null;
  current_revenue_annual: string | null;
  device: string;
  expected_incremental_annual: string | null;
  expected_incremental_high_annual: string | null;
  expected_incremental_low_annual: string | null;
  explanation_json: Record<string, unknown>;
  har_confidence: string;
  har_position: number | null;
  keyword: string;
  keyword_id: string;
  keyword_priority: number | null;
  link_power_score: string | null;
  monthly_revenue_json: Record<string, unknown>;
  rank_attainment_probability: string | null;
  ranking_url: string | null;
  relevancy_score: string | null;
  scenario: string;
  search_intent: string | null;
  tactical_status: string | null;
  target_absolute_revenue_annual: string | null;
  target_incremental_revenue_annual: string | null;
  volume_forward: string | null;
}

interface SiteArchitectureDetailRow {
  avg_monthly_volume: number | null;
  base_rank: number | null;
  category: string | null;
  content_status: string | null;
  keyword: string;
  keyword_id: string;
  matched_url: string | null;
  provider_status: string | null;
  ranking_url: string | null;
  relevancy_score: string | null;
  search_intent: string | null;
  tactical_status: string | null;
}

interface CtrCurveDetailRow {
  confidence: string;
  ctr: string;
  device: string;
  impressions: string;
  is_branded: boolean;
  rank: number;
  search_intent: string;
  source: string;
}

function bodyRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", "The request body is invalid.");
  }
  return value as Record<string, unknown>;
}

function valueArray(value: unknown, field: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new HttpError(400, "invalid_request", `${field} is invalid.`);
  }
  return value;
}

function optionalNumber(
  value: unknown,
  field: string,
  maximum: number,
): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw new HttpError(400, "invalid_request", `${field} is invalid.`);
  }
  return value;
}

function optionalString(value: unknown, field: string, maximumLength: number): string | null {
  if (value === null || value === undefined) return null;
  return requireString(value, field, maximumLength);
}

function uuid(value: unknown, field: string): string {
  const parsed = requireString(value, field, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed)) {
    throw new HttpError(400, "invalid_request", `${field} is invalid.`);
  }
  return parsed;
}

function domain(value: unknown): string {
  const parsed = requireString(value, "domain", 253).toLowerCase().replace(/\.$/, "");
  if (
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
      parsed,
    )
  ) {
    throw new HttpError(400, "invalid_domain", "domain is invalid.");
  }
  return parsed;
}

function uniqueNormalised(values: string[], field: string): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const normalised = normaliseKeyword(value);
    if (seen.has(normalised)) {
      throw new HttpError(400, "duplicate_value", `${field} contains duplicate values.`);
    }
    seen.add(normalised);
  }
  return values;
}

function country(value: unknown): string {
  const parsed = requireString(value, "country", 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(parsed)) {
    throw new HttpError(400, "invalid_request", "country is invalid.");
  }
  return parsed;
}

function currency(value: unknown): string {
  const parsed = requireString(value, "currency", 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(parsed)) {
    throw new HttpError(400, "invalid_request", "currency is invalid.");
  }
  return parsed;
}

function isConflict(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}

async function clientAccess(
  client: PoolClient | DatabasePool,
  userId: string,
  clientId: string,
): Promise<AccessRow> {
  const result = await client.query<AccessRow>(
    `
      SELECT access_role
      FROM user_client_access
      WHERE user_id = $1
        AND client_id = $2
    `,
    [userId, clientId],
  );
  const access = result.rows[0];
  if (!access) {
    throw new HttpError(404, "client_not_found", "Client not found.");
  }
  return access;
}

function requireWriteAccess(access: AccessRow): void {
  if (access.access_role === "viewer") {
    throw new HttpError(403, "write_access_required", "Write access is required.");
  }
}

export async function assertProjectAccess(
  client: PoolClient | DatabasePool,
  userId: string,
  projectId: string,
  write = false,
): Promise<ProjectAccessRow> {
  const project = await assertProjectAccessByRole(client, userId, projectId, write);
  return {
    access_role: write ? "editor" : "viewer",
    client_id: project.client_id,
  };
}

function parseRules(value: unknown): Array<{ type: RuleType; value: string }> {
  const record = bodyRecord(value);
  const definitions: Array<{
    field: string;
    type: RuleType;
  }> = [
    { field: "whitelist", type: "whitelist" },
    { field: "blacklist", type: "blacklist" },
    { field: "ownBrands", type: "own_brand" },
    { field: "competitorBrands", type: "competitor_brand" },
    { field: "relevantTerms", type: "relevant_term" },
  ];
  const rules: Array<{ type: RuleType; value: string }> = [];
  for (const definition of definitions) {
    const values = uniqueNormalised(
      valueArray(record[definition.field] ?? [], definition.field, 1_000).map(
        (item, index) =>
          requireString(item, `${definition.field}[${index}]`, 200),
      ),
      definition.field,
    );
    rules.push(...values.map((item) => ({ type: definition.type, value: item })));
  }
  return rules;
}

async function insertRules(
  client: PoolClient,
  projectId: string,
  rules: Array<{ type: RuleType; value: string }>,
): Promise<void> {
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
      [randomUUID(), projectId, rule.type, rule.value, normaliseKeyword(rule.value)],
    );
  }
}

export async function createClient(
  pool: DatabasePool,
  user: AuthenticatedUser,
  body: unknown,
): Promise<Record<string, unknown>> {
  const record = bodyRecord(body);
  const id = randomUUID();
  const companyName = requireString(record.companyName, "companyName", 200);
  const clientDomain = domain(record.domain);
  const industry = requireString(record.industry, "industry", 200);
  const brandTerms = uniqueNormalised(
    valueArray(record.brandTerms ?? [], "brandTerms", 1_000).map((item, index) =>
      requireString(item, `brandTerms[${index}]`, 200),
    ),
    "brandTerms",
  );

  try {
    await withTransaction(pool, async (client) => {
      await client.query(
        `
          INSERT INTO clients (
            id,
            company_name,
            domain,
            industry,
            brand_terms,
            created_by
          )
          VALUES ($1, $2, $3, $4, $5::text[], $6)
        `,
        [id, companyName, clientDomain, industry, brandTerms, user.id],
      );
      await client.query(
        `
          INSERT INTO user_client_access (user_id, client_id, access_role)
          VALUES ($1, $2, 'owner')
        `,
        [user.id, id],
      );
    });
  } catch (error) {
    if (isConflict(error)) {
      throw new HttpError(409, "client_conflict", "A client with this domain already exists.");
    }
    throw error;
  }

  return { brandTerms, companyName, domain: clientDomain, id, industry };
}

export async function createProject(
  pool: DatabasePool,
  user: AuthenticatedUser,
  clientId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const record = bodyRecord(body);
  const rules = parseRules(record.rules ?? {});
  const id = randomUUID();
  const name = requireString(record.name, "name", 200);
  const projectCountry = country(record.country);
  const language = requireString(record.language, "language", 32).toLowerCase();
  const projectCurrency = currency(record.currency);
  const categoryFocus = requireString(record.categoryFocus, "categoryFocus", 200);
  const authority = bodyRecord(record.authority ?? {});
  const domainRating = optionalNumber(authority.domainRating, "authority.domainRating", 100) ?? 0;
  const referringDomains =
    optionalNumber(authority.referringDomains, "authority.referringDomains", 2_147_483_647) ?? 0;
  const backlinks =
    optionalNumber(authority.backlinks, "authority.backlinks", Number.MAX_SAFE_INTEGER) ?? 0;
  const economics = bodyRecord(record.economics ?? {});
  const conversionRate = optionalNumber(
    economics.conversionRate,
    "economics.conversionRate",
    1,
  );
  const averageOrderValue = optionalNumber(
    economics.averageOrderValue,
    "economics.averageOrderValue",
    Number.MAX_SAFE_INTEGER,
  );
  const gscWindowDays =
    optionalNumber(
      economics.gscWindowDays,
      "economics.gscWindowDays",
      3_650,
    ) ?? 30;
  if (!Number.isInteger(gscWindowDays) || gscWindowDays < 1) {
    throw new HttpError(
      400,
      "invalid_request",
      "economics.gscWindowDays must be a positive integer.",
    );
  }

  try {
    await withTransaction(pool, async (client) => {
      await assertClientAccess(client, user.id, clientId, true);
      await client.query(
        `
          INSERT INTO navigator_projects (
            id,
            client_id,
            project_name,
            country,
            language,
            currency,
            category_focus,
            authority_domain_rating,
            authority_referring_domains,
            authority_backlinks,
            conversion_rate,
            aov,
            gsc_window_days
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        `,
        [
          id,
          clientId,
          name,
          projectCountry,
          language,
          projectCurrency,
          categoryFocus,
          domainRating,
          referringDomains,
          backlinks,
          conversionRate,
          averageOrderValue,
          gscWindowDays,
        ],
      );
      await insertRules(client, id, rules);
    });
  } catch (error) {
    if (isConflict(error)) {
      throw new HttpError(409, "project_conflict", "A project with this name already exists.");
    }
    throw error;
  }

  return {
    categoryFocus,
    clientId,
    country: projectCountry,
    currency: projectCurrency,
    id,
    economics: {
      averageOrderValue,
      conversionRate,
      gscWindowDays,
    },
    language,
    name,
    ruleCount: rules.length,
  };
}

export async function replaceProjectRules(
  pool: DatabasePool,
  user: AuthenticatedUser,
  projectId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const rules = parseRules(body);
  await withTransaction(pool, async (client) => {
    await assertProjectAccess(client, user.id, projectId, true);
    await client.query("DELETE FROM project_keyword_rules WHERE project_id = $1", [projectId]);
    await insertRules(client, projectId, rules);
  });
  return { projectId, ruleCount: rules.length };
}

interface ParsedKeyword {
  avgMonthlyVolume: number | null;
  id: string;
  keywordDifficulty: number | null;
  priority: 1 | 2 | 3 | null;
  rankingUrl: string | null;
  seedTags: string[];
  text: string;
}

function parseKeywords(value: unknown): ParsedKeyword[] {
  const record = bodyRecord(value);
  const keywords = valueArray(record.keywords, "keywords", 50_000).map((item, index) => {
    const keyword = bodyRecord(item);
    const priority = optionalNumber(
      keyword.priority,
      `keywords[${index}].priority`,
      3,
    );
    if (
      priority !== null &&
      (!Number.isInteger(priority) || priority < 1)
    ) {
      throw new HttpError(
        400,
        "invalid_request",
        `keywords[${index}].priority is invalid.`,
      );
    }
    return {
      avgMonthlyVolume: optionalNumber(
        keyword.avgMonthlyVolume,
        `keywords[${index}].avgMonthlyVolume`,
        2_147_483_647,
      ),
      id:
        keyword.id === undefined
          ? randomUUID()
          : uuid(keyword.id, `keywords[${index}].id`),
      keywordDifficulty: optionalNumber(
        keyword.keywordDifficulty,
        `keywords[${index}].keywordDifficulty`,
        100,
      ),
      priority: priority as ParsedKeyword["priority"],
      rankingUrl: optionalString(
        keyword.rankingUrl,
        `keywords[${index}].rankingUrl`,
        2_048,
      ),
      seedTags: uniqueNormalised(
        valueArray(
          keyword.seedTags ?? [],
          `keywords[${index}].seedTags`,
          3,
        ).map((tag, tagIndex) =>
          requireString(
            tag,
            `keywords[${index}].seedTags[${tagIndex}]`,
            200,
          ),
        ),
        `keywords[${index}].seedTags`,
      ),
      text: requireString(keyword.text, `keywords[${index}].text`, 200),
    };
  });
  uniqueNormalised(
    keywords.map((keyword) => keyword.text),
    "keywords",
  );
  return keywords;
}

export async function addProjectKeywords(
  pool: DatabasePool,
  user: AuthenticatedUser,
  projectId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const keywords = parseKeywords(body);
  let insertedKeywordCount = 0;
  try {
    await withTransaction(pool, async (client) => {
      await assertProjectAccess(client, user.id, projectId, true);
      const result = await client.query(
        `
          INSERT INTO keywords (
            id,
            project_id,
            keyword,
            normalised_keyword,
            sources,
            avg_monthly_volume,
            keyword_difficulty,
            keyword_priority,
            ranking_url,
            category,
            tags,
            categorisation_tier,
            categorisation_source
          )
          SELECT
            input.id,
            $1,
            input.keyword,
            input.normalised_keyword,
            ARRAY['source']::text[],
            input.avg_monthly_volume,
            input.keyword_difficulty,
            input.keyword_priority,
            input.ranking_url,
            input.category,
            input.tags,
            CASE WHEN input.category IS NULL THEN NULL ELSE 'live' END,
            CASE WHEN input.category IS NULL THEN NULL ELSE 'client_supplied' END
          FROM jsonb_to_recordset($2::jsonb) AS input(
            id uuid,
            keyword text,
            normalised_keyword text,
            avg_monthly_volume integer,
            keyword_difficulty numeric,
            keyword_priority integer,
            ranking_url text,
            category text,
            tags text[]
          )
          ON CONFLICT (project_id, normalised_keyword)
          DO NOTHING
          RETURNING id
        `,
        [
          projectId,
          JSON.stringify(
            keywords.map((keyword) => ({
              avg_monthly_volume: keyword.avgMonthlyVolume,
              id: keyword.id,
              keyword: keyword.text,
              keyword_difficulty: keyword.keywordDifficulty,
              keyword_priority: keyword.priority,
              normalised_keyword: normaliseKeyword(keyword.text),
              ranking_url: keyword.rankingUrl,
              category: keyword.seedTags[0] ?? null,
              tags: keyword.seedTags,
            })),
          ),
        ],
      );
      insertedKeywordCount = result.rowCount ?? 0;
      await client.query(
        `
          UPDATE navigator_projects
          SET
            keywords_dirty = true,
            last_dirty_at = now(),
            updated_at = now()
          WHERE id = $1
        `,
        [projectId],
      );
    });
  } catch (error) {
    if (isConflict(error)) {
      throw new HttpError(
        409,
        "keyword_id_conflict",
        "A keyword ID already belongs to another record.",
      );
    }
    throw error;
  }
  return {
    acceptedKeywordCount: keywords.length,
    insertedKeywordCount,
    projectId,
    skippedDuplicateCount: keywords.length - insertedKeywordCount,
  };
}

export interface ProjectKeywordQuery {
  categorisedOnly?: boolean;
  detoxStatus?: string | null;
  direction?: string | null;
  limit?: string | null;
  offset?: string | null;
  rankingUrlOnly?: boolean;
  search?: string | null;
  sort?: string | null;
}

function parseKeywordQuery(query: ProjectKeywordQuery): {
  categorisedOnly: boolean;
  detoxStatus: "keep" | "pending" | "remove" | "review" | null;
  direction: "ASC" | "DESC";
  limit: number;
  offset: number;
  rankingUrlOnly: boolean;
  search: string;
  sortColumn: string;
} {
  const limit = Number(query.limit ?? "200");
  const offset = Number(query.offset ?? "0");
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1_000 ||
    !Number.isInteger(offset) ||
    offset < 0
  ) {
    throw new HttpError(
      400,
      "invalid_request",
      "Keyword pagination parameters are invalid.",
    );
  }
  const search = (query.search ?? "").trim();
  if (search.length > 200) {
    throw new HttpError(400, "invalid_request", "Keyword search is invalid.");
  }
  const rawStatus =
    query.detoxStatus === "removed" ? "remove" : query.detoxStatus;
  const detoxStatus =
    !rawStatus || rawStatus === "all"
      ? null
      : rawStatus;
  if (
    detoxStatus !== null &&
    detoxStatus !== "keep" &&
    detoxStatus !== "pending" &&
    detoxStatus !== "remove" &&
    detoxStatus !== "review"
  ) {
    throw new HttpError(
      400,
      "invalid_request",
      "Keyword detox status is invalid.",
    );
  }
  const sortColumns: Record<string, string> = {
    baseRank: "base_rank",
    keyword: "normalised_keyword",
    rankingUrl: "ranking_url",
    volume: "avg_monthly_volume",
  };
  const sortColumn = sortColumns[query.sort ?? "keyword"];
  if (!sortColumn) {
    throw new HttpError(400, "invalid_request", "Keyword sort is invalid.");
  }
  const rawDirection = (query.direction ?? "asc").toLowerCase();
  if (rawDirection !== "asc" && rawDirection !== "desc") {
    throw new HttpError(
      400,
      "invalid_request",
      "Keyword sort direction is invalid.",
    );
  }
  return {
    categorisedOnly: query.categorisedOnly === true,
    detoxStatus,
    direction: rawDirection === "desc" ? "DESC" : "ASC",
    limit,
    offset,
    rankingUrlOnly: query.rankingUrlOnly === true,
    search,
    sortColumn,
  };
}

export async function getProjectKeywords(
  pool: DatabasePool,
  user: AuthenticatedUser,
  projectId: string,
  query: ProjectKeywordQuery,
): Promise<Record<string, unknown>> {
  await assertProjectAccess(pool, user.id, projectId);
  const parsed = parseKeywordQuery(query);
  const predicate = `
    project_id = $1
    AND ($2::text = '' OR keyword ILIKE '%' || $2 || '%')
    AND ($3::text IS NULL OR detox_status = $3)
    AND (NOT $4::boolean OR ranking_url IS NOT NULL)
    AND (NOT $5::boolean OR category IS NOT NULL)
  `;
  const parameters = [
    projectId,
    parsed.search,
    parsed.detoxStatus,
    parsed.rankingUrlOnly,
    parsed.categorisedOnly,
  ];
  const [itemsResult, aggregateResult] = await Promise.all([
    pool.query<KeywordManagementRow>(
      `
        SELECT
          id,
          keyword,
          detox_status,
          detox_reason,
          detox_rule,
          device,
          human_reviewed,
          category,
          tags,
          search_intent,
          intent_confidence,
          intent_source,
          categorisation_tier,
          categorisation_source,
          categorisation_status,
          keyword_difficulty,
          keyword_priority,
          avg_monthly_volume,
          competition,
          ranking_url,
          base_rank
        FROM keywords
        WHERE ${predicate}
        ORDER BY ${parsed.sortColumn} ${parsed.direction} NULLS LAST, id
        LIMIT $6 OFFSET $7
      `,
      [...parameters, parsed.limit, parsed.offset],
    ),
    pool.query<KeywordAggregateRow>(
      `
        SELECT
          count(*)::text AS total_count,
          count(*) FILTER (WHERE detox_status = 'pending')::text AS pending_count,
          count(*) FILTER (WHERE detox_status = 'keep')::text AS keep_count,
          count(*) FILTER (WHERE detox_status = 'remove')::text AS remove_count,
          count(*) FILTER (WHERE detox_status = 'review')::text AS review_count,
          count(*) FILTER (WHERE category IS NOT NULL)::text AS categorised_count,
          count(*) FILTER (WHERE ranking_url IS NOT NULL)::text AS ranking_url_count
        FROM keywords
        WHERE
          project_id = $1
          AND ($2::text = '' OR keyword ILIKE '%' || $2 || '%')
          AND (NOT $3::boolean OR ranking_url IS NOT NULL)
          AND (NOT $4::boolean OR category IS NOT NULL)
      `,
      [
        projectId,
        parsed.search,
        parsed.rankingUrlOnly,
        parsed.categorisedOnly,
      ],
    ),
  ]);
  const keywordIds = itemsResult.rows.map((item) => item.id);
  const monthlyResult =
    keywordIds.length === 0
      ? { rows: [] as KeywordMonthlyVolumeRow[] }
      : await pool.query<KeywordMonthlyVolumeRow>(
          `
            SELECT keyword_id, month, volume
            FROM keyword_monthly_volumes
            WHERE keyword_id = ANY($1::uuid[])
            UNION ALL
            SELECT
              keyword.id AS keyword_id,
              provider.month,
              provider.volume
            FROM local_provider_keyword_monthly_volumes AS provider
            JOIN keywords AS keyword
              ON keyword.project_id = provider.project_id
             AND keyword.normalised_keyword = provider.normalised_keyword
            WHERE keyword.id = ANY($1::uuid[])
              AND NOT EXISTS (
                SELECT 1
                FROM keyword_monthly_volumes AS migrated
                WHERE migrated.keyword_id = keyword.id
                  AND migrated.month = provider.month
              )
            ORDER BY keyword_id, month
          `,
          [keywordIds],
        );
  const monthlyByKeyword = new Map<
    string,
    Array<{ month: string; volume: number }>
  >();
  for (const row of monthlyResult.rows) {
    const values = monthlyByKeyword.get(row.keyword_id) ?? [];
    values.push({
      month: row.month.toISOString().slice(0, 10),
      volume: row.volume,
    });
    monthlyByKeyword.set(row.keyword_id, values);
  }
  const aggregate = aggregateResult.rows[0];
  return {
    filterCounts: {
      all: Number(aggregate?.total_count ?? "0"),
      keep: Number(aggregate?.keep_count ?? "0"),
      pending: Number(aggregate?.pending_count ?? "0"),
      remove: Number(aggregate?.remove_count ?? "0"),
      removed: Number(aggregate?.remove_count ?? "0"),
      review: Number(aggregate?.review_count ?? "0"),
    },
    items: itemsResult.rows.map((keyword) => ({
      avgMonthlyVolume: keyword.avg_monthly_volume,
      baseRank: keyword.base_rank,
      categorisationSource: keyword.categorisation_source,
      categorisationStatus: keyword.categorisation_status,
      categorisationTier: keyword.categorisation_tier,
      category: keyword.category,
      competition: keyword.competition,
      detoxReason: keyword.detox_reason,
      detoxRule: keyword.detox_rule,
      detoxStatus: keyword.detox_status,
      device: keyword.device,
      humanReviewed: keyword.human_reviewed,
      id: keyword.id,
      intentConfidence: keyword.intent_confidence,
      intentSource: keyword.intent_source,
      keywordDifficulty:
        keyword.keyword_difficulty === null
          ? null
          : Number(keyword.keyword_difficulty),
      keywordPriority: keyword.keyword_priority,
      monthlyVolumes: monthlyByKeyword.get(keyword.id) ?? [],
      rankingUrl: keyword.ranking_url,
      searchIntent: keyword.search_intent,
      tags: keyword.tags ?? [],
      text: keyword.keyword,
    })),
    limit: parsed.limit,
    offset: parsed.offset,
    projectId,
    summary: {
      categorised: Number(aggregate?.categorised_count ?? "0"),
      rankingUrls: Number(aggregate?.ranking_url_count ?? "0"),
    },
    total:
      parsed.detoxStatus === "keep"
        ? Number(aggregate?.keep_count ?? "0")
        : parsed.detoxStatus === "pending"
          ? Number(aggregate?.pending_count ?? "0")
          : parsed.detoxStatus === "remove"
            ? Number(aggregate?.remove_count ?? "0")
            : parsed.detoxStatus === "review"
              ? Number(aggregate?.review_count ?? "0")
              : Number(aggregate?.total_count ?? "0"),
  };
}

interface ParsedKeywordMutation {
  action: "delete" | "updateDetox" | "updatePriority";
  detoxStatus: "keep" | "pending" | "remove" | "review" | null;
  ids: string[] | null;
  priority: 1 | 2 | 3 | null;
  predicate: {
    detoxStatus: "keep" | "pending" | "remove" | "review" | null;
    search: string;
  } | null;
}

function parseKeywordMutation(value: unknown): ParsedKeywordMutation {
  const record = bodyRecord(value);
  const action = requireString(record.action, "action", 32);
  if (
    action !== "delete" &&
    action !== "updateDetox" &&
    action !== "updatePriority"
  ) {
    throw new HttpError(400, "invalid_request", "Keyword action is invalid.");
  }
  const ids =
    record.ids === undefined
      ? null
      : valueArray(record.ids, "ids", 50_000).map((id, index) =>
          uuid(id, `ids[${index}]`),
        );
  const predicate =
    record.predicate === undefined
      ? null
      : (() => {
          const input = bodyRecord(record.predicate);
          const search = optionalString(input.search, "predicate.search", 200) ?? "";
          const rawStatus =
            input.detoxStatus === "removed" ? "remove" : input.detoxStatus;
          const detoxStatus =
            rawStatus === undefined ||
            rawStatus === null ||
            rawStatus === "all"
              ? null
              : requireString(rawStatus, "predicate.detoxStatus", 16);
          if (
            detoxStatus !== null &&
            detoxStatus !== "keep" &&
            detoxStatus !== "pending" &&
            detoxStatus !== "remove" &&
            detoxStatus !== "review"
          ) {
            throw new HttpError(
              400,
              "invalid_request",
              "Keyword predicate status is invalid.",
            );
          }
          const parsedDetoxStatus = detoxStatus as
            | "keep"
            | "pending"
            | "remove"
            | "review"
            | null;
          return {
            detoxStatus: parsedDetoxStatus,
            search: search.trim(),
          };
        })();
  if (
    (ids === null && predicate === null) ||
    (ids !== null && predicate !== null) ||
    (ids !== null && ids.length === 0)
  ) {
    throw new HttpError(
      400,
      "invalid_request",
      "Specify either keyword IDs or one matching predicate.",
    );
  }
  const rawDetoxStatus =
    record.detoxStatus === "removed" ? "remove" : record.detoxStatus;
  const detoxStatus =
    action === "updateDetox"
      ? requireString(rawDetoxStatus, "detoxStatus", 16)
      : null;
  if (
    detoxStatus !== null &&
    detoxStatus !== "keep" &&
    detoxStatus !== "pending" &&
    detoxStatus !== "remove" &&
    detoxStatus !== "review"
  ) {
    throw new HttpError(
      400,
      "invalid_request",
      "Keyword detox status is invalid.",
    );
  }
  const priority =
    action === "updatePriority"
      ? record.priority === null
        ? null
        : record.priority
      : null;
  if (
    priority !== null &&
    priority !== 1 &&
    priority !== 2 &&
    priority !== 3
  ) {
    throw new HttpError(
      400,
      "invalid_request",
      "Keyword priority is invalid.",
    );
  }
  return {
    action,
    detoxStatus,
    ids,
    predicate,
    priority,
  };
}

export async function mutateProjectKeywords(
  pool: DatabasePool,
  user: AuthenticatedUser,
  projectId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const mutation = parseKeywordMutation(body);
  let affectedKeywordCount = 0;
  await withTransaction(pool, async (client) => {
    await assertProjectAccess(client, user.id, projectId, true);
    const targetPredicate =
      mutation.ids !== null
        ? "project_id = $1 AND id = ANY($2::uuid[])"
        : `
            project_id = $1
            AND ($2::text = '' OR keyword ILIKE '%' || $2 || '%')
            AND ($3::text IS NULL OR detox_status = $3)
          `;
    const parameters: unknown[] =
      mutation.ids !== null
        ? [projectId, mutation.ids]
        : [
            projectId,
            mutation.predicate?.search ?? "",
            mutation.predicate?.detoxStatus ?? null,
          ];
    const result =
      mutation.action === "delete"
        ? await client.query(
            `DELETE FROM keywords WHERE ${targetPredicate}`,
            parameters,
          )
        : mutation.action === "updateDetox"
          ? await client.query(
              `
                UPDATE keywords
                SET
                  detox_status = $${parameters.length + 1},
                  human_reviewed = true,
                  categorisation_status = CASE
                    WHEN $${parameters.length + 1} = 'keep' AND category IS NOT NULL
                      THEN 'done'
                    WHEN $${parameters.length + 1} = 'keep'
                      THEN 'pending'
                    WHEN $${parameters.length + 1} IN ('remove', 'review')
                      THEN 'skipped'
                    ELSE categorisation_status
                  END,
                  updated_at = now()
                WHERE ${targetPredicate}
              `,
              [...parameters, mutation.detoxStatus],
            )
          : await client.query(
              `
                UPDATE keywords
                SET
                  keyword_priority = $${parameters.length + 1},
                  updated_at = now()
                WHERE ${targetPredicate}
              `,
              [...parameters, mutation.priority],
            );
    affectedKeywordCount = result.rowCount ?? 0;
    if (affectedKeywordCount > 0) {
      await client.query(
        `
          UPDATE navigator_projects
          SET
            keywords_dirty = true,
            last_dirty_at = now(),
            updated_at = now()
          WHERE id = $1
        `,
        [projectId],
      );
    }
  });
  return {
    action: mutation.action,
    affectedKeywordCount,
    detoxStatus: mutation.detoxStatus,
    priority: mutation.priority,
    projectId,
  };
}

interface ParsedGscRow {
  clicks: number;
  ctr: number;
  device: "all" | "desktop" | "mobile" | "tablet";
  id: string;
  impressions: number;
  page: string;
  position: number;
  query: string;
}

interface ParsedGscPage {
  clicks: number;
  ctr: number;
  device: ParsedGscRow["device"];
  id: string;
  impressions: number;
  pageUrl: string;
  position: number;
}

interface ParsedGscImport {
  dateRangeEnd: string | null;
  dateRangeStart: string | null;
  device: "all" | "desktop" | "mixed" | "mobile" | "tablet";
  originalFilename: string | null;
  pages: ParsedGscPage[];
  rows: ParsedGscRow[];
  sheetsSeen: string[];
  sourceName: string;
  warnings: string[];
}

function dateString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  const parsed = requireString(value, field, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed)) {
    throw new HttpError(400, "invalid_request", `${field} is invalid.`);
  }
  const date = new Date(`${parsed}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== parsed) {
    throw new HttpError(400, "invalid_request", `${field} is invalid.`);
  }
  return parsed;
}

function metric(
  record: Record<string, unknown>,
  field: string,
  path: string,
  maximum: number,
): number {
  const parsed = optionalNumber(record[field], `${path}.${field}`, maximum);
  if (parsed === null) {
    throw new HttpError(400, "invalid_request", `${path}.${field} is required.`);
  }
  return parsed;
}

function gscDevice(
  value: unknown,
  field: string,
): ParsedGscRow["device"] {
  const device = requireString(value, field, 10);
  if (!["all", "desktop", "mobile", "tablet"].includes(device)) {
    throw new HttpError(400, "invalid_request", `${field} is invalid.`);
  }
  return device as ParsedGscRow["device"];
}

function parseGscRows(value: unknown): ParsedGscImport {
  const record = bodyRecord(value);
  const sourceName = requireString(record.sourceName, "sourceName", 200);
  const rows = valueArray(record.rows, "rows", 50_000).map((item, index) => {
    const row = bodyRecord(item);
    const path = `rows[${index}]`;
    return {
      clicks: metric(row, "clicks", path, 2_147_483_647),
      ctr: metric(row, "ctr", path, 1),
      device: gscDevice(row.device, `${path}.device`),
      id: randomUUID(),
      impressions: metric(row, "impressions", path, 2_147_483_647),
      page:
        row.page === undefined || row.page === null || row.page === ""
          ? ""
          : requireString(row.page, `${path}.page`, 2_048),
      position: metric(row, "position", path, 1_000),
      query: requireString(row.query, `${path}.query`, 200),
    };
  });
  const pages = valueArray(record.pages ?? [], "pages", 50_000).map(
    (item, index) => {
      const page = bodyRecord(item);
      const path = `pages[${index}]`;
      return {
        clicks: metric(page, "clicks", path, 2_147_483_647),
        ctr: metric(page, "ctr", path, 1),
        device: gscDevice(page.device, `${path}.device`),
        id: randomUUID(),
        impressions: metric(page, "impressions", path, 2_147_483_647),
        pageUrl: requireString(page.pageUrl, `${path}.pageUrl`, 2_048),
        position: metric(page, "position", path, 1_000),
      };
    },
  );
  const uniqueRows = new Set(
    rows.map(
      (row) =>
        `${normaliseKeyword(row.query)}\u0000${row.page}\u0000${row.device}`,
    ),
  );
  if (uniqueRows.size !== rows.length) {
    throw new HttpError(400, "duplicate_gsc_row", "rows contains duplicate GSC entries.");
  }
  const uploadDevice = optionalString(record.device, "device", 10) ?? "all";
  if (!["all", "desktop", "mixed", "mobile", "tablet"].includes(uploadDevice)) {
    throw new HttpError(400, "invalid_request", "device is invalid.");
  }
  const dateRangeStart = dateString(record.dateRangeStart, "dateRangeStart");
  const dateRangeEnd = dateString(record.dateRangeEnd, "dateRangeEnd");
  if ((dateRangeStart === null) !== (dateRangeEnd === null)) {
    throw new HttpError(
      400,
      "invalid_request",
      "dateRangeStart and dateRangeEnd must be provided together.",
    );
  }
  if (
    dateRangeStart !== null &&
    dateRangeEnd !== null &&
    dateRangeStart > dateRangeEnd
  ) {
    throw new HttpError(
      400,
      "invalid_request",
      "dateRangeStart must not be after dateRangeEnd.",
    );
  }
  return {
    dateRangeEnd,
    dateRangeStart,
    device: uploadDevice as ParsedGscImport["device"],
    originalFilename:
      optionalString(record.originalFilename, "originalFilename", 255),
    pages,
    rows,
    sheetsSeen: valueArray(record.sheetsSeen ?? [], "sheetsSeen", 100).map(
      (sheet, index) =>
        requireString(sheet, `sheetsSeen[${index}]`, 100),
    ),
    sourceName,
    warnings: valueArray(record.warnings ?? [], "warnings", 100).map(
      (warning, index) =>
        requireString(warning, `warnings[${index}]`, 500),
    ),
  };
}

export async function importProjectGscRows(
  pool: DatabasePool,
  user: AuthenticatedUser,
  projectId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const parsed = parseGscRows(body);
  const { pages, rows, sourceName } = parsed;
  const uploadId = randomUUID();
  await withTransaction(pool, async (client) => {
    await assertProjectAccess(client, user.id, projectId, true);
    await client.query(
      `
        INSERT INTO gsc_uploads (
          id,
          project_id,
          source_name,
          row_count,
          date_range_end,
          date_range_start,
          device,
          original_filename
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        uploadId,
        projectId,
        sourceName,
        rows.length,
        parsed.dateRangeEnd,
        parsed.dateRangeStart,
        parsed.device,
        parsed.originalFilename,
      ],
    );
    for (const row of rows) {
      await client.query(
        `
          INSERT INTO gsc_upload_keywords (
            id,
            upload_id,
            query,
            normalised_query,
            page,
            device,
            clicks,
            impressions,
            ctr,
            position
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `,
        [
          row.id,
          uploadId,
          row.query,
          normaliseKeyword(row.query),
          row.page,
          row.device,
          row.clicks,
          row.impressions,
          row.ctr,
          row.position,
        ],
      );
    }
    for (const page of pages) {
      await client.query(
        `
          INSERT INTO gsc_upload_pages (
            id,
            upload_id,
            page_url,
            device,
            clicks,
            impressions,
            ctr,
            position
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          page.id,
          uploadId,
          page.pageUrl,
          page.device,
          page.clicks,
          page.impressions,
          page.ctr,
          page.position,
        ],
      );
    }
    await client.query(
      `
        UPDATE navigator_projects
        SET
          keywords_dirty = true,
          inputs_dirty = true,
          last_dirty_at = now(),
          updated_at = now()
        WHERE id = $1
      `,
      [projectId],
    );
  });
  return {
    date_range_end: parsed.dateRangeEnd,
    date_range_start: parsed.dateRangeStart,
    pages_inserted: pages.length,
    projectId,
    row_count: rows.length,
    sheets_seen: parsed.sheetsSeen,
    source: sourceName,
    upload_device: parsed.device,
    upload_id: uploadId,
    warnings: parsed.warnings,
  };
}

export async function replaceLocalProviderInputs(
  pool: DatabasePool,
  user: AuthenticatedUser,
  projectId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const record = bodyRecord(body);
  const inputs = valueArray(record.keywords, "keywords", 50_000).map(
    (item, index) => {
      const keyword = bodyRecord(item);
      const intent = optionalString(
        keyword.intent,
        `keywords[${index}].intent`,
        20,
      );
      if (
        intent !== null &&
        !["transactional", "commercial", "informational", "navigational"].includes(
          intent,
        )
      ) {
        throw new HttpError(
          400,
          "invalid_request",
          `keywords[${index}].intent is invalid.`,
        );
      }
      const monthlyVolumes = valueArray(
        keyword.monthlyVolumes ?? [],
        `keywords[${index}].monthlyVolumes`,
        1_200,
      ).map((pointValue, pointIndex) => {
        const point = bodyRecord(pointValue);
        const path = `keywords[${index}].monthlyVolumes[${pointIndex}]`;
        const month = requireString(point.month, `${path}.month`, 10);
        if (!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(month)) {
          throw new HttpError(
            400,
            "invalid_request",
            `${path}.month must be a month-start date.`,
          );
        }
        const volume = optionalNumber(
          point.volume,
          `${path}.volume`,
          2_147_483_647,
        );
        if (volume === null || !Number.isInteger(volume)) {
          throw new HttpError(
            400,
            "invalid_request",
            `${path}.volume must be an integer.`,
          );
        }
        return { month, volume };
      });
      if (
        new Set(monthlyVolumes.map((point) => point.month)).size !==
        monthlyVolumes.length
      ) {
        throw new HttpError(
          400,
          "duplicate_value",
          `keywords[${index}].monthlyVolumes contains duplicate months.`,
        );
      }
      return {
        avgMonthlyVolume: optionalNumber(
          keyword.avgMonthlyVolume,
          `keywords[${index}].avgMonthlyVolume`,
          2_147_483_647,
        ),
        intent,
        keywordDifficulty: optionalNumber(
          keyword.keywordDifficulty,
          `keywords[${index}].keywordDifficulty`,
          100,
        ),
        monthlyVolumes,
        rank: optionalNumber(keyword.rank, `keywords[${index}].rank`, 1_000),
        rankingUrl: optionalString(
          keyword.rankingUrl,
          `keywords[${index}].rankingUrl`,
          2_048,
        ),
        text: requireString(keyword.text, `keywords[${index}].text`, 200),
      };
    },
  );
  uniqueNormalised(
    inputs.map((input) => input.text),
    "keywords",
  );
  const serpInputs = valueArray(
    record.serpKeywords ?? [],
    "serpKeywords",
    50_000,
  ).map((item, keywordIndex) => {
    const keyword = bodyRecord(item);
    const results = valueArray(
      keyword.results,
      `serpKeywords[${keywordIndex}].results`,
      100,
    ).map((resultValue, resultIndex) => {
      const result = bodyRecord(resultValue);
      const path = `serpKeywords[${keywordIndex}].results[${resultIndex}]`;
      const rankAbsolute = optionalNumber(
        result.rankAbsolute,
        `${path}.rankAbsolute`,
        100,
      );
      if (
        rankAbsolute === null ||
        !Number.isInteger(rankAbsolute) ||
        rankAbsolute < 1
      ) {
        throw new HttpError(
          400,
          "invalid_request",
          `${path}.rankAbsolute is invalid.`,
        );
      }
      const url = requireString(result.url, `${path}.url`, 2_048);
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        throw new HttpError(400, "invalid_request", `${path}.url is invalid.`);
      }
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        throw new HttpError(400, "invalid_request", `${path}.url is invalid.`);
      }
      const resultDomain = requireString(
        result.domain,
        `${path}.domain`,
        253,
      )
        .toLowerCase()
        .replace(/^www\./, "");
      const urlDomain = parsedUrl.hostname.toLowerCase().replace(/^www\./, "");
      if (resultDomain !== urlDomain) {
        throw new HttpError(
          400,
          "invalid_request",
          `${path}.domain does not match the URL.`,
        );
      }
      return {
        ahrefsRank: optionalNumber(
          result.ahrefsRank,
          `${path}.ahrefsRank`,
          Number.MAX_SAFE_INTEGER,
        ),
        backlinks: optionalNumber(
          result.backlinks,
          `${path}.backlinks`,
          Number.MAX_SAFE_INTEGER,
        ),
        domain: resultDomain,
        domainRating: optionalNumber(
          result.domainRating,
          `${path}.domainRating`,
          100,
        ),
        rankAbsolute,
        referringDomains: optionalNumber(
          result.referringDomains,
          `${path}.referringDomains`,
          Number.MAX_SAFE_INTEGER,
        ),
        url,
        urlRating: optionalNumber(
          result.urlRating,
          `${path}.urlRating`,
          100,
        ),
      };
    });
    if (
      new Set(results.map((result) => result.rankAbsolute)).size !==
        results.length ||
      new Set(results.map((result) => result.url)).size !== results.length
    ) {
      throw new HttpError(
        400,
        "duplicate_value",
        `serpKeywords[${keywordIndex}].results contains duplicate values.`,
      );
    }
    return {
      results,
      text: requireString(
        keyword.text,
        `serpKeywords[${keywordIndex}].text`,
        200,
      ),
    };
  });
  uniqueNormalised(
    serpInputs.map((input) => input.text),
    "serpKeywords",
  );
  const siteArchitectureInputs = valueArray(
    record.siteArchitectureKeywords ?? [],
    "siteArchitectureKeywords",
    50_000,
  ).map((item, index) => {
    const input = bodyRecord(item);
    const path = `siteArchitectureKeywords[${index}]`;
    const contentStatus = requireString(
      input.contentStatus,
      `${path}.contentStatus`,
      10,
    );
    if (!["green", "amber", "red"].includes(contentStatus)) {
      throw new HttpError(
        400,
        "invalid_request",
        `${path}.contentStatus is invalid.`,
      );
    }
    const tacticalStatus = requireString(
      input.tacticalStatus,
      `${path}.tacticalStatus`,
      32,
    );
    if (
      ![
        "create_content",
        "green",
        "new_content",
        "no_action_needed",
        "optimise_content",
      ].includes(tacticalStatus)
    ) {
      throw new HttpError(
        400,
        "invalid_request",
        `${path}.tacticalStatus is invalid.`,
      );
    }
    const relevancyScore = optionalNumber(
      input.relevancyScore,
      `${path}.relevancyScore`,
      100,
    );
    if (relevancyScore === null) {
      throw new HttpError(
        400,
        "invalid_request",
        `${path}.relevancyScore is required.`,
      );
    }
    const matchedUrl = optionalString(
      input.matchedUrl,
      `${path}.matchedUrl`,
      2_048,
    );
    if (matchedUrl !== null) {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(matchedUrl);
      } catch {
        throw new HttpError(
          400,
          "invalid_request",
          `${path}.matchedUrl is invalid.`,
        );
      }
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        throw new HttpError(
          400,
          "invalid_request",
          `${path}.matchedUrl is invalid.`,
        );
      }
    }
    return {
      contentStatus: contentStatus as "amber" | "green" | "red",
      matchedUrl,
      relevancyScore,
      tacticalStatus: tacticalStatus as
        | "create_content"
        | "green"
        | "new_content"
        | "no_action_needed"
        | "optimise_content",
      text: requireString(input.text, `${path}.text`, 200),
    };
  });
  uniqueNormalised(
    siteArchitectureInputs.map((input) => input.text),
    "siteArchitectureKeywords",
  );
  await withTransaction(pool, async (client) => {
    await assertProjectAccess(client, user.id, projectId, true);
    await client.query(
      "DELETE FROM local_provider_keyword_inputs WHERE project_id = $1",
      [projectId],
    );
    await client.query(
      "DELETE FROM local_provider_serp_keywords WHERE project_id = $1",
      [projectId],
    );
    await client.query(
      "DELETE FROM local_provider_site_architecture_inputs WHERE project_id = $1",
      [projectId],
    );
    for (const input of inputs) {
      const normalisedText = normaliseKeyword(input.text);
      await client.query(
        `
          INSERT INTO local_provider_keyword_inputs (
            project_id,
            normalised_keyword,
            keyword,
            avg_monthly_volume,
            keyword_difficulty,
            search_intent,
            ranking_url,
            rank
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          projectId,
          normalisedText,
          input.text,
          input.avgMonthlyVolume,
          input.keywordDifficulty,
          input.intent,
          input.rankingUrl,
          input.rank,
        ],
      );
      for (const point of input.monthlyVolumes) {
        await client.query(
          `
            INSERT INTO local_provider_keyword_monthly_volumes (
              project_id,
              normalised_keyword,
              month,
              volume
            )
            VALUES ($1, $2, $3, $4)
          `,
          [projectId, normalisedText, point.month, point.volume],
        );
      }
    }
    for (const input of serpInputs) {
      const normalisedText = normaliseKeyword(input.text);
      await client.query(
        `
          INSERT INTO local_provider_serp_keywords (
            project_id,
            normalised_keyword,
            keyword
          )
          VALUES ($1, $2, $3)
        `,
        [projectId, normalisedText, input.text],
      );
      for (const result of input.results) {
        await client.query(
          `
            INSERT INTO local_provider_serp_results (
              project_id,
              normalised_keyword,
              rank_absolute,
              url,
              domain,
              url_rating,
              domain_rating,
              ahrefs_rank,
              referring_domains,
              backlinks
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          `,
          [
            projectId,
            normalisedText,
            result.rankAbsolute,
            result.url,
            result.domain,
            result.urlRating,
            result.domainRating,
            result.ahrefsRank,
            result.referringDomains,
            result.backlinks,
          ],
        );
      }
    }
    for (const input of siteArchitectureInputs) {
      await client.query(
        `
          INSERT INTO local_provider_site_architecture_inputs (
            project_id,
            normalised_keyword,
            keyword,
            matched_url,
            relevancy_score,
            content_status,
            tactical_status
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          projectId,
          normaliseKeyword(input.text),
          input.text,
          input.matchedUrl,
          input.relevancyScore,
          input.contentStatus,
          input.tacticalStatus,
        ],
      );
    }
  });
  return {
    inputCount: inputs.length,
    monthlyVolumeCount: inputs.reduce(
      (count, input) => count + input.monthlyVolumes.length,
      0,
    ),
    projectId,
    serpKeywordCount: serpInputs.length,
    serpResultCount: serpInputs.reduce(
      (count, input) => count + input.results.length,
      0,
    ),
    siteArchitectureKeywordCount: siteArchitectureInputs.length,
  };
}

function groupedRules(rows: RuleRow[]): Record<string, string[]> {
  const rules = {
    blacklist: [] as string[],
    competitorBrands: [] as string[],
    ownBrands: [] as string[],
    relevantTerms: [] as string[],
    whitelist: [] as string[],
  };
  for (const row of rows) {
    const field =
      row.rule_type === "competitor_brand"
        ? "competitorBrands"
        : row.rule_type === "own_brand"
          ? "ownBrands"
          : row.rule_type === "relevant_term"
            ? "relevantTerms"
            : row.rule_type;
    rules[field].push(row.value);
  }
  return rules;
}

export async function getProject(
  pool: DatabasePool,
  user: AuthenticatedUser,
  projectId: string,
): Promise<Record<string, unknown>> {
  await assertProjectAccess(pool, user.id, projectId);
  const [
    projectResult,
    keywordResult,
    keywordAggregateResult,
    rulesResult,
    gscCountResult,
    serpCountResult,
    clientMetricResult,
    calculationCountResult,
  ] = await Promise.all([
      pool.query<ProjectRow>(
        `
          SELECT
            project.id,
            project.client_id,
            project.project_name,
            project.country,
            project.language,
            project.currency,
            project.category_focus,
            project.authority_domain_rating,
            project.authority_referring_domains,
            project.authority_backlinks::text,
            project.conversion_rate,
            project.aov,
            project.gsc_window_days,
            project.archived_at,
            project.created_at,
            client.company_name,
            client.domain,
            client.industry,
            client.brand_terms
          FROM navigator_projects AS project
          JOIN clients AS client ON client.id = project.client_id
          WHERE project.id = $1
        `,
        [projectId],
      ),
      pool.query<KeywordRow>(
        `
          SELECT
            id,
            keyword,
            sources,
            avg_monthly_volume,
            keyword_difficulty,
            enrichment_source,
            ranking_url,
            ranking_lookup_no_match,
            base_rank,
            base_rank_source,
            is_branded,
            brand_confidence,
            brand_source,
            brand_matched_term,
            serp_lookup_no_result,
            serp_provider_missing,
            gsc_clicks,
            gsc_impressions,
            gsc_ctr,
            gsc_position,
            gsc_devices,
            detox_status,
            detox_reason,
            detox_rule,
            category,
            tags,
            search_intent,
            categorisation_tier,
            categorisation_source
          FROM keywords
          WHERE project_id = $1
          ORDER BY created_at, id
          LIMIT 1000
        `,
        [projectId],
      ),
      pool.query<KeywordAggregateRow>(
        `
          SELECT
            count(*)::text AS total_count,
            count(*) FILTER (WHERE detox_status = 'pending')::text AS pending_count,
            count(*) FILTER (WHERE detox_status = 'keep')::text AS keep_count,
            count(*) FILTER (WHERE detox_status = 'remove')::text AS remove_count,
            count(*) FILTER (WHERE detox_status = 'review')::text AS review_count,
            count(*) FILTER (WHERE category IS NOT NULL)::text AS categorised_count,
            count(*) FILTER (WHERE ranking_url IS NOT NULL)::text AS ranking_url_count
          FROM keywords
          WHERE project_id = $1
        `,
        [projectId],
      ),
      pool.query<RuleRow>(
        `
          SELECT rule_type, value
          FROM project_keyword_rules
          WHERE project_id = $1
          ORDER BY rule_type, normalised_value
        `,
        [projectId],
      ),
      pool.query<CountRow>(
        `
          SELECT count(*)::text AS count
          FROM gsc_upload_keywords AS keyword
          JOIN gsc_uploads AS upload ON upload.id = keyword.upload_id
          WHERE upload.project_id = $1
        `,
        [projectId],
      ),
      pool.query<CountRow>(
        "SELECT count(*)::text AS count FROM serp_results WHERE project_id = $1",
        [projectId],
      ),
      pool.query<ClientDomainMetricRow>(
        `
          SELECT
            domain,
            url_rating,
            domain_rating,
            ahrefs_rank::text,
            referring_domains::text,
            backlinks::text,
            metric_source,
            fetched_at
          FROM client_domain_metrics
          WHERE project_id = $1
        `,
        [projectId],
      ),
      pool.query<CalculationCountRow>(
        `
          WITH latest_run AS (
            SELECT id
            FROM pipeline_runs
            WHERE input->>'projectId' = $1
              AND status = 'succeeded'
            ORDER BY completed_at DESC, id DESC
            LIMIT 1
          )
          SELECT
            (
              SELECT count(*)::text
              FROM site_architecture
              JOIN latest_run ON latest_run.id = site_architecture.pipeline_run_id
            ) AS site_architecture_count,
            (
              SELECT count(*)::text
              FROM link_power_scores
              JOIN latest_run ON latest_run.id = link_power_scores.pipeline_run_id
            ) AS link_power_score_count,
            (
              SELECT count(*)::text
              FROM keyword_demand_signals
              JOIN latest_run ON latest_run.id = keyword_demand_signals.pipeline_run_id
            ) AS demand_signal_count,
            (
              SELECT count(*)::text
              FROM ctr_curves
              JOIN latest_run ON latest_run.id = ctr_curves.pipeline_run_id
            ) AS ctr_curve_count,
            (
              SELECT count(*)::text
              FROM keyword_clusters
              JOIN latest_run ON latest_run.id = keyword_clusters.pipeline_run_id
            ) AS cluster_count,
            (
              SELECT count(*)::text
              FROM har_forecasts
              JOIN latest_run ON latest_run.id = har_forecasts.pipeline_run_id
            ) AS har_forecast_count,
            (
              SELECT count(*)::text
              FROM revenue_forecasts
              JOIN latest_run ON latest_run.id = revenue_forecasts.pipeline_run_id
            ) AS revenue_forecast_count,
            (
              SELECT count(*)::text
              FROM calibration_snapshots
              JOIN latest_run ON latest_run.id = calibration_snapshots.pipeline_run_id
            ) AS calibration_count
        `,
        [projectId],
      ),
    ]);
  const project = projectResult.rows[0];
  if (!project) {
    throw new HttpError(404, "project_not_found", "Project not found.");
  }

  return {
    authority: {
      backlinks: Number(project.authority_backlinks),
      domainRating: Number(project.authority_domain_rating),
      referringDomains: project.authority_referring_domains,
    },
    categoryFocus: project.category_focus,
    client: {
      brandTerms: project.brand_terms,
      companyName: project.company_name,
      domain: project.domain,
      id: project.client_id,
      industry: project.industry,
    },
    country: project.country,
    createdAt: project.created_at.toISOString(),
    currency: project.currency,
    economics: {
      averageOrderValue:
        project.aov === null
          ? null
          : Number(project.aov),
      conversionRate:
        project.conversion_rate === null
          ? null
          : Number(project.conversion_rate),
      gscWindowDays: project.gsc_window_days,
    },
    calculationCounts: {
      clusters: Number(calculationCountResult.rows[0]?.cluster_count ?? "0"),
      calibrationSnapshots: Number(
        calculationCountResult.rows[0]?.calibration_count ?? "0",
      ),
      ctrCurves: Number(
        calculationCountResult.rows[0]?.ctr_curve_count ?? "0",
      ),
      demandSignals: Number(
        calculationCountResult.rows[0]?.demand_signal_count ?? "0",
      ),
      harForecasts: Number(
        calculationCountResult.rows[0]?.har_forecast_count ?? "0",
      ),
      linkPowerScores: Number(
        calculationCountResult.rows[0]?.link_power_score_count ?? "0",
      ),
      revenueForecasts: Number(
        calculationCountResult.rows[0]?.revenue_forecast_count ?? "0",
      ),
      siteArchitecture: Number(
        calculationCountResult.rows[0]?.site_architecture_count ?? "0",
      ),
    },
    gscRowCount: Number(gscCountResult.rows[0]?.count ?? "0"),
    id: project.id,
    keywordCount: Number(
      keywordAggregateResult.rows[0]?.total_count ?? "0",
    ),
    keywordStatusCounts: {
      categorised: Number(
        keywordAggregateResult.rows[0]?.categorised_count ?? "0",
      ),
      keep: Number(keywordAggregateResult.rows[0]?.keep_count ?? "0"),
      pending: Number(
        keywordAggregateResult.rows[0]?.pending_count ?? "0",
      ),
      rankingUrls: Number(
        keywordAggregateResult.rows[0]?.ranking_url_count ?? "0",
      ),
      remove: Number(keywordAggregateResult.rows[0]?.remove_count ?? "0"),
      review: Number(keywordAggregateResult.rows[0]?.review_count ?? "0"),
    },
    keywords: keywordResult.rows.map((keyword) => ({
      avgMonthlyVolume: keyword.avg_monthly_volume,
      brand: keyword.is_branded === null
        ? null
        : {
            confidence:
              keyword.brand_confidence === null
                ? null
                : Number(keyword.brand_confidence),
            isBranded: keyword.is_branded,
            matchedTerm: keyword.brand_matched_term,
            source: keyword.brand_source,
          },
      categorisation: keyword.category
        ? {
            category: keyword.category,
            intent: keyword.search_intent,
            source: keyword.categorisation_source,
            tags: keyword.tags,
            tier: keyword.categorisation_tier,
          }
        : null,
      detox: {
        reason: keyword.detox_reason,
        rule: keyword.detox_rule,
        status: keyword.detox_status,
      },
      enrichmentSource: keyword.enrichment_source,
      gsc: keyword.gsc_clicks === null
        ? null
        : {
            clicks: keyword.gsc_clicks,
            ctr: Number(keyword.gsc_ctr),
            devices: keyword.gsc_devices,
            impressions: keyword.gsc_impressions,
            position: Number(keyword.gsc_position),
          },
      id: keyword.id,
      keywordDifficulty:
        keyword.keyword_difficulty === null ? null : Number(keyword.keyword_difficulty),
      rankingUrl: keyword.ranking_url,
      ranking: {
        noMatch: keyword.ranking_lookup_no_match,
        rank: keyword.base_rank,
        source: keyword.base_rank_source,
      },
      serp: {
        noResult: keyword.serp_lookup_no_result,
        providerMissing: keyword.serp_provider_missing,
      },
      sources: keyword.sources,
      text: keyword.keyword,
    })),
    language: project.language,
    name: project.project_name,
    rules: groupedRules(rulesResult.rows),
    serpResultCount: Number(serpCountResult.rows[0]?.count ?? "0"),
    authorityMetrics: clientMetricResult.rows[0]
      ? {
          ahrefsRank:
            clientMetricResult.rows[0].ahrefs_rank === null
              ? null
              : Number(clientMetricResult.rows[0].ahrefs_rank),
          backlinks:
            clientMetricResult.rows[0].backlinks === null
              ? null
              : Number(clientMetricResult.rows[0].backlinks),
          domain: clientMetricResult.rows[0].domain,
          domainRating:
            clientMetricResult.rows[0].domain_rating === null
              ? null
              : Number(clientMetricResult.rows[0].domain_rating),
          fetchedAt: clientMetricResult.rows[0].fetched_at.toISOString(),
          referringDomains:
            clientMetricResult.rows[0].referring_domains === null
              ? null
              : Number(clientMetricResult.rows[0].referring_domains),
          source: clientMetricResult.rows[0].metric_source,
          urlRating:
            clientMetricResult.rows[0].url_rating === null
              ? null
              : Number(clientMetricResult.rows[0].url_rating),
        }
      : null,
  };
}

export async function getProjectSerpResults(
  pool: DatabasePool,
  user: AuthenticatedUser,
  projectId: string,
  limit: number,
  offset: number,
  keywordId: string | null = null,
): Promise<Record<string, unknown>> {
  await assertProjectAccess(pool, user.id, projectId);
  if (
    keywordId !== null &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      keywordId,
    )
  ) {
    throw new HttpError(400, "invalid_request", "Keyword ID is invalid.");
  }
  const [rows, count] = await Promise.all([
    pool.query<SerpApiRow>(
      `
        SELECT
          result.keyword_id,
          keyword.keyword,
          result.rank_absolute,
          result.url,
          result.domain,
          result.is_client_domain,
          result.url_rating,
          result.domain_rating,
          result.ahrefs_rank::text,
          result.referring_domains::text,
          result.backlinks::text,
          result.metric_source,
          result.fetched_at,
          result.metrics_fetched_at
        FROM serp_results AS result
        JOIN keywords AS keyword ON keyword.id = result.keyword_id
        WHERE result.project_id = $1
          AND ($2::uuid IS NULL OR result.keyword_id = $2)
        ORDER BY keyword.normalised_keyword, result.rank_absolute
        LIMIT $3 OFFSET $4
      `,
      [projectId, keywordId, limit, offset],
    ),
    pool.query<CountRow>(
      `
        SELECT count(*)::text AS count
        FROM serp_results
        WHERE project_id = $1
          AND ($2::uuid IS NULL OR keyword_id = $2)
      `,
      [projectId, keywordId],
    ),
  ]);
  return {
    items: rows.rows.map((row) => ({
      ahrefsRank: row.ahrefs_rank === null ? null : Number(row.ahrefs_rank),
      backlinks: row.backlinks === null ? null : Number(row.backlinks),
      domain: row.domain,
      domainRating:
        row.domain_rating === null ? null : Number(row.domain_rating),
      fetchedAt: row.fetched_at.toISOString(),
      isClientDomain: row.is_client_domain,
      keyword: row.keyword,
      keywordId: row.keyword_id,
      metricSource: row.metric_source,
      metricsFetchedAt: row.metrics_fetched_at?.toISOString() ?? null,
      rankAbsolute: row.rank_absolute,
      referringDomains:
        row.referring_domains === null ? null : Number(row.referring_domains),
      url: row.url,
      urlRating: row.url_rating === null ? null : Number(row.url_rating),
    })),
    limit,
    offset,
    projectId,
    total: Number(count.rows[0]?.count ?? "0"),
  };
}

export async function getProjectCalculations(
  pool: DatabasePool,
  user: AuthenticatedUser,
  projectId: string,
): Promise<Record<string, unknown>> {
  await assertProjectAccess(pool, user.id, projectId);
  const runResult = await pool.query<LatestCalculationRunRow>(
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
  const run = runResult.rows[0];
  if (!run) {
    return {
      calibration: null,
      completedAt: null,
      har: [],
      opportunities: [],
      projectId,
      revenue: [],
      runId: null,
      siteActions: [],
    };
  }
  const [har, revenue, calibration, siteActions, opportunities] =
    await Promise.all([
      pool.query<HarSummaryRow>(
        `
          SELECT
            scenario,
            min(model_version) AS model_version,
            count(*)::text AS forecast_count,
            avg(har_position)::text AS average_har_position,
            avg(har_confidence)::text AS average_confidence
          FROM har_forecasts
          WHERE project_id = $1
            AND pipeline_run_id = $2
          GROUP BY scenario
          ORDER BY
            CASE scenario
              WHEN 'conservative' THEN 1
              WHEN 'realistic' THEN 2
              ELSE 3
            END
        `,
        [projectId, run.id],
      ),
      pool.query<RevenueSummaryRow>(
        `
          SELECT
            scenario,
            min(model_version) AS model_version,
            min(band_method) AS band_method,
            count(*)::text AS forecast_count,
            count(*) FILTER (
              WHERE jsonb_array_length(monthly_revenue_json -> 'months') = 12
            )::text AS monthly_forecast_count,
            sum(target_incremental_revenue_annual)::text AS target_incremental,
            sum(expected_incremental_annual)::text AS expected_incremental
          FROM revenue_forecasts
          WHERE project_id = $1
            AND pipeline_run_id = $2
          GROUP BY scenario
          ORDER BY
            CASE scenario
              WHEN 'conservative' THEN 1
              WHEN 'realistic' THEN 2
              ELSE 3
            END
        `,
        [projectId, run.id],
      ),
      pool.query<CalibrationApiRow>(
        `
          SELECT
            model_version,
            overall_ratio::text,
            median_per_pair_ratio::text,
            sum_modelled_monthly::text,
            sum_actual_monthly::text,
            impressions_context::text,
            promotion_eligible,
            status,
            matched,
            excluded_noise_floor,
            pair_count,
            by_intent,
            by_rank_band
          FROM calibration_snapshots
          WHERE project_id = $1
            AND pipeline_run_id = $2
        `,
        [projectId, run.id],
      ),
      pool.query<SiteActionSummaryRow>(
        `
          SELECT tactical_status, count(*)::text AS count
          FROM site_architecture
          WHERE project_id = $1
            AND pipeline_run_id = $2
          GROUP BY tactical_status
          ORDER BY tactical_status NULLS LAST
        `,
        [projectId, run.id],
      ),
      pool.query<OpportunityRow>(
        `
          SELECT
            keyword.id AS keyword_id,
            keyword.keyword,
            har.base_rank,
            har.har_position,
            har.rank_attainment_probability,
            revenue.expected_incremental_annual::text AS expected_incremental
          FROM revenue_forecasts AS revenue
          JOIN har_forecasts AS har
            ON har.pipeline_run_id = revenue.pipeline_run_id
           AND har.keyword_id = revenue.keyword_id
           AND har.scenario = revenue.scenario
          JOIN keywords AS keyword ON keyword.id = revenue.keyword_id
          WHERE revenue.project_id = $1
            AND revenue.pipeline_run_id = $2
            AND revenue.scenario = 'realistic'
          ORDER BY revenue.expected_incremental_annual DESC NULLS LAST,
            keyword.normalised_keyword
          LIMIT 50
        `,
        [projectId, run.id],
      ),
    ]);
  const calibrationRow = calibration.rows[0];
  return {
    calibration: calibrationRow
      ? {
          byIntent: calibrationRow.by_intent,
          byRankBand: calibrationRow.by_rank_band,
          excludedNoiseFloor: calibrationRow.excluded_noise_floor,
          impressionsContext: Number(calibrationRow.impressions_context),
          matched: calibrationRow.matched,
          medianPerPairRatio:
            calibrationRow.median_per_pair_ratio === null
              ? null
              : Number(calibrationRow.median_per_pair_ratio),
          modelVersion: calibrationRow.model_version,
          overallRatio:
            calibrationRow.overall_ratio === null
              ? null
              : Number(calibrationRow.overall_ratio),
          pairCount: calibrationRow.pair_count,
          promotionEligible: calibrationRow.promotion_eligible,
          status: calibrationRow.status,
          sumActualMonthly: Number(calibrationRow.sum_actual_monthly),
          sumModelledMonthly: Number(calibrationRow.sum_modelled_monthly),
        }
      : null,
    completedAt: run.completed_at.toISOString(),
    har: har.rows.map((row) => ({
      averageConfidence:
        row.average_confidence === null
          ? null
          : Number(row.average_confidence),
      averageHarPosition:
        row.average_har_position === null
          ? null
          : Number(row.average_har_position),
      forecastCount: Number(row.forecast_count),
      modelVersion: row.model_version,
      scenario: row.scenario,
    })),
    opportunities: opportunities.rows.map((row) => ({
      baseRank: row.base_rank,
      expectedIncremental:
        row.expected_incremental === null
          ? null
          : Number(row.expected_incremental),
      harPosition: row.har_position,
      keyword: row.keyword,
      keywordId: row.keyword_id,
      rankAttainmentProbability:
        row.rank_attainment_probability === null
          ? null
          : Number(row.rank_attainment_probability),
    })),
    projectId,
    revenue: revenue.rows.map((row) => ({
      bandMethod: row.band_method,
      expectedIncremental:
        row.expected_incremental === null
          ? null
          : Number(row.expected_incremental),
      forecastCount: Number(row.forecast_count),
      modelVersion: row.model_version,
      monthlyForecastCount: Number(row.monthly_forecast_count),
      scenario: row.scenario,
      targetIncremental:
        row.target_incremental === null
          ? null
          : Number(row.target_incremental),
    })),
    runId: run.id,
    siteActions: siteActions.rows.map((row) => ({
      count: Number(row.count),
      tacticalStatus: row.tactical_status,
    })),
  };
}

export async function getProjectForecastRows(
  pool: DatabasePool,
  user: AuthenticatedUser,
  projectId: string,
  scenario: string,
  limit: number,
  offset: number,
): Promise<Record<string, unknown>> {
  await assertProjectAccess(pool, user.id, projectId);
  if (!["conservative", "realistic", "stretch"].includes(scenario)) {
    throw new HttpError(
      400,
      "invalid_request",
      "Forecast scenario is invalid.",
    );
  }
  const runResult = await pool.query<LatestCalculationRunRow>(
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
  const run = runResult.rows[0];
  if (!run) {
    return {
      completedAt: null,
      items: [],
      limit,
      offset,
      projectId,
      runId: null,
      scenario,
      total: 0,
    };
  }
  const [items, count] = await Promise.all([
    pool.query<ForecastDetailRow>(
      `
        SELECT
          keyword.id AS keyword_id,
          keyword.keyword,
          keyword.device,
          keyword.avg_monthly_volume,
          keyword.keyword_priority,
          keyword.search_intent,
          keyword.ranking_url,
          har.scenario,
          har.base_rank,
          har.har_position,
          har.har_confidence::text,
          har.rank_attainment_probability::text,
          har.link_power_score::text,
          har.content_fit_score::text,
          har.explanation_json,
          revenue.annual_volume::text,
          revenue.volume_forward::text,
          revenue.conversion_rate_used::text,
          revenue.average_order_value_used::text,
          revenue.conversion_rate_override_id,
          revenue.average_order_value_override_id,
          revenue.ctr_now::text,
          revenue.ctr_target::text,
          revenue.current_revenue_annual::text,
          revenue.target_absolute_revenue_annual::text,
          revenue.target_incremental_revenue_annual::text,
          revenue.expected_incremental_annual::text,
          revenue.expected_incremental_low_annual::text,
          revenue.expected_incremental_high_annual::text,
          revenue.monthly_revenue_json,
          architecture.relevancy_score::text,
          architecture.content_status,
          architecture.tactical_status,
          client_result.url_rating::text AS client_url_rating,
          competitor_result.url AS competitor_url,
          competitor_result.url_rating::text AS competitor_url_rating
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
            AND result.is_client_domain
          ORDER BY result.rank_absolute
          LIMIT 1
        ) AS client_result ON true
        LEFT JOIN LATERAL (
          SELECT result.url, result.url_rating
          FROM serp_results AS result
          WHERE result.project_id = revenue.project_id
            AND result.keyword_id = revenue.keyword_id
            AND NOT result.is_client_domain
          ORDER BY result.rank_absolute
          LIMIT 1
        ) AS competitor_result ON true
        WHERE revenue.project_id = $1
          AND revenue.pipeline_run_id = $2
          AND revenue.scenario = $3
        ORDER BY
          revenue.expected_incremental_annual DESC NULLS LAST,
          keyword.normalised_keyword
        LIMIT $4 OFFSET $5
      `,
      [projectId, run.id, scenario, limit, offset],
    ),
    pool.query<CountRow>(
      `
        SELECT count(*)::text AS count
        FROM revenue_forecasts
        WHERE project_id = $1
          AND pipeline_run_id = $2
          AND scenario = $3
      `,
      [projectId, run.id, scenario],
    ),
  ]);
  return {
    completedAt: run.completed_at.toISOString(),
    items: items.rows.map((row) => {
      const annualVolume =
        row.annual_volume === null ? null : Number(row.annual_volume);
      const ctrNow = row.ctr_now === null ? null : Number(row.ctr_now);
      const ctrTarget =
        row.ctr_target === null ? null : Number(row.ctr_target);
      const baseRank = row.base_rank;
      const harPosition = row.har_position;
      const opportunity =
        baseRank !== null && baseRank <= 3
          ? "maintain"
          : harPosition !== null &&
              baseRank !== null &&
              harPosition < baseRank
            ? "improve"
            : baseRank !== null && baseRank > 20
              ? "grow"
              : "opportunity";
      return {
        annualVolume,
        averageOrderValueOverrideId: row.average_order_value_override_id,
        averageOrderValueUsed:
          row.average_order_value_used === null
            ? null
            : Number(row.average_order_value_used),
        averageMonthlyVolume: row.avg_monthly_volume,
        baseRank,
        clientUrlRating:
          row.client_url_rating === null
            ? null
            : Number(row.client_url_rating),
        competitorUrl: row.competitor_url,
        competitorUrlRating:
          row.competitor_url_rating === null
            ? null
            : Number(row.competitor_url_rating),
        contentFitScore:
          row.content_fit_score === null
            ? null
            : Number(row.content_fit_score),
        contentStatus: row.content_status,
        ctrNow,
        ctrTarget,
        conversionRateOverrideId: row.conversion_rate_override_id,
        conversionRateUsed:
          row.conversion_rate_used === null
            ? null
            : Number(row.conversion_rate_used),
        currentRevenueAnnual:
          row.current_revenue_annual === null
            ? null
            : Number(row.current_revenue_annual),
        device: row.device,
        expectedIncrementalAnnual:
          row.expected_incremental_annual === null
            ? null
            : Number(row.expected_incremental_annual),
        expectedIncrementalHighAnnual:
          row.expected_incremental_high_annual === null
            ? null
            : Number(row.expected_incremental_high_annual),
        expectedIncrementalLowAnnual:
          row.expected_incremental_low_annual === null
            ? null
            : Number(row.expected_incremental_low_annual),
        explanation: row.explanation_json,
        harConfidence: Number(row.har_confidence),
        harPosition,
        keyword: row.keyword,
        keywordId: row.keyword_id,
        keywordPriority: row.keyword_priority,
        linkPowerScore:
          row.link_power_score === null
            ? null
            : Number(row.link_power_score),
        monthlyRevenue: row.monthly_revenue_json,
        opportunity,
        rankAttainmentProbability:
          row.rank_attainment_probability === null
            ? null
            : Number(row.rank_attainment_probability),
        rankingUrl: row.ranking_url,
        relevancyScore:
          row.relevancy_score === null
            ? null
            : Number(row.relevancy_score),
        scenario: row.scenario,
        searchIntent: row.search_intent,
        tacticalStatus: row.tactical_status,
        targetAbsoluteRevenueAnnual:
          row.target_absolute_revenue_annual === null
            ? null
            : Number(row.target_absolute_revenue_annual),
        targetIncrementalRevenueAnnual:
          row.target_incremental_revenue_annual === null
            ? null
            : Number(row.target_incremental_revenue_annual),
        trafficGainAnnual:
          annualVolume === null || ctrNow === null || ctrTarget === null
            ? null
            : annualVolume * Math.max(0, ctrTarget - ctrNow),
        volumeForward:
          row.volume_forward === null ? null : Number(row.volume_forward),
      };
    }),
    limit,
    offset,
    projectId,
    runId: run.id,
    scenario,
    total: Number(count.rows[0]?.count ?? "0"),
  };
}

export async function getProjectSiteArchitecture(
  pool: DatabasePool,
  user: AuthenticatedUser,
  projectId: string,
  limit: number,
  offset: number,
): Promise<Record<string, unknown>> {
  await assertProjectAccess(pool, user.id, projectId);
  const runResult = await pool.query<LatestCalculationRunRow>(
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
  const run = runResult.rows[0] ?? null;
  const [items, count] = await Promise.all([
    pool.query<SiteArchitectureDetailRow>(
      `
        SELECT
          keyword.id AS keyword_id,
          keyword.keyword,
          keyword.category,
          keyword.search_intent,
          keyword.avg_monthly_volume,
          keyword.base_rank,
          keyword.ranking_url,
          architecture.matched_url,
          architecture.relevancy_score::text,
          architecture.content_status,
          architecture.tactical_status,
          architecture.provider_status
        FROM keywords AS keyword
        LEFT JOIN site_architecture AS architecture
          ON architecture.keyword_id = keyword.id
         AND architecture.pipeline_run_id = $2::uuid
        WHERE keyword.project_id = $1
          AND keyword.detox_status = 'keep'
        ORDER BY keyword.normalised_keyword
        LIMIT $3 OFFSET $4
      `,
      [projectId, run?.id ?? null, limit, offset],
    ),
    pool.query<CountRow>(
      `
        SELECT count(*)::text AS count
        FROM keywords
        WHERE project_id = $1
          AND detox_status = 'keep'
      `,
      [projectId],
    ),
  ]);
  return {
    completedAt: run?.completed_at.toISOString() ?? null,
    items: items.rows.map((row) => ({
      averageMonthlyVolume: row.avg_monthly_volume,
      baseRank: row.base_rank,
      category: row.category,
      contentStatus: row.content_status,
      isUnscored: row.relevancy_score === null,
      keyword: row.keyword,
      keywordId: row.keyword_id,
      matchedUrl: row.matched_url,
      providerStatus: row.provider_status,
      rankingUrl: row.ranking_url,
      relevancyScore:
        row.relevancy_score === null
          ? null
          : Number(row.relevancy_score),
      searchIntent: row.search_intent,
      tacticalStatus: row.tactical_status,
    })),
    limit,
    offset,
    projectId,
    runId: run?.id ?? null,
    total: Number(count.rows[0]?.count ?? "0"),
  };
}

export async function getProjectCtrCurves(
  pool: DatabasePool,
  user: AuthenticatedUser,
  projectId: string,
): Promise<Record<string, unknown>> {
  await assertProjectAccess(pool, user.id, projectId);
  const runResult = await pool.query<LatestCalculationRunRow>(
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
  const run = runResult.rows[0];
  if (!run) {
    return {
      completedAt: null,
      curves: [],
      projectId,
      runId: null,
    };
  }
  const result = await pool.query<CtrCurveDetailRow>(
    `
      SELECT
        curve.device,
        curve.search_intent,
        curve.is_branded,
        point.rank,
        point.ctr::text,
        point.impressions::text,
        point.confidence,
        point.source
      FROM ctr_curves AS curve
      JOIN ctr_curve_points AS point ON point.curve_id = curve.id
      WHERE curve.project_id = $1
        AND curve.pipeline_run_id = $2
      ORDER BY
        curve.device,
        curve.search_intent,
        curve.is_branded,
        point.rank
    `,
    [projectId, run.id],
  );
  const curves = new Map<
    string,
    {
      device: string;
      isBranded: boolean;
      points: Array<{
        confidence: string;
        ctr: number;
        impressions: number;
        rank: number;
        source: string;
      }>;
      searchIntent: string;
    }
  >();
  for (const row of result.rows) {
    const key = `${row.device}\u0000${row.search_intent}\u0000${row.is_branded}`;
    const curve = curves.get(key) ?? {
      device: row.device,
      isBranded: row.is_branded,
      points: [],
      searchIntent: row.search_intent,
    };
    curve.points.push({
      confidence: row.confidence,
      ctr: Number(row.ctr),
      impressions: Number(row.impressions),
      rank: row.rank,
      source: row.source,
    });
    curves.set(key, curve);
  }
  return {
    completedAt: run.completed_at.toISOString(),
    curves: [...curves.values()],
    projectId,
    runId: run.id,
  };
}
