// Pure brand-classification helpers.
//
// Rule pass: given a client's company name, domain, and any explicit brand
// terms already curated as keyword_rules, derive a set of brand tokens and
// classify a keyword as branded, non-branded, or uncertain.
//
// Deterministic. No I/O. Used by supabase/functions/brand-classification.

export interface BrandContext {
  companyName: string | null;
  domain: string | null;
  domainNormalised: string | null;
  extraBrandTerms?: string[];
  /** Admin-curated explicit brand tokens. Bypass the >=3-char rule and stop-word filter.
   * Matched via word-boundary containsWholeToken. Never contribute to fuzzy/partial-match uncertain branch. */
  explicitTerms?: string[];
}

export interface BrandTokens {
  /** Individual whole-word tokens (>=3 chars). */
  tokens: string[];
  /** Concatenations of adjacent company-name words, e.g. "no brainer" -> "nobrainer". */
  concatenations: string[];
  /** Splits inferred from concatenations back to spaced form. */
  splits: string[];
  /** Explicit admin-curated tokens (bypass length/stop-word filters). */
  explicit: string[];
}


export type BrandVerdict =
  | { decision: "branded"; confidence: 0.95; matched: string }
  | { decision: "non_branded"; confidence: 0.9 }
  | { decision: "uncertain"; reason: "partial_match" | "fuzzy_match"; hint?: string };

const STOP_WORDS = new Set([
  "the", "and", "for", "inc", "ltd", "llc", "plc", "co", "com", "group", "agency",
]);

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function words(s: string): string[] {
  return norm(s).split(" ").filter(Boolean);
}

function firstLabel(domain: string): string {
  const cleaned = domain.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");
  const host = cleaned.split(/[/?#]/, 1)[0] ?? "";
  return host.split(".")[0] ?? "";
}

/** Insert space every time a lowercase letter borders a digit or capitalised chunk. */
function inferSplits(word: string): string[] {
  const out = new Set<string>();
  const camel = word.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().trim();
  if (camel !== word.toLowerCase() && camel.includes(" ")) out.add(camel);
  return [...out];
}

export function deriveBrandTokens(ctx: BrandContext): BrandTokens {
  const tokens = new Set<string>();
  const concatenations = new Set<string>();
  const splits = new Set<string>();

  const nameWords = ctx.companyName ? words(ctx.companyName) : [];
  const meaningful = nameWords.filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  for (const w of meaningful) tokens.add(w);

  // adjacent concatenations across original word order (not filtered).
  for (let i = 0; i < nameWords.length - 1; i++) {
    const joined = (nameWords[i] + nameWords[i + 1]).toLowerCase();
    if (joined.length >= 4) concatenations.add(joined);
  }
  // full concatenation of the whole name
  if (nameWords.length >= 2) {
    const full = nameWords.join("").toLowerCase();
    if (full.length >= 4) concatenations.add(full);
  }

  // Domain label
  const src = ctx.domainNormalised ?? ctx.domain ?? "";
  if (src) {
    const label = firstLabel(src);
    if (label.length >= 3) {
      tokens.add(label);
      for (const s of inferSplits(label)) splits.add(s);
      // Also add a naive split if the label starts with a name word: "nobraineragency" -> "no brainer agency"
      let remaining = label;
      const parts: string[] = [];
      let progress = true;
      while (remaining.length > 0 && progress) {
        progress = false;
        for (const w of nameWords.slice().sort((a, b) => b.length - a.length)) {
          if (w.length >= 2 && remaining.startsWith(w)) {
            parts.push(w);
            remaining = remaining.slice(w.length);
            progress = true;
            break;
          }
        }
      }
      if (parts.length >= 2 && remaining.length === 0) {
        splits.add(parts.join(" "));
      }
    }
  }

  for (const t of ctx.extraBrandTerms ?? []) {
    const cleaned = norm(t);
    if (!cleaned) continue;
    for (const w of cleaned.split(" ")) if (w.length >= 3) tokens.add(w);
    if (cleaned.includes(" ")) {
      concatenations.add(cleaned.replace(/\s+/g, ""));
      splits.add(cleaned);
    }
  }

  // strip stop words from tokens post-hoc for safety
  for (const s of [...tokens]) if (STOP_WORDS.has(s)) tokens.delete(s);

  const explicit = new Set<string>();
  for (const t of ctx.explicitTerms ?? []) {
    const cleaned = norm(t);
    if (cleaned) explicit.add(cleaned);
  }

  return {
    tokens: [...tokens],
    concatenations: [...concatenations],
    splits: [...splits],
    explicit: [...explicit],
  };
}


function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp: number[] = Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length];
}

function containsWholeToken(haystack: string, needle: string): boolean {
  if (!needle) return false;
  // needle may be a single token ("ao") or a normalised phrase ("ao com").
  // Escape regex metacharacters; internal spaces stay literal (norm() already
  // collapsed whitespace). Boundaries are non-alphanumeric so punctuation and
  // string ends both qualify.
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i");
  return re.test(haystack);
}

export function classifyKeyword(keyword: string, tokens: BrandTokens): BrandVerdict {
  const normalised = norm(keyword);
  if (!normalised) return { decision: "non_branded", confidence: 0.9 };

  // Explicit admin-curated terms first: exact word-boundary, no length filter.
  for (const t of tokens.explicit ?? []) {
    if (!t) continue;
    if (containsWholeToken(normalised, t)) {
      return { decision: "branded", confidence: 0.95, matched: t };
    }
  }

  const all = [...tokens.tokens, ...tokens.concatenations, ...tokens.splits];
  if (all.length === 0) return { decision: "non_branded", confidence: 0.9 };

  // Direct whole-token / concatenation / split match.
  for (const t of all) {
    if (!t) continue;
    if (containsWholeToken(normalised, t)) {
      return { decision: "branded", confidence: 0.95, matched: t };
    }
  }


  // Substring or fuzzy near-match on tokens >= 4 chars -> uncertain.
  const kwWords = normalised.split(" ");
  for (const t of [...tokens.tokens, ...tokens.concatenations]) {
    if (t.length < 4) continue;
    if (normalised.includes(t)) {
      return { decision: "uncertain", reason: "partial_match", hint: t };
    }
    for (const w of kwWords) {
      if (Math.abs(w.length - t.length) <= 1 && levenshtein(w, t) <= 1) {
        return { decision: "uncertain", reason: "fuzzy_match", hint: t };
      }
    }
  }

  return { decision: "non_branded", confidence: 0.9 };
}
