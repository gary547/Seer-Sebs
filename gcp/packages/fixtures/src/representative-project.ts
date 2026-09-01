export type DetoxDecision = "keep" | "remove" | "review";
export type KeywordTier = "live" | "deferred" | null;
export type SearchIntent =
  | "transactional"
  | "commercial"
  | "informational"
  | "navigational"
  | null;

export interface SyntheticKeyword {
  avgMonthlyVolume: number | null;
  category?: string | null;
  coreKeyword?: string | null;
  id: string;
  keywordDifficulty: number | null;
  preCurated?: boolean;
  rankingUrl: string | null;
  searchIntent?: SearchIntent;
  text: string;
  volumeSource?: "manual" | "provider" | null;
}

export interface SyntheticGscRow {
  clicks: number;
  ctr: number;
  device: "all" | "desktop" | "mobile" | "tablet";
  impressions: number;
  page: string;
  position: number;
  query: string;
}

export interface SyntheticProviderKeyword {
  avgMonthlyVolume: number | null;
  coreKeyword?: string | null;
  intent: SearchIntent;
  keywordDifficulty: number | null;
  monthlyVolumes: Array<{
    month: string;
    volume: number;
  }>;
  rank: number | null;
  rankingUrl: string | null;
  text: string;
}

export interface SyntheticSerpResult {
  ahrefsRank: number | null;
  backlinks: number | null;
  domain: string;
  domainRating: number | null;
  rankAbsolute: number;
  referringDomains: number | null;
  url: string;
  urlRating: number | null;
}

export interface SyntheticProviderSerpKeyword {
  features?: string[];
  results: SyntheticSerpResult[];
  text: string;
}

export interface SyntheticProviderSiteArchitectureKeyword {
  contentStatus: "amber" | "green" | "red";
  matchedUrl: string | null;
  relevancyScore: number;
  tacticalStatus:
    | "create_content"
    | "green"
    | "new_content"
    | "no_action_needed"
    | "optimise_content";
  text: string;
}

export interface ExpectedKeywordOutcome {
  category: string | null;
  detoxDecision: DetoxDecision;
  intent: SearchIntent;
  text: string;
  tier: KeywordTier;
}

export interface RepresentativeSourceSummary {
  gscDistinctQueryCount: number;
  gscPromotionCandidateCount: number;
  gscRowCount: number;
  sourceKeywordCount: number;
  sourceMissingRankingUrlCount: number;
}

export interface RepresentativePipelineSummary {
  deferredKeywordCount: number;
  keptKeywordCount: number;
  liveKeywordCount: number;
  missingRankingUrlCount: number;
  processingKeywordCount: number;
  removedKeywordCount: number;
  reviewKeywordCount: number;
}

export interface RepresentativeExpectedOutcomes {
  keywordOutcomes: ExpectedKeywordOutcome[];
  promotedQueries: string[];
  summary: RepresentativePipelineSummary;
}

export type ConversionOverrideScope = "category" | "intent" | "project" | "url";

export interface ProjectConversionOverride {
  averageOrderValue: number | null;
  conversionRate: number | null;
  id: string;
  scopeType: ConversionOverrideScope;
  scopeValue: string | null;
}

