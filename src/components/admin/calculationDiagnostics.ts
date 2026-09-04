import type {
  CalculationInspectorRow,
  CtrCurve,
} from "@/integrations/gcp/calculations";

export type DiagnosticFlag =
  | "clamped"
  | "delta"
  | "missing_content_fit"
  | "missing_lps"
  | "override"
  | "synthetic_lps";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function calculationFlags(row: CalculationInspectorRow): DiagnosticFlag[] {
  const realistic = row.scenarios.realistic;
  if (!realistic) return [];
  const explanation = record(realistic.explanation);
  const inputs = record(explanation.inputs);
  const clamps = record(explanation.clamps);
  const flags: DiagnosticFlag[] = [];
  if (
    row.harV1 !== null &&
    realistic.harPosition !== null &&
    Math.abs(realistic.harPosition - row.harV1) > 2
  ) {
    flags.push("delta");
  }
  if (
    row.harIsManualV1 ||
    realistic.averageOrderValueOverrideId !== null ||
    realistic.conversionRateOverrideId !== null
  ) {
    flags.push("override");
  }
  if (realistic.linkPowerScore === null) flags.push("missing_lps");
  if (inputs.client_lps_basis === "synthetic") flags.push("synthetic_lps");
  if (clamps.clamped_har_position !== null && clamps.clamped_har_position !== undefined) {
    flags.push("clamped");
  }
  if (realistic.contentFitScore === null) flags.push("missing_content_fit");
  return flags;
}

export function volumeCoverageBuckets(input: {
  keptKeywords: number;
  with12Months: number;
  with24Months: number;
  withHistory: number;
}) {
  return [
    {
      count: input.with24Months,
      key: "ready",
      label: "24+ months",
    },
    {
      count: Math.max(0, input.with12Months - input.with24Months),
      key: "partial",
      label: "12–23 months",
    },
    {
      count: Math.max(0, input.withHistory - input.with12Months),
      key: "limited",
      label: "1–11 months",
    },
    {
      count: Math.max(0, input.keptKeywords - input.withHistory),
      key: "missing",
      label: "No history",
    },
  ];
}

export function ctrChartRows(curves: CtrCurve[]) {
  const ranks = new Set<number>();
  for (const curve of curves) {
    for (const point of curve.points) ranks.add(point.rank);
  }
  return [...ranks]
    .sort((left, right) => left - right)
    .map((rank) => {
      const row: Record<string, number> = { rank };
      for (const curve of curves) {
        const point = curve.points.find((candidate) => candidate.rank === rank);
        if (point) row[`${curve.device}:${curve.isBranded ? "brand" : "nonbrand"}`] = point.ctr * 100;
      }
      return row;
    });
}

export function humanise(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
