import { createHash } from "node:crypto";

import { domainBrandTerms } from "./brand-terms.js";

import {
  CALIBRATION_MODEL_VERSION,
  computeCalibration,
  isPromotionEligible,
  trafficLight,
  type IntentBucket as CalibrationIntent,
} from "../../models/src/calibration.js";
import {
  clusterKey,
  pickCanonical,
} from "../../calculations/src/clustering.js";
import {
  ctrConfidence,
  fallbackCtr,
} from "../../calculations/src/ctr.js";
import { computeDemandSignal } from "../../calculations/src/demand.js";
import {
  computeScenario,
  HAR_V2_MODEL_VERSION as HAR_MODEL_VERSION,
  SCENARIOS as HAR_SCENARIOS,
  type ScoringConfig,
  type Scenario as HarScenario,
} from "../../models/src/har-v2.js";
import {
  computeLps,
  createLpsScoringContext,
} from "../../calculations/src/lps.js";
import {
  annualVolumeFromInputs,
  computeRevenueV2,
  REVENUE_V2_MODEL_VERSION as REVENUE_MODEL_VERSION,
  type MonthlyRevenueJson,
} from "../../models/src/revenue-v2.js";
import {
  normaliseKeyword,
  type DetoxDecision,
  type RepresentativePipelineSummary,
  type ProjectPipelineSource,
  type SearchIntent,
  type SyntheticGscRow,
  type SyntheticSerpResult,
} from "../../fixtures/src/representative-project.js";
import type { PipelineStageId } from "./definition.js";

export interface PipelineKeyword {
  avgMonthlyVolume: number | null;
  category: string | null;
  coreKeyword: string | null;
  gsc: {
    clicks: number;
    ctr: number;
    devices: string[];
    impressions: number;
    position: number;
  } | null;
  id: string;
  keywordDifficulty: number | null;
  normalisedText: string;
  promotedFromGsc: boolean;
  preCurated: boolean;
  rankingUrl: string | null;
  searchIntent: SearchIntent;
  sources: Array<"gsc" | "source">;
  text: string;
  volumeSource: "manual" | "provider" | null;
}

export interface IntakeStageData {
  handlerVersion: "intake-v1";
  keywords: PipelineKeyword[];
  sourceKeywordCount: number;
}

export interface GscPromotionStageData {
  handlerVersion: "gsc-promotion-v1";
  keywords: PipelineKeyword[];
  processingKeywordCount: number;
  promotedQueries: string[];
  promotionCount: number;
  excludedBelowFloorCount: number;
  impressionsFloor: number;
}

export interface PreflightStageData {
  handlerVersion: "preflight-v1";
  keywords: DetoxedKeyword[];
  ready: true;
  checks: Array<{ id: string; ok: true; value: number | string }>;
  derivedBrandSuggestions: string[];
  policy: {
    competitiveEnrichmentVolumeFloor: number;
    gscPromotionImpressionsFloor: number;
  };
}

export interface DetoxedKeyword extends PipelineKeyword {
  detox: {
    decision: DetoxDecision;
    reason: string;
    rule: string;
  };
}

export interface DetoxStageData {
  handlerVersion: "detox-v1";
  keptKeywordCount: number;
  keywords: DetoxedKeyword[];
  removedKeywordCount: number;
  reviewKeywordCount: number;
}

export interface CategorisedKeyword extends DetoxedKeyword {
  categorisation: {
    category: string;
    intent: Exclude<SearchIntent, null>;
    source: "client_supplied" | "rule" | "taxonomy";
    tags: string[];
    tier: "deferred" | "live";
  };
}

export interface CategorisationStageData {
  handlerVersion: "categorisation-v1";
  keywords: CategorisedKeyword[];
  summary: RepresentativePipelineSummary;
}

export interface EnrichedKeyword extends DetoxedKeyword {
  category: string | null;
  enrichment: {
    avgMonthlyVolume: number | null;
    competitiveEligible: boolean;
    competitiveEligibilityReason: string;
    coreKeyword: string;
    intent: Exclude<SearchIntent, null>;
    keywordDifficulty: number | null;
    source: "existing" | "local-provider" | "mixed" | "missing-provider";
    volumeSource: "manual" | "provider" | "missing";
  };
}

export interface KeywordEnrichmentStageData {
  enrichedKeywordCount: number;
  handlerVersion: "keyword-enrichment-v1";
  keywords: EnrichedKeyword[];
  missingProviderCount: number;
  providerValueCount: number;
}

export interface HistoricalVolumeStageData {
  handlerVersion: "historical-volume-v1";
  keywords: Array<{
    coverageMonths: number;
    id: string;
    normalisedText: string;
  }>;
  sufficientHistoryCount: number;
  unavailableCount: number;
}

export interface RankingUrlStageData {
  existingCount: number;
  handlerVersion: "ranking-url-v1";
  keywords: Array<{
    id: string;
    normalisedText: string;
    rank: number | null;
    rankingUrl: string | null;
    status: "existing" | "matched" | "no-match";
  }>;
  matchedCount: number;
  noMatchCount: number;
}

export interface GscIntentStageData {
  genericCount: number;
  handlerVersion: "gsc-intent-v1";
  intentCounts: Record<string, number>;
  keywords: Array<{
    intent: Exclude<SearchIntent, null> | "generic";
    normalisedText: string;
  }>;
  resolvedCount: number;
}

export interface BrandClassificationStageData {
  brandedCount: number;
  handlerVersion: "brand-classification-v1";
  keywords: Array<{
    confidence: number;
    id: string;
    isBranded: boolean;
    matchedTerm: string | null;
    normalisedText: string;
    source: "derived-client" | "deterministic-non-brand" | "explicit-rule";
  }>;
  nonBrandedCount: number;
}

export interface SerpResult {
  domain: string;
  isClientDomain: boolean;
  rankAbsolute: number;
  url: string;
}

export interface SerpKeywordResult {
  features: string[];
  id: string;
  normalisedText: string;
  results: SerpResult[];
  sourceKeywordId: string;
  status: "matched" | "missing-provider" | "no-result";
}

export interface SerpCollectionStageData {
  handlerVersion: "serp-collection-v1";
  keywords: SerpKeywordResult[];
  matchedKeywordCount: number;
  missingProviderCount: number;
  noResultCount: number;
  resultCount: number;
  clusterFetchCount: number;
  inheritedKeywordCount: number;
}

export interface AuthorityStageData {
  authority: {
    ahrefsRank: number | null;
    backlinks: number;
    domain: string;
    domainRating: number;
    referringDomains: number;
    source: "project-input";
    urlRating: number | null;
  };
  clientResultCount: number;
  handlerVersion: "authority-v1";
  keywords: SerpKeywordResult[];
  resultCount: number;
}

export interface BacklinkResult extends SerpResult {
  ahrefsRank: number | null;
  backlinks: number | null;
  domainRating: number | null;
  metricSource: "local-provider" | "missing-provider";
  referringDomains: number | null;
  urlRating: number | null;
}

export interface BacklinksStageData {
  enrichedResultCount: number;
  handlerVersion: "backlinks-v1";
  keywords: Array<Omit<SerpKeywordResult, "results"> & { results: BacklinkResult[] }>;
  missingResultCount: number;
  resultCount: number;
}

export interface SiteArchitectureStageData {
  handlerVersion: "site-architecture-v1";
  keywords: Array<{
    contentStatus: "amber" | "green" | "red" | null;
    id: string;
    matchedUrl: string | null;
    normalisedText: string;
    relevancyScore: number | null;
    status: "matched" | "missing-provider";
    tacticalStatus:
      | "create_content"
      | "green"
      | "new_content"
      | "no_action_needed"
      | "optimise_content"
      | null;
  }>;
  matchedCount: number;
  missingProviderCount: number;
}

export interface LinkPowerScoreStageData {
  handlerVersion: "link-power-score-v1";
  keywords: Array<{
    id: string;
    normalisedText: string;
    results: Array<BacklinkResult & {
      confidence: "high" | "low" | "medium";
      score: number;
    }>;
  }>;
  resultCount: number;
  scoredResultCount: number;
}

export interface DemandSignalsStageData {
  handlerVersion: "demand-signals-v1";
  keywords: Array<{
    avgMonthlyVolume: number | null;
    coverageMonths: number;
    demandWarning: boolean;
    demandWarningReason: string | null;
    id: string;
    monthlyVolumes: Array<{ month: string; volume: number }>;
    normalisedText: string;
    peakMonths: number[];
    seasonalityStrength: number | null;
    trendConfidence: "high" | "low" | "medium";
    trendDirection:
      | "declining"
      | "growing"
      | "insufficient_data"
      | "stable"
      | "volatile";
    trendPct: number | null;
    trendSlope: number | null;
    volatilityScore: number | null;
  }>;
  sufficientHistoryCount: number;
  warningCount: number;
}

export interface CtrCurvePoint {
  confidence: "high" | "low" | "medium";
  ctr: number;
  impressions: number;
  rank: number;
  source: "blended" | "fallback" | "gsc";
}

export interface CtrCurvesStageData {
  curves: Array<{
    device: SyntheticGscRow["device"];
    intent: Exclude<SearchIntent, null> | "generic";
    isBranded: boolean;
    points: CtrCurvePoint[];
  }>;
  handlerVersion: "ctr-curves-v1";
  keywords: Array<{
    device: SyntheticGscRow["device"];
    impressions: number;
    intent: Exclude<SearchIntent, null> | "generic";
    isBranded: boolean;
    normalisedText: string;
    position: number;
  }>;
  observedPointCount: number;
  provenance: {
    dateRangeEnd: string | null;
    dateRangeStart: string | null;
    excludedBrandedRows: number;
    sampleImpressions: number;
    sampleRows: number;
  };
}

export interface ClusteringStageData {
  clusterCount: number;
  handlerVersion: "clustering-v1";
  keywords: Array<{
    canonicalBasis: "alphabetical" | "base_rank" | "gsc_clicks" | "volume";
    canonicalKeywordId: string;
    clusterKey: string;
    id: string;
    isCanonical: boolean;
    memberCount: number;
    normalisedText: string;
  }>;
}

export interface HarScenarioResult {
  authorityScore: number | null;
  confidence: number;
  contentFitScore: number | null;
  explanation: Record<string, unknown>;
  harPosition: number | null;
  linkGapScore: number | null;
  linkPowerScore: number | null;
  rankAttainmentProbability: number | null;
  scenario: HarScenario;
  serpVisibilityMultiplier: number;
}

export interface HarV2StageData {
  handlerVersion: "har-v2.1";
  keywords: Array<{
    baseRank: number | null;
    category: string | null;
    device: SyntheticGscRow["device"] | null;
    id: string;
    intent: Exclude<SearchIntent, null>;
    isBranded: boolean;
    isCanonical: boolean;
    normalisedText: string;
    serpFeatures: string[];
    scenarios: HarScenarioResult[];
  }>;
  modelVersion: typeof HAR_MODEL_VERSION;
  scenarioCount: number;
}

