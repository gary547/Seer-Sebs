// Single source of truth for link-strength / authority terminology.
// Used by MetricHelp tooltips, table headers, and the "How this is scored" panel
// so wording stays consistent across HAR, Performance Output, and the
// Competitor Backlink Landscape.

export type MetricKey =
  | "UR"
  | "DR"
  | "TP"
  | "LinkBand"
  | "RefDoms"
  | "Backlinks"
  | "AhrefsRank";

export interface MetricEntry {
  /** Short label shown in the tooltip header. */
  label: string;
  /** One-line plain-English definition. */
  short: string;
  /** Optional extra context (scale hint, source, gotchas). */
  detail?: string;
  /** Where this number comes from. */
  source?: string;
}

export const METRIC_GLOSSARY: Record<MetricKey, MetricEntry> = {
  UR: {
    label: "URL Rating (UR)",
    short:
      "Strength of a single page's backlink profile. Higher = harder to outrank.",
    detail:
      "Scored 0–100 on a logarithmic scale, so going from 30 → 40 takes roughly 4× the link work of going from 10 → 20.",
    source: "Ahrefs",
  },
  DR: {
    label: "Domain Rating (DR)",
    short:
      "Strength of the whole domain's backlink profile. A proxy for overall site authority.",
    detail:
      "Scored 0–100 on a logarithmic scale. Useful as background context — page-level UR is what we use to compute Top Potential.",
    source: "Ahrefs",
  },
  TP: {
    label: "Top Potential (TP)",
    short:
      "The highest SERP position your link strength can realistically reach today.",
    detail:
      "Calculated by walking the search results from rank 1 down and finding the first competitor whose URL Rating you match or beat. Lower number = better.",
    source: "Calculated from Ahrefs UR + live SERP",
  },
  LinkBand: {
    label: "Link strength vs ranking page",
    short:
      "How your URL Rating compares to the page currently ranking for this keyword.",
    detail:
      "Matched (within 5 points) — content/relevance work alone can win. Slightly behind (6–15 points) — content + a modest link push. Behind (16+ points) — a real authority gap that needs link-building.",
    source: "Calculated from Ahrefs UR",
  },
  RefDoms: {
    label: "Referring Domains",
    short:
      "Number of unique websites linking to this page. More distinct sources = stronger signal.",
    source: "DataForSEO Backlinks",
  },
  Backlinks: {
    label: "Backlinks",
    short:
      "Total inbound links to this page (a single domain can contribute many).",
    source: "DataForSEO Backlinks",
  },
  AhrefsRank: {
    label: "Ahrefs Rank",
    short:
      "Global rank of this domain by link strength (1 = strongest in the world).",
    source: "Ahrefs",
  },
};

export const LINK_BAND_DEFINITIONS = [
  {
    label: "Matched",
    range: "Within 5 points",
    meaning:
      "Roughly equal authority — content and on-page work alone can win this keyword.",
    tone: "pos" as const,
  },
  {
    label: "Slightly behind",
    range: "6–15 points behind",
    meaning:
      "Small authority gap — content plus a modest link-building push will close it.",
    tone: "warn" as const,
  },
  {
    label: "Behind",
    range: "16+ points behind",
    meaning:
      "Real authority gap — content alone won't break through. Links needed.",
    tone: "neg" as const,
  },
];
