import type { PoolClient } from "pg";

import { normaliseKeyword } from "../../../packages/fixtures/src/representative-project.js";
import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { withTransaction } from "../../../packages/runtime/src/database.js";
import { HttpError } from "../../../packages/runtime/src/http.js";
import type { AuthenticatedUser } from "../../../packages/runtime/src/local-auth.js";
import { parseCsvRows, parseNumber } from "./gsc-workbook.js";
import { assertProjectAccessByRole } from "./authorization.js";

type ImportKind = "backlinks" | "features" | "rankings";

interface ProjectDomainRow {
  domain: string;
}

interface KeywordLookupRow {
  id: string;
  normalised_keyword: string;
}

interface SerpFeatureRow {
  avg_monthly_volume: number | null;
  base_rank: number | null;
  captured_at: Date;
  device: string;
  feature_raw: string;
  feature_url: string | null;
  id: string;
  keyword: string;
  keyword_id: string;
  owned: boolean;
  result_type: string;
  search_intent: string | null;
  source: string;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", "The import body is invalid.");
  }
  return value as Record<string, unknown>;
}

function stringValue(
  value: unknown,
  field: string,
  maximum: number,
): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new HttpError(400, "invalid_request", `${field} is invalid.`);
  }
  return value.trim();
}

function normaliseHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseCsv(text: string): Array<Record<string, string>> {
  const grid = parseCsvRows(text);
  if (grid.length < 2) {
    throw new HttpError(400, "empty_csv", "The CSV has no data rows.");
  }
  const headers = (grid[0] ?? []).map(normaliseHeader);
  if (headers.some((header) => !header)) {
    throw new HttpError(400, "invalid_csv", "The CSV header is invalid.");
  }
  return grid
    .slice(1)
    .filter((row) => row.some((value) => value.trim()))
    .map((row) =>
      Object.fromEntries(
        headers.map((header, index) => [header, row[index]?.trim() ?? ""]),
      ),
    );
}

function optionalMetric(
  value: string | undefined,
  field: string,
  maximum: number,
): number | null {
  if (!value?.trim()) return null;
  const parsed = parseNumber(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > maximum) {
    throw new HttpError(400, "invalid_csv", `${field} is invalid.`);
  }
  return parsed;
}

function parsedUrl(value: string, field: string): URL {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    return url;
  } catch {
    throw new HttpError(400, "invalid_csv", `${field} is invalid.`);
  }
}