export interface RevenueScenarioResult {
  annualVolume: number | null;
  averageOrderValueOverrideId: string | null;
  averageOrderValueUsed: number | null;
  ctrNow: number | null;
  ctrTarget: number | null;
  conversionRateOverrideId: string | null;
  conversionRateUsed: number | null;
  currentRevenueAnnual: number | null;
  expectedIncrementalAnnual: number | null;
  expectedIncrementalHighAnnual: number | null;
  expectedIncrementalLowAnnual: number | null;
  factorApplied: number;
  harConfidenceUsed: number;
  bandMethod: "conf_interp_band_v1";
  modelledMonthlyClicks: number | null;
  monthlyRevenue: MonthlyRevenueJson;
  rankAttainmentProbabilityUsed: number;
  scenario: HarScenario;
  targetAbsoluteRevenueAnnual: number | null;
  targetIncrementalRevenueAnnual: number | null;
  serpVisibilityMultiplierUsed: number;
  volumeForward: number | null;
  warnings: string[];
}

export interface RevenueV2StageData {
  forecastCount: number;
  handlerVersion: "revenue-v2.1";
  keywords: Array<{
    baseRank: number | null;
    id: string;
    intent: Exclude<SearchIntent, null>;
    isBranded: boolean;
    isCanonical: boolean;
    normalisedText: string;
    scenarios: RevenueScenarioResult[];
  }>;
  modelVersion: typeof REVENUE_MODEL_VERSION;
}

export interface CalibrationStageData {
  byIntent: ReturnType<typeof computeCalibration>["by_intent"];
  byRankBand: ReturnType<typeof computeCalibration>["by_rank_band"];
  excludedNoiseFloor: number;
  handlerVersion: "calibration-v1";
  keywords: Array<{
    actualClicks: number;
    id: string;
    impressions: number;
    intent: CalibrationIntent;
    modelledMonthlyClicks: number;
    normalisedText: string;
    rank: number;
    windowDays: number;
  }>;
  matched: number;
  medianPerPairRatio: number | null;
  modelVersion: typeof CALIBRATION_MODEL_VERSION;
  overallRatio: number | null;
  promotionEligible: boolean;
  impressionsContext: number;
  status: "amber" | "green" | "red" | "unavailable";
  sumActualMonthly: number;
  sumModelledMonthly: number;
  unavailableReason: "calibration_unavailable_no_gsc" | null;
}

export interface ReadinessStageData {
  handlerVersion: "har-readiness-v1" | "revenue-readiness-v1";
  keywords: Array<{ id: string; normalisedText: string }>;
  ready: true;
  substitutions: Array<{
    count: number;
    input: string;
    substitute: string;
  }>;
}

export interface RollupOutputStageData {
  handlerVersion: "rollup-output-v1";
  keywords: Array<{ id: string; normalisedText: string }>;
  scenarios: Array<{
    categoryRollup: Array<{
      category: string;
      expectedIncrementalAnnual: number;
      keywordCount: number;
    }>;
    clusterDedupedExpectedIncrementalAnnual: number;
    clusterRollup: Array<{
      canonicalKeywordId: string;
      clusterKey: string;
      expectedIncrementalAnnual: number;
      memberCount: number;
    }>;
    doubleCountAnnual: number;
    naiveExpectedIncrementalAnnual: number;
    quarterRollup: Array<{
      expectedIncrementalAnnual: number;
      keywordCount: number;
      quarter: "Q1" | "Q2" | "Q3" | "Q4" | "Unscheduled";
    }>;
    scenario: HarScenario;
    trendRollup: Array<{
      expectedIncrementalAnnual: number;
      keywordCount: number;
      trend: DemandSignalsStageData["keywords"][number]["trendDirection"];
    }>;
  }>;
  confidenceDistribution: { high: number; low: number; medium: number };
  cannibalisationFlags: Array<{ keywordIds: string[]; url: string }>;
}

export type DataDrivenStageData =
  | IntakeStageData
  | GscPromotionStageData
  | PreflightStageData
  | DetoxStageData
  | CategorisationStageData
  | KeywordEnrichmentStageData
  | HistoricalVolumeStageData
  | RankingUrlStageData
  | GscIntentStageData
  | BrandClassificationStageData
  | SerpCollectionStageData
  | AuthorityStageData
  | BacklinksStageData
  | SiteArchitectureStageData
  | LinkPowerScoreStageData
  | DemandSignalsStageData
  | CtrCurvesStageData
  | ClusteringStageData
  | HarV2StageData
  | RevenueV2StageData
  | CalibrationStageData
  | ReadinessStageData
  | RollupOutputStageData;

type DependencyOutputs = Partial<Record<PipelineStageId, unknown>>;

const TRANSACTIONAL_RE =
  /\b(buy|order|price|prices|cost|cheap|deal|deals|discount|delivery|deliver|near me|book|booking|hire|rent|shop|for sale|coupon|promo|same day|next day|offer|offers)\b/;
const COMMERCIAL_RE =
  /\b(best|top|review|reviews|vs|versus|compare|comparison|alternative|alternatives|cheapest)\b/;
const INFORMATIONAL_RE =
  /^(how|what|why|when|where|who|can|do|does|is|are)\b|\b(guide|tutorial|tips|meaning|definition|symptoms|causes)\b/;
const TV_PRODUCT_RE =
  /\b(oled|qled|uhd|4k|8k|smart|samsung|lg|sony|philips|hisense|panasonic|toshiba|tcl|sharp|jvc)\b|\b\d{2,3}\s*(?:in|inch|inches|tv)\b/;
const TV_RE = /\btvs?\b|\btelevisions?\b|\boled\b|\bqled\b/;
const PROFANITY = [
  "fuck",
  "shit",
  "porn",
  "xxx",
  "nude",
  "naked",
  "sex",
  "cunt",
  "wank",
  "tits",
  "boob",
  "dick",
  "cock",
  "pussy",
  "milf",
] as const;
const STOP_WORDS_EXACT = new Set([
  "the",
  "and",
  "or",
  "of",
  "a",
  "an",
  "to",
  "in",
  "on",
  "for",
  "with",
  "at",
  "by",
  "from",
  "is",
  "it",
]);
const POSTCODE_US = /\b\d{5}(-\d{4})?\b/;
const POSTCODE_UK = /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/i;
const PHONE = /(?:\+?\d[\s().-]*){9,}/;

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function dependency<T extends DataDrivenStageData>(
  outputs: DependencyOutputs,
  stageId: PipelineStageId,
  handlerVersion: T["handlerVersion"],
): T {
  const output = object(outputs[stageId], `dependency ${stageId}`);
  if (output.handlerVersion !== handlerVersion || !Array.isArray(output.keywords)) {
    throw new Error(`Dependency ${stageId} does not contain ${handlerVersion} output.`);
  }
  return output as unknown as T;
}

function containsTokenOrPhrase(keyword: string, needle: string): boolean {
  const normalisedNeedle = normaliseKeyword(needle);
  if (!normalisedNeedle) return false;
  if (normalisedNeedle.includes(" ")) return keyword.includes(normalisedNeedle);
  const escaped = normalisedNeedle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(keyword);
}

function normaliseHost(value: string): string {
  return value
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "");
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (character) => character.toUpperCase());
}