export interface ProjectPipelineSource {
  authority: {
    backlinks: number;
    domainRating: number;
    referringDomains: number;
  };
  client: {
    brandTerms: string[];
    companyName: string;
    domain: string;
    id: string;
    industry: string;
  };
  economics: {
    averageOrderValue: number | null;
    conversionRate: number | null;
    gscDateRangeEnd?: string | null;
    gscDateRangeStart?: string | null;
    gscWindowDays: number;
  };
  conversionOverrides: ProjectConversionOverride[];
  gscRows: SyntheticGscRow[];
  keywords: SyntheticKeyword[];
  project: {
    categoryFocus: string;
    clientId: string;
    country: string;
    currency: string;
    id: string;
    language: string;
    name: string;
    policy?: {
      competitiveEnrichmentVolumeFloor: number;
      gscPromotionImpressionsFloor: number;
      reviewedAt: string | null;
    };
  };
  competitorDomains?: string[];
  scoringConfig?: {
    config_id?: string | null;
    config_version?: string | null;
    min_confidence?: number | null;
    scenario_floor_multipliers?: Partial<Record<"conservative" | "realistic" | "stretch", number>>;
    scenario_prob_factors?: Partial<Record<"conservative" | "realistic" | "stretch", number>>;
    scenario_temperatures?: Partial<Record<"conservative" | "realistic" | "stretch", number>>;
    scenario_thresholds?: Partial<Record<"conservative" | "realistic" | "stretch", number>>;
  };
  scoringConfigActive?: boolean;
  serpVisibilityAdjustments?: Array<{
    device: "all" | "desktop" | "mobile" | "tablet";
    featureType: string;
    intent: Exclude<SearchIntent, null> | "generic";
    multiplier: number;
  }>;
  providerInputs: {
    keywords: SyntheticProviderKeyword[];
    serpKeywords: SyntheticProviderSerpKeyword[];
    siteArchitectureKeywords: SyntheticProviderSiteArchitectureKeyword[];
  };
  rules: {
    blacklist: string[];
    competitorBrands: string[];
    ownBrands: string[];
    relevantTerms: string[];
    whitelist: string[];
  };
}

export interface RepresentativeProjectFixture extends ProjectPipelineSource {
  expected: RepresentativeExpectedOutcomes;
  schemaVersion: "1.1";
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return value.trim();
}

function stringArray(value: unknown, path: string): string[] {
  return array(value, path).map((item, index) => string(item, `${path}[${index}]`));
}

function uuid(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (!UUID_PATTERN.test(parsed)) {
    throw new Error(`${path} must be a UUID.`);
  }
  return parsed;
}

function number(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new Error(`${path} must be a number greater than or equal to ${minimum}.`);
  }
  return value;
}

function nullableNumber(value: unknown, path: string): number | null {
  return value === null ? null : number(value, path);
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : string(value, path);
}

function parseConversionOverride(
  value: unknown,
  index: number,
): ProjectConversionOverride {
  const path = `conversionOverrides[${index}]`;
  const item = record(value, path);
  const scopeType = literal(
    item.scopeType,
    ["category", "intent", "project", "url"] as const,
    `${path}.scopeType`,
  );
  const scopeValue =
    item.scopeValue === null || item.scopeValue === undefined
      ? null
      : string(item.scopeValue, `${path}.scopeValue`);
  if (scopeType !== "project" && scopeValue === null) {
    throw new Error(`${path}.scopeValue is required for ${scopeType} overrides.`);
  }

  const conversionRate = nullableNumber(
    item.conversionRate ?? null,
    `${path}.conversionRate`,
  );
  if (conversionRate !== null && conversionRate > 1) {
    throw new Error(`${path}.conversionRate must be between 0 and 1.`);
  }

  return {
    averageOrderValue: nullableNumber(
      item.averageOrderValue ?? null,
      `${path}.averageOrderValue`,
    ),
    conversionRate,
    id: uuid(item.id, `${path}.id`),
    scopeType,
    scopeValue,
  };
}

function literal<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${path} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

