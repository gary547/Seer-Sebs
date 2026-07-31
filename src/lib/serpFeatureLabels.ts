// Human-readable labels for DataForSEO SERP feature rows.
//
// The `top_serp_feature` column from DataForSEO stores the *entity title*
// inside a feature (e.g. "APIVoid" or "Wikipedia" inside a knowledge_graph
// panel), which looks like an API error in the admin UI. This module gives
// us a single source of truth for turning `result_type` into a friendly
// label, and for pairing it with the entity title where useful.

export interface SerpFeatureLabelInput {
  result_type: string | null | undefined;
  top_serp_feature?: string | null | undefined;
  top_serp_feature_url?: string | null | undefined;
}

const RESULT_TYPE_LABELS: Record<string, string> = {
  knowledge_graph: "Knowledge graph",
  people_also_ask: "People also ask",
  related_searches: "Related searches",
  featured_snippet: "Featured snippet",
  answer_box: "Answer box",
  video: "Video",
  videos: "Video pack",
  local_pack: "Local pack",
  map: "Map pack",
  images: "Image pack",
  image: "Image pack",
  shopping: "Shopping",
  paid: "Paid ads",
  ads: "Paid ads",
  organic: "Organic result",
  site_links: "Site links",
  sitelinks: "Site links",
  top_stories: "Top stories",
  news_search: "News",
  twitter: "Twitter / X",
  faq: "FAQ",
  ai_overview: "AI overview",
  ai_mode: "AI overview",
  jobs: "Jobs",
  events: "Events",
  recipes: "Recipes",
  podcasts: "Podcasts",
  scholarly_articles: "Scholarly articles",
  refine_products: "Refine products",
  popular_products: "Popular products",
  perspectives: "Perspectives",
  discussions_and_forums: "Discussions & forums",
};

export function humaniseResultType(resultType: string | null | undefined): string {
  const raw = (resultType ?? "").toString().toLowerCase().trim();
  if (!raw) return "Unknown feature";
  if (RESULT_TYPE_LABELS[raw]) return RESULT_TYPE_LABELS[raw];
  // Fallback: prettify snake_case → Title Case.
  return raw
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface FormattedSerpFeature {
  primary: string;
  secondary: string | null;
  tooltip: string;
  entityHost: string | null;
}

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

const GOOGLE_HOSTS = new Set([
  "google.com",
  "google.co.uk",
  "youtube.com",
  "maps.google.com",
  "support.google.com",
]);

export function isGoogleOwnedHost(host: string | null): boolean {
  if (!host) return false;
  if (GOOGLE_HOSTS.has(host)) return true;
  if (host.endsWith(".google.com") || host.endsWith(".google.co.uk")) return true;
  if (host === "youtu.be" || host.endsWith(".youtube.com")) return true;
  return false;
}

export function formatTopFeature(
  row: SerpFeatureLabelInput | null | undefined,
  opts?: { featureCount?: number | null; owned?: boolean | null; snippetOpportunity?: boolean | null },
): FormattedSerpFeature {
  if (!row || !row.result_type) {
    return {
      primary: "—",
      secondary: null,
      tooltip: "No SERP feature recorded for this keyword.",
      entityHost: null,
    };
  }

  const primary = humaniseResultType(row.result_type);
  const entity = (row.top_serp_feature ?? "").toString().trim();
  const host = hostOf(row.top_serp_feature_url ?? null);

  // Only show secondary line when the entity title adds real information —
  // skip when it's empty, or when it just repeats the primary label.
  const secondary =
    entity && entity.toLowerCase() !== primary.toLowerCase()
      ? `via ${entity}`
      : null;

  const tooltipParts: string[] = [primary];
  if (entity) tooltipParts.push(`Entity: ${entity}`);
  if (host) tooltipParts.push(`Host: ${host}`);
  if (opts?.featureCount != null) tooltipParts.push(`Feature count: ${opts.featureCount}`);
  if (opts?.owned) tooltipParts.push("Owned by client");
  if (opts?.snippetOpportunity) tooltipParts.push("Snippet opportunity");

  return {
    primary,
    secondary,
    tooltip: tooltipParts.join(" • "),
    entityHost: host,
  };
}
