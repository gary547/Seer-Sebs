import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { canonicalProjectVolumeCte, projectVolumeSampleSql, projectVolumeSummarySql } from "../../dist/gcp/packages/runtime/src/project-volume-history.js";

const projectId = "00000000-0000-4000-8000-000000000001";
const otherProjectId = "00000000-0000-4000-8000-000000000002";
const keywordId = "00000000-0000-4000-8000-000000000101";
const cacheOnlyId = "00000000-0000-4000-8000-000000000102";
const removedId = "00000000-0000-4000-8000-000000000103";
const otherKeywordId = "00000000-0000-4000-8000-000000000201";

const setup = `
  BEGIN;
  CREATE TEMP TABLE keywords (
    id uuid PRIMARY KEY, project_id uuid NOT NULL,
    normalised_keyword text NOT NULL, detox_status text NOT NULL
  ) ON COMMIT DROP;
  CREATE TEMP TABLE keyword_monthly_volumes (
    id uuid PRIMARY KEY, keyword_id uuid NOT NULL, month date NOT NULL,
    volume integer NOT NULL, fetched_at timestamptz NOT NULL, source text NOT NULL
  ) ON COMMIT DROP;
  CREATE TEMP TABLE local_provider_keyword_monthly_volumes (
    project_id uuid NOT NULL, normalised_keyword text NOT NULL,
    month date NOT NULL, volume integer NOT NULL,
    PRIMARY KEY (project_id, normalised_keyword, month)
  ) ON COMMIT DROP;
  INSERT INTO keywords VALUES
    ('${keywordId}', '${projectId}', 'shared query', 'keep'),
    ('${cacheOnlyId}', '${projectId}', 'cached query', 'keep'),
    ('${removedId}', '${projectId}', 'removed query', 'remove'),
    ('${otherKeywordId}', '${otherProjectId}', 'shared query', 'keep');
  INSERT INTO keyword_monthly_volumes VALUES
    ('00000000-0000-4000-8000-000000001001', '${keywordId}', '2025-01-01', 900, '2026-01-01', 'archive'),
    ('00000000-0000-4000-8000-000000001002', '${keywordId}', '2025-01-01', 0, '2026-02-01', 'archive'),
    ('00000000-0000-4000-8000-000000001003', '${keywordId}', '2025-03-01', 123, '2026-02-01', 'archive'),
    ('00000000-0000-4000-8000-000000001004', '${keywordId}', '2025-03-01', 321, '2026-02-01', 'archive'),
    ('00000000-0000-4000-8000-000000001005', '${otherKeywordId}', '2025-01-01', 9999, '2026-02-01', 'archive');
  INSERT INTO local_provider_keyword_monthly_volumes VALUES
    ('${projectId}', 'shared query', '2025-01-01', 999),
    ('${projectId}', 'shared query', '2025-02-01', 125),
    ('${projectId}', 'cached query', '2025-01-01', 222),
    ('${projectId}', 'removed query', '2025-01-01', 80),
    ('${otherProjectId}', 'shared query', '2025-02-01', 9999);
  GRANT SELECT ON keywords, keyword_monthly_volumes,
    local_provider_keyword_monthly_volumes TO seer_api, seer_worker;
  ALTER TABLE keywords ADD COLUMN keyword text;
  UPDATE keywords SET keyword = normalised_keyword;
`;

const kept = [
  { keyword_id: keywordId, month: "2025-01-01", volume: 0 },
  { keyword_id: keywordId, month: "2025-02-01", volume: 125 },
  { keyword_id: keywordId, month: "2025-03-01", volume: 321 },
  { keyword_id: cacheOnlyId, month: "2025-01-01", volume: 222 },
];

for (const [keptOnly, role] of [[true, "seer_api"], [false, "seer_worker"]]) {
  const query = `
    ${setup}
    SET LOCAL ROLE ${role};
    WITH ${canonicalProjectVolumeCte(keptOnly)}
    SELECT jsonb_agg(jsonb_build_object(
      'keyword_id', keyword_id, 'month', month, 'volume', volume
    ) ORDER BY keyword_id, month) FROM canonical_volume;
    ROLLBACK;
  `.replaceAll("$1", `'${projectId}'::uuid`);
  const output = execFileSync("docker", [
    "compose", "-f", "gcp/docker-compose.local.yml", "exec", "-T", "postgres",
    "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "seer_owner", "-d", "seer", "-Atq",
  ], { input: query, encoding: "utf8", timeout: 30_000 });
  assert.deepEqual(JSON.parse(output.trim()), keptOnly ? kept : [
    ...kept, { keyword_id: removedId, month: "2025-01-01", volume: 80 },
  ]);
}

console.log("Volume history PostgreSQL integration passed: shared worker/inspector resolution, cache fallback, imported zero preservation, deduplication, qualification and project isolation.");

for (const [kind, sql] of [["summary", projectVolumeSummarySql()], ["sample", projectVolumeSampleSql()]]) {
  const query = `${setup} SET LOCAL ROLE seer_api;
    SELECT jsonb_agg(result) FROM (${sql}) AS result; ROLLBACK;`
    .replaceAll("$1", `'${projectId}'::uuid`);
  const output = execFileSync("docker", ["compose", "-f", "gcp/docker-compose.local.yml", "exec", "-T", "postgres",
    "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "seer_owner", "-d", "seer", "-Atq"],
    { input: query, encoding: "utf8", timeout: 30_000 });
  const rows = JSON.parse(output.trim());
  if (kind === "summary") {
    assert.equal(rows[0].history_row_count, "4");
    assert.equal(rows[0].kept_keyword_count, "2");
  } else {
    assert.deepEqual(rows.flatMap(row => row.months.map(month => ({ keyword_id: row.keyword_id, ...month }))), kept);
  }
}
console.log("Bounded inspector SQL matches canonical volumes, including imported zeros and deterministic ties.");