function parseKeyword(value: unknown, index: number): SyntheticKeyword {
  const path = `keywords[${index}]`;
  const item = record(value, path);

  const keyword: SyntheticKeyword = {
    avgMonthlyVolume: nullableNumber(item.avgMonthlyVolume, `${path}.avgMonthlyVolume`),
    coreKeyword:
      item.coreKeyword === undefined || item.coreKeyword === null
        ? null
        : string(item.coreKeyword, `${path}.coreKeyword`),
    id: uuid(item.id, `${path}.id`),
    keywordDifficulty: nullableNumber(item.keywordDifficulty, `${path}.keywordDifficulty`),
    rankingUrl: nullableString(item.rankingUrl, `${path}.rankingUrl`),
    searchIntent:
      item.searchIntent === undefined || item.searchIntent === null
        ? null
        : literal(
            item.searchIntent,
            ["transactional", "commercial", "informational", "navigational"] as const,
            `${path}.searchIntent`,
          ),
    text: string(item.text, `${path}.text`),
    volumeSource:
      item.volumeSource === undefined || item.volumeSource === null
        ? null
        : literal(item.volumeSource, ["manual", "provider"] as const, `${path}.volumeSource`),
  };
  if (item.category !== undefined) {
    keyword.category =
      item.category === null ? null : string(item.category, `${path}.category`);
  }
  return keyword;
}

function parseGscRow(value: unknown, index: number): SyntheticGscRow {
  const path = `gscRows[${index}]`;
  const item = record(value, path);
  const ctr = number(item.ctr, `${path}.ctr`);
  if (ctr > 1) {
    throw new Error(`${path}.ctr must be expressed as a decimal between 0 and 1.`);
  }

  return {
    clicks: number(item.clicks, `${path}.clicks`),
    ctr,
    device: literal(
      item.device,
      ["all", "desktop", "mobile", "tablet"] as const,
      `${path}.device`,
    ),
    impressions: number(item.impressions, `${path}.impressions`),
    page: string(item.page, `${path}.page`),
    position: number(item.position, `${path}.position`),
    query: string(item.query, `${path}.query`),
  };
}

function parseProviderKeyword(
  value: unknown,
  index: number,
): SyntheticProviderKeyword {
  const path = `providerInputs.keywords[${index}]`;
  const item = record(value, path);
  const intent =
    item.intent === null
      ? null
      : literal(
          item.intent,
          ["transactional", "commercial", "informational", "navigational"] as const,
          `${path}.intent`,
        );
  const monthlyVolumes = array(
    item.monthlyVolumes ?? [],
    `${path}.monthlyVolumes`,
  ).map((value, monthIndex) => {
    const monthPath = `${path}.monthlyVolumes[${monthIndex}]`;
    const month = record(value, monthPath);
    const monthValue = string(month.month, `${monthPath}.month`);
    if (!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(monthValue)) {
      throw new Error(`${monthPath}.month must be a month-start date.`);
    }
    return {
      month: monthValue,
      volume: number(month.volume, `${monthPath}.volume`),
    };
  });
  if (
    new Set(monthlyVolumes.map((point) => point.month)).size !==
    monthlyVolumes.length
  ) {
    throw new Error(`${path}.monthlyVolumes must contain unique months.`);
  }
  return {
    avgMonthlyVolume: nullableNumber(
      item.avgMonthlyVolume,
      `${path}.avgMonthlyVolume`,
    ),
    coreKeyword:
      item.coreKeyword === undefined || item.coreKeyword === null
        ? null
        : string(item.coreKeyword, `${path}.coreKeyword`),
    intent,
    keywordDifficulty: nullableNumber(
      item.keywordDifficulty,
      `${path}.keywordDifficulty`,
    ),
    monthlyVolumes,
    rank: nullableNumber(item.rank, `${path}.rank`),
    rankingUrl: nullableString(item.rankingUrl, `${path}.rankingUrl`),
    text: string(item.text, `${path}.text`),
  };
}

