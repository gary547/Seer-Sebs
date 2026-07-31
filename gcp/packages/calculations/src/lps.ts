export interface LpsMetricRow {
  backlinks: number | null;
  domainRating: number | null;
  keywordId: string;
  referringDomains: number | null;
  urlRating: number | null;
}

export interface LpsResult {
  components: {
    backlinks: number | null;
    domainRating: number | null;
    referringDomains: number | null;
    urlRating: number | null;
  };
  confidence: "high" | "low" | "medium";
  score: number;
}

const percentile95 = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(0.95 * (sorted.length - 1))] ?? 0;
};

const logScore = (value: number, maximum: number): number =>
  maximum <= 0
    ? 0
    : Math.min(100, (Math.log10(1 + value) / Math.log10(1 + maximum)) * 100);

export function computeLps(
  row: LpsMetricRow,
  rows: LpsMetricRow[],
): LpsResult {
  const referringMaximum = percentile95(
    rows.flatMap((item) =>
      item.referringDomains === null ? [] : [item.referringDomains],
    ),
  );
  const backlinkMaximum = percentile95(
    rows.flatMap((item) => (item.backlinks === null ? [] : [item.backlinks])),
  );
  const components = {
    backlinks:
      row.backlinks === null ? null : logScore(row.backlinks, backlinkMaximum),
    domainRating:
      row.domainRating === null ? null : Math.min(100, row.domainRating),
    referringDomains:
      row.referringDomains === null
        ? null
        : logScore(row.referringDomains, referringMaximum),
    urlRating: row.urlRating === null ? null : Math.min(100, row.urlRating),
  };
  const weighted: Array<readonly [number | null, number]> = [
    [components.urlRating, 0.35],
    [components.domainRating, 0.3],
    [components.referringDomains, 0.2],
    [components.backlinks, 0.15],
  ];
  const available: Array<readonly [number, number]> = [];
  for (const [value, componentWeight] of weighted) {
    if (value !== null) available.push([value, componentWeight]);
  }
  const weight = available.reduce((sum, item) => sum + item[1], 0);
  const score =
    weight === 0
      ? 0
      : available.reduce((sum, item) => sum + item[0] * item[1], 0) / weight;
  return {
    components,
    confidence:
      available.length === 4
        ? "high"
        : available.length === 3
          ? "medium"
          : "low",
    score: Math.round(score * 100) / 100,
  };
}
