import type { PoolClient } from "pg";

import {
  normaliseKeyword,
  type ProjectPipelineSource,
  type SyntheticGscRow,
  type SyntheticKeyword,
  type SyntheticProviderKeyword,
  type SyntheticProviderSerpKeyword,
  type SyntheticProviderSiteArchitectureKeyword,
} from "../../../packages/fixtures/src/representative-project.js";
import type {
  AuthorityStageData,
  BacklinksStageData,
  BrandClassificationStageData,
  CalibrationStageData,
  CategorisationStageData,
  ClusteringStageData,
  CtrCurvesStageData,
  DataDrivenStageData,
  DemandSignalsStageData,
  DetoxStageData,
  GscPromotionStageData,
  GscIntentStageData,
  HarV2StageData,
  KeywordEnrichmentStageData,
  LinkPowerScoreStageData,
  RankingUrlStageData,
  RollupOutputStageData,
  RevenueV2StageData,
  SerpCollectionStageData,
  SiteArchitectureStageData,
} from "../../../packages/pipeline/src/stage-handlers.js";
import { resolveBrandTerms } from "../../../packages/pipeline/src/brand-terms.js";
import type { DatabasePool } from "../../../packages/runtime/src/database.js";

interface ProjectSourceRow {
  aov: string | null;
  authority_backlinks: string;
  authority_domain_rating: string;
  authority_referring_domains: number;
  brand_terms: string[];
  category_focus: string;
  client_id: string;
  company_name: string;
  conversion_rate: string | null;
  country: string;
  currency: string;
  domain: string;
  gsc_window_days: number;
  gsc_date_range_end: string | null;
  gsc_date_range_start: string | null;
  id: string;
  industry: string;
  language: string;
  project_name: string;
  competitive_enrichment_volume_floor: number;
  gsc_promotion_impressions_floor: number;
  pipeline_policy_reviewed_at: Date | null;
}

interface KeywordSourceRow {
  avg_monthly_volume: number | null;
  category: string | null;
  core_keyword: string | null;
  id: string;
  keyword: string;
  keyword_difficulty: string | null;
  pre_curated: boolean;
  ranking_url: string | null;
  search_intent: SyntheticProviderKeyword["intent"];
  volume_source: "manual" | "provider" | null;
}

interface GscSourceRow {
  clicks: number;
  ctr: string;
  device: SyntheticGscRow["device"];
  impressions: number;
  page: string;
  position: string;
  query: string;
}

interface RuleSourceRow {
  rule_type:
    | "blacklist"
    | "competitor_brand"
    | "own_brand"
    | "relevant_term"
    | "whitelist";
  value: string;
}

interface ProviderSourceRow {
  avg_monthly_volume: number | null;
  core_keyword: string | null;
  keyword: string;
  keyword_difficulty: string | null;
  rank: number | null;
  ranking_url: string | null;
  search_intent: SyntheticProviderKeyword["intent"];
}

interface CompetitorSourceRow {
  competitor_domain: string;
}

interface ProviderSerpFeatureRow {
  feature_raw: string;
  normalised_keyword: string;
}

interface ScoringConfigSourceRow {
  id: string;
  thresholds_json: {
    floor_multipliers?: Record<string, number>;
    min_confidence?: number;
    probability_factors?: Record<string, number>;
    temperatures?: Record<string, number>;
    thresholds?: Record<string, number>;
  };
  version: string;
}

interface VisibilityAdjustmentSourceRow {
  device: "all" | "desktop" | "mobile" | "tablet";
  feature_type: string;
  multiplier: string;
  search_intent:
    | "commercial"
    | "generic"
    | "informational"
    | "navigational"
    | "transactional";
}

interface ProviderSerpKeywordRow {
  keyword: string;
  normalised_keyword: string;
}

interface ProviderSerpResultRow {
  ahrefs_rank: string | null;
  backlinks: string | null;
  domain: string;
  domain_rating: string | null;
  normalised_keyword: string;
  rank_absolute: number;
  referring_domains: string | null;
  url: string;
  url_rating: string | null;
}

interface ProviderMonthlyVolumeRow {
  month: string;
  normalised_keyword: string;
  volume: number;
}

interface ProviderSiteArchitectureRow {
  content_status: SyntheticProviderSiteArchitectureKeyword["contentStatus"];
  keyword: string;
  matched_url: string | null;
  relevancy_score: string;
  tactical_status: SyntheticProviderSiteArchitectureKeyword["tacticalStatus"];
}

interface ConversionOverrideSourceRow {
  average_order_value: string | null;
  conversion_rate: string | null;
  id: string;
  scope_type: "category" | "intent" | "project" | "url";
  scope_value: string | null;
}

const FORECAST_PERSISTENCE_BATCH_SIZE = 2_000;

function batches<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