function parseProviderSiteArchitectureKeyword(
  value: unknown,
  index: number,
): SyntheticProviderSiteArchitectureKeyword {
  const path = `providerInputs.siteArchitectureKeywords[${index}]`;
  const item = record(value, path);
  const relevancyScore = number(item.relevancyScore, `${path}.relevancyScore`);
  if (relevancyScore > 100) {
    throw new Error(`${path}.relevancyScore must be between 0 and 100.`);
  }
  return {
    contentStatus: literal(
      item.contentStatus,
      ["amber", "green", "red"] as const,
      `${path}.contentStatus`,
    ),
    matchedUrl: nullableString(item.matchedUrl, `${path}.matchedUrl`),
    relevancyScore,
    tacticalStatus: literal(
      item.tacticalStatus,
      [
        "create_content",
        "green",
        "new_content",
        "no_action_needed",
        "optimise_content",
      ] as const,
      `${path}.tacticalStatus`,
    ),
    text: string(item.text, `${path}.text`),
  };
}

function parseSerpResult(
  value: unknown,
  keywordIndex: number,
  resultIndex: number,
): SyntheticSerpResult {
  const path = `providerInputs.serpKeywords[${keywordIndex}].results[${resultIndex}]`;
  const item = record(value, path);
  const rankAbsolute = number(item.rankAbsolute, `${path}.rankAbsolute`, 1);
  if (!Number.isInteger(rankAbsolute) || rankAbsolute > 100) {
    throw new Error(`${path}.rankAbsolute must be an integer between 1 and 100.`);
  }
  const url = string(item.url, `${path}.url`);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`${path}.url must be a valid URL.`);
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error(`${path}.url must use HTTP or HTTPS.`);
  }
  const domain = string(item.domain, `${path}.domain`).toLowerCase();
  const urlDomain = parsedUrl.hostname.toLowerCase().replace(/^www\./, "");
  if (domain.replace(/^www\./, "") !== urlDomain) {
    throw new Error(`${path}.domain must match the URL hostname.`);
  }
  return {
    ahrefsRank: nullableNumber(item.ahrefsRank, `${path}.ahrefsRank`),
    backlinks: nullableNumber(item.backlinks, `${path}.backlinks`),
    domain,
    domainRating: nullableNumber(item.domainRating, `${path}.domainRating`),
    rankAbsolute,
    referringDomains: nullableNumber(
      item.referringDomains,
      `${path}.referringDomains`,
    ),
    url,
    urlRating: nullableNumber(item.urlRating, `${path}.urlRating`),
  };
}

function parseProviderSerpKeyword(
  value: unknown,
  index: number,
): SyntheticProviderSerpKeyword {
  const path = `providerInputs.serpKeywords[${index}]`;
  const item = record(value, path);
  const results = array(item.results, `${path}.results`).map((result, resultIndex) =>
    parseSerpResult(result, index, resultIndex),
  );
  const ranks = results.map((result) => result.rankAbsolute);
  if (new Set(ranks).size !== ranks.length) {
    throw new Error(`${path}.results must contain unique absolute ranks.`);
  }
  return {
    features: stringArray(item.features ?? [], `${path}.features`),
    results,
    text: string(item.text, `${path}.text`),
  };
}

function parseExpectedOutcome(value: unknown, index: number): ExpectedKeywordOutcome {
  const path = `expected.keywordOutcomes[${index}]`;
  const item = record(value, path);
  const detoxDecision = literal(
    item.detoxDecision,
    ["keep", "remove", "review"] as const,
    `${path}.detoxDecision`,
  );
  const tier =
    item.tier === null
      ? null
      : literal(item.tier, ["live", "deferred"] as const, `${path}.tier`);
  const intent =
    item.intent === null
      ? null
      : literal(
          item.intent,
          ["transactional", "commercial", "informational", "navigational"] as const,
          `${path}.intent`,
        );
  const category = nullableString(item.category, `${path}.category`);

  if (detoxDecision === "keep" && (!tier || !intent || !category)) {
    throw new Error(`${path} kept keywords require tier, intent and category.`);
  }
  if (detoxDecision !== "keep" && (tier || intent || category)) {
    throw new Error(`${path} non-kept keywords cannot have downstream classifications.`);
  }

  return {
    category,
    detoxDecision,
    intent,
    text: string(item.text, `${path}.text`),
    tier,
  };
}

