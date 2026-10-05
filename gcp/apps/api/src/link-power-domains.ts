import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { HttpError } from "../../../packages/runtime/src/http.js";
import type { AuthenticatedUser } from "../../../packages/runtime/src/local-auth.js";
import { assertAdministrator, assertProjectAccessByRole } from "./authorization.js";
import { queryCalculationDiagnostic } from "./calculation-reads.js";

const SORT_COLUMNS = { meanScore: "mean_score", appearances: "appearance_count" } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getProjectLinkPowerDomains(
  pool: DatabasePool, user: AuthenticatedUser, projectId: string, params: URLSearchParams,
): Promise<Record<string, unknown>> {
  await assertAdministrator(pool, user.id);
  await assertProjectAccessByRole(pool, user.id, projectId);
  const sort = params.get("sort") ?? "meanScore";
  const direction = params.get("direction") ?? "desc";
  const limit = Number(params.get("limit") ?? "10");
  const offset = Number(params.get("offset") ?? "0");
  const runId = params.get("runId");
  if (
    !Object.hasOwn(SORT_COLUMNS, sort) || !["asc", "desc"].includes(direction) ||
    !Number.isSafeInteger(limit) || limit < 1 || limit > 200 ||
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
    domains: page.rows.filter(row => row.domain !== null).map(row => ({
      appearances: Number(row.appearance_count), bestRank: row.best_rank, domain: row.domain,
      isClientDomain: row.is_client_domain, meanScore: Number(row.mean_score),
    })),
    total: Number(page.rows[0]?.total ?? 0),
  };
}
