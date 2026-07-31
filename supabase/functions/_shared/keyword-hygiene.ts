// Single source of truth for keyword string hygiene.
// Used at every entry point that writes to the `keywords` table and at every
// worker read so that a rogue character (smart quote, BOM, NBSP, control char,
// stray ASCII quote, etc.) can never break downstream matching against AI output.
//
// Rules:
//  - Idempotent: sanitizeKeyword(sanitizeKeyword(x)) === sanitizeKeyword(x)
//  - Lossless on real letters/numbers (incl. accented chars).
//  - Strips: BOM, zero-width, all C0/C1 control chars, NBSP, other Unicode
//    whitespace, curly quotes, primes, back-ticks, ASCII " ' and the punctuation
//    set we already disallowed.
//  - Lowercases, collapses whitespace, trims.

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;
const UNICODE_WS = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;
// Curly/typographic quotes + primes + back-tick + ASCII " and '
const QUOTES = /[\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F\u2032\u2033\u2035\u2036`'"]/g;
// Existing punctuation strip from V1 (minus quotes, handled above)
const PUNCTUATION = /[?!()[\]{}<>|\\/,;:=+*&^%$#@~]/g;

export function sanitizeKeyword(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  let s = String(raw);
  // 1. Unicode normalise (collapses ligatures, full-width chars, etc.)
  try {
    s = s.normalize("NFKC");
  } catch {
    // ignore — older runtimes
  }
  // 2. Strip invisibles and control chars
  s = s.replace(ZERO_WIDTH, "").replace(CONTROL, "");
  // 3. Convert weird whitespace to plain space
  s = s.replace(UNICODE_WS, " ");
  // 4. Convert all quote-likes to space
  s = s.replace(QUOTES, " ");
  // 5. Lowercase
  s = s.toLowerCase();
  // 6. Strip remaining punctuation
  s = s.replace(PUNCTUATION, " ");
  // 7. Collapse whitespace + trim
  s = s.replace(/\s+/g, " ").trim();
  return s;
}
