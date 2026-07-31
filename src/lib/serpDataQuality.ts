// Data-quality signal computation for the SERP CTR deflator inspector.
//
// Pure, deterministic, side-effect-free — the same function is intended to
// run inside future compute-forecasts / calc-engine paths. All inputs are
// already loaded by the caller (no queries here).

import { hostOf, humaniseResultType, isGoogleOwnedHost } from "@/lib/serpFeatureLabels";
import type {
  SerpAdjustmentRow,
  SerpDevice,
  SerpFeatureRow,
} from "@/lib/serpVisibility";

export type SignalSeverity = "info" | "warn" | "critical";
export type SignalScope = "project" | "keyword";

export type SignalCode =
  | "ADJUSTMENT_TABLE_EMPTY"
  | "NO_KEPT_KEYWORDS"
  | "SPARSE_COVERAGE"
  | "UNKNOWN_RESULT_TYPES"
  | "MISSING_INTENT_TIER"
  | "HIGH_HEAVY_DEFLATION"
  | "COMPETITOR_KNOWLEDGE_PANEL"
  | "OWNED_FEATURE_PRESENT"
  | "SNIPPET_OPPORTUNITY";

export interface DataQualitySignal {
  id: string;
  severity: SignalSeverity;
  scope: SignalScope;
  code: SignalCode;
  title: string;
  detail: string;
  affectedKeywordIds: string[];
  evidence?: Record<string, unknown>;
}

export interface SampledKeyword {
  id: string;
  keyword: string;
  search_intent: string | null;
}

export interface KeywordVisibilityResult {
  keywordId: string;
  multiplier: number;
  featureCount: number;
  unmatchedFeatureTypes: string[];
}

export interface SerpFeatureRowWithUrl extends SerpFeatureRow {
  top_serp_feature?: string | null;
  top_serp_feature_url?: string | null;
}

export interface ComputeSignalsInput {
  device: SerpDevice;
  clientDomain: string | null;
  keywords: SampledKeyword[];
  featuresByKeyword: Map<string, SerpFeatureRowWithUrl[]>;
  adjustments: SerpAdjustmentRow[];
  results: KeywordVisibilityResult[];
}

const SPARSE_THRESHOLD = 0.25;
const HEAVY_DEFLATION_THRESHOLD = 0.15;
const EVIDENCE_LIMIT = 5;
const SEVERITY_ORDER: Record<SignalSeverity, number> = {
  critical: 0,
  warn: 1,
  info: 2,
};

function sortSignals(signals: DataQualitySignal[]): DataQualitySignal[] {
  return signals.sort((a, b) => {
    const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (s !== 0) return s;
    return a.code.localeCompare(b.code);
  });
}

