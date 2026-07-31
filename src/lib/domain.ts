/**
 * Canonicalise a user-supplied domain string so that
 *   "https://Pilltime.co.uk/", "www.pilltime.co.uk", "PILLTIME.CO.UK"
 * all collapse to `pilltime.co.uk`.
 *
 * Must stay byte-for-byte equivalent to `public.normalize_domain(text)` in the
 * database — the generated column and unique index depend on that parity.
 * If you change one, change the other and update the vitest suite.
 */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (input == null) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  const canonical = trimmed
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "")
    .replace(/\s+/g, "");

  return canonical.length ? canonical : null;
}
