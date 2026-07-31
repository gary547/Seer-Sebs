import { addProjectKeywords } from "@/integrations/gcp/project-data";
import type { ParsedKeywordRow } from "./parseKeywordInput";

export type AddKeywordsResult = {
  submitted: number;
  inserted: number;
  skippedDuplicates: number;
  invalid: number;
  withPriority: number;
  withSeededCategories: number;
};

const CHUNK_SIZE = 500;
const MAX_KEYWORD_LEN = 200;

/**
 * Canonical keyword ingestion path. Accepts structured rows (keyword + optional
 * priority + optional seed categories), normalises, dedupes in-memory, then
 * chunked-upserts with `ignoreDuplicates: true` so partial overlap with
 * existing rows on the project never throws a unique-constraint error.
 *
 * Seeded categories are written to tag_1..tag_3 and the row is marked
 * `categorisation_status = 'done'` with `intent_source = 'client_supplied'`,
 * so the AI categoriser (which only claims rows with NULL tag_1) leaves them
 * alone — the client-supplied taxonomy is locked.
 */
export async function addKeywordsToProject(
  projectId: string,
  rows: ParsedKeywordRow[],
  opts?: { onProgress?: (done: number, total: number) => void },
): Promise<AddKeywordsResult> {
  const seen = new Set<string>();
  const cleaned: ParsedKeywordRow[] = [];
  let invalid = 0;
  let withPriority = 0;
  let withSeededCategories = 0;

  for (const row of rows) {
    if (!row || typeof row.keyword !== "string") {
      invalid++;
      continue;
    }
    const k = row.keyword.trim().toLowerCase();
    if (!k) continue;
    if (k.length > MAX_KEYWORD_LEN) {
      invalid++;
      continue;
    }
    if (seen.has(k)) continue;
    seen.add(k);
    cleaned.push({ ...row, keyword: k });
    if (row.priority) withPriority++;
    if (row.seedTags?.length) withSeededCategories++;
  }

  const submitted = cleaned.length;
  if (!submitted) {
    return {
      submitted: 0,
      inserted: 0,
      skippedDuplicates: 0,
      invalid,
      withPriority: 0,
      withSeededCategories: 0,
    };
  }

  let inserted = 0;
  for (let i = 0; i < cleaned.length; i += CHUNK_SIZE) {
    const slice = cleaned.slice(i, i + CHUNK_SIZE).map((row) => ({
      priority: row.priority ?? null,
      seedTags: row.seedTags ?? [],
      text: row.keyword,
    }));
    const result = await addProjectKeywords(projectId, slice);
    inserted += result.insertedKeywordCount;
    opts?.onProgress?.(Math.min(i + CHUNK_SIZE, cleaned.length), cleaned.length);
  }

  return {
    submitted,
    inserted,
    skippedDuplicates: submitted - inserted,
    invalid,
    withPriority,
    withSeededCategories,
  };
}
