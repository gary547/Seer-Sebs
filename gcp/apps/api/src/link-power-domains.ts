import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { HttpError } from "../../../packages/runtime/src/http.js";
import type { AuthenticatedUser } from "../../../packages/runtime/src/local-auth.js";
import { assertAdministrator, assertProjectAccessByRole } from "./authorization.js";
import { queryCalculationDiagnostic } from "./calculation-reads.js";

const SORT_COLUMNS = { meanScore: "mean_score", appearances: "appearance_count" } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_EXPORT_DOMAINS = 250_000;
const MAX_EXPORT_RESPONSE_BYTES = 30 * 1024 * 1024;

interface DomainBenchmarkPage {
  completedAt: string | null;
  domains: Array<{ appearances: number; bestRank: number; domain: string; isClientDomain: boolean; meanScore: number }>;
  direction: string;
  limit: number;
  offset: number;
  projectId: string;
  runId: string | null;
  sort: string;
  total: number;
}

export async function getProjectLinkPowerDomains(
  pool: DatabasePool, user: AuthenticatedUser, projectId: string, params: URLSearchParams,
): Promise<Record<string, unknown>> {
  return { ...await readDomainBenchmark(pool, user, projectId, params) };
}

async function readDomainBenchmark(
  pool: DatabasePool, user: AuthenticatedUser, projectId: string, params: URLSearchParams, exportAll = false,
): Promise<DomainBenchmarkPage> {
  await assertAdministrator(pool, user.id);
  await assertProjectAccessByRole(pool, user.id, projectId);
  const sort = params.get("sort") ?? "meanScore";
  const direction = params.get("direction") ?? "desc";
  const limit = exportAll ? MAX_EXPORT_DOMAINS + 1 : Number(params.get("limit") ?? "10");
  const offset = exportAll ? 0 : Number(params.get("offset") ?? "0");
  const runId = params.get("runId");
  if (
    !Object.hasOwn(SORT_COLUMNS, sort) || !["asc", "desc"].includes(direction) ||
    !Number.isSafeInteger(limit) || limit < 1 || (!exportAll && limit > 200) ||
    !Number.isSafeInteger(offset) || offset < 0 || (runId !== null && !UUID.test(runId))
  ) throw new HttpError(400, "invalid_request", "Domain benchmark parameters are invalid.");

  const runs = await pool.query<{ id: string; completed_at: Date }>(
    `SELECT id, completed_at FROM pipeline_runs
     WHERE input->>'projectId' = $1 AND status = 'succeeded'
       AND ($2::uuid IS NULL OR id = $2::uuid)
     ORDER BY completed_at DESC, id DESC LIMIT 1`, [projectId, runId],
  );
  const run = runs.rows[0];
  if (!run && runId) throw new HttpError(404, "run_not_found", "Completed project run not found.");
  const metadata = { completedAt: run?.completed_at.toISOString() ?? null, direction, limit, offset, projectId, runId: run?.id ?? null, sort };
  if (!run) return { ...metadata, domains: [], total: 0 };

  const column = SORT_COLUMNS[sort as keyof typeof SORT_COLUMNS];
  const order = direction === "asc" ? "ASC" : "DESC";
  const page = await queryCalculationDiagnostic<{
    domain: string | null; is_client_domain: boolean; appearance_count: string;
    mean_score: string; best_rank: number; total: string;
  }>(pool,
    `WITH domain_benchmark AS MATERIALIZED (
       SELECT result.domain, bool_or(result.is_client_domain) AS is_client_domain,
         count(*) AS appearance_count, avg(score.score) AS mean_score,
         min(result.rank_absolute) AS best_rank
       FROM link_power_scores AS score
       JOIN serp_results AS result ON result.id = score.serp_result_id
       WHERE score.project_id = $1 AND score.pipeline_run_id = $2
       GROUP BY result.domain
     ), domain_page AS (
       SELECT * FROM domain_benchmark
       ORDER BY ${column} ${order}, domain ASC LIMIT $3 OFFSET $4
     )
     SELECT page.*, totals.total
     FROM (SELECT count(*)::text AS total FROM domain_benchmark) AS totals
     LEFT JOIN domain_page AS page ON true
     ORDER BY page.${column} ${order}, page.domain ASC`,
    [projectId, run.id, limit, offset],
  );
  return {
    ...metadata,
    domains: page.rows.flatMap(row => row.domain === null ? [] : [{
      appearances: Number(row.appearance_count), bestRank: row.best_rank, domain: row.domain,
      isClientDomain: row.is_client_domain, meanScore: Number(row.mean_score),
    }]),
    total: Number(page.rows[0]?.total ?? 0),
  };
}

function csvCell(value: string | number): string {
  const text = typeof value === "string" && /^(?:[\t\r\n]|[\s\uFEFF]*[=+\-@])/.test(value) ? `'${value}` : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export async function getProjectLinkPowerDomainExport(
  pool: DatabasePool, user: AuthenticatedUser, projectId: string, params: URLSearchParams,
): Promise<Record<string, unknown>> {
  const page = await readDomainBenchmark(pool, user, projectId, params, true);
  if (!page.runId || !page.total) throw new HttpError(409, "domain_export_not_ready", "No completed domain results are available for this export.");
  if (page.total > MAX_EXPORT_DOMAINS) {
    throw new HttpError(413, "domain_export_too_large", "The domain list exceeds the single-file export limit. No partial file was downloaded.");
  }
  if (page.domains.length !== page.total) {
    throw new HttpError(409, "domain_export_incomplete", "The domain list is incomplete. Refresh the benchmark and retry.");
  }
  const lines = [["Domain", "Mean LPS", "Best rank", "Appearances", "Client domain"].map(csvCell).join(",")];
  let responseBytes = Buffer.byteLength(JSON.stringify(lines[0]));
  for (const domain of page.domains) {
    const line = [domain.domain, domain.meanScore, domain.bestRank, domain.appearances, domain.isClientDomain ? "Yes" : "No"].map(csvCell).join(",");
    responseBytes += Buffer.byteLength(JSON.stringify(line)) + 4;
    if (responseBytes > MAX_EXPORT_RESPONSE_BYTES - 1024) {
      throw new HttpError(413, "domain_export_too_large", "The domain list exceeds the single-file export limit. No partial file was downloaded.");
    }
    lines.push(line);
  }
  return { csv: lines.join("\r\n"), runId: page.runId, total: page.total };
}
