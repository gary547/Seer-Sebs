/**
 * Shared Recharts theme — editorial / restrained.
 * Always reference HSL CSS variables so charts retheme with the rest of the app.
 *
 * Usage:
 *   import { chartColors, axisProps, gridProps, tooltipProps } from "@/lib/chartTheme";
 */

export const chartColors = {
  signal: "hsl(var(--signal))",
  signal2: "hsl(var(--signal-2))",
  signal3: "hsl(var(--signal-3))",
  signalSoft: "hsl(var(--signal-soft))",
  ink: "hsl(var(--ink))",
  inkMuted: "hsl(var(--ink-muted))",
  inkSubtle: "hsl(var(--ink-subtle))",
  hairline: "hsl(var(--hairline))",
  pos: "hsl(var(--signal))",      // No Brainer teal as positive
  neg: "hsl(var(--signal-2))",    // Coral as negative
  warn: "hsl(var(--signal-3))",   // Amber as warning
  neutral: "hsl(var(--neutral))",
  obsidian: "hsl(var(--obsidian))",
  obsidianInk: "hsl(var(--obsidian-ink))",
} as const;

/**
 * Brand semantic palette — No Brainer.
 * Use these for any categorical/status data instead of raw greens/reds/blues.
 *   teal   = primary / positive / transactional / "good rank"
 *   coral  = destructive / opportunity / behind / navigational
 *   amber  = warning / grow / informational / mid rank
 *   navy   = neutral structural / commercial / improve
 */
export const brand = {
  teal: "hsl(var(--signal))",
  coral: "hsl(var(--signal-2))",
  amber: "hsl(var(--signal-3))",
  /** Categorical "fourth" — deep navy on light, white on dark for contrast. */
  navy: "hsl(var(--cat-navy))",
  tealSoft: "hsl(var(--signal) / 0.15)",
  coralSoft: "hsl(var(--signal-2) / 0.15)",
  amberSoft: "hsl(var(--signal-3) / 0.18)",
  navySoft: "hsl(var(--cat-navy) / 0.15)",
  tealInk: "hsl(var(--signal-ink))",
  coralInk: "hsl(var(--signal-2))",
  amberInk: "hsl(var(--signal-3))",
} as const;

/** Categorical intent palette — used by intent charts/badges. */
export const intentColors: Record<string, string> = {
  transactional: brand.teal,
  commercial: brand.navy,
  informational: brand.amber,
  navigational: brand.coral,
  generic: "hsl(var(--ink-subtle))",
};

/** Opportunity / classification palette. */
export const opportunityColors: Record<string, string> = {
  maintain: brand.teal,
  improve: brand.navy,
  grow: brand.amber,
  opportunity: brand.coral,
};

/** Position-bucket palette — teal (best) → amber → coral (worst). */
export const rankBucketColors = {
  best: brand.teal,        // 1–3
  good: brand.teal,        // 4–10 (slightly lighter via opacity if needed)
  mid: brand.amber,        // 11–20
  weak: brand.coral,       // 21–50
  poor: brand.coral,       // 51–100
  none: "hsl(var(--ink-subtle))",
} as const;

/** Restrained sequential palette — derived from a single accent + neutrals. */
export const chartSequence = [
  "hsl(var(--signal))",
  "hsl(var(--signal-2))",
  "hsl(var(--ink))",
  "hsl(var(--ink-muted))",
  "hsl(var(--ink-subtle))",
  "hsl(var(--warn))",
  "hsl(var(--pos))",
];

export const axisProps = {
  stroke: chartColors.inkSubtle,
  tickLine: false,
  axisLine: false,
  tick: {
    fill: chartColors.inkMuted,
    fontSize: 11,
    fontFamily: "Open Sans, system-ui, sans-serif",
    fontVariantNumeric: "tabular-nums",
  } as const,
} as const;

export const gridProps = {
  stroke: chartColors.hairline,
  strokeDasharray: "0",
  vertical: false,
} as const;

export const tooltipProps = {
  cursor: { stroke: chartColors.inkSubtle, strokeDasharray: "2 2" },
  contentStyle: {
    background: "hsl(var(--obsidian))",
    border: "1px solid hsl(var(--obsidian-line))",
    borderRadius: 8,
    color: "hsl(var(--obsidian-ink))",
    fontSize: 12,
    fontFamily: "Open Sans, system-ui, sans-serif",
    fontVariantNumeric: "tabular-nums",
    padding: "8px 10px",
    boxShadow: "var(--shadow-obsidian)",
  } as const,
  labelStyle: {
    color: "hsl(var(--obsidian-ink-muted))",
    fontSize: 10,
    textTransform: "uppercase" as const,
    letterSpacing: "0.12em",
    marginBottom: 4,
  } as const,
  itemStyle: {
    color: "hsl(var(--obsidian-ink))",
    padding: 0,
  } as const,
} as const;
