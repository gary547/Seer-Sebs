// Single source of truth for parsing pasted / CSV keyword input.
//
// Line shape:  keyword [, priority] [, cat1|cat2|cat3|...]
//
//  - keyword:    required
//  - priority:   primary | secondary | tertiary  (case-insensitive, optional)
//  - categories: pipe-separated, only first 3 kept (tag_1, tag_2, tag_3)
//
// Backward compatible: a plain "keyword" line still works.

export type ParsedKeywordRow = {
  keyword: string;
  priority?: 1 | 2 | 3;
  seedTags?: string[]; // length 1–3 when present
};

export type ParseResult = {
  rows: ParsedKeywordRow[];
  invalidLines: number;
  droppedExtraTags: number; // count of lines that supplied >3 tags
  withPriority: number;
  withSeededCategories: number;
};

const PRIORITY_MAP: Record<string, 1 | 2 | 3> = {
  primary: 1,
  secondary: 2,
  tertiary: 3,
  p1: 1,
  p2: 2,
  p3: 3,
  "1": 1,
  "2": 2,
  "3": 3,
};

const HEADER_TOKENS = new Set([
  "keyword",
  "keywords",
  "term",
  "search term",
]);

function splitFields(line: string): string[] {
  // We deliberately keep this simple — no quoted-CSV support, since the only
  // pipe-bearing column is the last one. Split into max 3 fields so commas
  // inside the categories field (shouldn't happen, but defensive) survive.
  const parts: string[] = [];
  let remaining = line;
  for (let i = 0; i < 2; i++) {
    const idx = remaining.indexOf(",");
    if (idx === -1) break;
    parts.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx + 1);
  }
  parts.push(remaining);
  return parts.map((p) => p.trim());
}

function parseLine(line: string): { row: ParsedKeywordRow | null; droppedExtraTags: boolean; invalid: boolean } {
  const trimmed = line.trim();
  if (!trimmed) return { row: null, droppedExtraTags: false, invalid: false };

  const fields = splitFields(trimmed);
  const keyword = fields[0]?.trim();
  if (!keyword) return { row: null, droppedExtraTags: false, invalid: true };

  const row: ParsedKeywordRow = { keyword: keyword.toLowerCase() };

  if (fields[1]) {
    const p = PRIORITY_MAP[fields[1].toLowerCase().trim()];
    if (p) row.priority = p;
  }

  let droppedExtraTags = false;
  if (fields[2]) {
    const tags = fields[2]
      .split("|")
      .map((t) => t.trim())
      .filter(Boolean);
    if (tags.length > 0) {
      if (tags.length > 3) droppedExtraTags = true;
      row.seedTags = tags.slice(0, 3);
    }
  }

  return { row, droppedExtraTags, invalid: false };
}

export function parseKeywordInput(text: string): ParseResult {
  const lines = text.split(/\r?\n/);
  const rows: ParsedKeywordRow[] = [];
  const seen = new Set<string>();
  let invalidLines = 0;
  let droppedExtraTags = 0;
  let withPriority = 0;
  let withSeededCategories = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    // Skip a header row if present at the top (e.g. "keyword,priority,categories").
    if (i === 0) {
      const firstField = raw.split(",")[0]?.trim().toLowerCase();
      if (firstField && HEADER_TOKENS.has(firstField)) continue;
    }

    const { row, droppedExtraTags: dropped, invalid } = parseLine(raw);
    if (invalid) {
      invalidLines++;
      continue;
    }
    if (!row) continue;
    if (seen.has(row.keyword)) continue;
    seen.add(row.keyword);
    rows.push(row);
    if (dropped) droppedExtraTags++;
    if (row.priority) withPriority++;
    if (row.seedTags?.length) withSeededCategories++;
  }

  return { rows, invalidLines, droppedExtraTags, withPriority, withSeededCategories };
}