function canonicalDomain(value: string): string {
  return value.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

function featureType(value: string): string {
  return normaliseHeader(value) || "organic";
}

async function projectLookups(
  client: PoolClient,
  projectId: string,
): Promise<{
  clientDomain: string;
  keywords: Map<string, string>;
}> {
  const [project, keywords] = await Promise.all([
    client.query<ProjectDomainRow>(
      `
        SELECT client.domain
        FROM navigator_projects AS project
        JOIN clients AS client ON client.id = project.client_id
        WHERE project.id = $1
      `,
      [projectId],
    ),
    client.query<KeywordLookupRow>(
      `
        SELECT id, normalised_keyword
        FROM keywords
        WHERE project_id = $1
          AND detox_status = 'keep'
      `,
      [projectId],
    ),
  ]);
  const domain = project.rows[0]?.domain;
  if (!domain) {
    throw new HttpError(404, "project_not_found", "Project not found.");
  }
  return {
    clientDomain: canonicalDomain(domain),
    keywords: new Map(
      keywords.rows.map((keyword) => [
        keyword.normalised_keyword,
        keyword.id,
      ]),
    ),
  };
}

async function importRankings(
  client: PoolClient,
  projectId: string,
  rows: Array<Record<string, string>>,
  clientDomain: string,
  keywords: Map<string, string>,
): Promise<{ imported: number; unmatched: number }> {
  let imported = 0;
  let unmatched = 0;
  for (const [index, row] of rows.entries()) {
    const text = row.keyword;
    const keywordId = text ? keywords.get(normaliseKeyword(text)) : undefined;
    if (!keywordId) {
      unmatched += 1;
      continue;
    }
    const rank = Math.round(parseNumber(row.rank_position ?? row.rank));
    if (!Number.isInteger(rank) || rank < 1 || rank > 100) {
      throw new HttpError(
        400,
        "invalid_csv",
        `rank_position is invalid on row ${index + 2}.`,
      );
    }
    const url = parsedUrl(
      stringValue(row.ranking_url ?? row.url, "ranking_url", 2_048),
      `ranking_url on row ${index + 2}`,
    );
    const domain = canonicalDomain(url.hostname);
    const providedDomain = canonicalDomain(
      row.ranking_domain ?? row.domain ?? domain,
    );
    if (providedDomain !== domain) {
      throw new HttpError(
        400,
        "invalid_csv",
        `ranking_domain does not match ranking_url on row ${index + 2}.`,
      );
    }
    const urlRating = optionalMetric(row.url_rating, "url_rating", 100);
    const domainRating = optionalMetric(
      row.domain_rating,
      "domain_rating",
      100,
    );
    const ahrefsRank = optionalMetric(
      row.ahrefs_rank,
      "ahrefs_rank",
      Number.MAX_SAFE_INTEGER,
    );
    const referringDomains = optionalMetric(
      row.referring_domains,
      "referring_domains",
      Number.MAX_SAFE_INTEGER,
    );
    const backlinks = optionalMetric(
      row.backlinks_total ?? row.backlinks,
      "backlinks",
      Number.MAX_SAFE_INTEGER,
    );
    await client.query(
      `
        INSERT INTO serp_results (
          project_id,
          keyword_id,
          rank_absolute,
          url,
          domain,
          is_client_domain,
          url_rating,
          domain_rating,
          ahrefs_rank,
          referring_domains,
          backlinks,
          metric_source,
          fetched_at,
          metrics_fetched_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
          'manual-csv', now(),
          CASE
            WHEN $7::numeric IS NOT NULL
              OR $8::numeric IS NOT NULL
              OR $9::bigint IS NOT NULL
              OR $10::bigint IS NOT NULL
              OR $11::bigint IS NOT NULL
            THEN now()
            ELSE NULL
          END
        )
        ON CONFLICT (keyword_id, rank_absolute)
        DO UPDATE SET
          url = EXCLUDED.url,
          domain = EXCLUDED.domain,
          is_client_domain = EXCLUDED.is_client_domain,
          url_rating = COALESCE(EXCLUDED.url_rating, serp_results.url_rating),
          domain_rating = COALESCE(
            EXCLUDED.domain_rating,
            serp_results.domain_rating
          ),
          ahrefs_rank = COALESCE(EXCLUDED.ahrefs_rank, serp_results.ahrefs_rank),
          referring_domains = COALESCE(
            EXCLUDED.referring_domains,
            serp_results.referring_domains
          ),
          backlinks = COALESCE(EXCLUDED.backlinks, serp_results.backlinks),
          metric_source = 'manual-csv',
          fetched_at = now(),
          metrics_fetched_at = COALESCE(
            EXCLUDED.metrics_fetched_at,
            serp_results.metrics_fetched_at
          )
      `,
      [
        projectId,
        keywordId,
        rank,
        url.toString(),
        domain,
        domain === clientDomain,
        urlRating,
        domainRating,
        ahrefsRank === null ? null : Math.round(ahrefsRank),
        referringDomains === null ? null : Math.round(referringDomains),
        backlinks === null ? null : Math.round(backlinks),
      ],
    );
    imported += 1;
  }
  return { imported, unmatched };
}

async function importBacklinks(
  client: PoolClient,
  projectId: string,
  rows: Array<Record<string, string>>,
): Promise<{ imported: number; unmatched: number }> {
  let imported = 0;
  let unmatched = 0;
  for (const [index, row] of rows.entries()) {
    const url = parsedUrl(
      stringValue(row.ranking_url ?? row.url, "ranking_url", 2_048),
      `ranking_url on row ${index + 2}`,
    );
    const result = await client.query(
      `
        UPDATE serp_results
        SET
          url_rating = $3,
          domain_rating = $4,
          referring_domains = $5,
          backlinks = $6,
          ahrefs_rank = $7,
          metric_source = 'manual-csv',
          metrics_fetched_at = now()
        WHERE project_id = $1
          AND lower(url) = lower($2)
      `,
      [
        projectId,
        url.toString(),
        optionalMetric(row.url_rating, "url_rating", 100),
        optionalMetric(row.domain_rating, "domain_rating", 100),
        optionalMetric(
          row.referring_domains,
          "referring_domains",
          Number.MAX_SAFE_INTEGER,
        ),
        optionalMetric(
          row.backlinks_total ?? row.backlinks,
          "backlinks",
          Number.MAX_SAFE_INTEGER,
        ),
        optionalMetric(
          row.ahrefs_rank,
          "ahrefs_rank",
          Number.MAX_SAFE_INTEGER,
        ),
      ],
    );
    if ((result.rowCount ?? 0) === 0) unmatched += 1;
    else imported += result.rowCount ?? 0;
  }
  return { imported, unmatched };
}

async function importFeatures(
  client: PoolClient,
  projectId: string,
  rows: Array<Record<string, string>>,
  clientDomain: string,
  keywords: Map<string, string>,
): Promise<{ imported: number; unmatched: number }> {
  let imported = 0;
  let unmatched = 0;
  for (const [index, row] of rows.entries()) {
    const keywordText = row.keyword;
    const keywordId = keywordText
      ? keywords.get(normaliseKeyword(keywordText))
      : undefined;
    if (!keywordId) {
      unmatched += 1;
      continue;
    }
    const raw = stringValue(
      row.serp_feature_raw ?? row.result_type,
      "serp_feature_raw",
      200,
    );
    const rawUrl = row.feature_url ?? row.ranking_url ?? "";
    const url = rawUrl
      ? parsedUrl(rawUrl, `feature_url on row ${index + 2}`)
      : null;
    const device = (row.device || "mobile").toLowerCase();
    if (!["desktop", "mobile", "tablet"].includes(device)) {
      throw new HttpError(
        400,
        "invalid_csv",
        `device is invalid on row ${index + 2}.`,
      );
    }
    const domain = url ? canonicalDomain(url.hostname) : "";
    const owned =
      domain === clientDomain || domain.endsWith(`.${clientDomain}`);
    await client.query(
      `
        INSERT INTO project_serp_features (
          project_id,
          keyword_id,
          device,
          feature_raw,
          result_type,
          feature_url,
          owned,
          source,
          captured_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual-csv', now())
        ON CONFLICT (
          project_id,
          keyword_id,
          device,
          result_type,
          feature_raw,
          (COALESCE(feature_url, ''))
        )
        DO UPDATE SET
          owned = EXCLUDED.owned,
          source = EXCLUDED.source,
          captured_at = now()
      `,
      [
        projectId,
        keywordId,
        device,
        raw,
        featureType(row.result_type || raw),
        url?.toString() ?? null,
        owned,
      ],
    );
    imported += 1;
  }
  return { imported, unmatched };
}

export async function importProjectSerpCsv(
  pool: DatabasePool,
  user: AuthenticatedUser,
  projectId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const input = record(body);
  const kind = stringValue(input.kind, "kind", 20) as ImportKind;
  if (!["backlinks", "features", "rankings"].includes(kind)) {
    throw new HttpError(400, "invalid_request", "Import kind is invalid.");
  }
  const rows = parseCsv(stringValue(input.csvText, "csvText", 20 * 1_024 * 1_024));
  if (rows.length > 100_000) {
    throw new HttpError(413, "csv_too_large", "The CSV has too many rows.");
  }
  let result = { imported: 0, unmatched: 0 };
  await withTransaction(pool, async (client) => {
    await assertProjectAccessByRole(client, user.id, projectId, true);
    const lookup = await projectLookups(client, projectId);
    result =
      kind === "rankings"
        ? await importRankings(
            client,
            projectId,
            rows,
            lookup.clientDomain,
            lookup.keywords,
          )
        : kind === "backlinks"
          ? await importBacklinks(client, projectId, rows)
          : await importFeatures(
              client,
              projectId,
              rows,
              lookup.clientDomain,
              lookup.keywords,
            );
    if (result.imported === 0) {
      throw new HttpError(
        400,
        "no_matching_rows",
        "No CSV rows matched this project.",
      );
    }
    await client.query(
      `
        UPDATE navigator_projects
        SET
          serp_dirty = true,
          last_dirty_at = now(),
          updated_at = now()
        WHERE id = $1
      `,
      [projectId],
    );
  });
  return {
    importKind: kind,
    importedRowCount: result.imported,
    projectId,
    sourceRowCount: rows.length,
    unmatchedRowCount: result.unmatched,
  };
}

export async function listProjectSerpFeatures(
  pool: DatabasePool,
  user: AuthenticatedUser,
  projectId: string,
  limit: number,
  offset: number,
): Promise<Record<string, unknown>> {
  await assertProjectAccessByRole(pool, user.id, projectId);
  const [items, count] = await Promise.all([
    pool.query<SerpFeatureRow>(
      `
        SELECT
          feature.id,
          feature.keyword_id,
          keyword.keyword,
          keyword.search_intent,
          keyword.avg_monthly_volume,
          keyword.base_rank,
          feature.device,
          feature.feature_raw,
          feature.result_type,
          feature.feature_url,
          feature.owned,
          feature.source,
          feature.captured_at
        FROM project_serp_features AS feature
        JOIN keywords AS keyword ON keyword.id = feature.keyword_id
        WHERE feature.project_id = $1
          AND keyword.detox_status = 'keep'
        ORDER BY
          keyword.avg_monthly_volume DESC NULLS LAST,
          keyword.normalised_keyword,
          feature.result_type
        LIMIT $2 OFFSET $3
      `,
      [projectId, limit, offset],
    ),
    pool.query<{ count: string }>(
      `
        SELECT count(*)::text AS count
        FROM project_serp_features AS feature
        JOIN keywords AS keyword ON keyword.id = feature.keyword_id
        WHERE feature.project_id = $1
          AND keyword.detox_status = 'keep'
      `,
      [projectId],
    ),
  ]);
  return {
    items: items.rows.map((item) => ({
      averageMonthlyVolume: item.avg_monthly_volume,
      baseRank: item.base_rank,
      capturedAt: item.captured_at.toISOString(),
      device: item.device,
      featureRaw: item.feature_raw,
      featureUrl: item.feature_url,
      id: item.id,
      keyword: item.keyword,
      keywordId: item.keyword_id,
      owned: item.owned,
      resultType: item.result_type,
      searchIntent: item.search_intent,
      source: item.source,
    })),
    limit,
    offset,
    projectId,
    total: Number(count.rows[0]?.count ?? "0"),
  };
}
