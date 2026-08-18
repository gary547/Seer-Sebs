const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  "co.nz",
  "co.uk",
  "com.au",
  "com.br",
  "com.sg",
  "org.uk",
]);

const UNSAFE_DOMAIN_LABELS = new Set([
  "app",
  "blog",
  "company",
  "group",
  "online",
  "shop",
  "store",
  "tv",
  "tvs",
  "uk",
]);

function domainHost(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0]!
    .replace(/:\d+$/, "");
}

export type BrandTermsSource = "domain_fallback" | "explicit" | "missing";

export function domainBrandTerms(domain: string): string[] {
  const parts = domainHost(domain).split(".").filter(Boolean);
  if (parts.length < 2) return [];
  const suffix = parts.slice(-2).join(".");
  const labelIndex = parts.length - (MULTI_LABEL_PUBLIC_SUFFIXES.has(suffix) ? 3 : 2);
  const label = parts[labelIndex]?.replace(/[^a-z0-9-]/g, "") ?? "";
  const compact = label.replace(/-/g, "");
  if (
    compact.length < 4 ||
    /^\d+$/.test(compact) ||
    UNSAFE_DOMAIN_LABELS.has(compact)
  ) {
    return [];
  }
  const phrase = label.replace(/-+/g, " ").trim();
  return phrase === compact ? [compact] : [phrase, compact];
}

export function resolveBrandTerms(
  explicitTerms: readonly string[],
  domain: string,
): { source: BrandTermsSource; terms: string[] } {
  const explicit: string[] = [];
  const seen = new Set<string>();
  for (const value of explicitTerms) {
    const term = value.trim();
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    explicit.push(term);
  }
  if (explicit.length > 0) return { source: "explicit", terms: explicit };
  const fallback = domainBrandTerms(domain);
  return fallback.length > 0
    ? { source: "domain_fallback", terms: fallback }
    : { source: "missing", terms: [] };
}
