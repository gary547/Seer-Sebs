/**
 * Title-case a person's display name while preserving short all-caps acronyms
 * (e.g. "BBC", "AI") and handling hyphens / apostrophes correctly.
 *
 *   toDisplayName("laura")           → "Laura"
 *   toDisplayName("LAURA O'NEILL")   → "Laura O'Neill"
 *   toDisplayName("mary-jane bbc")   → "Mary-Jane BBC"
 *   toDisplayName("  jean   smith ") → "Jean Smith"
 */
export function toDisplayName(input: string | null | undefined): string {
  if (!input) return "";
  const trimmed = String(input).trim().replace(/\s+/g, " ");
  if (!trimmed) return "";

  const titleCaseToken = (token: string): string => {
    if (!token) return token;
    // Preserve short uppercase acronyms (2-4 letters, all uppercase in original)
    if (token.length >= 2 && token.length <= 4 && token === token.toUpperCase() && /^[A-Z]+$/.test(token)) {
      return token;
    }
    // Handle hyphenated and apostrophe segments by recursing on each chunk
    if (token.includes("-")) {
      return token.split("-").map(titleCaseToken).join("-");
    }
    if (token.includes("'")) {
      return token
        .split("'")
        .map((part, idx) => (idx === 0 ? titleCaseToken(part) : titleCaseToken(part)))
        .join("'");
    }
    const lower = token.toLowerCase();
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  };

  return trimmed.split(" ").map(titleCaseToken).join(" ");
}