export function computeSerpDataQualitySignals(
  input: ComputeSignalsInput,
): DataQualitySignal[] {
  const signals: DataQualitySignal[] = [];
  const { keywords, featuresByKeyword, adjustments, results, clientDomain } = input;

  // 1. Adjustment table empty
  if ((adjustments?.length ?? 0) === 0) {
    signals.push({
      id: "adjustment-table-empty",
      severity: "critical",
      scope: "project",
      code: "ADJUSTMENT_TABLE_EMPTY",
      title: "No active CTR adjustment rows",
      detail:
        "`serp_feature_ctr_adjustments` has no active rows — every multiplier falls back to 1.0.",
      affectedKeywordIds: [],
    });
  }

  // 2. No kept keywords
  if (keywords.length === 0) {
    signals.push({
      id: "no-kept-keywords",
      severity: "warn",
      scope: "project",
      code: "NO_KEPT_KEYWORDS",
      title: "No kept keywords to sample",
      detail: "This project has no `detox_status = keep` keywords available.",
      affectedKeywordIds: [],
    });
    return sortSignals(signals);
  }

  // 3. Sparse coverage
  const kwWithoutFeatures = keywords.filter(
    (k) => (featuresByKeyword.get(k.id)?.length ?? 0) === 0,
  );
  const sparseShare = kwWithoutFeatures.length / keywords.length;
  if (sparseShare > SPARSE_THRESHOLD) {
    signals.push({
      id: "sparse-coverage",
      severity: "warn",
      scope: "project",
      code: "SPARSE_COVERAGE",
      title: "Sparse SERP feature coverage",
      detail: `${kwWithoutFeatures.length} of ${keywords.length} sampled keywords have no serp_features rows — multipliers default to 1.0.`,
      affectedKeywordIds: kwWithoutFeatures.slice(0, EVIDENCE_LIMIT).map((k) => k.id),
      evidence: {
        share: Number((sparseShare * 100).toFixed(1)),
        examples: kwWithoutFeatures.slice(0, EVIDENCE_LIMIT).map((k) => k.keyword),
      },
    });
  }

  // 4. Unknown result types (unmatched by adjustments)
  const unmatchedByType = new Map<string, Set<string>>();
  for (const r of results) {
    for (const t of r.unmatchedFeatureTypes) {
      const set = unmatchedByType.get(t) ?? new Set<string>();
      set.add(r.keywordId);
      unmatchedByType.set(t, set);
    }
  }
  if (unmatchedByType.size > 0) {
    const affected = new Set<string>();
    for (const set of unmatchedByType.values()) for (const id of set) affected.add(id);
    const typeList = Array.from(unmatchedByType.entries())
      .sort((a, b) => b[1].size - a[1].size)
      .slice(0, EVIDENCE_LIMIT)
      .map(([t, set]) => ({ result_type: t, label: humaniseResultType(t), keyword_count: set.size }));
    signals.push({
      id: "unknown-result-types",
      severity: "warn",
      scope: "keyword",
      code: "UNKNOWN_RESULT_TYPES",
      title: "SERP feature types with no adjustment row",
      detail: `${unmatchedByType.size} feature type(s) resolved to multiplier 1.0 because no matching row exists in serp_feature_ctr_adjustments.`,
      affectedKeywordIds: Array.from(affected),
      evidence: { types: typeList },
    });
  }

  // 5. Missing intent tier
  const missingIntent = keywords.filter((k) => !k.search_intent);
  if (missingIntent.length > 0) {
    signals.push({
      id: "missing-intent-tier",
      severity: "info",
      scope: "keyword",
      code: "MISSING_INTENT_TIER",
      title: "Keywords with no search intent",
      detail: `${missingIntent.length} keyword(s) have no search_intent — tier-specific multipliers fall back to the generic tier.`,
      affectedKeywordIds: missingIntent.map((k) => k.id),
      evidence: {
        examples: missingIntent.slice(0, EVIDENCE_LIMIT).map((k) => k.keyword),
      },
    });
  }

  // 6. High heavy deflation
  const heavy = results.filter((r) => r.featureCount > 0 && r.multiplier < 0.5);
  const heavyShare = results.length > 0 ? heavy.length / results.length : 0;
  if (heavyShare > HEAVY_DEFLATION_THRESHOLD) {
    const heavyIds = new Set(heavy.map((r) => r.keywordId));
    const heavyKeywords = keywords.filter((k) => heavyIds.has(k.id));
    signals.push({
      id: "high-heavy-deflation",
      severity: "warn",
      scope: "keyword",
      code: "HIGH_HEAVY_DEFLATION",
      title: "Portfolio risk: many keywords heavily deflated",
      detail: `${heavy.length} of ${results.length} sampled keywords land in the Heavy bucket (multiplier < 0.5). Rich SERPs are compressing available CTR.`,
      affectedKeywordIds: heavy.map((r) => r.keywordId),
      evidence: {
        share: Number((heavyShare * 100).toFixed(1)),
        examples: heavyKeywords.slice(0, EVIDENCE_LIMIT).map((k) => k.keyword),
      },
    });
  }

  // 7. Competitor knowledge panel (generalised APIVoid case)
  const clientHost = clientDomain ? clientDomain.replace(/^www\./i, "").toLowerCase() : null;
  const competitorEntities = new Map<
    string,
    { host: string; entity: string; keywordIds: Set<string>; keywordSamples: string[] }
  >();
  for (const k of keywords) {
    const feats = featuresByKeyword.get(k.id) ?? [];
    for (const f of feats) {
      if ((f.result_type ?? "").toLowerCase() !== "knowledge_graph") continue;
      const host = hostOf(f.top_serp_feature_url ?? null);
      if (!host) continue;
      if (isGoogleOwnedHost(host)) continue;
      if (clientHost && (host === clientHost || host.endsWith(`.${clientHost}`))) continue;
      const entity = (f.top_serp_feature ?? host).toString();
      const key = `${entity}|${host}`;
      const bucket = competitorEntities.get(key) ?? {
        host,
        entity,
        keywordIds: new Set<string>(),
        keywordSamples: [],
      };
      bucket.keywordIds.add(k.id);
      if (bucket.keywordSamples.length < EVIDENCE_LIMIT) bucket.keywordSamples.push(k.keyword);
      competitorEntities.set(key, bucket);
    }
  }
  if (competitorEntities.size > 0) {
    const affected = new Set<string>();
    for (const b of competitorEntities.values()) for (const id of b.keywordIds) affected.add(id);
    const entities = Array.from(competitorEntities.values())
      .sort((a, b) => b.keywordIds.size - a.keywordIds.size)
      .slice(0, EVIDENCE_LIMIT)
      .map((b) => ({
        entity: b.entity,
        host: b.host,
        keyword_count: b.keywordIds.size,
        examples: b.keywordSamples,
      }));
    signals.push({
      id: "competitor-knowledge-panel",
      severity: "warn",
      scope: "keyword",
      code: "COMPETITOR_KNOWLEDGE_PANEL",
      title: "Third-party entity in Knowledge panel",
      detail: `Google is surfacing a third-party entity inside the Knowledge panel for ${affected.size} keyword(s). Multipliers still apply correctly, but this is worth surfacing as an SEO finding.`,
      affectedKeywordIds: Array.from(affected),
      evidence: { entities },
    });
  }

  // 8. Owned feature present (positive)
  const owned = new Set<string>();
  for (const [kwId, feats] of featuresByKeyword) {
    if (feats.some((f) => f.serp_feature_owned === true)) owned.add(kwId);
  }
  if (owned.size > 0) {
    signals.push({
      id: "owned-feature-present",
      severity: "info",
      scope: "keyword",
      code: "OWNED_FEATURE_PRESENT",
      title: "Client owns a SERP feature",
      detail: `${owned.size} sampled keyword(s) have at least one SERP feature owned by the client — those features are guarded from downward deflation.`,
      affectedKeywordIds: Array.from(owned),
    });
  }

  // 9. Snippet opportunity (positive)
  const snippetIds = new Set<string>();
  for (const [kwId, feats] of featuresByKeyword) {
    if (feats.some((f) => f.snippet_opportunity === true)) snippetIds.add(kwId);
  }
  if (snippetIds.size > 0) {
    signals.push({
      id: "snippet-opportunity",
      severity: "info",
      scope: "keyword",
      code: "SNIPPET_OPPORTUNITY",
      title: "Snippet opportunities available",
      detail: `${snippetIds.size} sampled keyword(s) flagged as snippet opportunities — potential CTR upside if captured.`,
      affectedKeywordIds: Array.from(snippetIds),
    });
  }

  return sortSignals(signals);
}
