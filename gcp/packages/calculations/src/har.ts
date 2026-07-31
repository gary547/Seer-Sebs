export type HarScenario = "conservative" | "realistic" | "stretch";

export const HAR_SCENARIOS: HarScenario[] = [
  "conservative",
  "realistic",
  "stretch",
];

export const HAR_MODEL_VERSION = "har_v2.1.0";

export interface HarCompetitor {
  linkPowerScore: number | null;
  rank: number;
  urlRating: number | null;
}

export interface HarInputs {
  baseRank: number | null;
  clientLinkPowerScore: number | null;
  clientUrlRating: number | null;
  competitors: HarCompetitor[];
  contentFit: number | null;
}

export interface HarResult {
  authorityScore: number | null;
  confidence: number;
  explanation: Record<string, unknown>;
  harPosition: number | null;
  linkGapScore: number | null;
  rankAttainmentProbability: number | null;
  scenario: HarScenario;
  serpVisibilityMultiplier: number;
}

const thresholds: Record<HarScenario, number> = {
  conservative: 0.6,
  realistic: 0.5,
  stretch: 0.4,
};

const temperatures: Record<HarScenario, number> = {
  conservative: 1.6,
  realistic: 1,
  stretch: 0.7,
};

const floors: Record<HarScenario, number> = {
  conservative: 0.7,
  realistic: 0.5,
  stretch: 0.3,
};

const probabilityFactors: Record<HarScenario, number> = {
  conservative: 0.85,
  realistic: 1,
  stretch: 1.15,
};

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value));

const sigmoid = (value: number): number => 1 / (1 + Math.exp(-value));

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function competitorScore(competitor: HarCompetitor): number | null {
  return competitor.linkPowerScore ?? competitor.urlRating;
}

function pBeat(
  inputs: HarInputs,
  competitor: HarCompetitor,
): number | null {
  const client = inputs.clientLinkPowerScore ?? inputs.clientUrlRating;
  const rival = competitorScore(competitor);
  if (client === null || rival === null) return null;
  const authorityGap = clamp((client - rival) / 100, -1, 1);
  const contentEdge = inputs.contentFit ?? 0.5;
  return clamp(
    sigmoid(3.2 * authorityGap + 1.6 * (contentEdge - 0.5)),
    0,
    1,
  );
}

export function computeHarScenario(
  inputs: HarInputs,
  scenario: HarScenario,
): HarResult {
  const competitors = [...inputs.competitors].sort(
    (left, right) => left.rank - right.rank,
  );
  let harPosition: number | null = null;
  let rankProbability: number | null = null;
  const ladder: Array<Record<string, unknown>> = [];
  for (const competitor of competitors) {
    const raw = pBeat(inputs, competitor);
    if (raw === null) {
      ladder.push({
        rank: competitor.rank,
        skipped: "missing_competitor_authority",
      });
      continue;
    }
    const probability = raw ** temperatures[scenario];
    const beaten = probability >= thresholds[scenario];
    ladder.push({
      beaten,
      probability: Math.round(probability * 10_000) / 10_000,
      rank: competitor.rank,
    });
    if (beaten) {
      harPosition = competitor.rank;
      rankProbability = clamp(
        probability * probabilityFactors[scenario],
        0,
        1,
      );
      break;
    }
  }
  const rawHarPosition = harPosition;
  if (harPosition !== null && inputs.baseRank !== null && inputs.baseRank > 0) {
    harPosition = Math.max(
      harPosition,
      Math.max(1, Math.round(inputs.baseRank * floors[scenario])),
    );
  }
  const competitorScores = competitors
    .map(competitorScore)
    .filter((score): score is number => score !== null);
  const medianCompetitor = median(competitorScores);
  const clientScore =
    inputs.clientLinkPowerScore ?? inputs.clientUrlRating;
  const authorityScore =
    medianCompetitor === null || clientScore === null
      ? null
      : clamp(0.5 + (clientScore - medianCompetitor) / 200, 0, 1);
  const competitorLinkScores = competitors
    .map((competitor) => competitor.linkPowerScore)
    .filter((score): score is number => score !== null);
  const medianLinkScore = median(competitorLinkScores);
  const linkGapScore =
    medianLinkScore === null || inputs.clientLinkPowerScore === null
      ? null
      : clamp((medianLinkScore - inputs.clientLinkPowerScore) / 100, 0, 1);
  let confidence = 1;
  if (inputs.clientLinkPowerScore === null) confidence -= 0.25;
  if (inputs.contentFit === null) confidence -= 0.1;
  if (competitors.length < 5) confidence -= 0.1;
  if (scenario === "stretch" && inputs.clientLinkPowerScore === null) {
    confidence -= 0.1;
  }
  return {
    authorityScore,
    confidence: clamp(Math.round(confidence * 10_000) / 10_000, 0.05, 1),
    explanation: {
      baseRank: inputs.baseRank,
      clientLinkPowerScore: inputs.clientLinkPowerScore,
      contentFit: inputs.contentFit,
      floorMultiplier: floors[scenario],
      ladder,
      rawHarPosition,
      threshold: thresholds[scenario],
    },
    harPosition,
    linkGapScore,
    rankAttainmentProbability:
      rankProbability === null
        ? null
        : Math.round(rankProbability * 10_000) / 10_000,
    scenario,
    serpVisibilityMultiplier: 1,
  };
}