function parsePipelineSummary(value: unknown): RepresentativePipelineSummary {
  const summary = record(value, "expected.summary");
  return {
    deferredKeywordCount: number(
      summary.deferredKeywordCount,
      "expected.summary.deferredKeywordCount",
    ),
    keptKeywordCount: number(summary.keptKeywordCount, "expected.summary.keptKeywordCount"),
    liveKeywordCount: number(summary.liveKeywordCount, "expected.summary.liveKeywordCount"),
    missingRankingUrlCount: number(
      summary.missingRankingUrlCount,
      "expected.summary.missingRankingUrlCount",
    ),
    processingKeywordCount: number(
      summary.processingKeywordCount,
      "expected.summary.processingKeywordCount",
    ),
    removedKeywordCount: number(
      summary.removedKeywordCount,
      "expected.summary.removedKeywordCount",
    ),
    reviewKeywordCount: number(
      summary.reviewKeywordCount,
      "expected.summary.reviewKeywordCount",
    ),
  };
}

function parseExpected(value: unknown): RepresentativeExpectedOutcomes {
  const expected = record(value, "expected");
  return {
    keywordOutcomes: array(expected.keywordOutcomes, "expected.keywordOutcomes").map(
      parseExpectedOutcome,
    ),
    promotedQueries: stringArray(expected.promotedQueries, "expected.promotedQueries"),
    summary: parsePipelineSummary(expected.summary),
  };
}

export const normaliseKeyword = (value: string): string =>
  value.toLowerCase().trim().replace(/\s+/g, " ");

function assertUniqueNormalised(values: readonly string[], path: string): void {
  const normalised = values.map(normaliseKeyword);
  if (new Set(normalised).size !== normalised.length) {
    throw new Error(`${path} must contain unique normalised values.`);
  }
}

export function summariseRepresentativeFixture(
  fixture: Pick<RepresentativeProjectFixture, "gscRows" | "keywords">,
): RepresentativeSourceSummary {
  const keywordSet = new Set(fixture.keywords.map((keyword) => normaliseKeyword(keyword.text)));
  const gscQuerySet = new Set(fixture.gscRows.map((row) => normaliseKeyword(row.query)));

  return {
    gscDistinctQueryCount: gscQuerySet.size,
    gscPromotionCandidateCount: [...gscQuerySet].filter((query) => !keywordSet.has(query)).length,
    gscRowCount: fixture.gscRows.length,
    sourceKeywordCount: fixture.keywords.length,
    sourceMissingRankingUrlCount: fixture.keywords.filter(
      (keyword) => keyword.rankingUrl === null,
    ).length,
  };
}

