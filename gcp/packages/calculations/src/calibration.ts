export const CALIBRATION_MODEL_VERSION = "calibration_v1.0.0";
export const CALIBRATION_NOISE_FLOOR = 5;

export type CalibrationIntent =
  | "commercial"
  | "informational"
  | "navigational"
  | "transactional"
  | "unknown";

export type CalibrationRankBand = "1-3" | "4-10" | "11-20" | "21-30";

export interface CalibrationPair {
  actualClicks: number;
  impressions: number;
  intent: CalibrationIntent;
  modelledMonthlyClicks: number;
  rank: number;
  windowDays: number;
}

export interface CalibrationBucket {
  actualMonthlyClicks: number;
  matched: number;
  modelledMonthlyClicks: number;
  ratio: number | null;
}

export interface CalibrationResult {
  byIntent: Record<CalibrationIntent, CalibrationBucket>;
  byRankBand: Record<CalibrationRankBand, CalibrationBucket>;
  excludedNoiseFloor: number;
  matched: number;
  overallRatio: number | null;
  status: "amber" | "green" | "red" | "unavailable";
}

const emptyBucket = (): CalibrationBucket => ({
  actualMonthlyClicks: 0,
  matched: 0,
  modelledMonthlyClicks: 0,
  ratio: null,
});

export function calibrationRankBand(
  rank: number,
): CalibrationRankBand | null {
  if (rank >= 1 && rank <= 3) return "1-3";
  if (rank >= 4 && rank <= 10) return "4-10";
  if (rank >= 11 && rank <= 20) return "11-20";
  if (rank >= 21 && rank <= 30) return "21-30";
  return null;
}

function addPair(
  bucket: CalibrationBucket,
  pair: CalibrationPair,
  actualMonthly: number,
): void {
  bucket.actualMonthlyClicks += actualMonthly;
  bucket.modelledMonthlyClicks += pair.modelledMonthlyClicks;
  bucket.matched += 1;
}

function finalise(bucket: CalibrationBucket): CalibrationBucket {
  return {
    ...bucket,
    ratio:
      bucket.actualMonthlyClicks > 0
        ? bucket.modelledMonthlyClicks / bucket.actualMonthlyClicks
        : null,
  };
}

function status(
  ratio: number | null,
): CalibrationResult["status"] {
  if (ratio === null) return "unavailable";
  if (ratio >= 0.5 && ratio <= 2) return "green";
  if (ratio >= 0.33 && ratio <= 3) return "amber";
  return "red";
}

export function computeCalibration(
  pairs: CalibrationPair[],
): CalibrationResult {
  const overall = emptyBucket();
  const byIntent: Record<CalibrationIntent, CalibrationBucket> = {
    commercial: emptyBucket(),
    informational: emptyBucket(),
    navigational: emptyBucket(),
    transactional: emptyBucket(),
    unknown: emptyBucket(),
  };
  const byRankBand: Record<CalibrationRankBand, CalibrationBucket> = {
    "1-3": emptyBucket(),
    "4-10": emptyBucket(),
    "11-20": emptyBucket(),
    "21-30": emptyBucket(),
  };
  let excludedNoiseFloor = 0;
  for (const pair of pairs) {
    if (!Number.isFinite(pair.rank) || pair.windowDays <= 0) continue;
    const actualMonthly = (pair.actualClicks * 30) / pair.windowDays;
    if (actualMonthly < CALIBRATION_NOISE_FLOOR) {
      excludedNoiseFloor += 1;
      continue;
    }
    addPair(overall, pair, actualMonthly);
    addPair(byIntent[pair.intent], pair, actualMonthly);
    const band = calibrationRankBand(pair.rank);
    if (band) addPair(byRankBand[band], pair, actualMonthly);
  }
  const finalOverall = finalise(overall);
  const finalIntents = Object.fromEntries(
    Object.entries(byIntent).map(([key, bucket]) => [key, finalise(bucket)]),
  ) as Record<CalibrationIntent, CalibrationBucket>;
  const finalBands = Object.fromEntries(
    Object.entries(byRankBand).map(([key, bucket]) => [
      key,
      finalise(bucket),
    ]),
  ) as Record<CalibrationRankBand, CalibrationBucket>;
  return {
    byIntent: finalIntents,
    byRankBand: finalBands,
    excludedNoiseFloor,
    matched: finalOverall.matched,
    overallRatio: finalOverall.ratio,
    status: status(finalOverall.ratio),
  };
}