function groupRules(rows: RuleSourceRow[]): ProjectPipelineSource["rules"] {
  const rules: ProjectPipelineSource["rules"] = {
    blacklist: [],
    competitorBrands: [],
    ownBrands: [],
    relevantTerms: [],
    whitelist: [],
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

export function projectIdFromInput(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (record.inputVersion !== "project-v1") return null;
  if (
    typeof record.projectId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      record.projectId,
    )
  ) {
    throw new Error("Project pipeline input contains an invalid projectId.");
  }
  return record.projectId;
}

export function normaliseStoredConversionRate(value: string | null): number | null {
  if (value === null) return null;
  const conversionRate = Number(value);
  return conversionRate > 1 ? conversionRate / 100 : conversionRate;
}

export async function loadProjectPipelineSource(
  pool: DatabasePool,
  projectId: string,
): Promise<ProjectPipelineSource> {
  const [
    projectResult,
    keywordResult,
    gscResult,
    ruleResult,
    providerResult,
    providerMonthlyVolumeResult,
    providerSerpKeywordResult,
    providerSerpResult,
    providerSiteArchitectureResult,
    conversionOverrideResult,
    competitorResult,
    scoringConfigResult,
    providerSerpFeatureResult,
    visibilityAdjustmentResult,
  ] = await Promise.all([
    pool.query<ProjectSourceRow>(
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
          COALESCE(
            (latest_upload.date_range_end - latest_upload.date_range_start) + 1,
            project.gsc_window_days
          ) AS gsc_window_days,
          latest_upload.date_range_start::text AS gsc_date_range_start,
          latest_upload.date_range_end::text AS gsc_date_range_end,
          project.gsc_promotion_impressions_floor,
          project.competitive_enrichment_volume_floor,
          project.pipeline_policy_reviewed_at,
          client.company_name,
          client.domain,
          client.industry,
          client.brand_terms
        FROM navigator_projects AS project
        JOIN clients AS client ON client.id = project.client_id
        LEFT JOIN LATERAL (
          SELECT upload.date_range_start, upload.date_range_end
          FROM gsc_uploads AS upload
          WHERE upload.project_id = project.id
          ORDER BY upload.created_at DESC, upload.id DESC
          LIMIT 1
        ) AS latest_upload ON true
        WHERE project.id = $1
          AND project.archived_at IS NULL
          AND client.archived_at IS NULL
      `,
      [projectId],
    ),
    pool.query<KeywordSourceRow>(
      `
        SELECT
          id,
          keyword,
          avg_monthly_volume,
          keyword_difficulty,
          (human_reviewed AND categorisation_status = 'done') AS pre_curated,
          ranking_url,
          category,
          search_intent,
          core_keyword,
          volume_source
        FROM keywords
        WHERE project_id = $1
        ORDER BY created_at, id
      `,
      [projectId],
    ),
    pool.query<GscSourceRow>(
      `
        WITH latest_upload AS (
          SELECT id
          FROM gsc_uploads
          WHERE project_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        )
        SELECT
          keyword.query,
          keyword.page,
          keyword.device,
          keyword.clicks,
          keyword.impressions,
          keyword.ctr,
          keyword.position
        FROM gsc_upload_keywords AS keyword
        JOIN latest_upload ON latest_upload.id = keyword.upload_id
        ORDER BY keyword.id
      `,
      [projectId],
    ),
    pool.query<RuleSourceRow>(
      `
        SELECT rule_type, value
        FROM project_keyword_rules
        WHERE project_id = $1
        ORDER BY rule_type, normalised_value
      `,
      [projectId],
    ),
    pool.query<ProviderSourceRow>(
      `
        SELECT
          keyword,
          avg_monthly_volume,
          core_keyword,
          keyword_difficulty,
          search_intent,
          ranking_url,
          rank
        FROM local_provider_keyword_inputs
        WHERE project_id = $1
        ORDER BY normalised_keyword
      `,
      [projectId],
    ),
    pool.query<ProviderMonthlyVolumeRow>(
      `
        SELECT
          normalised_keyword,
          month::text,
          volume
        FROM local_provider_keyword_monthly_volumes
        WHERE project_id = $1
        ORDER BY normalised_keyword, month
      `,
      [projectId],
    ),
    pool.query<ProviderSerpKeywordRow>(
      `
        SELECT keyword, normalised_keyword
        FROM local_provider_serp_keywords
        WHERE project_id = $1
        ORDER BY normalised_keyword
      `,
      [projectId],
    ),
    pool.query<ProviderSerpResultRow>(
      `
        SELECT
          normalised_keyword,
          rank_absolute,
          url,
          domain,
          url_rating,
          domain_rating,
          ahrefs_rank::text,
          referring_domains::text,
          backlinks::text
        FROM local_provider_serp_results
        WHERE project_id = $1
        ORDER BY normalised_keyword, rank_absolute
      `,
      [projectId],
    ),
    pool.query<ProviderSiteArchitectureRow>(
      `
        SELECT
          keyword,
          matched_url,
          relevancy_score,
          content_status,
          tactical_status
        FROM local_provider_site_architecture_inputs
        WHERE project_id = $1
        ORDER BY normalised_keyword
      `,
      [projectId],
    ),
    pool.query<ConversionOverrideSourceRow>(
      `
        SELECT
          id,
          scope_type,
          scope_value,
          conversion_rate::text,
          average_order_value::text
        FROM project_conversion_overrides
        WHERE project_id = $1
        ORDER BY
          CASE scope_type
            WHEN 'url' THEN 1
            WHEN 'category' THEN 2
            WHEN 'intent' THEN 3
            ELSE 4
          END,
          updated_at DESC,
          id
      `,
      [projectId],
    ),
    pool.query<CompetitorSourceRow>(
      `
        SELECT competitor_domain
        FROM competitors
        WHERE client_id = (
          SELECT client_id FROM navigator_projects WHERE id = $1
        )
        ORDER BY competitor_domain
      `,
      [projectId],
    ),
    pool.query<ScoringConfigSourceRow>(
      `
        SELECT id, version, thresholds_json
        FROM har_scoring_config
        WHERE is_active
        LIMIT 1
      `,
    ),
    pool.query<ProviderSerpFeatureRow>(
      `
        SELECT keyword.normalised_keyword, feature.feature_raw
        FROM project_serp_features AS feature
        JOIN keywords AS keyword
          ON keyword.id = feature.keyword_id
         AND keyword.project_id = feature.project_id
        WHERE feature.project_id = $1
        ORDER BY keyword.normalised_keyword, feature.feature_raw
      `,
      [projectId],
    ),
    pool.query<VisibilityAdjustmentSourceRow>(
      `
        SELECT feature_type, device, search_intent, multiplier::text
        FROM serp_feature_visibility_adjustments
        WHERE is_active
        ORDER BY feature_type, device, search_intent
      `,
    ),
  ]);
  const project = projectResult.rows[0];
  if (!project) {
    throw new Error(`Project ${projectId} is unavailable to the pipeline.`);
  }

  const keywords: SyntheticKeyword[] = keywordResult.rows.map((keyword) => ({
    avgMonthlyVolume: keyword.avg_monthly_volume,
    category: keyword.category,
    coreKeyword: keyword.core_keyword,
    id: keyword.id,
    keywordDifficulty:
      keyword.keyword_difficulty === null ? null : Number(keyword.keyword_difficulty),
    preCurated: keyword.pre_curated,
    rankingUrl: keyword.ranking_url,
    searchIntent: keyword.search_intent,
    text: keyword.keyword,
    volumeSource: keyword.volume_source,
  }));
  const gscRows: SyntheticGscRow[] = gscResult.rows.map((row) => ({
    clicks: row.clicks,
    ctr: Number(row.ctr),
    device: row.device,
    impressions: row.impressions,
    page: row.page,
    position: Number(row.position),
    query: row.query,
  }));
  const providerSerpResults = new Map<
    string,
    SyntheticProviderSerpKeyword["results"]
  >();
  for (const row of providerSerpResult.rows) {
    const results = providerSerpResults.get(row.normalised_keyword) ?? [];
    results.push({
      ahrefsRank: row.ahrefs_rank === null ? null : Number(row.ahrefs_rank),
      backlinks: row.backlinks === null ? null : Number(row.backlinks),
      domain: row.domain,
      domainRating:
        row.domain_rating === null ? null : Number(row.domain_rating),
      rankAbsolute: row.rank_absolute,
      referringDomains:
        row.referring_domains === null ? null : Number(row.referring_domains),
      url: row.url,
      urlRating: row.url_rating === null ? null : Number(row.url_rating),
    });
    providerSerpResults.set(row.normalised_keyword, results);
  }
  const providerMonthlyVolumes = new Map<
    string,
    SyntheticProviderKeyword["monthlyVolumes"]
  >();
  for (const row of providerMonthlyVolumeResult.rows) {
    const points = providerMonthlyVolumes.get(row.normalised_keyword) ?? [];
    points.push({ month: row.month, volume: row.volume });
    providerMonthlyVolumes.set(row.normalised_keyword, points);
  }
  const providerSerpFeatures = new Map<string, string[]>();
  for (const row of providerSerpFeatureResult.rows) {
    providerSerpFeatures.set(row.normalised_keyword, [
      ...(providerSerpFeatures.get(row.normalised_keyword) ?? []),
      row.feature_raw,
    ]);
  }

  const brandTerms = resolveBrandTerms(project.brand_terms, project.domain);

  return {
    authority: {
      backlinks: Number(project.authority_backlinks),
      domainRating: Number(project.authority_domain_rating),
      referringDomains: project.authority_referring_domains,
    },
    client: {
      brandTerms: brandTerms.terms,
      companyName: project.company_name,
      domain: project.domain,
      id: project.client_id,
      industry: project.industry,
    },
    economics: {
      averageOrderValue:
        project.aov === null
          ? null
          : Number(project.aov),
      conversionRate:
        normaliseStoredConversionRate(project.conversion_rate),
      gscDateRangeEnd: project.gsc_date_range_end,
      gscDateRangeStart: project.gsc_date_range_start,
      gscWindowDays: project.gsc_window_days,
    },
    conversionOverrides: conversionOverrideResult.rows.map((override) => ({
      averageOrderValue:
        override.average_order_value === null
          ? null
          : Number(override.average_order_value),
      conversionRate:
        override.conversion_rate === null
          ? null
          : Number(override.conversion_rate),
      id: override.id,
      scopeType: override.scope_type,
      scopeValue: override.scope_value,
    })),
    competitorDomains: competitorResult.rows.map((row) => row.competitor_domain),
    gscRows,
    keywords,
    project: {
      categoryFocus: project.category_focus,
      clientId: project.client_id,
      country: project.country,
      currency: project.currency,
      id: project.id,
      language: project.language,
      name: project.project_name,
      policy: {
        competitiveEnrichmentVolumeFloor:
          project.competitive_enrichment_volume_floor,
        gscPromotionImpressionsFloor: project.gsc_promotion_impressions_floor,
        reviewedAt: project.pipeline_policy_reviewed_at?.toISOString() ?? null,
      },
    },
    providerInputs: {
      keywords: providerResult.rows.map((input) => ({
        avgMonthlyVolume: input.avg_monthly_volume,
        coreKeyword: input.core_keyword,
        intent: input.search_intent,
        keywordDifficulty:
          input.keyword_difficulty === null
            ? null
            : Number(input.keyword_difficulty),
        rank: input.rank,
        rankingUrl: input.ranking_url,
        text: input.keyword,
        monthlyVolumes:
          providerMonthlyVolumes.get(normaliseKeyword(input.keyword)) ?? [],
      })),
      serpKeywords: providerSerpKeywordResult.rows.map((input) => ({
        features: providerSerpFeatures.get(input.normalised_keyword) ?? [],
        results: providerSerpResults.get(input.normalised_keyword) ?? [],
        text: input.keyword,
      })),
      siteArchitectureKeywords: providerSiteArchitectureResult.rows.map(
        (input) => ({
          contentStatus: input.content_status,
          matchedUrl: input.matched_url,
          relevancyScore: Number(input.relevancy_score),
          tacticalStatus: input.tactical_status,
          text: input.keyword,
        }),
      ),
    },
    rules: groupRules(ruleResult.rows),
    scoringConfig: scoringConfigResult.rows[0]
      ? {
          config_id: scoringConfigResult.rows[0].id,
          config_version: scoringConfigResult.rows[0].version,
          min_confidence:
            scoringConfigResult.rows[0].thresholds_json.min_confidence ?? null,
          scenario_floor_multipliers:
            scoringConfigResult.rows[0].thresholds_json.floor_multipliers,
          scenario_prob_factors:
            scoringConfigResult.rows[0].thresholds_json.probability_factors,
          scenario_temperatures:
            scoringConfigResult.rows[0].thresholds_json.temperatures,
          scenario_thresholds:
            scoringConfigResult.rows[0].thresholds_json.thresholds,
        }
      : undefined,
    scoringConfigActive: scoringConfigResult.rows.length > 0,
    serpVisibilityAdjustments: visibilityAdjustmentResult.rows.map((row) => ({
      device: row.device,
      featureType: row.feature_type,
      intent: row.search_intent,
      multiplier: Number(row.multiplier),
    })),
  };
}

async function persistGscPromotion(
  client: PoolClient,
  projectId: string,
  output: GscPromotionStageData,
): Promise<void> {
  const values = output.keywords.map((keyword) => ({
    avg_monthly_volume: keyword.avgMonthlyVolume,
    gsc_clicks: keyword.gsc?.clicks ?? null,
    gsc_ctr: keyword.gsc?.ctr ?? null,
    gsc_devices: keyword.gsc?.devices ?? null,
    gsc_impressions: keyword.gsc?.impressions ?? null,
    gsc_position: keyword.gsc?.position ?? null,
    id: keyword.id,
    keyword: keyword.text,
    keyword_difficulty: keyword.keywordDifficulty,
    normalised_keyword: keyword.normalisedText,
    ranking_url: keyword.rankingUrl,
    sources: keyword.sources,
  }));
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
          ranking_url,
          gsc_clicks,
          gsc_impressions,
          gsc_ctr,
          gsc_position,
          gsc_devices
        )
        SELECT
          input.id,
          $1,
          input.keyword,
          input.normalised_keyword,
          input.sources,
          input.avg_monthly_volume,
          input.keyword_difficulty,
          input.ranking_url,
          input.gsc_clicks,
          input.gsc_impressions,
          input.gsc_ctr,
          input.gsc_position,
          input.gsc_devices
        FROM jsonb_to_recordset($2::jsonb) AS input(
          id uuid,
          keyword text,
          normalised_keyword text,
          sources text[],
          avg_monthly_volume integer,
          keyword_difficulty numeric,
          ranking_url text,
          gsc_clicks integer,
          gsc_impressions integer,
          gsc_ctr numeric,
          gsc_position numeric,
          gsc_devices text[]
        )
        ON CONFLICT (project_id, normalised_keyword)
        DO UPDATE SET
          sources = EXCLUDED.sources,
          ranking_url = COALESCE(keywords.ranking_url, EXCLUDED.ranking_url),
          gsc_clicks = EXCLUDED.gsc_clicks,
          gsc_impressions = EXCLUDED.gsc_impressions,
          gsc_ctr = EXCLUDED.gsc_ctr,
          gsc_position = EXCLUDED.gsc_position,
          gsc_devices = EXCLUDED.gsc_devices,
          updated_at = now()
      `,
    [projectId, JSON.stringify(values)],
  );
  if ((result.rowCount ?? 0) !== values.length) {
    throw new Error("GSC promotion did not persist every processing keyword.");
  }
}

async function persistDetox(
  client: PoolClient,
  projectId: string,
  output: DetoxStageData,
): Promise<void> {
  const decisions = output.keywords.map((keyword) => ({
    decision: keyword.detox.decision,
    id: keyword.id,
    reason: keyword.detox.reason,
    rule: keyword.detox.rule,
  }));
  const result = await client.query(
    `
      UPDATE keywords AS keyword
      SET detox_status = decision.decision,
          detox_reason = decision.reason,
          detox_rule = decision.rule,
          human_reviewed = CASE
            WHEN decision.rule = 'pre-curated' THEN true
            WHEN decision.decision = 'keep' THEN keyword.human_reviewed
            ELSE false
          END,
          categorisation_status = CASE
            WHEN decision.decision = 'keep' THEN keyword.categorisation_status
            ELSE 'skipped'
          END,
          category = CASE WHEN decision.decision = 'keep' THEN keyword.category ELSE NULL END,
          tags = CASE WHEN decision.decision = 'keep' THEN keyword.tags ELSE NULL END,
          search_intent = CASE
            WHEN decision.decision = 'keep' THEN keyword.search_intent
            ELSE NULL
          END,
          categorisation_tier = CASE
            WHEN decision.decision = 'keep' THEN keyword.categorisation_tier
            ELSE NULL
          END,
          categorisation_source = CASE
            WHEN decision.decision = 'keep' THEN keyword.categorisation_source
            ELSE NULL
          END,
          updated_at = now()
      FROM jsonb_to_recordset($2::jsonb) AS decision(
        id uuid,
        decision text,
        reason text,
        rule text
      )
      WHERE keyword.project_id = $1
        AND keyword.id = decision.id
    `,
    [projectId, JSON.stringify(decisions)],
  );
  if ((result.rowCount ?? 0) !== decisions.length) {
    throw new Error("Detox persistence did not update every processing keyword.");
  }
}

function uniqueById<T extends { id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (!item.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

async function persistCategorisation(
  client: PoolClient,
  projectId: string,
  output: CategorisationStageData,
): Promise<void> {
  const classifications = uniqueById(
    output.keywords.map((keyword) => ({
      category: keyword.categorisation.category,
      id: keyword.id,
      intent: keyword.categorisation.intent,
      source: keyword.categorisation.source,
      tags: keyword.categorisation.tags,
      tier: keyword.categorisation.tier,
    })),
  );
  const result = await client.query(
    `
      UPDATE keywords AS keyword
      SET category = classification.category,
          tags = classification.tags,
          search_intent = classification.intent,
          categorisation_tier = classification.tier,
          categorisation_source = classification.source,
          categorisation_status = 'done',
          categorisation_last_error = NULL,
          categorisation_locked_at = NULL,
          updated_at = now()
      FROM jsonb_to_recordset($2::jsonb) AS classification(
        id uuid,
        category text,
        tags text[],
        intent text,
        tier text,
        source text
      )
      WHERE keyword.project_id = $1
        AND keyword.id = classification.id
        AND keyword.detox_status = 'keep'
    `,
    [projectId, JSON.stringify(classifications)],
  );
  if ((result.rowCount ?? 0) !== classifications.length) {
    throw new Error("Categorisation persistence did not update every kept keyword.");
  }
}

async function persistKeywordEnrichment(
  client: PoolClient,
  projectId: string,
  output: KeywordEnrichmentStageData,
): Promise<void> {
  const values = uniqueById(output.keywords.map((keyword) => ({
    avg_monthly_volume: keyword.enrichment.avgMonthlyVolume,
    category: keyword.category,
    competitive_eligible: keyword.enrichment.competitiveEligible,
    competitive_eligibility_reason:
      keyword.enrichment.competitiveEligibilityReason,
    core_keyword: keyword.enrichment.coreKeyword,
    id: keyword.id,
    intent: keyword.enrichment.intent,
    keyword_difficulty: keyword.enrichment.keywordDifficulty,
    source: keyword.enrichment.source,
    volume_source: keyword.enrichment.volumeSource,
  })));
  const result = await client.query(
    `
      UPDATE keywords AS keyword
      SET avg_monthly_volume = enrichment.avg_monthly_volume,
          category = COALESCE(keyword.category, enrichment.category),
          keyword_difficulty = enrichment.keyword_difficulty,
          core_keyword = enrichment.core_keyword,
          core_keyword_source = 'dataforseo_or_form',
          volume_source = enrichment.volume_source,
          competitive_eligible = enrichment.competitive_eligible,
          competitive_eligibility_reason = enrichment.competitive_eligibility_reason,
          search_intent = enrichment.intent,
          intent_source = enrichment.source,
          enrichment_source = enrichment.source,
          volume_fetched_at = CASE
            WHEN enrichment.avg_monthly_volume IS NULL THEN keyword.volume_fetched_at
            ELSE now()
          END,
          difficulty_fetched_at = CASE
            WHEN enrichment.keyword_difficulty IS NULL THEN keyword.difficulty_fetched_at
            ELSE now()
          END,
          intent_fetched_at = now(),
          updated_at = now()
      FROM jsonb_to_recordset($2::jsonb) AS enrichment(
        id uuid,
        avg_monthly_volume integer,
        category text,
        keyword_difficulty numeric,
        core_keyword text,
        intent text,
        source text,
        volume_source text,
        competitive_eligible boolean,
        competitive_eligibility_reason text
      )
      WHERE keyword.project_id = $1
        AND keyword.id = enrichment.id
        AND keyword.detox_status = 'keep'
    `,
    [projectId, JSON.stringify(values)],
  );
  if ((result.rowCount ?? 0) !== values.length) {
    throw new Error("Keyword enrichment did not update every kept keyword.");
  }
}

async function persistRankingUrl(
  client: PoolClient,
  projectId: string,
  output: RankingUrlStageData,
): Promise<void> {
  const values = output.keywords.map((keyword) => ({
    id: keyword.id,
    rank: keyword.rank,
    ranking_url: keyword.rankingUrl,
    status: keyword.status,
  }));
  const result = await client.query(
    `
      UPDATE keywords AS keyword
      SET ranking_url = CASE
            WHEN keyword.base_rank_source = 'serp_results' THEN keyword.ranking_url
            ELSE COALESCE(ranking.ranking_url, keyword.ranking_url)
          END,
          base_rank = CASE
            WHEN keyword.base_rank_source = 'serp_results' THEN keyword.base_rank
            ELSE COALESCE(ranking.rank, keyword.base_rank)
          END,
          base_rank_source = CASE
            WHEN keyword.base_rank_source = 'serp_results' THEN keyword.base_rank_source
            WHEN ranking.status = 'matched' THEN 'local-provider'
            ELSE keyword.base_rank_source
          END,
          ranking_lookup_checked_at = now(),
          ranking_lookup_no_match = ranking.status = 'no-match',
          updated_at = now()
      FROM jsonb_to_recordset($2::jsonb) AS ranking(
        id uuid,
        ranking_url text,
        rank integer,
        status text
      )
      WHERE keyword.project_id = $1
        AND keyword.id = ranking.id
        AND keyword.detox_status = 'keep'
    `,
    [projectId, JSON.stringify(values)],
  );
  if ((result.rowCount ?? 0) !== values.length) {
    throw new Error("Ranking URL persistence did not update every kept keyword.");
  }
}

async function persistGscIntent(
  client: PoolClient,
  projectId: string,
  output: GscIntentStageData,
): Promise<void> {
  const result = await client.query(
    `
      WITH latest_upload AS (
        SELECT id
        FROM gsc_uploads
        WHERE project_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      )
      UPDATE gsc_upload_keywords AS keyword
      SET search_intent = intent.intent,
          intent_source = CASE
            WHEN intent.intent = 'generic' THEN 'fallback'
            ELSE 'project-classification'
          END
      FROM latest_upload,
        jsonb_to_recordset($2::jsonb) AS intent(
          normalised_text text,
          intent text
        )
      WHERE keyword.upload_id = latest_upload.id
        AND keyword.normalised_query = intent.normalised_text
    `,
    [
      projectId,
      JSON.stringify(
        output.keywords.map((keyword) => ({
          intent: keyword.intent,
          normalised_text: keyword.normalisedText,
        })),
      ),
    ],
  );
  if ((result.rowCount ?? 0) === 0 && output.keywords.length > 0) {
    throw new Error("GSC intent persistence did not update the latest upload.");
  }
}

async function persistBrandClassification(
  client: PoolClient,
  projectId: string,
  output: BrandClassificationStageData,
): Promise<void> {
  const values = output.keywords.map((keyword) => ({
    confidence: keyword.confidence,
    id: keyword.id,
    is_branded: keyword.isBranded,
    matched_term: keyword.matchedTerm,
    normalised_text: keyword.normalisedText,
    source: keyword.source,
  }));
  const keywordResult = await client.query(
    `
      UPDATE keywords AS keyword
      SET is_branded = classification.is_branded,
          brand_confidence = classification.confidence,
          brand_source = classification.source,
          brand_matched_term = classification.matched_term,
          brand_classified_at = now(),
          updated_at = now()
      FROM jsonb_to_recordset($2::jsonb) AS classification(
        id uuid,
        normalised_text text,
        is_branded boolean,
        confidence numeric,
        source text,
        matched_term text
      )
      WHERE keyword.project_id = $1
        AND keyword.id = classification.id
    `,
    [projectId, JSON.stringify(values)],
  );
  if ((keywordResult.rowCount ?? 0) !== values.length) {
    throw new Error("Brand classification did not update every keyword.");
  }
  await client.query(
    `
      WITH latest_upload AS (
        SELECT id
        FROM gsc_uploads
        WHERE project_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      )
      UPDATE gsc_upload_keywords AS keyword
      SET is_branded = classification.is_branded,
          brand_confidence = classification.confidence,
          brand_source = classification.source,
          brand_matched_term = classification.matched_term,
          brand_classified_at = now()
      FROM latest_upload,
        jsonb_to_recordset($2::jsonb) AS classification(
          normalised_text text,
          is_branded boolean,
          confidence numeric,
          source text,
          matched_term text
        )
      WHERE keyword.upload_id = latest_upload.id
        AND keyword.normalised_query = classification.normalised_text
    `,
    [projectId, JSON.stringify(values)],
  );
}

async function persistSerpCollection(
  client: PoolClient,
  projectId: string,
  output: SerpCollectionStageData,
): Promise<void> {
  const statuses = output.keywords.map((keyword) => {
    const clientResult = keyword.results
      .filter((result) => result.isClientDomain)
      .sort((left, right) => left.rankAbsolute - right.rankAbsolute)[0];
    return {
      client_rank: clientResult?.rankAbsolute ?? null,
      client_url: clientResult?.url ?? null,
      id: keyword.id,
      source_keyword_id: keyword.sourceKeywordId,
      status: keyword.status,
    };
  });
  const statusResult = await client.query(
    `
      UPDATE keywords AS keyword
      SET serp_lookup_checked_at = CASE
            WHEN status.status = 'missing-provider' THEN keyword.serp_lookup_checked_at
            ELSE now()
          END,
          serp_lookup_no_result = CASE
            WHEN status.status = 'missing-provider' THEN keyword.serp_lookup_no_result
            ELSE status.status = 'no-result'
          END,
          serp_provider_missing = status.status = 'missing-provider',
          serp_inherited_from_keyword_id = CASE
            WHEN status.source_keyword_id <> keyword.id THEN status.source_keyword_id
            ELSE NULL
          END,
          base_rank = COALESCE(status.client_rank, keyword.base_rank),
          ranking_url = COALESCE(status.client_url, keyword.ranking_url),
          base_rank_source = CASE
            WHEN status.client_rank IS NOT NULL THEN 'serp_results'
            ELSE keyword.base_rank_source
          END,
          base_rank_checked_at = CASE
            WHEN status.client_rank IS NOT NULL THEN now()
            ELSE keyword.base_rank_checked_at
          END,
          updated_at = now()
      FROM jsonb_to_recordset($2::jsonb) AS status(
        id uuid,
        status text,
        source_keyword_id uuid,
        client_rank integer,
        client_url text
      )
      WHERE keyword.project_id = $1
        AND keyword.id = status.id
        AND keyword.detox_status = 'keep'
    `,
    [projectId, JSON.stringify(statuses)],
  );
  if ((statusResult.rowCount ?? 0) !== statuses.length) {
    throw new Error("SERP collection did not update every kept keyword.");
  }
  await client.query(
    `
      DELETE FROM serp_results AS result
      USING jsonb_to_recordset($2::jsonb) AS status(id uuid, status text)
      WHERE result.project_id = $1
        AND result.keyword_id = status.id
        AND status.status <> 'missing-provider'
    `,
    [projectId, JSON.stringify(statuses)],
  );
  for (const keyword of output.keywords) {
    if (keyword.status !== "missing-provider") {
      await client.query(
        `
          DELETE FROM project_serp_features
          WHERE project_id = $1
            AND keyword_id = $2
            AND source = 'dataforseo'
        `,
        [projectId, keyword.id],
      );
    }
    for (const feature of keyword.features) {
      await client.query(
        `
          INSERT INTO project_serp_features (
            project_id,
            keyword_id,
            device,
            feature_raw,
            result_type,
            source
          )
          VALUES ($1, $2, 'mobile', $3, $3, 'dataforseo')
          ON CONFLICT DO NOTHING
        `,
        [projectId, keyword.id, feature],
      );
    }
    for (const result of keyword.results) {
      await client.query(
        `
          INSERT INTO serp_results (
            project_id,
            keyword_id,
            rank_absolute,
            url,
            domain,
            is_client_domain
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (keyword_id, rank_absolute)
          DO UPDATE SET
            url = EXCLUDED.url,
            domain = EXCLUDED.domain,
            is_client_domain = EXCLUDED.is_client_domain,
            fetched_at = now()
        `,
        [
          projectId,
          keyword.id,
          result.rankAbsolute,
          result.url,
          result.domain,
          result.isClientDomain,
        ],
      );
    }
  }
}

async function persistRollupOutput(
  client: PoolClient,
  projectId: string,
  runId: string,
  output: RollupOutputStageData,
): Promise<void> {
  const result = await client.query(
    `
      INSERT INTO pipeline_rollups (
        pipeline_run_id,
        project_id,
        scenario,
        naive_expected_incremental_annual,
        cluster_deduped_expected_incremental_annual,
        double_count_annual,
        cluster_rollup,
        category_rollup,
        quarter_rollup,
        trend_rollup,
        confidence_distribution,
        cannibalisation_flags,
        provenance
      )
      SELECT
        $1,
        $2,
        rollup.scenario,
        rollup.naive_total,
        rollup.deduped_total,
        rollup.double_count,
        rollup.cluster_rollup,
        rollup.category_rollup,
        rollup.quarter_rollup,
        rollup.trend_rollup,
        $4,
        $5,
        $6
      FROM jsonb_to_recordset($3::jsonb) AS rollup(
        scenario text,
        naive_total numeric,
        deduped_total numeric,
        double_count numeric,
        cluster_rollup jsonb,
        category_rollup jsonb,
        quarter_rollup jsonb,
        trend_rollup jsonb
      )
      ON CONFLICT (pipeline_run_id, scenario)
      DO UPDATE SET
        naive_expected_incremental_annual = EXCLUDED.naive_expected_incremental_annual,
        cluster_deduped_expected_incremental_annual =
          EXCLUDED.cluster_deduped_expected_incremental_annual,
        double_count_annual = EXCLUDED.double_count_annual,
        cluster_rollup = EXCLUDED.cluster_rollup,
        category_rollup = EXCLUDED.category_rollup,
        quarter_rollup = EXCLUDED.quarter_rollup,
        trend_rollup = EXCLUDED.trend_rollup,
        confidence_distribution = EXCLUDED.confidence_distribution,
        cannibalisation_flags = EXCLUDED.cannibalisation_flags,
        provenance = EXCLUDED.provenance,
        computed_at = now()
    `,
    [
      runId,
      projectId,
      JSON.stringify(
        output.scenarios.map((scenario) => ({
          deduped_total: scenario.clusterDedupedExpectedIncrementalAnnual,
          double_count: scenario.doubleCountAnnual,
          category_rollup: scenario.categoryRollup,
          cluster_rollup: scenario.clusterRollup,
          naive_total: scenario.naiveExpectedIncrementalAnnual,
          quarter_rollup: scenario.quarterRollup,
          scenario: scenario.scenario,
          trend_rollup: scenario.trendRollup,
        })),
      ),
      JSON.stringify(output.confidenceDistribution),
      JSON.stringify(output.cannibalisationFlags),
      JSON.stringify({ clusterDeduped: true, handlerVersion: output.handlerVersion }),
    ],
  );
  if ((result.rowCount ?? 0) !== output.scenarios.length) {
    throw new Error("Rollup output did not persist every scenario.");
  }
}

async function persistAuthority(
  client: PoolClient,
  projectId: string,
  output: AuthorityStageData,
): Promise<void> {
  await client.query(
    `
      INSERT INTO client_domain_metrics (
        project_id,
        domain,
        url_rating,
        domain_rating,
        ahrefs_rank,
        referring_domains,
        backlinks,
        metric_source
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (project_id)
      DO UPDATE SET
        domain = EXCLUDED.domain,
        url_rating = EXCLUDED.url_rating,
        domain_rating = EXCLUDED.domain_rating,
        ahrefs_rank = EXCLUDED.ahrefs_rank,
        referring_domains = EXCLUDED.referring_domains,
        backlinks = EXCLUDED.backlinks,
        metric_source = EXCLUDED.metric_source,
        fetched_at = now()
    `,
    [
      projectId,
      output.authority.domain,
      output.authority.urlRating,
      output.authority.domainRating,
      output.authority.ahrefsRank,
      output.authority.referringDomains,
      output.authority.backlinks,
      output.authority.source,
    ],
  );
}

async function persistBacklinks(
  client: PoolClient,
  projectId: string,
  output: BacklinksStageData,
): Promise<void> {
  const values = output.keywords.flatMap((keyword) =>
    keyword.results.map((result) => ({
      ahrefs_rank: result.ahrefsRank,
      backlinks: result.backlinks,
      domain_rating: result.domainRating,
      keyword_id: keyword.id,
      metric_source: result.metricSource,
      rank_absolute: result.rankAbsolute,
      referring_domains: result.referringDomains,
      url_rating: result.urlRating,
    })),
  );
  if (values.length === 0) return;
  const result = await client.query(
    `
      UPDATE serp_results AS serp
      SET url_rating = metrics.url_rating,
          domain_rating = metrics.domain_rating,
          ahrefs_rank = metrics.ahrefs_rank,
          referring_domains = metrics.referring_domains,
          backlinks = metrics.backlinks,
          metric_source = metrics.metric_source,
          metrics_fetched_at = CASE
            WHEN metrics.metric_source = 'local-provider' THEN now()
            ELSE serp.metrics_fetched_at
          END
      FROM jsonb_to_recordset($2::jsonb) AS metrics(
        keyword_id uuid,
        rank_absolute integer,
        url_rating numeric,
        domain_rating numeric,
        ahrefs_rank bigint,
        referring_domains bigint,
        backlinks bigint,
        metric_source text
      )
      WHERE serp.project_id = $1
        AND serp.keyword_id = metrics.keyword_id
        AND serp.rank_absolute = metrics.rank_absolute
    `,
    [projectId, JSON.stringify(values)],
  );
  if ((result.rowCount ?? 0) !== values.length) {
    throw new Error("Backlink enrichment did not update every SERP result.");
  }
}

async function persistSiteArchitecture(
  client: PoolClient,
  projectId: string,
  runId: string,
  output: SiteArchitectureStageData,
): Promise<void> {
  const values = output.keywords.map((keyword) => ({
    content_status: keyword.contentStatus,
    id: keyword.id,
    matched_url: keyword.matchedUrl,
    provider_status: keyword.status,
    relevancy_score: keyword.relevancyScore,
    tactical_status: keyword.tacticalStatus,
  }));
  const result = await client.query(
    `
      INSERT INTO site_architecture (
        project_id,
        keyword_id,
        pipeline_run_id,
        matched_url,
        relevancy_score,
        content_status,
        tactical_status,
        provider_status
      )
      SELECT
        $1,
        keyword.id,
        $2,
        input.matched_url,
        input.relevancy_score,
        input.content_status,
        input.tactical_status,
        input.provider_status
      FROM jsonb_to_recordset($3::jsonb) AS input(
        id uuid,
        matched_url text,
        relevancy_score numeric,
        content_status text,
        tactical_status text,
        provider_status text
      )
      JOIN keywords AS keyword
        ON keyword.id = input.id
       AND keyword.project_id = $1
      ON CONFLICT (pipeline_run_id, keyword_id)
      DO UPDATE SET
        matched_url = EXCLUDED.matched_url,
        relevancy_score = EXCLUDED.relevancy_score,
        content_status = EXCLUDED.content_status,
        tactical_status = EXCLUDED.tactical_status,
        provider_status = EXCLUDED.provider_status,
        computed_at = now()
    `,
    [projectId, runId, JSON.stringify(values)],
  );
  if ((result.rowCount ?? 0) !== values.length) {
    throw new Error("Site architecture did not persist every kept keyword.");
  }
}

async function persistLinkPowerScore(
  client: PoolClient,
  projectId: string,
  runId: string,
  output: LinkPowerScoreStageData,
): Promise<void> {
  const values = output.keywords.flatMap((keyword) =>
    keyword.results.map((result) => ({
      confidence: result.confidence,
      keyword_id: keyword.id,
      rank_absolute: result.rankAbsolute,
      score: result.score,
    })),
  );
  if (values.length === 0) return;
  const result = await client.query(
    `
      INSERT INTO link_power_scores (
        project_id,
        keyword_id,
        serp_result_id,
        pipeline_run_id,
        score,
        confidence
      )
      SELECT
        $1,
        serp.keyword_id,
        serp.id,
        $2,
        input.score,
        input.confidence
      FROM jsonb_to_recordset($3::jsonb) AS input(
        keyword_id uuid,
        rank_absolute integer,
        score numeric,
        confidence text
      )
      JOIN serp_results AS serp
        ON serp.project_id = $1
       AND serp.keyword_id = input.keyword_id
       AND serp.rank_absolute = input.rank_absolute
      ON CONFLICT (pipeline_run_id, serp_result_id)
      DO UPDATE SET
        score = EXCLUDED.score,
        confidence = EXCLUDED.confidence,
        computed_at = now()
    `,
    [projectId, runId, JSON.stringify(values)],
  );
  if ((result.rowCount ?? 0) !== values.length) {
    throw new Error("Link power score did not persist every SERP result.");
  }
}

async function persistDemandSignals(
  client: PoolClient,
  projectId: string,
  runId: string,
  output: DemandSignalsStageData,
): Promise<void> {
  const values = output.keywords.map((keyword) => ({
    coverage_months: keyword.coverageMonths,
    demand_warning: keyword.demandWarning,
    demand_warning_reason: keyword.demandWarningReason,
    id: keyword.id,
    peak_months: keyword.peakMonths,
    seasonality_strength: keyword.seasonalityStrength,
    trend_confidence: keyword.trendConfidence,
    trend_direction: keyword.trendDirection,
    trend_pct: keyword.trendPct,
    trend_slope: keyword.trendSlope,
    volatility_score: keyword.volatilityScore,
  }));
  const result = await client.query(
    `
      INSERT INTO keyword_demand_signals (
        project_id,
        keyword_id,
        pipeline_run_id,
        coverage_months,
        trend_direction,
        trend_pct,
        trend_slope,
        trend_confidence,
        volatility_score,
        seasonality_strength,
        peak_months,
        demand_warning,
        demand_warning_reason
      )
      SELECT
        $1,
        keyword.id,
        $2,
        input.coverage_months,
        input.trend_direction,
        input.trend_pct,
        input.trend_slope,
        input.trend_confidence,
        input.volatility_score,
        input.seasonality_strength,
        input.peak_months,
        input.demand_warning,
        input.demand_warning_reason
      FROM jsonb_to_recordset($3::jsonb) AS input(
        id uuid,
        coverage_months integer,
        trend_direction text,
        trend_pct numeric,
        trend_slope numeric,
        trend_confidence text,
        volatility_score numeric,
        seasonality_strength numeric,
        peak_months integer[],
        demand_warning boolean,
        demand_warning_reason text
      )
      JOIN keywords AS keyword
        ON keyword.id = input.id
       AND keyword.project_id = $1
      ON CONFLICT (pipeline_run_id, keyword_id)
      DO UPDATE SET
        coverage_months = EXCLUDED.coverage_months,
        trend_direction = EXCLUDED.trend_direction,
        trend_pct = EXCLUDED.trend_pct,
        trend_slope = EXCLUDED.trend_slope,
        trend_confidence = EXCLUDED.trend_confidence,
        volatility_score = EXCLUDED.volatility_score,
        seasonality_strength = EXCLUDED.seasonality_strength,
        peak_months = EXCLUDED.peak_months,
        demand_warning = EXCLUDED.demand_warning,
        demand_warning_reason = EXCLUDED.demand_warning_reason,
        computed_at = now()
    `,
    [projectId, runId, JSON.stringify(values)],
  );
  if ((result.rowCount ?? 0) !== values.length) {
    throw new Error("Demand signals did not persist every kept keyword.");
  }
}

async function persistCtrCurves(
  client: PoolClient,
  projectId: string,
  runId: string,
  output: CtrCurvesStageData,
): Promise<void> {
  for (const curve of output.curves) {
    const curveResult = await client.query<{ id: string }>(
      `
        INSERT INTO ctr_curves (
          project_id,
          pipeline_run_id,
          device,
          search_intent,
          is_branded,
          source_date_range_start,
          source_date_range_end,
          source_sample_size,
          provenance
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (pipeline_run_id, device, search_intent, is_branded)
        DO UPDATE SET
          source_date_range_start = EXCLUDED.source_date_range_start,
          source_date_range_end = EXCLUDED.source_date_range_end,
          source_sample_size = EXCLUDED.source_sample_size,
          provenance = EXCLUDED.provenance,
          computed_at = now()
        RETURNING id
      `,
      [
        projectId,
        runId,
        curve.device,
        curve.intent,
        curve.isBranded,
        output.provenance.dateRangeStart,
        output.provenance.dateRangeEnd,
        curve.points.reduce((sum, point) => sum + point.impressions, 0),
        JSON.stringify({
          ...output.provenance,
          curveSource: curve.points.some((point) => point.source === "gsc")
            ? "measured_or_blended"
            : "global_fallback",
        }),
      ],
    );
    const curveId = curveResult.rows[0]?.id;
    if (!curveId) throw new Error("CTR curve did not return an identifier.");
    const pointResult = await client.query(
      `
        INSERT INTO ctr_curve_points (
          curve_id,
          rank,
          ctr,
          impressions,
          confidence,
          source
        )
        SELECT
          $1,
          point.rank,
          point.ctr,
          point.impressions,
          point.confidence,
          point.source
        FROM jsonb_to_recordset($2::jsonb) AS point(
          rank integer,
          ctr numeric,
          impressions bigint,
          confidence text,
          source text
        )
        ON CONFLICT (curve_id, rank)
        DO UPDATE SET
          ctr = EXCLUDED.ctr,
          impressions = EXCLUDED.impressions,
          confidence = EXCLUDED.confidence,
          source = EXCLUDED.source
      `,
      [curveId, JSON.stringify(curve.points)],
    );
    if ((pointResult.rowCount ?? 0) !== curve.points.length) {
      throw new Error("CTR curve did not persist every rank.");
    }
  }
}

async function persistClustering(
  client: PoolClient,
  projectId: string,
  runId: string,
  output: ClusteringStageData,
): Promise<void> {
  const groups = new Map<string, ClusteringStageData["keywords"]>();
  for (const keyword of output.keywords) {
    groups.set(keyword.clusterKey, [
      ...(groups.get(keyword.clusterKey) ?? []),
      keyword,
    ]);
  }
  const clusters = [...groups.entries()].map(([key, members]) => {
    const canonical = members.find((member) => member.isCanonical);
    if (!canonical) throw new Error(`Cluster ${key} has no canonical keyword.`);
    return {
      canonical_basis: canonical.canonicalBasis,
      canonical_keyword_id: canonical.canonicalKeywordId,
      cluster_key: key,
      member_count: members.length,
    };
  });
  let persistedClusterCount = 0;
  for (const batch of batches(clusters, FORECAST_PERSISTENCE_BATCH_SIZE)) {
    const clusterResult = await client.query(
      `
      INSERT INTO keyword_clusters (
        project_id,
        pipeline_run_id,
        cluster_key,
        canonical_keyword_id,
        canonical_basis,
        member_count
      )
      SELECT
        $1,
        $2,
        input.cluster_key,
        input.canonical_keyword_id,
        input.canonical_basis,
        input.member_count
      FROM jsonb_to_recordset($3::jsonb) AS input(
        cluster_key text,
        canonical_keyword_id uuid,
        canonical_basis text,
        member_count integer
      )
      JOIN keywords AS keyword
        ON keyword.id = input.canonical_keyword_id
       AND keyword.project_id = $1
      ON CONFLICT (pipeline_run_id, cluster_key)
      DO UPDATE SET
        canonical_keyword_id = EXCLUDED.canonical_keyword_id,
        canonical_basis = EXCLUDED.canonical_basis,
        member_count = EXCLUDED.member_count,
        computed_at = now()
    `,
      [projectId, runId, JSON.stringify(batch)],
    );
    persistedClusterCount += clusterResult.rowCount ?? 0;
  }
  if (persistedClusterCount !== clusters.length) {
    throw new Error("Clustering did not persist every cluster.");
  }
  await client.query(
    `
      DELETE FROM keyword_cluster_members AS member
      USING keyword_clusters AS cluster
      WHERE member.cluster_id = cluster.id
        AND cluster.project_id = $1
        AND cluster.pipeline_run_id = $2
    `,
    [projectId, runId],
  );
  const members = output.keywords.map((keyword) => ({
    cluster_key: keyword.clusterKey,
    is_canonical: keyword.isCanonical,
    keyword_id: keyword.id,
  }));
  let persistedMemberCount = 0;
  for (const batch of batches(members, FORECAST_PERSISTENCE_BATCH_SIZE)) {
    const memberResult = await client.query(
      `
      INSERT INTO keyword_cluster_members (
        cluster_id,
        keyword_id,
        is_canonical
      )
      SELECT cluster.id, keyword.id, input.is_canonical
      FROM jsonb_to_recordset($3::jsonb) AS input(
        cluster_key text,
        keyword_id uuid,
        is_canonical boolean
      )
      JOIN keyword_clusters AS cluster
        ON cluster.project_id = $1
       AND cluster.pipeline_run_id = $2
       AND cluster.cluster_key = input.cluster_key
      JOIN keywords AS keyword
        ON keyword.id = input.keyword_id
       AND keyword.project_id = $1
    `,
      [projectId, runId, JSON.stringify(batch)],
    );
    persistedMemberCount += memberResult.rowCount ?? 0;
  }
  if (persistedMemberCount !== members.length) {
    throw new Error("Clustering did not persist every cluster member.");
  }
}

async function persistHarV2(
  client: PoolClient,
  projectId: string,
  runId: string,
  output: HarV2StageData,
): Promise<void> {
  const values = output.keywords.flatMap((keyword) =>
    keyword.scenarios.map((scenario) => ({
      authority_score: scenario.authorityScore,
      base_rank: keyword.baseRank,
      content_fit_score: scenario.contentFitScore,
      explanation_json: scenario.explanation,
      har_confidence: scenario.confidence,
      har_position: scenario.harPosition,
      keyword_id: keyword.id,
      link_gap_score: scenario.linkGapScore,
      link_power_score: scenario.linkPowerScore,
      rank_attainment_probability: scenario.rankAttainmentProbability,
      scenario: scenario.scenario,
      serp_visibility_multiplier: scenario.serpVisibilityMultiplier,
    })),
  );
  let persistedCount = 0;
  for (const batch of batches(values, FORECAST_PERSISTENCE_BATCH_SIZE)) {
    const result = await client.query(
      `
      INSERT INTO har_forecasts (
        project_id,
        keyword_id,
        pipeline_run_id,
        scenario,
        model_version,
        base_rank,
        har_position,
        har_confidence,
        rank_attainment_probability,
        authority_score,
        link_power_score,
        link_gap_score,
        content_fit_score,
        serp_visibility_multiplier,
        explanation_json
      )
      SELECT
        $1,
        keyword.id,
        $2,
        input.scenario,
        $3,
        input.base_rank,
        input.har_position,
        input.har_confidence,
        input.rank_attainment_probability,
        input.authority_score,
        input.link_power_score,
        input.link_gap_score,
        input.content_fit_score,
        input.serp_visibility_multiplier,
        input.explanation_json
      FROM jsonb_to_recordset($4::jsonb) AS input(
        keyword_id uuid,
        scenario text,
        base_rank integer,
        har_position integer,
        har_confidence numeric,
        rank_attainment_probability numeric,
        authority_score numeric,
        link_power_score numeric,
        link_gap_score numeric,
        content_fit_score numeric,
        serp_visibility_multiplier numeric,
        explanation_json jsonb
      )
      JOIN keywords AS keyword
        ON keyword.id = input.keyword_id
       AND keyword.project_id = $1
      ON CONFLICT (pipeline_run_id, keyword_id, scenario)
      DO UPDATE SET
        model_version = EXCLUDED.model_version,
        base_rank = EXCLUDED.base_rank,
        har_position = EXCLUDED.har_position,
        har_confidence = EXCLUDED.har_confidence,
        rank_attainment_probability = EXCLUDED.rank_attainment_probability,
        authority_score = EXCLUDED.authority_score,
        link_power_score = EXCLUDED.link_power_score,
        link_gap_score = EXCLUDED.link_gap_score,
        content_fit_score = EXCLUDED.content_fit_score,
        serp_visibility_multiplier = EXCLUDED.serp_visibility_multiplier,
        explanation_json = EXCLUDED.explanation_json,
        computed_at = now()
      `,
      [projectId, runId, output.modelVersion, JSON.stringify(batch)],
    );
    persistedCount += result.rowCount ?? 0;
  }
  if (persistedCount !== values.length) {
    throw new Error("HAR v2 did not persist every scenario.");
  }
}

async function persistRevenueV2(
  client: PoolClient,
  projectId: string,
  runId: string,
  output: RevenueV2StageData,
): Promise<void> {
  const values = output.keywords.flatMap((keyword) =>
    keyword.scenarios.map((scenario) => ({
      annual_volume: scenario.annualVolume,
      average_order_value_override_id:
        scenario.averageOrderValueOverrideId,
      average_order_value_used: scenario.averageOrderValueUsed,
      ctr_now: scenario.ctrNow,
      ctr_target: scenario.ctrTarget,
      conversion_rate_override_id: scenario.conversionRateOverrideId,
      conversion_rate_used: scenario.conversionRateUsed,
      current_revenue_annual: scenario.currentRevenueAnnual,
      expected_incremental_annual: scenario.expectedIncrementalAnnual,
      expected_incremental_high_annual:
        scenario.expectedIncrementalHighAnnual,
      expected_incremental_low_annual:
        scenario.expectedIncrementalLowAnnual,
      factor_applied: scenario.factorApplied,
      band_method: scenario.bandMethod,
      har_conf_used: scenario.harConfidenceUsed,
      keyword_id: keyword.id,
      modelled_monthly_clicks: scenario.modelledMonthlyClicks,
      monthly_revenue_json: scenario.monthlyRevenue,
      p_att_used: scenario.rankAttainmentProbabilityUsed,
      scenario: scenario.scenario,
      svm_used: scenario.serpVisibilityMultiplierUsed,
      target_absolute_revenue_annual:
        scenario.targetAbsoluteRevenueAnnual,
      target_incremental_revenue_annual:
        scenario.targetIncrementalRevenueAnnual,
      volume_forward: scenario.volumeForward,
      warnings: scenario.warnings,
    })),
  );
  let persistedCount = 0;
  for (const batch of batches(values, FORECAST_PERSISTENCE_BATCH_SIZE)) {
    const result = await client.query(
      `
      INSERT INTO revenue_forecasts (
        project_id,
        keyword_id,
        pipeline_run_id,
        scenario,
        model_version,
        annual_volume,
        volume_forward,
        factor_applied,
        conversion_rate_used,
        average_order_value_used,
        conversion_rate_override_id,
        average_order_value_override_id,
        monthly_revenue_json,
        svm_used,
        p_att_used,
        har_conf_used,
        band_method,
        ctr_now,
        ctr_target,
        current_revenue_annual,
        target_absolute_revenue_annual,
        target_incremental_revenue_annual,
        expected_incremental_annual,
        expected_incremental_low_annual,
        expected_incremental_high_annual,
        modelled_monthly_clicks,
        warnings
      )
      SELECT
        $1,
        keyword.id,
        $2,
        input.scenario,
        $3,
        input.annual_volume,
        input.volume_forward,
        input.factor_applied,
        input.conversion_rate_used,
        input.average_order_value_used,
        input.conversion_rate_override_id,
        input.average_order_value_override_id,
        input.monthly_revenue_json,
        input.svm_used,
        input.p_att_used,
        input.har_conf_used,
        input.band_method,
        input.ctr_now,
        input.ctr_target,
        input.current_revenue_annual,
        input.target_absolute_revenue_annual,
        input.target_incremental_revenue_annual,
        input.expected_incremental_annual,
        input.expected_incremental_low_annual,
        input.expected_incremental_high_annual,
        input.modelled_monthly_clicks,
        input.warnings
      FROM jsonb_to_recordset($4::jsonb) AS input(
        keyword_id uuid,
        scenario text,
        annual_volume numeric,
        volume_forward numeric,
        factor_applied numeric,
        conversion_rate_used numeric,
        average_order_value_used numeric,
        conversion_rate_override_id uuid,
        average_order_value_override_id uuid,
        monthly_revenue_json jsonb,
        svm_used numeric,
        p_att_used numeric,
        har_conf_used numeric,
        band_method text,
        ctr_now numeric,
        ctr_target numeric,
        current_revenue_annual numeric,
        target_absolute_revenue_annual numeric,
        target_incremental_revenue_annual numeric,
        expected_incremental_annual numeric,
        expected_incremental_low_annual numeric,
        expected_incremental_high_annual numeric,
        modelled_monthly_clicks numeric,
        warnings text[]
      )
      JOIN keywords AS keyword
        ON keyword.id = input.keyword_id
       AND keyword.project_id = $1
      ON CONFLICT (pipeline_run_id, keyword_id, scenario)
      DO UPDATE SET
        model_version = EXCLUDED.model_version,
        annual_volume = EXCLUDED.annual_volume,
        volume_forward = EXCLUDED.volume_forward,
        factor_applied = EXCLUDED.factor_applied,
        conversion_rate_used = EXCLUDED.conversion_rate_used,
        average_order_value_used = EXCLUDED.average_order_value_used,
        conversion_rate_override_id = EXCLUDED.conversion_rate_override_id,
        average_order_value_override_id =
          EXCLUDED.average_order_value_override_id,
        monthly_revenue_json = EXCLUDED.monthly_revenue_json,
        svm_used = EXCLUDED.svm_used,
        p_att_used = EXCLUDED.p_att_used,
        har_conf_used = EXCLUDED.har_conf_used,
        band_method = EXCLUDED.band_method,
        ctr_now = EXCLUDED.ctr_now,
        ctr_target = EXCLUDED.ctr_target,
        current_revenue_annual = EXCLUDED.current_revenue_annual,
        target_absolute_revenue_annual =
          EXCLUDED.target_absolute_revenue_annual,
        target_incremental_revenue_annual =
          EXCLUDED.target_incremental_revenue_annual,
        expected_incremental_annual = EXCLUDED.expected_incremental_annual,
        expected_incremental_low_annual =
          EXCLUDED.expected_incremental_low_annual,
        expected_incremental_high_annual =
          EXCLUDED.expected_incremental_high_annual,
        modelled_monthly_clicks = EXCLUDED.modelled_monthly_clicks,
        warnings = EXCLUDED.warnings,
        computed_at = now()
      `,
      [projectId, runId, output.modelVersion, JSON.stringify(batch)],
    );
    persistedCount += result.rowCount ?? 0;
  }
  if (persistedCount !== values.length) {
    throw new Error("Revenue v2 did not persist every scenario.");
  }
}

async function persistCalibration(
  client: PoolClient,
  projectId: string,
  runId: string,
  output: CalibrationStageData,
): Promise<void> {
  await client.query(
    `
      INSERT INTO calibration_snapshots (
        project_id,
        pipeline_run_id,
        model_version,
        overall_ratio,
        median_per_pair_ratio,
        sum_modelled_monthly,
        sum_actual_monthly,
        impressions_context,
        promotion_eligible,
        unavailable_reason,
        status,
        matched,
        excluded_noise_floor,
        pair_count,
        by_intent,
        by_rank_band
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, $15, $16
      )
      ON CONFLICT (pipeline_run_id)
      DO UPDATE SET
        model_version = EXCLUDED.model_version,
        overall_ratio = EXCLUDED.overall_ratio,
        median_per_pair_ratio = EXCLUDED.median_per_pair_ratio,
        sum_modelled_monthly = EXCLUDED.sum_modelled_monthly,
        sum_actual_monthly = EXCLUDED.sum_actual_monthly,
        impressions_context = EXCLUDED.impressions_context,
        promotion_eligible = EXCLUDED.promotion_eligible,
        unavailable_reason = EXCLUDED.unavailable_reason,
        status = EXCLUDED.status,
        matched = EXCLUDED.matched,
        excluded_noise_floor = EXCLUDED.excluded_noise_floor,
        pair_count = EXCLUDED.pair_count,
        by_intent = EXCLUDED.by_intent,
        by_rank_band = EXCLUDED.by_rank_band,
        computed_at = now()
    `,
    [
      projectId,
      runId,
      output.modelVersion,
      output.overallRatio,
      output.medianPerPairRatio,
      output.sumModelledMonthly,
      output.sumActualMonthly,
      output.impressionsContext,
      output.promotionEligible,
      output.unavailableReason,
      output.status,
      output.matched,
      output.excludedNoiseFloor,
      output.keywords.length,
      JSON.stringify(output.byIntent),
      JSON.stringify(output.byRankBand),
    ],
  );
}

export async function persistProjectStageData(
  client: PoolClient,
  projectId: string,
  runId: string,
  output: DataDrivenStageData,
): Promise<void> {
  switch (output.handlerVersion) {
    case "intake-v1":
      return;
    case "gsc-promotion-v1":
      await persistGscPromotion(client, projectId, output);
      return;
    case "detox-v1":
      await persistDetox(client, projectId, output);
      return;
    case "preflight-v1":
    case "historical-volume-v1":
    case "har-readiness-v1":
    case "revenue-readiness-v1":
      return;
    case "categorisation-v1":
      await persistCategorisation(client, projectId, output);
      return;
    case "keyword-enrichment-v1":
      await persistKeywordEnrichment(client, projectId, output);
      return;
    case "ranking-url-v1":
      await persistRankingUrl(client, projectId, output);
      return;
    case "gsc-intent-v1":
      await persistGscIntent(client, projectId, output);
      return;
    case "brand-classification-v1":
      await persistBrandClassification(client, projectId, output);
      return;
    case "serp-collection-v1":
      await persistSerpCollection(client, projectId, output);
      return;
    case "authority-v1":
      await persistAuthority(client, projectId, output);
      return;
    case "backlinks-v1":
      await persistBacklinks(client, projectId, output);
      return;
    case "site-architecture-v1":
      await persistSiteArchitecture(client, projectId, runId, output);
      return;
    case "link-power-score-v1":
      await persistLinkPowerScore(client, projectId, runId, output);
      return;
    case "demand-signals-v1":
      await persistDemandSignals(client, projectId, runId, output);
      return;
    case "ctr-curves-v1":
      await persistCtrCurves(client, projectId, runId, output);
      return;
    case "clustering-v1":
      await persistClustering(client, projectId, runId, output);
      return;
    case "har-v2.1":
      await persistHarV2(client, projectId, runId, output);
      return;
    case "revenue-v2.1":
      await persistRevenueV2(client, projectId, runId, output);
      return;
    case "calibration-v1":
      await persistCalibration(client, projectId, runId, output);
      return;
    case "rollup-output-v1":
      await persistRollupOutput(client, projectId, runId, output);
      return;
  }
}