export function parseRepresentativeProjectFixture(
  value: unknown,
): RepresentativeProjectFixture {
  const root = record(value, "fixture");
  if (root.schemaVersion !== "1.1") {
    throw new Error("fixture.schemaVersion must be 1.1.");
  }

  const clientValue = record(root.client, "client");
  const projectValue = record(root.project, "project");
  const authorityValue = record(root.authority, "authority");
  const economicsValue = record(root.economics, "economics");
  const rulesValue = record(root.rules, "rules");
  const providerInputsValue = record(root.providerInputs, "providerInputs");
  const client = {
    brandTerms: stringArray(clientValue.brandTerms ?? [], "client.brandTerms"),
    companyName: string(clientValue.companyName, "client.companyName"),
    domain: string(clientValue.domain, "client.domain"),
    id: uuid(clientValue.id, "client.id"),
    industry: string(clientValue.industry, "client.industry"),
  };
  const project = {
    categoryFocus: string(projectValue.categoryFocus, "project.categoryFocus"),
    clientId: uuid(projectValue.clientId, "project.clientId"),
    country: string(projectValue.country, "project.country"),
    currency: string(projectValue.currency, "project.currency"),
    id: uuid(projectValue.id, "project.id"),
    language: string(projectValue.language, "project.language"),
    name: string(projectValue.name, "project.name"),
    policy: {
      competitiveEnrichmentVolumeFloor: number(
        record(projectValue.policy ?? {}, "project.policy")
          .competitiveEnrichmentVolumeFloor ?? 0,
        "project.policy.competitiveEnrichmentVolumeFloor",
      ),
      gscPromotionImpressionsFloor: number(
        record(projectValue.policy ?? {}, "project.policy")
          .gscPromotionImpressionsFloor ?? 1,
        "project.policy.gscPromotionImpressionsFloor",
      ),
      reviewedAt:
        record(projectValue.policy ?? {}, "project.policy").reviewedAt === undefined ||
        record(projectValue.policy ?? {}, "project.policy").reviewedAt === null
          ? null
          : string(
              record(projectValue.policy ?? {}, "project.policy").reviewedAt,
              "project.policy.reviewedAt",
            ),
    },
  };
  if (project.clientId !== client.id) {
    throw new Error("project.clientId must reference client.id.");
  }

  const fixture: RepresentativeProjectFixture = {
    authority: {
      backlinks: number(authorityValue.backlinks, "authority.backlinks"),
      domainRating: number(authorityValue.domainRating, "authority.domainRating"),
      referringDomains: number(authorityValue.referringDomains, "authority.referringDomains"),
    },
    client,
    economics: {
      averageOrderValue: nullableNumber(
        economicsValue.averageOrderValue,
        "economics.averageOrderValue",
      ),
      conversionRate: nullableNumber(
        economicsValue.conversionRate,
        "economics.conversionRate",
      ),
      gscWindowDays: number(
        economicsValue.gscWindowDays,
        "economics.gscWindowDays",
        1,
      ),
    },
    conversionOverrides: array(
      root.conversionOverrides ?? [],
      "conversionOverrides",
    ).map(parseConversionOverride),
    competitorDomains: stringArray(
      root.competitorDomains ?? rulesValue.competitorBrands,
      "competitorDomains",
    ),
    expected: parseExpected(root.expected),
    gscRows: array(root.gscRows, "gscRows").map(parseGscRow),
    keywords: array(root.keywords, "keywords").map(parseKeyword),
    project,
    providerInputs: {
      keywords: array(
        providerInputsValue.keywords,
        "providerInputs.keywords",
      ).map(parseProviderKeyword),
      serpKeywords: array(
        providerInputsValue.serpKeywords,
        "providerInputs.serpKeywords",
      ).map(parseProviderSerpKeyword),
      siteArchitectureKeywords: array(
        providerInputsValue.siteArchitectureKeywords,
        "providerInputs.siteArchitectureKeywords",
      ).map(parseProviderSiteArchitectureKeyword),
    },
    rules: {
      blacklist: stringArray(rulesValue.blacklist, "rules.blacklist"),
      competitorBrands: stringArray(
        rulesValue.competitorBrands,
        "rules.competitorBrands",
      ),
      ownBrands: stringArray(rulesValue.ownBrands, "rules.ownBrands"),
      relevantTerms: stringArray(rulesValue.relevantTerms, "rules.relevantTerms"),
      whitelist: stringArray(rulesValue.whitelist, "rules.whitelist"),
    },
    scoringConfigActive:
      root.scoringConfigActive === undefined
        ? true
        : root.scoringConfigActive === true,
    schemaVersion: "1.1",
  };
  if (
    fixture.economics.conversionRate !== null &&
    fixture.economics.conversionRate > 1
  ) {
    throw new Error("economics.conversionRate must be between 0 and 1.");
  }
  if (!Number.isInteger(fixture.economics.gscWindowDays)) {
    throw new Error("economics.gscWindowDays must be an integer.");
  }

  const keywordIds = new Set(fixture.keywords.map((keyword) => keyword.id));
  if (keywordIds.size !== fixture.keywords.length) {
    throw new Error("fixture keywords must have unique IDs.");
  }
  assertUniqueNormalised(
    fixture.keywords.map((keyword) => keyword.text),
    "fixture keywords",
  );
  assertUniqueNormalised(
    fixture.providerInputs.siteArchitectureKeywords.map(
      (keyword) => keyword.text,
    ),
    "providerInputs.siteArchitectureKeywords",
  );
  assertUniqueNormalised(fixture.expected.promotedQueries, "expected.promotedQueries");
  assertUniqueNormalised(
    fixture.providerInputs.keywords.map((keyword) => keyword.text),
    "providerInputs.keywords",
  );
  assertUniqueNormalised(
    fixture.providerInputs.serpKeywords.map((keyword) => keyword.text),
    "providerInputs.serpKeywords",
  );
  assertUniqueNormalised(
    fixture.expected.keywordOutcomes.map((outcome) => outcome.text),
    "expected.keywordOutcomes",
  );

  const sourceTexts = new Set(fixture.keywords.map((keyword) => normaliseKeyword(keyword.text)));
  const actualPromotions = [
    ...new Set(fixture.gscRows.map((row) => normaliseKeyword(row.query))),
  ].filter((query) => !sourceTexts.has(query));
  const expectedPromotions = fixture.expected.promotedQueries
    .map(normaliseKeyword)
    .sort();
  if (JSON.stringify(actualPromotions.sort()) !== JSON.stringify(expectedPromotions)) {
    throw new Error("expected.promotedQueries must match the GSC-only query set.");
  }

  const processingTexts = new Set([
    ...sourceTexts,
    ...fixture.expected.promotedQueries.map(normaliseKeyword),
  ]);
  if (
    fixture.providerInputs.serpKeywords.some(
      (keyword) => !processingTexts.has(normaliseKeyword(keyword.text)),
    )
  ) {
    throw new Error(
      "providerInputs.serpKeywords must reference processing keywords.",
    );
  }
  if (
    fixture.providerInputs.siteArchitectureKeywords.some(
      (keyword) => !processingTexts.has(normaliseKeyword(keyword.text)),
    )
  ) {
    throw new Error(
      "providerInputs.siteArchitectureKeywords must reference processing keywords.",
    );
  }
  const outcomeTexts = new Set(
    fixture.expected.keywordOutcomes.map((outcome) => normaliseKeyword(outcome.text)),
  );
  if (
    processingTexts.size !== outcomeTexts.size ||
    [...processingTexts].some((text) => !outcomeTexts.has(text))
  ) {
    throw new Error("expected.keywordOutcomes must cover every processing keyword exactly once.");
  }

  const expectedSummary = {
    deferredKeywordCount: fixture.expected.keywordOutcomes.filter(
      (outcome) => outcome.detoxDecision === "keep" && outcome.tier === "deferred",
    ).length,
    keptKeywordCount: fixture.expected.keywordOutcomes.filter(
      (outcome) => outcome.detoxDecision === "keep",
    ).length,
    liveKeywordCount: fixture.expected.keywordOutcomes.filter(
      (outcome) => outcome.detoxDecision === "keep" && outcome.tier === "live",
    ).length,
    processingKeywordCount: fixture.expected.keywordOutcomes.length,
    removedKeywordCount: fixture.expected.keywordOutcomes.filter(
      (outcome) => outcome.detoxDecision === "remove",
    ).length,
    reviewKeywordCount: fixture.expected.keywordOutcomes.filter(
      (outcome) => outcome.detoxDecision === "review",
    ).length,
  };
  for (const [key, actual] of Object.entries(expectedSummary)) {
    const expected = fixture.expected.summary[key as keyof typeof expectedSummary];
    if (actual !== expected) {
      throw new Error(`expected.summary.${key}=${expected}, received ${actual}.`);
    }
  }

  return fixture;
}