function stableGscId(projectId: string, normalisedText: string): string {
  const digest = createHash("sha256")
    .update(`${projectId}:${normalisedText}`)
    .digest("hex")
    .slice(0, 32);
  const variant = ((Number.parseInt(digest[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function executeIntake(fixture: ProjectPipelineSource): IntakeStageData {
  return {
    handlerVersion: "intake-v1",
    keywords: fixture.keywords.map((keyword) => ({
      avgMonthlyVolume: keyword.avgMonthlyVolume,
      category: keyword.category ?? null,
      coreKeyword: keyword.coreKeyword ?? null,
      gsc: null,
      id: keyword.id,
      keywordDifficulty: keyword.keywordDifficulty,
      normalisedText: normaliseKeyword(keyword.text),
      promotedFromGsc: false,
      preCurated: keyword.preCurated ?? false,
      rankingUrl: keyword.rankingUrl,
      searchIntent: keyword.searchIntent ?? null,
      sources: ["source"],
      text: keyword.text,
      volumeSource:
        keyword.volumeSource ??
        (keyword.avgMonthlyVolume !== null && keyword.avgMonthlyVolume > 0
          ? "manual"
          : null),
    })),
    sourceKeywordCount: fixture.keywords.length,
  };
}

interface AggregatedGscQuery {
  clicks: number;
  ctr: number;
  devices: string[];
  impressions: number;
  normalisedText: string;
  page: string;
  position: number;
  query: string;
}

function aggregateGscRows(rows: SyntheticGscRow[]): AggregatedGscQuery[] {
  const groups = new Map<string, SyntheticGscRow[]>();
  for (const row of rows) {
    const key = normaliseKeyword(row.query);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  return [...groups.entries()].map(([normalisedText, group]) => {
    const clicks = group.reduce((total, row) => total + row.clicks, 0);
    const impressions = group.reduce((total, row) => total + row.impressions, 0);
    const rankedPages = [...group].sort(
      (left, right) =>
        right.clicks - left.clicks ||
        right.impressions - left.impressions ||
        left.page.localeCompare(right.page),
    );

    return {
      clicks,
      ctr: impressions === 0 ? 0 : clicks / impressions,
      devices: [...new Set(group.map((row) => row.device))].sort(),
      impressions,
      normalisedText,
      page: rankedPages[0]?.page ?? "",
      position:
        impressions === 0
          ? 0
          : group.reduce((total, row) => total + row.position * row.impressions, 0) /
            impressions,
      query: group[0]?.query.trim() ?? normalisedText,
    };
  });
}

function executeGscPromotion(
  fixture: ProjectPipelineSource,
  intake: IntakeStageData,
): GscPromotionStageData {
  const byText = new Map(intake.keywords.map((keyword) => [keyword.normalisedText, keyword]));
  const promotedQueries: string[] = [];
  const impressionsFloor = fixture.project.policy?.gscPromotionImpressionsFloor ?? 1;
  let excludedBelowFloorCount = 0;

  for (const aggregate of aggregateGscRows(fixture.gscRows)) {
    const gsc = {
      clicks: aggregate.clicks,
      ctr: aggregate.ctr,
      devices: aggregate.devices,
      impressions: aggregate.impressions,
      position: aggregate.position,
    };
    const existing = byText.get(aggregate.normalisedText);
    if (existing) {
      byText.set(aggregate.normalisedText, {
        ...existing,
        gsc,
        rankingUrl: existing.rankingUrl ?? aggregate.page,
        sources: ["source", "gsc"],
      });
      continue;
    }

    if (aggregate.impressions < impressionsFloor) {
      excludedBelowFloorCount += 1;
      continue;
    }

    promotedQueries.push(aggregate.normalisedText);
    byText.set(aggregate.normalisedText, {
      avgMonthlyVolume: null,
      category: null,
      coreKeyword: null,
      gsc,
      id: stableGscId(fixture.project.id, aggregate.normalisedText),
      keywordDifficulty: null,
      normalisedText: aggregate.normalisedText,
      promotedFromGsc: true,
      preCurated: false,
      rankingUrl: aggregate.page,
      searchIntent: null,
      sources: ["gsc"],
      text: aggregate.query,
      volumeSource: null,
    });
  }

  const keywords = [...byText.values()];
  return {
    handlerVersion: "gsc-promotion-v1",
    keywords,
    excludedBelowFloorCount,
    impressionsFloor,
    processingKeywordCount: keywords.length,
    promotedQueries: promotedQueries.sort(),
    promotionCount: promotedQueries.length,
  };
}

function detoxDecision(
  keyword: PipelineKeyword,
  fixture: ProjectPipelineSource,
): DetoxedKeyword["detox"] {
  const text = keyword.normalisedText;
  if (keyword.preCurated) {
    return {
      decision: "keep",
      reason: "Operator-confirmed pre-curated set",
      rule: "pre-curated",
    };
  }
  for (const value of fixture.rules.whitelist) {
    if (containsTokenOrPhrase(text, value)) {
      return { decision: "keep", reason: `Matched whitelist: ${value}`, rule: "whitelist" };
    }
  }
  if (!text.replace(/[\s\d]/g, "").length) {
    return { decision: "remove", reason: "Numeric or empty keyword", rule: "numeric" };
  }
  if (text.length <= 1) {
    return { decision: "remove", reason: "Single character", rule: "single-character" };
  }
  if (text.length > 200) {
    return { decision: "remove", reason: "Keyword exceeds 200 characters", rule: "length" };
  }
  if (PHONE.test(text)) {
    return { decision: "remove", reason: "Phone number", rule: "phone" };
  }
  if (POSTCODE_UK.test(text) || POSTCODE_US.test(text)) {
    return { decision: "remove", reason: "Postcode", rule: "postcode" };
  }
  if (!text.includes(" ") && STOP_WORDS_EXACT.has(text)) {
    return { decision: "remove", reason: "Stop word only", rule: "stop-word" };
  }
  if (PROFANITY.some((value) => containsTokenOrPhrase(text, value))) {
    return { decision: "remove", reason: "Adult or profane term", rule: "profanity" };
  }
  for (const value of fixture.rules.blacklist) {
    if (containsTokenOrPhrase(text, value)) {
      return { decision: "remove", reason: `Matched blacklist: ${value}`, rule: "blacklist" };
    }
  }
  for (const value of fixture.rules.competitorBrands) {
    if (containsTokenOrPhrase(text, value)) {
      return {
        decision: "remove",
        reason: `Matched competitor brand: ${value}`,
        rule: "competitor",
      };
    }
  }
  if (
    fixture.rules.relevantTerms.some((value) => containsTokenOrPhrase(text, value)) ||
    containsTokenOrPhrase(text, fixture.project.categoryFocus)
  ) {
    return {
      decision: "keep",
      reason: `Relevant to ${fixture.project.categoryFocus}`,
      rule: "category-relevance",
    };
  }
  return {
    decision: "review",
    reason: "No deterministic relevance rule matched",
    rule: "manual-review",
  };
}

function executeDetox(
  fixture: ProjectPipelineSource,
  promotion: GscPromotionStageData,
): DetoxStageData {
  const keywords = promotion.keywords.map((keyword) => ({
    ...keyword,
    detox: detoxDecision(keyword, fixture),
  }));

  return {
    handlerVersion: "detox-v1",
    keptKeywordCount: keywords.filter((keyword) => keyword.detox.decision === "keep").length,
    keywords,
    removedKeywordCount: keywords.filter((keyword) => keyword.detox.decision === "remove")
      .length,
    reviewKeywordCount: keywords.filter((keyword) => keyword.detox.decision === "review")
      .length,
  };
}

function executePreflight(
  fixture: ProjectPipelineSource,
  detox: DetoxStageData,
): PreflightStageData {
  const missing: string[] = [];
  const domain = normaliseHost(fixture.client.domain);
  const competitorCount = fixture.competitorDomains?.length ?? 0;
  const brandTermCount = fixture.client.brandTerms
    .map(normaliseKeyword)
    .filter(Boolean).length;
  const authorityReady =
    fixture.authority.domainRating > 0 ||
    fixture.authority.referringDomains > 0 ||
    fixture.authority.backlinks > 0;

  if (!domain) missing.push("client_domain");
  if (competitorCount === 0) missing.push("competitor_domains");
  if (brandTermCount === 0) missing.push("explicit_brand_terms");
  if (fixture.economics.conversionRate === null) missing.push("conversion_rate");
  if (fixture.economics.averageOrderValue === null) missing.push("average_order_value");
  if (!authorityReady) missing.push("client_domain_authority");
  if (fixture.scoringConfigActive === false) missing.push("active_scoring_config");
  if (detox.keptKeywordCount === 0) missing.push("kept_keywords");

  if (missing.length > 0) {
    throw new Error(`Pipeline preflight failed: ${missing.join(", ")}.`);
  }

  return {
    checks: [
      { id: "client_domain", ok: true, value: domain },
      { id: "competitor_domains", ok: true, value: competitorCount },
      { id: "explicit_brand_terms", ok: true, value: brandTermCount },
      { id: "conversion_rate", ok: true, value: fixture.economics.conversionRate! },
      { id: "average_order_value", ok: true, value: fixture.economics.averageOrderValue! },
      { id: "client_domain_authority", ok: true, value: fixture.authority.domainRating },
      { id: "active_scoring_config", ok: true, value: "active" },
      { id: "kept_keywords", ok: true, value: detox.keptKeywordCount },
    ],
    handlerVersion: "preflight-v1",
    keywords: detox.keywords,
    derivedBrandSuggestions: derivedBrandTerms(fixture).filter(
      (term) => !fixture.client.brandTerms.map(normaliseKeyword).includes(term),
    ),
    policy: {
      competitiveEnrichmentVolumeFloor:
        fixture.project.policy?.competitiveEnrichmentVolumeFloor ?? 0,
      gscPromotionImpressionsFloor:
        fixture.project.policy?.gscPromotionImpressionsFloor ?? 1,
    },
    ready: true,
  };
}

function findBrand(keyword: string, brands: readonly string[]): string | null {
  return brands.find((brand) => containsTokenOrPhrase(keyword, brand)) ?? null;
}

function classifyIntent(
  keyword: string,
  fixture: ProjectPipelineSource,
): Exclude<SearchIntent, null> {
  if (findBrand(keyword, fixture.rules.ownBrands)) return "navigational";
  if (findBrand(keyword, fixture.rules.competitorBrands)) return "navigational";
  if (TRANSACTIONAL_RE.test(keyword)) return "transactional";
  if (COMMERCIAL_RE.test(keyword)) return "commercial";
  if (INFORMATIONAL_RE.test(keyword)) return "informational";
  if (TV_PRODUCT_RE.test(keyword) && TV_RE.test(keyword)) return "commercial";
  return "informational";
}

function tvTags(keyword: string): string[] {
  const tags = ["Electronics", "Television"];
  const tech =
    /\boled\b/.test(keyword)
      ? "OLED"
      : /\bqled\b/.test(keyword)
        ? "QLED"
        : /\b4k\b|\buhd\b/.test(keyword)
          ? "4K"
          : /\b8k\b/.test(keyword)
            ? "8K"
            : /\bsmart\b/.test(keyword)
              ? "Smart TV"
              : null;
  const sizeMatch =
    keyword.match(/\b(\d{2,3})\s*(?:in|inch|inches|"|''|”|in\.)\b/) ??
    keyword.match(/\b(\d{2,3})\s*tv\b/);
  const brandMatch = keyword.match(
    /\b(samsung|lg|sony|philips|hisense|panasonic|toshiba|tcl|sharp|jvc)\b/,
  );
  if (tech) tags.push(tech);
  if (sizeMatch?.[1]) tags.push(`${sizeMatch[1]} Inch`);
  if (brandMatch?.[1]) tags.push(titleCase(brandMatch[1]));
  if (/\b(deal|deals|sale|cheap|offer|offers|discount|price|prices|for sale)\b/.test(keyword)) {
    tags.push("Offers");
  }
  return tags.slice(0, 5);
}

function usesTelevisionTaxonomy(categoryFocus: string): boolean {
  return /\b(?:electronics|televisions?|tvs?)\b/i.test(categoryFocus);
}

function categoriseKeyword(
  keyword: DetoxedKeyword,
  fixture: ProjectPipelineSource,
): CategorisedKeyword["categorisation"] {
  const text = keyword.normalisedText;
  if (keyword.preCurated && keyword.category && keyword.searchIntent) {
    return {
      category: keyword.category,
      intent: keyword.searchIntent,
      source: "client_supplied",
      tags: [keyword.category],
      tier: decideTier(text, keyword.searchIntent),
    };
  }
  const ownBrand = findBrand(text, fixture.rules.ownBrands);
  if (ownBrand) {
    return {
      category: "Brand",
      intent: "navigational",
      source: "rule",
      tags: ["Brand", titleCase(ownBrand)],
      tier: decideTier(text, "navigational"),
    };
  }
  const competitor = findBrand(text, fixture.rules.competitorBrands);
  if (competitor) {
    return {
      category: "Competitor",
      intent: "navigational",
      source: "rule",
      tags: ["Competitor", titleCase(competitor)],
      tier: decideTier(text, "navigational"),
    };
  }

  const intent = classifyIntent(text, fixture);
  if (!usesTelevisionTaxonomy(fixture.project.categoryFocus)) {
    return {
      category: fixture.project.categoryFocus,
      intent,
      source: "taxonomy",
      tags: [fixture.project.categoryFocus],
      tier: decideTier(text, intent),
    };
  }
  if (/\b(repair|fix)\b/.test(text)) {
    return {
      category: "TV Repair",
      intent,
      source: "taxonomy",
      tags: ["TV Repair"],
      tier: decideTier(text, intent),
    };
  }
  if (/\b(mount|install|installation)\b/.test(text)) {
    return {
      category: "TV Installation",
      intent,
      source: "taxonomy",
      tags: ["TV Installation"],
      tier: decideTier(text, intent),
    };
  }
  if (/\b(no sound|support|troubleshoot|problem)\b/.test(text)) {
    return {
      category: "TV Support",
      intent,
      source: "taxonomy",
      tags: ["TV Support"],
      tier: decideTier(text, intent),
    };
  }
  if (/\b(stand|bracket|remote|accessor|cable)\b/.test(text)) {
    return {
      category: "TV Accessories",
      intent,
      source: "taxonomy",
      tags: ["TV Accessories"],
      tier: decideTier(text, intent),
    };
  }

  return {
    category: "Electronics",
    intent,
    source: "taxonomy",
    tags: tvTags(text),
    tier: decideTier(text, intent),
  };
}

export function decideTier(
  keyword: string,
  intent: Exclude<SearchIntent, null>,
): "deferred" | "live" {
  const normalised = normaliseKeyword(keyword);
  const wordCount = normalised ? normalised.split(/\s+/).length : 0;
  if (intent === "transactional" || intent === "commercial") return "live";
  if (TRANSACTIONAL_RE.test(normalised) || COMMERCIAL_RE.test(normalised)) return "live";
  if (wordCount <= 4) return "live";
  return "deferred";
}

function executeCategorisation(
  fixture: ProjectPipelineSource,
  detox: DetoxStageData,
): CategorisationStageData {
  const keywords = detox.keywords
    .filter((keyword) => keyword.detox.decision === "keep")
    .map((keyword) => ({
      ...keyword,
      categorisation: categoriseKeyword(keyword, fixture),
    }));

  return {
    handlerVersion: "categorisation-v1",
    keywords,
    summary: {
      deferredKeywordCount: keywords.filter(
        (keyword) => keyword.categorisation.tier === "deferred",
      ).length,
      keptKeywordCount: detox.keptKeywordCount,
      liveKeywordCount: keywords.filter(
        (keyword) => keyword.categorisation.tier === "live",
      ).length,
      missingRankingUrlCount: keywords.filter((keyword) => keyword.rankingUrl === null)
        .length,
      processingKeywordCount: detox.keywords.length,
      removedKeywordCount: detox.removedKeywordCount,
      reviewKeywordCount: detox.reviewKeywordCount,
    },
  };
}

function executeKeywordEnrichment(
  fixture: ProjectPipelineSource,
  preflight: PreflightStageData,
): KeywordEnrichmentStageData {
  const provider = new Map(
    fixture.providerInputs.keywords.map((input) => [
      normaliseKeyword(input.text),
      input,
    ]),
  );
  let providerValueCount = 0;
  const floor = fixture.project.policy?.competitiveEnrichmentVolumeFloor ?? 0;
  const keywords = preflight.keywords
    .filter((keyword) => keyword.detox.decision === "keep")
    .map((keyword) => {
    const input = provider.get(keyword.normalisedText);
    const avgMonthlyVolume =
      keyword.avgMonthlyVolume !== null && keyword.avgMonthlyVolume > 0
        ? keyword.avgMonthlyVolume
        : input?.avgMonthlyVolume ?? keyword.avgMonthlyVolume ?? null;
    const keywordDifficulty =
      keyword.keywordDifficulty ?? input?.keywordDifficulty ?? null;
    const fallbackCategorisation = categoriseKeyword(keyword, fixture);
    const intent =
      input?.intent ?? keyword.searchIntent ?? fallbackCategorisation.intent;
    const usedProvider =
      (keyword.avgMonthlyVolume === null && input?.avgMonthlyVolume !== null && input?.avgMonthlyVolume !== undefined) ||
      (keyword.keywordDifficulty === null && input?.keywordDifficulty !== null && input?.keywordDifficulty !== undefined) ||
      (input?.intent !== null && input?.intent !== undefined);
    if (usedProvider) providerValueCount += 1;
    const complete = avgMonthlyVolume !== null && keywordDifficulty !== null;
    const source =
      usedProvider && (keyword.avgMonthlyVolume !== null || keyword.keywordDifficulty !== null)
        ? "mixed"
        : usedProvider
          ? "local-provider"
          : complete
            ? "existing"
            : "missing-provider";
    return {
      ...keyword,
      category: keyword.category ?? fallbackCategorisation.category,
      enrichment: {
        avgMonthlyVolume,
        competitiveEligible:
          avgMonthlyVolume !== null && avgMonthlyVolume >= floor,
        competitiveEligibilityReason:
          avgMonthlyVolume === null
            ? "missing_volume"
            : avgMonthlyVolume >= floor
              ? "meets_operator_threshold"
              : "below_operator_threshold",
        coreKeyword:
          input?.coreKeyword ?? keyword.coreKeyword ?? clusterKey(keyword.normalisedText),
        intent,
        keywordDifficulty,
        source,
        volumeSource:
          keyword.avgMonthlyVolume !== null && keyword.avgMonthlyVolume > 0
            ? "manual"
            : input?.avgMonthlyVolume !== null && input?.avgMonthlyVolume !== undefined
              ? "provider"
              : "missing",
      },
    } satisfies EnrichedKeyword;
  });
  return {
    enrichedKeywordCount: keywords.filter(
      (keyword) =>
        keyword.enrichment.avgMonthlyVolume !== null &&
        keyword.enrichment.keywordDifficulty !== null,
    ).length,
    handlerVersion: "keyword-enrichment-v1",
    keywords,
    missingProviderCount: keywords.filter(
      (keyword) => keyword.enrichment.source === "missing-provider",
    ).length,
    providerValueCount,
  };
}

function executeRankingUrl(
  fixture: ProjectPipelineSource,
  preflight: PreflightStageData,
): RankingUrlStageData {
  const provider = new Map(
    fixture.providerInputs.keywords.map((input) => [
      normaliseKeyword(input.text),
      input,
    ]),
  );
  const keywords = preflight.keywords
    .filter((keyword) => keyword.detox.decision === "keep")
    .map((keyword) => {
    const input = provider.get(keyword.normalisedText);
    if (keyword.rankingUrl) {
      return {
        id: keyword.id,
        normalisedText: keyword.normalisedText,
        rank: null,
        rankingUrl: keyword.rankingUrl,
        status: "existing" as const,
      };
    }
    if (input?.rankingUrl) {
      return {
        id: keyword.id,
        normalisedText: keyword.normalisedText,
        rank: input.rank,
        rankingUrl: input.rankingUrl,
        status: "matched" as const,
      };
    }
    return {
      id: keyword.id,
      normalisedText: keyword.normalisedText,
      rank: null,
      rankingUrl: null,
      status: "no-match" as const,
    };
  });
  return {
    existingCount: keywords.filter((keyword) => keyword.status === "existing").length,
    handlerVersion: "ranking-url-v1",
    keywords,
    matchedCount: keywords.filter((keyword) => keyword.status === "matched").length,
    noMatchCount: keywords.filter((keyword) => keyword.status === "no-match").length,
  };
}

function executeHistoricalVolume(
  fixture: ProjectPipelineSource,
  enrichment: KeywordEnrichmentStageData,
): HistoricalVolumeStageData {
  const provider = new Map(
    fixture.providerInputs.keywords.map((input) => [
      normaliseKeyword(input.text),
      input,
    ]),
  );
  const keywords = enrichment.keywords.map((keyword) => ({
    coverageMonths:
      provider.get(keyword.normalisedText)?.monthlyVolumes.length ?? 0,
    id: keyword.id,
    normalisedText: keyword.normalisedText,
  }));
  return {
    handlerVersion: "historical-volume-v1",
    keywords,
    sufficientHistoryCount: keywords.filter(
      (keyword) => keyword.coverageMonths >= 12,
    ).length,
    unavailableCount: keywords.filter(
      (keyword) => keyword.coverageMonths === 0,
    ).length,
  };
}

function executeGscIntent(
  fixture: ProjectPipelineSource,
  preflight: PreflightStageData,
): GscIntentStageData {
  const classifications = new Map(
    preflight.keywords.map((keyword) => [
      keyword.normalisedText,
      keyword.searchIntent ?? classifyIntent(keyword.normalisedText, fixture),
    ]),
  );
  const provider = new Map(
    fixture.providerInputs.keywords.map((input) => [
      normaliseKeyword(input.text),
      input.intent,
    ]),
  );
  const distinctQueries = [
    ...new Set(fixture.gscRows.map((row) => normaliseKeyword(row.query))),
  ];
  const keywords = distinctQueries.map((normalisedText) => ({
    intent:
      provider.get(normalisedText) ??
      classifications.get(normalisedText) ??
      ("generic" as const),
    normalisedText,
  }));
  const intentCounts: Record<string, number> = {};
  for (const keyword of keywords) {
    intentCounts[keyword.intent] = (intentCounts[keyword.intent] ?? 0) + 1;
  }
  return {
    genericCount: keywords.filter((keyword) => keyword.intent === "generic").length,
    handlerVersion: "gsc-intent-v1",
    intentCounts,
    keywords,
    resolvedCount: keywords.filter((keyword) => keyword.intent !== "generic").length,
  };
}

const BRAND_STOP_WORDS = new Set([
  "agency",
  "and",
  "com",
  "company",
  "group",
  "inc",
  "limited",
  "llc",
  "ltd",
  "plc",
  "the",
]);

function derivedBrandTerms(fixture: ProjectPipelineSource): string[] {
  const companyWords = normaliseKeyword(fixture.client.companyName)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(
      (word) => word.length >= 3 && !BRAND_STOP_WORDS.has(word),
    );
  const terms = new Set(companyWords);
  if (companyWords.length > 1) {
    terms.add(companyWords.join(""));
    terms.add(companyWords.join(" "));
  }
  for (const term of domainBrandTerms(fixture.client.domain)) terms.add(term);
  return [...terms];
}

function executeBrandClassification(
  fixture: ProjectPipelineSource,
  preflight: PreflightStageData,
): BrandClassificationStageData {
  const explicitTerms = [
    ...fixture.client.brandTerms,
    ...fixture.rules.ownBrands,
  ].map(normaliseKeyword);
  const keywords = preflight.keywords.map((keyword) => {
    const explicit = explicitTerms.find((term) =>
      containsTokenOrPhrase(keyword.normalisedText, term),
    );
    if (explicit) {
      return {
        confidence: 0.95,
        id: keyword.id,
        isBranded: true,
        matchedTerm: explicit,
        normalisedText: keyword.normalisedText,
        source: "explicit-rule" as const,
      };
    }
    return {
      confidence: 0.9,
      id: keyword.id,
      isBranded: false,
      matchedTerm: null,
      normalisedText: keyword.normalisedText,
      source: "deterministic-non-brand" as const,
    };
  });
  return {
    brandedCount: keywords.filter((keyword) => keyword.isBranded).length,
    handlerVersion: "brand-classification-v1",
    keywords,
    nonBrandedCount: keywords.filter((keyword) => !keyword.isBranded).length,
  };
}

function executeSerpCollection(
  fixture: ProjectPipelineSource,
  clustering: ClusteringStageData,
): SerpCollectionStageData {
  const provider = new Map(
    fixture.providerInputs.serpKeywords.map((keyword) => [
      normaliseKeyword(keyword.text),
      keyword,
    ]),
  );
  const clientDomain = normaliseHost(fixture.client.domain);
  const clusterMembers = new Map<string, ClusteringStageData["keywords"]>();
  for (const keyword of clustering.keywords) {
    clusterMembers.set(keyword.clusterKey, [
      ...(clusterMembers.get(keyword.clusterKey) ?? []),
      keyword,
    ]);
  }
  const keywords: SerpKeywordResult[] = [];
  for (const members of clusterMembers.values()) {
    const canonical = members.find((member) => member.isCanonical) ?? members[0]!;
    const input = provider.get(canonical.normalisedText);
    if (!input) {
      for (const member of members) {
        keywords.push({
          id: member.id,
          features: [],
          normalisedText: member.normalisedText,
          results: [],
          sourceKeywordId: canonical.id,
          status: "missing-provider",
        });
      }
      continue;
    }
    const results = input.results.map((result) => ({
      domain: normaliseHost(result.domain),
      isClientDomain: normaliseHost(result.domain) === clientDomain,
      rankAbsolute: result.rankAbsolute,
      url: result.url,
    }));
    for (const member of members) {
      keywords.push({
        id: member.id,
        features: input.features ?? [],
        normalisedText: member.normalisedText,
        results,
        sourceKeywordId: canonical.id,
        status: results.length > 0 ? "matched" : "no-result",
      });
    }
  }
  return {
    clusterFetchCount: clusterMembers.size,
    handlerVersion: "serp-collection-v1",
    inheritedKeywordCount: keywords.filter(
      (keyword) => keyword.id !== keyword.sourceKeywordId,
    ).length,
    keywords,
    matchedKeywordCount: keywords.filter((keyword) => keyword.status === "matched")
      .length,
    missingProviderCount: keywords.filter(
      (keyword) => keyword.status === "missing-provider",
    ).length,
    noResultCount: keywords.filter((keyword) => keyword.status === "no-result").length,
    resultCount: keywords.reduce(
      (count, keyword) => count + keyword.results.length,
      0,
    ),
  };
}

function executeAuthority(
  fixture: ProjectPipelineSource,
  serp: SerpCollectionStageData,
): AuthorityStageData {
  return {
    authority: {
      ahrefsRank: null,
      backlinks: fixture.authority.backlinks,
      domain: normaliseHost(fixture.client.domain),
      domainRating: fixture.authority.domainRating,
      referringDomains: fixture.authority.referringDomains,
      source: "project-input",
      urlRating: null,
    },
    clientResultCount: serp.keywords.reduce(
      (count, keyword) =>
        count + keyword.results.filter((result) => result.isClientDomain).length,
      0,
    ),
    handlerVersion: "authority-v1",
    keywords: serp.keywords,
    resultCount: serp.resultCount,
  };
}

function providerMetric(
  results: SyntheticSerpResult[],
  result: SerpResult,
): SyntheticSerpResult | undefined {
  return results.find(
    (candidate) =>
      candidate.rankAbsolute === result.rankAbsolute &&
      candidate.url === result.url,
  );
}

function executeBacklinks(
  fixture: ProjectPipelineSource,
  authority: AuthorityStageData,
): BacklinksStageData {
  const provider = new Map(
    fixture.providerInputs.serpKeywords.map((keyword) => [
      normaliseKeyword(keyword.text),
      keyword.results,
    ]),
  );
  const keywords = authority.keywords.map((keyword) => ({
    ...keyword,
    results: keyword.results.map((result) => {
      const metrics = providerMetric(
        provider.get(keyword.normalisedText) ?? [],
        result,
      );
      const hasMetrics = Boolean(
        metrics &&
          [
            metrics.urlRating,
            metrics.domainRating,
            metrics.ahrefsRank,
            metrics.referringDomains,
            metrics.backlinks,
          ].some((value) => value !== null),
      );
      return {
        ...result,
        ahrefsRank: metrics?.ahrefsRank ?? null,
        backlinks: metrics?.backlinks ?? null,
        domainRating: metrics?.domainRating ?? null,
        metricSource: hasMetrics
          ? ("local-provider" as const)
          : ("missing-provider" as const),
        referringDomains: metrics?.referringDomains ?? null,
        urlRating: metrics?.urlRating ?? null,
      };
    }),
  }));
  const results = keywords.flatMap((keyword) => keyword.results);
  return {
    enrichedResultCount: results.filter(
      (result) => result.metricSource === "local-provider",
    ).length,
    handlerVersion: "backlinks-v1",
    keywords,
    missingResultCount: results.filter(
      (result) => result.metricSource === "missing-provider",
    ).length,
    resultCount: results.length,
  };
}

function executeSiteArchitecture(
  fixture: ProjectPipelineSource,
  ranking: RankingUrlStageData,
): SiteArchitectureStageData {
  const provider = new Map(
    fixture.providerInputs.siteArchitectureKeywords.map((keyword) => [
      normaliseKeyword(keyword.text),
      keyword,
    ]),
  );
  const keywords = ranking.keywords.map((keyword) => {
    const input = provider.get(keyword.normalisedText);
    if (!input) {
      return {
        contentStatus: null,
        id: keyword.id,
        matchedUrl: keyword.rankingUrl,
        normalisedText: keyword.normalisedText,
        relevancyScore: null,
        status: "missing-provider" as const,
        tacticalStatus: null,
      };
    }
    return {
      contentStatus: input.contentStatus,
      id: keyword.id,
      matchedUrl: input.matchedUrl,
      normalisedText: keyword.normalisedText,
      relevancyScore: input.relevancyScore,
      status: "matched" as const,
      tacticalStatus: input.tacticalStatus,
    };
  });
  return {
    handlerVersion: "site-architecture-v1",
    keywords,
    matchedCount: keywords.filter((keyword) => keyword.status === "matched")
      .length,
    missingProviderCount: keywords.filter(
      (keyword) => keyword.status === "missing-provider",
    ).length,
  };
}

function executeLinkPowerScore(
  backlinks: BacklinksStageData,
): LinkPowerScoreStageData {
  const metricRows = backlinks.keywords.flatMap((keyword) =>
    keyword.results.map((result) => ({
      backlinks: result.backlinks,
      domainRating: result.domainRating,
      keywordId: `${keyword.id}:${result.rankAbsolute}`,
      referringDomains: result.referringDomains,
      urlRating: result.urlRating,
    })),
  );
  const scoringContext = createLpsScoringContext(metricRows);
  const metrics = new Map(
    metricRows.map((row) => [row.keywordId, computeLps(row, scoringContext)]),
  );
  const keywords = backlinks.keywords.map((keyword) => ({
    id: keyword.id,
    normalisedText: keyword.normalisedText,
    results: keyword.results.map((result) => {
      const score = metrics.get(`${keyword.id}:${result.rankAbsolute}`);
      if (!score) {
        throw new Error("Link power score input was not indexed.");
      }
      return {
        ...result,
        confidence: score.confidence,
        score: score.score,
      };
    }),
  }));
  const results = keywords.flatMap((keyword) => keyword.results);
  return {
    handlerVersion: "link-power-score-v1",
    keywords,
    resultCount: results.length,
    scoredResultCount: results.filter(
      (result) => result.metricSource === "local-provider",
    ).length,
  };
}

function executeDemandSignals(
  fixture: ProjectPipelineSource,
  enrichment: KeywordEnrichmentStageData,
): DemandSignalsStageData {
  const provider = new Map(
    fixture.providerInputs.keywords.map((keyword) => [
      normaliseKeyword(keyword.text),
      keyword,
    ]),
  );
  const keywords = enrichment.keywords.map((keyword) => {
    const input = provider.get(keyword.normalisedText);
    const monthlyVolumes = input?.monthlyVolumes ?? [];
    return {
      avgMonthlyVolume: keyword.enrichment.avgMonthlyVolume,
      id: keyword.id,
      monthlyVolumes,
      normalisedText: keyword.normalisedText,
      ...computeDemandSignal(monthlyVolumes),
    };
  });
  return {
    handlerVersion: "demand-signals-v1",
    keywords,
    sufficientHistoryCount: keywords.filter(
      (keyword) => keyword.coverageMonths >= 12,
    ).length,
    warningCount: keywords.filter((keyword) => keyword.demandWarning).length,
  };
}

interface CtrObservation {
  ctr: number;
  impressions: number;
  position: number;
}

function executeCtrCurves(
  fixture: ProjectPipelineSource,
  brand: BrandClassificationStageData,
  gscIntent: GscIntentStageData,
): CtrCurvesStageData {
  const brandByText = new Map(
    brand.keywords.map((keyword) => [
      keyword.normalisedText,
      keyword.isBranded,
    ]),
  );
  const intentByText = new Map(
    gscIntent.keywords.map((keyword) => [
      keyword.normalisedText,
      keyword.intent,
    ]),
  );
  const keywords = fixture.gscRows.map((row) => {
    const normalisedText = normaliseKeyword(row.query);
    return {
      device: row.device,
      impressions: row.impressions,
      intent: intentByText.get(normalisedText) ?? ("generic" as const),
      isBranded: brandByText.get(normalisedText) ?? false,
      normalisedText,
      position: row.position,
    };
  });
  const groups = new Map<
    string,
    {
      device: SyntheticGscRow["device"];
      intent: Exclude<SearchIntent, null> | "generic";
      isBranded: boolean;
      observations: CtrObservation[];
    }
  >();
  for (const row of fixture.gscRows) {
    const normalisedText = normaliseKeyword(row.query);
    const intent = intentByText.get(normalisedText) ?? ("generic" as const);
    const isBranded = brandByText.get(normalisedText) ?? false;
    if (isBranded) continue;
    const key = `${row.device}\u0000${intent}\u0000${isBranded}`;
    const group = groups.get(key) ?? {
      device: row.device,
      intent,
      isBranded,
      observations: [],
    };
    group.observations.push({
      ctr: row.ctr,
      impressions: row.impressions,
      position: row.position,
    });
    groups.set(key, group);
  }
  const curves = [...groups.values()].map((group) => {
    const observedByRank = new Map<number, CtrObservation[]>();
    for (const observation of group.observations) {
      const rank = Math.max(1, Math.min(20, Math.round(observation.position)));
      observedByRank.set(rank, [
        ...(observedByRank.get(rank) ?? []),
        observation,
      ]);
    }
    const points: CtrCurvePoint[] = Array.from({ length: 20 }, (_, index) => {
      const rank = index + 1;
      const observations = observedByRank.get(rank) ?? [];
      const impressions = observations.reduce(
        (sum, observation) => sum + observation.impressions,
        0,
      );
      if (impressions === 0) {
        return {
          confidence: "low",
          ctr: fallbackCtr(rank),
          impressions: 0,
          rank,
          source: "fallback",
        };
      }
      const observedCtr =
        observations.reduce(
          (sum, observation) =>
            sum + observation.ctr * observation.impressions,
          0,
        ) / impressions;
      const blendWeight = Math.min(1, impressions / 500);
      return {
        confidence: ctrConfidence(impressions),
        ctr:
          observedCtr * blendWeight +
          fallbackCtr(rank) * (1 - blendWeight),
        impressions,
        rank,
        source: impressions >= 500 ? "gsc" : "blended",
      };
    });
    for (let index = 1; index < points.length; index += 1) {
      points[index]!.ctr = Math.min(points[index]!.ctr, points[index - 1]!.ctr);
    }
    return {
      device: group.device,
      intent: group.intent,
      isBranded: group.isBranded,
      points,
    };
  });
  return {
    curves,
    handlerVersion: "ctr-curves-v1",
    keywords,
    observedPointCount: curves.reduce(
      (count, curve) =>
        count +
        curve.points.filter((point) => point.source !== "fallback").length,
      0,
    ),
    provenance: {
      dateRangeEnd: fixture.economics.gscDateRangeEnd ?? null,
      dateRangeStart: fixture.economics.gscDateRangeStart ?? null,
      excludedBrandedRows: keywords.filter((keyword) => keyword.isBranded).length,
      sampleImpressions: keywords
        .filter((keyword) => !keyword.isBranded)
        .reduce((sum, keyword) => sum + keyword.impressions, 0),
      sampleRows: keywords.filter((keyword) => !keyword.isBranded).length,
    },
  };
}

function executeClustering(
  enrichment: KeywordEnrichmentStageData,
): ClusteringStageData {
  const groups = new Map<string, EnrichedKeyword[]>();
  for (const keyword of enrichment.keywords) {
    const key =
      normaliseKeyword(keyword.enrichment.coreKeyword) ||
      clusterKey(keyword.normalisedText) ||
      keyword.normalisedText;
    groups.set(key, [...(groups.get(key) ?? []), keyword]);
  }
  const keywords: ClusteringStageData["keywords"] = [];
  for (const [key, members] of groups) {
    const canonical = pickCanonical(
      members.map((member) => {
        return {
          annualVolume: (member.enrichment.avgMonthlyVolume ?? 0) * 12,
          baseRank: member.gsc?.position ?? null,
          gscClicks: member.gsc?.clicks ?? 0,
          id: member.id,
          rankingUrl: member.rankingUrl,
          text: member.normalisedText,
        };
      }),
    );
    for (const member of members) {
      keywords.push({
        canonicalBasis: canonical.basis,
        canonicalKeywordId: canonical.member.id,
        clusterKey: key,
        id: member.id,
        isCanonical: canonical.member.id === member.id,
        memberCount: members.length,
        normalisedText: member.normalisedText,
      });
    }
  }
  return {
    clusterCount: groups.size,
    handlerVersion: "clustering-v1",
    keywords,
  };
}

function executeHarV2(
  fixture: ProjectPipelineSource,
  ranking: RankingUrlStageData,
  siteArchitecture: SiteArchitectureStageData,
  linkPowerScore: LinkPowerScoreStageData,
  clustering: ClusteringStageData,
  enrichment: KeywordEnrichmentStageData,
  brand: BrandClassificationStageData,
  serp: SerpCollectionStageData,
): HarV2StageData {
  const rankingById = new Map(
    ranking.keywords.map((keyword) => [keyword.id, keyword]),
  );
  const siteById = new Map(
    siteArchitecture.keywords.map((keyword) => [keyword.id, keyword]),
  );
  const lpsById = new Map(
    linkPowerScore.keywords.map((keyword) => [keyword.id, keyword]),
  );
  const clusterById = new Map(
    clustering.keywords.map((keyword) => [keyword.id, keyword]),
  );
  const brandById = new Map(
    brand.keywords.map((keyword) => [keyword.id, keyword]),
  );
  const serpById = new Map(
    serp.keywords.map((keyword) => [keyword.id, keyword]),
  );
  const keywords = enrichment.keywords.map((keyword) => {
    const serpKeyword = serpById.get(keyword.id);
    const lpsKeyword = lpsById.get(keyword.id);
    const clientResult = lpsKeyword?.results
      .filter((result) => result.isClientDomain)
      .sort((left, right) => left.rankAbsolute - right.rankAbsolute)[0];
    const lpsMetricRows = (lpsKeyword?.results ?? []).map((result) => ({
      backlinks: result.backlinks,
      domainRating: result.domainRating,
      keywordId: keyword.id,
      referringDomains: result.referringDomains,
      urlRating: result.urlRating,
    }));
    const syntheticClientLps = clientResult
      ? null
      : computeLps(
          {
            backlinks: fixture.authority.backlinks,
            domainRating: fixture.authority.domainRating,
            keywordId: keyword.id,
            referringDomains: fixture.authority.referringDomains,
            urlRating: null,
          },
          [
            ...lpsMetricRows,
            {
              backlinks: fixture.authority.backlinks,
              domainRating: fixture.authority.domainRating,
              keywordId: keyword.id,
              referringDomains: fixture.authority.referringDomains,
              urlRating: null,
            },
          ],
        ).score;
    const baseRank =
      clientResult?.rankAbsolute ??
      rankingById.get(keyword.id)?.rank ??
      null;
    const contentFit =
      siteById.get(keyword.id)?.relevancyScore === null ||
      siteById.get(keyword.id)?.relevancyScore === undefined
        ? null
        : siteById.get(keyword.id)!.relevancyScore! / 100;
    const competitors = (lpsKeyword?.results ?? [])
      .filter((result) => !result.isClientDomain)
      .map((result) => ({
        domain: result.domain,
        domain_rating: result.domainRating,
        lps_score: result.score,
        rank_absolute: result.rankAbsolute,
        url: result.url,
        url_rating: result.urlRating,
      }));
    const scenarios = HAR_SCENARIOS.map((scenario) => {
      const result = computeScenario(
        {
          base_rank: baseRank,
          client_dr: fixture.authority.domainRating,
          client_lps: clientResult?.score ?? syntheticClientLps,
          client_lps_match: clientResult ? "ranking_url" : "synthetic",
          client_lps_source: clientResult
            ? "serp_row"
            : "synthetic_client_domain",
          client_resolved_url:
            clientResult?.url ??
            rankingById.get(keyword.id)?.rankingUrl ??
            null,
          client_ur: clientResult?.urlRating ?? null,
          competitors,
          content_fit_score: contentFit,
          has_client_authority:
            fixture.authority.domainRating > 0 ||
            fixture.authority.referringDomains > 0 ||
            fixture.authority.backlinks > 0,
          has_client_lps_row:
            clientResult !== undefined || syntheticClientLps !== null,
          latest_lps_run_exists: (lpsKeyword?.results.length ?? 0) > 0,
          serp_feature_count: serpKeyword?.features.length ?? 0,
          snippet_opportunity: null,
          top_serp_feature: serpKeyword?.features[0] ?? null,
        },
        scenario,
        null,
        fixture.scoringConfig as ScoringConfig | undefined,
      );
      return {
        authorityScore: result.authority_score,
        confidence: result.har_confidence,
        contentFitScore: result.content_fit_score,
        explanation: {
          ...result.explanation_json,
          clientDomain: fixture.client.domain,
          serpStatus: serpKeyword?.status ?? "missing-provider",
        },
        harPosition: result.har_position,
        linkGapScore: result.link_gap_score,
        linkPowerScore: result.link_power_score,
        rankAttainmentProbability: result.rank_attainment_probability,
        scenario: result.scenario,
        serpVisibilityMultiplier: result.serp_visibility_multiplier ?? 1,
      };
    });
    return {
      baseRank,
      category: keyword.category,
      device: (keyword.gsc?.devices[0] as SyntheticGscRow["device"] | undefined) ?? null,
      id: keyword.id,
      intent: keyword.enrichment.intent,
      isBranded: brandById.get(keyword.id)?.isBranded ?? false,
      isCanonical: clusterById.get(keyword.id)?.isCanonical ?? true,
      normalisedText: keyword.normalisedText,
      serpFeatures: serpKeyword?.features ?? [],
      scenarios,
    };
  });
  return {
    handlerVersion: "har-v2.1",
    keywords,
    modelVersion: HAR_MODEL_VERSION,
    scenarioCount: keywords.reduce(
      (count, keyword) => count + keyword.scenarios.length,
      0,
    ),
  };
}

function curveCtr(
  curves: CtrCurvesStageData,
  rank: number | null,
  intent: Exclude<SearchIntent, null>,
  isBranded: boolean,
  device: SyntheticGscRow["device"] | null,
): number | null {
  if (rank === null || rank < 1) return null;
  const candidates = curves.curves
    .filter(
      (curve) => curve.intent === intent && curve.isBranded === isBranded,
    )
    .sort((left, right) => {
      if (device) {
        if (left.device === device && right.device !== device) return -1;
        if (right.device === device && left.device !== device) return 1;
      }
      const order: Record<SyntheticGscRow["device"], number> = {
        all: 0,
        mobile: 1,
        desktop: 2,
        tablet: 3,
      };
      return order[left.device] - order[right.device];
    });
  const point = candidates[0]?.points.find(
    (candidate) => candidate.rank === Math.min(20, Math.round(rank)),
  );
  return point?.ctr ?? fallbackCtr(rank);
}

function normaliseOverrideValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normaliseOverrideUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if (
      (url.protocol === "https:" && url.port === "443") ||
      (url.protocol === "http:" && url.port === "80")
    ) {
      url.port = "";
    }
    if (url.pathname !== "/") {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    url.searchParams.sort();
    return url.toString();
  } catch {
    return normaliseOverrideValue(value).replace(/\/+$/, "");
  }
}

const REVENUE_VISIBILITY_MULTIPLIERS: Record<
  string,
  Partial<Record<Exclude<SearchIntent, null>, number>>
> = {
  ai_overview: { commercial: 0.72, informational: 0.55, navigational: 0.9, transactional: 0.86 },
  featured_snippet: { commercial: 0.88, informational: 0.78, navigational: 0.95, transactional: 0.94 },
  local_pack: { commercial: 0.78, informational: 0.9, navigational: 0.82, transactional: 0.7 },
  people_also_ask: { commercial: 0.95, informational: 0.88, navigational: 0.98, transactional: 0.98 },
  shopping: { commercial: 0.78, informational: 0.93, navigational: 0.92, transactional: 0.68 },
  video: { commercial: 0.94, informational: 0.86, navigational: 0.96, transactional: 0.97 },
};

function revenueVisibilityMultiplier(
  features: readonly string[],
  intent: Exclude<SearchIntent, null>,
  fixture: ProjectPipelineSource,
  device: SyntheticGscRow["device"] | null,
): number {
  return Math.max(
    0.25,
    features.reduce((multiplier, feature) => {
      const key = normaliseKeyword(feature).replace(/[\s-]+/g, "_");
      const configured = fixture.serpVisibilityAdjustments?.find(
        (adjustment) =>
          normaliseKeyword(adjustment.featureType).replace(/[\s-]+/g, "_") === key &&
          (adjustment.intent === intent || adjustment.intent === "generic") &&
          (adjustment.device === "all" || adjustment.device === device),
      );
      return multiplier * (
        configured?.multiplier ?? REVENUE_VISIBILITY_MULTIPLIERS[key]?.[intent] ?? 1
      );
    }, 1),
  );
}

function revenueAssumptions(
  fixture: ProjectPipelineSource,
  keyword: HarV2StageData["keywords"][number],
  ranking: RankingUrlStageData,
): {
  averageOrderValue: number | null;
  averageOrderValueOverrideId: string | null;
  conversionRate: number | null;
  conversionRateOverrideId: string | null;
} {
  const rankingKeyword = ranking.keywords.find(
    (candidate) => candidate.id === keyword.id,
  );
  const category = keyword.category;
  const rankingUrl = rankingKeyword?.rankingUrl ?? null;
  const scopePriority = { url: 0, category: 1, intent: 2, project: 3 };
  const matchingOverrides = fixture.conversionOverrides
    .filter((override) => {
      if (override.scopeType === "project") return true;
      if (override.scopeValue === null) return false;
      if (override.scopeType === "url") {
        return (
          rankingUrl !== null &&
          normaliseOverrideUrl(override.scopeValue) ===
            normaliseOverrideUrl(rankingUrl)
        );
      }
      if (override.scopeType === "category") {
        return (
          category !== null &&
          normaliseOverrideValue(override.scopeValue) ===
            normaliseOverrideValue(category)
        );
      }
      return (
        normaliseOverrideValue(override.scopeValue) ===
        normaliseOverrideValue(keyword.intent)
      );
    })
    .sort(
      (left, right) =>
        scopePriority[left.scopeType] - scopePriority[right.scopeType],
    );
  const conversionRateOverride = matchingOverrides.find(
    (override) => override.conversionRate !== null,
  );
  const averageOrderValueOverride = matchingOverrides.find(
    (override) => override.averageOrderValue !== null,
  );

  return {
    averageOrderValue:
      averageOrderValueOverride?.averageOrderValue ??
      fixture.economics.averageOrderValue,
    averageOrderValueOverrideId: averageOrderValueOverride?.id ?? null,
    conversionRate:
      conversionRateOverride?.conversionRate ??
      fixture.economics.conversionRate,
    conversionRateOverrideId: conversionRateOverride?.id ?? null,
  };
}

function executeRevenueV2(
  fixture: ProjectPipelineSource,
  har: HarV2StageData,
  demand: DemandSignalsStageData,
  ctrCurves: CtrCurvesStageData,
  ranking: RankingUrlStageData,
): RevenueV2StageData {
  const demandById = new Map(
    demand.keywords.map((keyword) => [keyword.id, keyword]),
  );
  const keywords = har.keywords.map((keyword) => {
    const assumptions = revenueAssumptions(
      fixture,
      keyword,
      ranking,
    );
    const demandSignal = demandById.get(keyword.id);
    const volume = demandSignal
      ? annualVolumeFromInputs(
          demandSignal.monthlyVolumes,
          demandSignal.avgMonthlyVolume,
        )
      : {
          months_used: 0,
          source: "none" as const,
          volume_annual: null,
        };
    const ctrNow = curveCtr(
      ctrCurves,
      keyword.baseRank,
      keyword.intent,
      keyword.isBranded,
      keyword.device,
    );
    const scenarios = keyword.scenarios.map((harScenario) => {
      const ctrTarget = curveCtr(
        ctrCurves,
        harScenario.harPosition,
        keyword.intent,
        keyword.isBranded,
        keyword.device,
      );
      const result = computeRevenueV2({
        aov: assumptions.averageOrderValue,
        ctr_now: ctrNow,
        ctr_tp: ctrTarget,
        cvr: assumptions.conversionRate,
        har_confidence: harScenario.confidence,
        monthly_volumes: demandSignal?.monthlyVolumes ?? [],
        pos_now: keyword.baseRank,
        pos_tp: harScenario.harPosition,
        rank_attainment_probability:
          harScenario.rankAttainmentProbability,
        scenario: harScenario.scenario,
        svm: revenueVisibilityMultiplier(
          keyword.serpFeatures,
          keyword.intent,
          fixture,
          keyword.device,
        ),
        trend_confidence: demandSignal?.trendConfidence ?? "low",
        trend_pct: demandSignal?.trendPct ?? null,
        volume_annual: volume.volume_annual,
      });
      return {
        annualVolume: volume.volume_annual,
        averageOrderValueOverrideId:
          assumptions.averageOrderValueOverrideId,
        averageOrderValueUsed: assumptions.averageOrderValue,
        bandMethod: result.band_method,
        ctrNow: result.ctr_now,
        ctrTarget: result.ctr_tp,
        conversionRateOverrideId: assumptions.conversionRateOverrideId,
        conversionRateUsed: assumptions.conversionRate,
        currentRevenueAnnual: result.current_revenue_annual,
        expectedIncrementalAnnual:
          result.expected_incremental_revenue_annual,
        expectedIncrementalHighAnnual:
          result.expected_incremental_high_annual,
        expectedIncrementalLowAnnual:
          result.expected_incremental_low_annual,
        factorApplied: result.factor_applied,
        harConfidenceUsed: result.har_conf_used,
        modelledMonthlyClicks:
          result.volume_forward === null || result.ctr_now === null
            ? null
            : (result.volume_forward *
                result.ctr_now *
                result.svm_used) /
              12,
        monthlyRevenue: result.monthly_revenue_json,
        rankAttainmentProbabilityUsed: result.p_att_used,
        scenario: harScenario.scenario,
        serpVisibilityMultiplierUsed: result.svm_used,
        targetAbsoluteRevenueAnnual:
          result.tp_absolute_revenue_annual,
        targetIncrementalRevenueAnnual:
          result.tp_incremental_revenue_annual,
        volumeForward: result.volume_forward,
        warnings: result.warnings,
      };
    });
    return {
      baseRank: keyword.baseRank,
      id: keyword.id,
      intent: keyword.intent,
      isBranded: keyword.isBranded,
      isCanonical: keyword.isCanonical,
      normalisedText: keyword.normalisedText,
      scenarios,
    };
  });
  return {
    forecastCount: keywords.reduce(
      (count, keyword) => count + keyword.scenarios.length,
      0,
    ),
    handlerVersion: "revenue-v2.1",
    keywords,
    modelVersion: REVENUE_MODEL_VERSION,
  };
}

function executeHarReadiness(
  fixture: ProjectPipelineSource,
  ranking: RankingUrlStageData,
  siteArchitecture: SiteArchitectureStageData,
  linkPowerScore: LinkPowerScoreStageData,
  serp: SerpCollectionStageData,
): ReadinessStageData {
  const missing: string[] = [];
  if (ranking.keywords.length === 0) missing.push("kept_keywords");
  const competitiveKeywordCount = serp.keywords.filter(
    (keyword) => keyword.status !== "missing-provider",
  ).length;
  if (competitiveKeywordCount > 0 && serp.resultCount === 0) {
    missing.push("fresh_serp_results");
  }
  if (
    linkPowerScore.scoredResultCount === 0 &&
    fixture.authority.domainRating === 0 &&
    fixture.authority.referringDomains === 0 &&
    fixture.authority.backlinks === 0
  ) {
    missing.push("link_power_or_client_authority");
  }
  if (siteArchitecture.keywords.length !== ranking.keywords.length) {
    missing.push("content_fit_attempt");
  }
  if (fixture.scoringConfigActive === false) missing.push("active_scoring_config");
  if (missing.length > 0) {
    throw new Error(`HAR readiness failed: ${missing.join(", ")}.`);
  }
  return {
    handlerVersion: "har-readiness-v1",
    keywords: ranking.keywords.map(({ id, normalisedText }) => ({ id, normalisedText })),
    ready: true,
    substitutions: [
      {
        count: siteArchitecture.keywords.filter(
          (keyword) => keyword.relevancyScore === null,
        ).length,
        input: "content_fit",
        substitute: "neutral_with_confidence_penalty",
      },
      {
        count: serp.inheritedKeywordCount,
        input: "variant_serp",
        substitute: "canonical_cluster_serp",
      },
    ],
  };
}

function executeRevenueReadiness(
  fixture: ProjectPipelineSource,
  har: HarV2StageData,
  demand: DemandSignalsStageData,
  ctr: CtrCurvesStageData,
): ReadinessStageData {
  const missing: string[] = [];
  if (har.scenarioCount === 0) missing.push("completed_har_run");
  if (fixture.economics.conversionRate === null) missing.push("conversion_rate");
  if (fixture.economics.averageOrderValue === null) missing.push("average_order_value");
  if (demand.keywords.length !== har.keywords.length) missing.push("demand_signals");
  if (missing.length > 0) {
    throw new Error(`Revenue readiness failed: ${missing.join(", ")}.`);
  }
  return {
    handlerVersion: "revenue-readiness-v1",
    keywords: har.keywords.map(({ id, normalisedText }) => ({ id, normalisedText })),
    ready: true,
    substitutions: [
      {
        count: ctr.curves.length === 0 ? har.keywords.length : 0,
        input: "project_ctr_curve",
        substitute: "global_fallback_ladder",
      },
      {
        count: demand.warningCount,
        input: "monthly_history",
        substitute: "annual_volume_without_seasonal_shape",
      },
    ],
  };
}

function executeRollupOutput(
  revenue: RevenueV2StageData,
  ranking: RankingUrlStageData,
  categorisation: CategorisationStageData,
  clustering: ClusteringStageData,
  demand: DemandSignalsStageData,
): RollupOutputStageData {
  const categoryById = new Map(
    categorisation.keywords.map((keyword) => [
      keyword.id,
      keyword.categorisation.category,
    ]),
  );
  const clusterById = new Map(
    clustering.keywords.map((keyword) => [keyword.id, keyword]),
  );
  const demandById = new Map(
    demand.keywords.map((keyword) => [keyword.id, keyword]),
  );
  const scenarios = HAR_SCENARIOS.map((scenario) => {
    const rows = revenue.keywords.flatMap((keyword) => {
      const result = keyword.scenarios.find((item) => item.scenario === scenario);
      return result ? [{ keyword, result }] : [];
    });
    const naive = rows.reduce(
      (sum, row) => sum + (row.result.expectedIncrementalAnnual ?? 0),
      0,
    );
    const deduped = rows
      .filter((row) => row.keyword.isCanonical)
      .reduce(
        (sum, row) => sum + (row.result.expectedIncrementalAnnual ?? 0),
        0,
      );
    const canonicalRows = rows.filter((row) => row.keyword.isCanonical);
    const grouped = <T extends string>(
      values: Array<{ key: T; value: number }>,
    ): Array<{ expectedIncrementalAnnual: number; key: T; keywordCount: number }> => {
      const groups = new Map<T, { expectedIncrementalAnnual: number; keywordCount: number }>();
      for (const value of values) {
        const group = groups.get(value.key) ?? {
          expectedIncrementalAnnual: 0,
          keywordCount: 0,
        };
        group.expectedIncrementalAnnual += value.value;
        group.keywordCount += 1;
        groups.set(value.key, group);
      }
      return [...groups.entries()]
        .map(([key, value]) => ({ key, ...value }))
        .sort((left, right) => right.expectedIncrementalAnnual - left.expectedIncrementalAnnual);
    };
    const categoryRollup = grouped(
      canonicalRows.map((row) => ({
        key: categoryById.get(row.keyword.id) ?? "Uncategorised",
        value: row.result.expectedIncrementalAnnual ?? 0,
      })),
    ).map(({ key, ...value }) => ({ category: key, ...value }));
    const quarterRollup = grouped(
      canonicalRows.map((row) => {
        const peakMonth = demandById.get(row.keyword.id)?.peakMonths[0];
        const quarter: "Q1" | "Q2" | "Q3" | "Q4" | "Unscheduled" = peakMonth
          ? (`Q${Math.ceil(peakMonth / 3)}` as "Q1" | "Q2" | "Q3" | "Q4")
          : "Unscheduled";
        return {
          key: quarter,
          value: row.result.expectedIncrementalAnnual ?? 0,
        };
      }),
    ).map(({ key, ...value }) => ({ quarter: key, ...value }));
    const trendRollup = grouped(
      canonicalRows.map((row) => ({
        key: demandById.get(row.keyword.id)?.trendDirection ?? "insufficient_data",
        value: row.result.expectedIncrementalAnnual ?? 0,
      })),
    ).map(({ key, ...value }) => ({ trend: key, ...value }));
    const clusterRollup = canonicalRows.map((row) => {
      const cluster = clusterById.get(row.keyword.id);
      return {
        canonicalKeywordId: row.keyword.id,
        clusterKey: cluster?.clusterKey ?? row.keyword.normalisedText,
        expectedIncrementalAnnual: row.result.expectedIncrementalAnnual ?? 0,
        memberCount: cluster?.memberCount ?? 1,
      };
    });
    return {
      categoryRollup,
      clusterDedupedExpectedIncrementalAnnual: deduped,
      clusterRollup,
      doubleCountAnnual: Math.max(0, naive - deduped),
      naiveExpectedIncrementalAnnual: naive,
      quarterRollup,
      scenario,
      trendRollup,
    };
  });
  const realistic = revenue.keywords.flatMap((keyword) => {
    const result = keyword.scenarios.find((item) => item.scenario === "realistic");
    return result ? [result] : [];
  });
  const confidenceDistribution = { high: 0, low: 0, medium: 0 };
  for (const row of realistic) {
    if (row.harConfidenceUsed >= 0.75) confidenceDistribution.high += 1;
    else if (row.harConfidenceUsed >= 0.5) confidenceDistribution.medium += 1;
    else confidenceDistribution.low += 1;
  }
  const byUrl = new Map<string, string[]>();
  for (const keyword of ranking.keywords) {
    if (!keyword.rankingUrl) continue;
    byUrl.set(keyword.rankingUrl, [
      ...(byUrl.get(keyword.rankingUrl) ?? []),
      keyword.id,
    ]);
  }
  return {
    cannibalisationFlags: [...byUrl.entries()]
      .filter(([, keywordIds]) => keywordIds.length > 1)
      .map(([url, keywordIds]) => ({ keywordIds, url })),
    confidenceDistribution,
    handlerVersion: "rollup-output-v1",
    keywords: revenue.keywords.map(({ id, normalisedText }) => ({ id, normalisedText })),
    scenarios,
  };
}

function executeCalibration(
  fixture: ProjectPipelineSource,
  revenue: RevenueV2StageData,
): CalibrationStageData {
  const gsc = new Map(
    aggregateGscRows(fixture.gscRows).map((row) => [
      row.normalisedText,
      row,
    ]),
  );
  const keywords: CalibrationStageData["keywords"] = [];
  for (const keyword of revenue.keywords) {
    if (!keyword.isCanonical || keyword.baseRank === null) continue;
    const actual = gsc.get(keyword.normalisedText);
    const realistic = keyword.scenarios.find(
      (scenario) => scenario.scenario === "realistic",
    );
    if (!actual || realistic?.modelledMonthlyClicks === null || !realistic) {
      continue;
    }
    keywords.push({
      actualClicks: actual.clicks,
      id: keyword.id,
      impressions: actual.impressions,
      intent: keyword.intent,
      modelledMonthlyClicks: realistic.modelledMonthlyClicks,
      normalisedText: keyword.normalisedText,
      rank: keyword.baseRank,
      windowDays: fixture.economics.gscWindowDays,
    });
  }
  const result = computeCalibration(
    keywords.map((keyword) => ({
      actual_clicks_raw: keyword.actualClicks,
      impressions: keyword.impressions,
      intent: keyword.intent,
      modelled_monthly_clicks: keyword.modelledMonthlyClicks,
      rank: keyword.rank,
      window_days: keyword.windowDays,
    })),
  );
  const calibrationStatus = trafficLight(result.overall_ratio);
  return {
    byIntent: result.by_intent,
    byRankBand: result.by_rank_band,
    excludedNoiseFloor: result.excluded_noise_floor,
    handlerVersion: "calibration-v1",
    impressionsContext: result.impressions_context,
    keywords,
    matched: result.matched,
    medianPerPairRatio: result.median_per_pair_ratio,
    modelVersion: CALIBRATION_MODEL_VERSION,
    overallRatio: result.overall_ratio,
    promotionEligible: isPromotionEligible(result),
    status: calibrationStatus ?? "unavailable",
    sumActualMonthly: result.sum_actual_monthly,
    sumModelledMonthly: result.sum_modelled_monthly,
    unavailableReason:
      fixture.gscRows.length === 0 ? "calibration_unavailable_no_gsc" : null,
  };
}

export function executeDataDrivenStage(
  stageId: PipelineStageId,
  fixture: ProjectPipelineSource,
  outputs: DependencyOutputs,
): DataDrivenStageData | null {
  switch (stageId) {
    case "intake":
      return executeIntake(fixture);
    case "gsc-promotion":
      return executeGscPromotion(
        fixture,
        dependency<IntakeStageData>(outputs, "intake", "intake-v1"),
      );
    case "detox":
      return executeDetox(
        fixture,
        dependency<GscPromotionStageData>(
          outputs,
          "gsc-promotion",
          "gsc-promotion-v1",
        ),
      );
    case "preflight":
      return executePreflight(
        fixture,
        dependency<DetoxStageData>(outputs, "detox", "detox-v1"),
      );
    case "categorisation":
      return executeCategorisation(
        fixture,
        dependency<DetoxStageData>(outputs, "detox", "detox-v1"),
      );
    case "keyword-enrichment":
      return executeKeywordEnrichment(
        fixture,
        dependency<PreflightStageData>(
          outputs,
          "preflight",
          "preflight-v1",
        ),
      );
    case "historical-volume":
      return executeHistoricalVolume(
        fixture,
        dependency<KeywordEnrichmentStageData>(
          outputs,
          "keyword-enrichment",
          "keyword-enrichment-v1",
        ),
      );
    case "ranking-url":
      return executeRankingUrl(
        fixture,
        dependency<PreflightStageData>(
          outputs,
          "preflight",
          "preflight-v1",
        ),
      );
    case "gsc-intent":
      return executeGscIntent(
        fixture,
        dependency<PreflightStageData>(
          outputs,
          "preflight",
          "preflight-v1",
        ),
      );
    case "brand-classification":
      return executeBrandClassification(
        fixture,
        dependency<PreflightStageData>(
          outputs,
          "preflight",
          "preflight-v1",
        ),
      );
    case "serp-collection":
      return executeSerpCollection(
        fixture,
        dependency<ClusteringStageData>(
          outputs,
          "clustering",
          "clustering-v1",
        ),
      );
    case "authority":
      return executeAuthority(
        fixture,
        dependency<SerpCollectionStageData>(
          outputs,
          "serp-collection",
          "serp-collection-v1",
        ),
      );
    case "backlinks":
      return executeBacklinks(
        fixture,
        dependency<AuthorityStageData>(
          outputs,
          "authority",
          "authority-v1",
        ),
      );
    case "site-architecture":
      return executeSiteArchitecture(
        fixture,
        dependency<RankingUrlStageData>(
          outputs,
          "ranking-url",
          "ranking-url-v1",
        ),
      );
    case "link-power-score":
      return executeLinkPowerScore(
        dependency<BacklinksStageData>(
          outputs,
          "backlinks",
          "backlinks-v1",
        ),
      );
    case "demand-signals":
      dependency<HistoricalVolumeStageData>(
        outputs,
        "historical-volume",
        "historical-volume-v1",
      );
      return executeDemandSignals(
        fixture,
        dependency<KeywordEnrichmentStageData>(
          outputs,
          "keyword-enrichment",
          "keyword-enrichment-v1",
        ),
      );
    case "ctr-curves":
      return executeCtrCurves(
        fixture,
        dependency<BrandClassificationStageData>(
          outputs,
          "brand-classification",
          "brand-classification-v1",
        ),
        dependency<GscIntentStageData>(
          outputs,
          "gsc-intent",
          "gsc-intent-v1",
        ),
      );
    case "clustering":
      return executeClustering(
        dependency<KeywordEnrichmentStageData>(
          outputs,
          "keyword-enrichment",
          "keyword-enrichment-v1",
        ),
      );
    case "har-readiness":
      return executeHarReadiness(
        fixture,
        dependency<RankingUrlStageData>(outputs, "ranking-url", "ranking-url-v1"),
        dependency<SiteArchitectureStageData>(
          outputs,
          "site-architecture",
          "site-architecture-v1",
        ),
        dependency<LinkPowerScoreStageData>(
          outputs,
          "link-power-score",
          "link-power-score-v1",
        ),
        dependency<SerpCollectionStageData>(
          outputs,
          "serp-collection",
          "serp-collection-v1",
        ),
      );
    case "har-v2":
      dependency<ReadinessStageData>(
        outputs,
        "har-readiness",
        "har-readiness-v1",
      );
      return executeHarV2(
        fixture,
        dependency<RankingUrlStageData>(
          outputs,
          "ranking-url",
          "ranking-url-v1",
        ),
        dependency<SiteArchitectureStageData>(
          outputs,
          "site-architecture",
          "site-architecture-v1",
        ),
        dependency<LinkPowerScoreStageData>(
          outputs,
          "link-power-score",
          "link-power-score-v1",
        ),
        dependency<ClusteringStageData>(
          outputs,
          "clustering",
          "clustering-v1",
        ),
        dependency<KeywordEnrichmentStageData>(
          outputs,
          "keyword-enrichment",
          "keyword-enrichment-v1",
        ),
        dependency<BrandClassificationStageData>(
          outputs,
          "brand-classification",
          "brand-classification-v1",
        ),
        dependency<SerpCollectionStageData>(
          outputs,
          "serp-collection",
          "serp-collection-v1",
        ),
      );
    case "revenue-readiness":
      return executeRevenueReadiness(
        fixture,
        dependency<HarV2StageData>(outputs, "har-v2", "har-v2.1"),
        dependency<DemandSignalsStageData>(
          outputs,
          "demand-signals",
          "demand-signals-v1",
        ),
        dependency<CtrCurvesStageData>(outputs, "ctr-curves", "ctr-curves-v1"),
      );
    case "revenue-v2":
      dependency<ReadinessStageData>(
        outputs,
        "revenue-readiness",
        "revenue-readiness-v1",
      );
      return executeRevenueV2(
        fixture,
        dependency<HarV2StageData>(outputs, "har-v2", "har-v2.1"),
        dependency<DemandSignalsStageData>(
          outputs,
          "demand-signals",
          "demand-signals-v1",
        ),
        dependency<CtrCurvesStageData>(
          outputs,
          "ctr-curves",
          "ctr-curves-v1",
        ),
        dependency<RankingUrlStageData>(
          outputs,
          "ranking-url",
          "ranking-url-v1",
        ),
      );
    case "calibration":
      return executeCalibration(
        fixture,
        dependency<RevenueV2StageData>(
          outputs,
          "revenue-v2",
          "revenue-v2.1",
        ),
      );
    case "rollup-output":
      dependency<CalibrationStageData>(
        outputs,
        "calibration",
        "calibration-v1",
      );
      dependency<CategorisationStageData>(
        outputs,
        "categorisation",
        "categorisation-v1",
      );
      dependency<ClusteringStageData>(outputs, "clustering", "clustering-v1");
      dependency<DemandSignalsStageData>(
        outputs,
        "demand-signals",
        "demand-signals-v1",
      );
      return executeRollupOutput(
        dependency<RevenueV2StageData>(outputs, "revenue-v2", "revenue-v2.1"),
        dependency<RankingUrlStageData>(outputs, "ranking-url", "ranking-url-v1"),
        dependency<CategorisationStageData>(outputs, "categorisation", "categorisation-v1"),
        dependency<ClusteringStageData>(outputs, "clustering", "clustering-v1"),
        dependency<DemandSignalsStageData>(outputs, "demand-signals", "demand-signals-v1"),
      );
    default:
      return null;
  }
}
