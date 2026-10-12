import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabasePool } from '../../dist/gcp/packages/runtime/src/database.js';
import { linkPowerDetailsSql, linkPowerDomainSummarySql, linkPowerSummarySql } from '../../dist/gcp/apps/api/src/link-power-inspector-queries.js';
import { serpVisibilitySummarySql } from '../../dist/gcp/apps/api/src/serp-visibility-queries.js';

const pool = createDatabasePool('postgresql://seer_owner:local-owner-only@127.0.0.1:25432/seer');
const client = await pool.connect();
const project = randomUUID(), otherProject = randomUUID(), run = randomUUID(), olderRun = randomUUID(), otherRun = randomUUID();
const values = [project, run];
const tables = ['keywords', 'serp_results', 'link_power_scores', 'project_serp_features', 'har_forecasts'];
function close(actual, expected, name) {
  if (expected === null) assert.equal(actual, null, name);
  else assert.ok(Math.abs(Number(actual) - Number(expected)) < 1e-10, `${name}: ${actual} differs from ${expected}`);
}
try {
  await client.query('BEGIN');
  await client.query("SET LOCAL statement_timeout = '180s'");
  for (const table of tables) {
    await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS INCLUDING CONSTRAINTS) ON COMMIT DROP`);
  }
  await client.query('ALTER TABLE keywords ADD COLUMN fixture_ordinal integer');
  await client.query(`INSERT INTO keywords (id, project_id, keyword, normalised_keyword, fixture_ordinal)
    SELECT gen_random_uuid(), $1::uuid, CASE WHEN n <= 5 THEN 'needle ' ELSE 'lps query ' END || n,
      CASE WHEN n <= 5 THEN 'needle ' ELSE 'lps query ' END || n, n
    FROM generate_series(1,100000) n
    UNION ALL SELECT gen_random_uuid(), $2::uuid, 'foreign-only '||n, 'foreign-only '||n, n
    FROM generate_series(1,50000) n`, [project, otherProject]);
  await client.query(`INSERT INTO serp_results (id,project_id,keyword_id,rank_absolute,url,domain,is_client_domain,
      url_rating,domain_rating,referring_domains,backlinks,metric_source,authority_scope)
    SELECT gen_random_uuid(),keyword.project_id,keyword.id,rank,
      'https://' || domain || '/query-' || fixture_ordinal || '/' || rank, domain, rank=9,
      CASE WHEN rank=1 THEN NULL WHEN rank=2 THEN 0 ELSE 50 END,
      CASE WHEN rank=3 THEN NULL WHEN rank=4 THEN 0 ELSE 45 END,
      CASE WHEN rank=5 THEN NULL ELSE 0 END,
      CASE WHEN rank=6 THEN NULL ELSE 100 END, 'dataforseo', 'page'
    FROM keywords keyword CROSS JOIN LATERAL generate_series(1,CASE WHEN keyword.project_id=$1 THEN 9 ELSE 18 END) rank
    CROSS JOIN LATERAL (SELECT CASE WHEN keyword.project_id<>$1 THEN 'foreign-only.test'
      WHEN rank=9 THEN 'client.test' WHEN fixture_ordinal<=5 AND rank=1 THEN 'needle.test'
      ELSE 'competitor-' || (fixture_ordinal % 31730) || '.test' END AS domain) names`, [project]);
  await client.query(`INSERT INTO project_serp_features (project_id,keyword_id,feature_raw,result_type,owned,source)
    SELECT result.project_id,result.keyword_id,'result-'||rank_absolute,'type-'||(keyword.fixture_ordinal%40),
      result.is_client_domain,'dataforseo' FROM serp_results result JOIN keywords keyword ON keyword.id=result.keyword_id`);
  await client.query(`INSERT INTO har_forecasts (project_id,keyword_id,pipeline_run_id,scenario,model_version,
      har_confidence,serp_visibility_multiplier,explanation_json)
    SELECT project_id,id,$2,'realistic','har_v2.1.1',0.75,(fixture_ordinal%51)/50.0,'{}'::jsonb
    FROM keywords WHERE project_id=$1`, values);
  await client.query(`INSERT INTO link_power_scores (project_id,keyword_id,serp_result_id,pipeline_run_id,score,confidence)
    SELECT result.project_id,result.keyword_id,result.id,
      CASE WHEN result.project_id=$1 THEN $2::uuid ELSE $3::uuid END,
      CASE WHEN keyword.fixture_ordinal<=100 THEN 0 ELSE ((keyword.fixture_ordinal*137+rank_absolute*313)%10001)/100.0 END,
      CASE rank_absolute%3 WHEN 0 THEN 'high' WHEN 1 THEN 'medium' ELSE 'low' END
    FROM serp_results result JOIN keywords keyword ON keyword.id=result.keyword_id
    WHERE result.project_id=$1 OR (keyword.fixture_ordinal<=25000 AND rank_absolute<=9)`, [project,run,otherRun]);
  for (const table of tables) await client.query(`ANALYZE ${table}`);
  await client.query(`INSERT INTO link_power_scores (project_id,keyword_id,serp_result_id,pipeline_run_id,score,confidence)
    SELECT project_id,keyword_id,serp_result_id,$3,100,'high' FROM link_power_scores
    WHERE project_id=$1 AND pipeline_run_id=$2 AND keyword_id IN (SELECT id FROM keywords WHERE project_id=$1 AND fixture_ordinal<=25000)`, [project,run,olderRun]);
  await client.query("SET LOCAL maintenance_work_mem = '256MB'");
  for (const table of tables) {
    const indexes = await client.query(`SELECT pg_get_indexdef(indexrelid) AS definition
      FROM pg_index WHERE indrelid=$1::regclass AND indisready AND indisvalid`, ['public.'+table]);
    for (const { definition } of indexes.rows) {
      const temporaryIndex = definition.replace(/INDEX (\S+) ON public\.(\S+)/, 'INDEX fixture_$1 ON pg_temp.$2');
      assert.notEqual(temporaryIndex, definition);
      await client.query(temporaryIndex);
    }
    await client.query(`ANALYZE ${table}`);
  }
  await client.query("SET LOCAL statement_timeout = '30s'");

  const oracle = (await client.query(`SELECT count(*)::text AS scored_count,count(DISTINCT score.keyword_id)::text AS keyword_count,
    avg(score.score)::text AS average_score,percentile_cont(0.1) WITHIN GROUP(ORDER BY score.score)::text AS p10_score,
    percentile_cont(0.5) WITHIN GROUP(ORDER BY score.score)::text AS p50_score,
    percentile_cont(0.9) WITHIN GROUP(ORDER BY score.score)::text AS p90_score,
    count(*) FILTER(WHERE score.confidence='high')::text AS high_confidence_count,
    count(*) FILTER(WHERE score.confidence='medium')::text AS medium_confidence_count,
    count(*) FILTER(WHERE score.confidence='low')::text AS low_confidence_count,
    count(*) FILTER(WHERE result.url_rating IS NULL)::text AS missing_url_rating_count,
    count(*) FILTER(WHERE result.domain_rating IS NULL)::text AS missing_domain_rating_count,
    count(*) FILTER(WHERE result.referring_domains IS NULL)::text AS missing_referring_domains_count,
    count(*) FILTER(WHERE result.backlinks IS NULL)::text AS missing_backlinks_count
    FROM link_power_scores score JOIN serp_results result ON result.id=score.serp_result_id
    WHERE score.project_id=$1 AND score.pipeline_run_id=$2`, values)).rows[0];
  const domainsOracle = (await client.query(`SELECT result.domain,result.is_client_domain,count(*)::text AS appearance_count,
    avg(score.score)::text AS mean_score,min(result.rank_absolute) AS best_rank
    FROM link_power_scores score JOIN serp_results result ON result.id=score.serp_result_id
    WHERE score.project_id=$1 AND score.pipeline_run_id=$2 GROUP BY result.domain,result.is_client_domain
    ORDER BY result.is_client_domain DESC,avg(score.score) DESC,result.domain LIMIT 10`, values)).rows;
  const started = Date.now();
  const summary = (await client.query(linkPowerSummarySql, values)).rows[0];
  const domains = (await client.query(linkPowerDomainSummarySql, values)).rows;
  const page = (await client.query(linkPowerDetailsSql(false), [...values,50,0])).rows;
  const elapsedMs = Date.now() - started;
  assert.ok(elapsedMs < 10000, `Large-run inspector exceeded 10s: ${elapsedMs}ms`);
  for (const [key, value] of Object.entries(summary)) close(value, oracle[key], key);
  assert.equal(Number(summary.scored_count),900000);
  assert.equal(Number(summary.keyword_count),100000);
  for (const key of ['missing_url_rating_count','missing_domain_rating_count','missing_referring_domains_count','missing_backlinks_count']) {
    assert.equal(Number(domains[0][key]),100000); close(domains[0][key], oracle[key], key);
  }
  assert.deepEqual(domains.map(({missing_url_rating_count,missing_domain_rating_count,missing_referring_domains_count,missing_backlinks_count,...row})=>row), domainsOracle);
  const next = (await client.query(linkPowerDetailsSql(false), [...values,50,50])).rows;
  assert.equal(new Set([...page,...next].map(row=>row.serp_result_id)).size,100);
  assert.ok(page.every(row=>row.metric_source==='dataforseo' && row.authority_scope==='page'));
  for (const [search,total] of [['needle',45],['client.test',100000],['foreign-only',0]]) {
    const result = await client.query(linkPowerDetailsSql(true), [...values,search,50,0]);
    assert.equal(Number(result.rows[0].total),total,search);
    assert.equal(result.rows.filter(row=>row.keyword_id!==null).length, Math.min(total,50),search);
  }
  const beyond = await client.query(linkPowerDetailsSql(true), [...values,'needle',50,100]);
  assert.equal(beyond.rows.length,1);assert.equal(beyond.rows[0].keyword_id,null);assert.equal(Number(beyond.rows[0].total),45);
  const empty = (await client.query(linkPowerSummarySql, [project,randomUUID()])).rows[0];
  assert.equal(Number(empty.scored_count),0);assert.equal(empty.average_score,null);assert.equal(empty.p10_score,null);
  const emptyDomains = (await client.query(linkPowerDomainSummarySql, [project,randomUUID()])).rows[0];
  assert.equal(emptyDomains.domain,null);assert.equal(Number(emptyDomains.missing_url_rating_count),0);
  const visibilityOracle = (await client.query(`WITH feature_types AS (
    SELECT result_type,count(*) AS count,count(*) FILTER(WHERE owned) AS owned_count
    FROM project_serp_features WHERE project_id=$1 GROUP BY result_type ORDER BY count(*) DESC,result_type LIMIT 30)
    SELECT (SELECT count(*)::text FROM project_serp_features WHERE project_id=$1) AS feature_count,
      (SELECT count(DISTINCT keyword_id)::text FROM project_serp_features WHERE project_id=$1) AS keyword_count,
      (SELECT count(*) FILTER(WHERE owned)::text FROM project_serp_features WHERE project_id=$1) AS owned_count,
      (SELECT avg(serp_visibility_multiplier)::text FROM har_forecasts WHERE project_id=$1 AND pipeline_run_id=$2 AND scenario='realistic') AS average_visibility_multiplier,
      (SELECT jsonb_agg(jsonb_build_object('resultType',result_type,'count',count,'ownedCount',owned_count) ORDER BY count DESC,result_type) FROM feature_types) AS feature_types`,values)).rows[0];
  const visibilityStarted=Date.now();const visibility=(await client.query(serpVisibilitySummarySql,values)).rows[0];
  const visibilityMs=Date.now()-visibilityStarted;assert.ok(visibilityMs<5000,`SERP visibility exceeded 5s: ${visibilityMs}ms`);
  assert.deepEqual(visibility,visibilityOracle);assert.equal(visibility.feature_count,'900000');assert.equal(visibility.keyword_count,'100000');assert.equal(visibility.owned_count,'100000');assert.equal(visibility.feature_types.length,30);
  const missingForecast=(await client.query(serpVisibilitySummarySql,[project,randomUUID()])).rows[0];
  assert.equal(missingForecast.average_visibility_multiplier,null);assert.equal(missingForecast.feature_count,'900000');
  const emptyVisibility=(await client.query(serpVisibilitySummarySql,[randomUUID(),run])).rows[0];
  assert.deepEqual(emptyVisibility,{feature_count:'0',keyword_count:'0',owned_count:'0',average_visibility_multiplier:null,feature_types:[]});
  console.log(JSON.stringify({linkPowerInspectorScale:true,keywords:100000,scoredRows:900000,serpRows:1800000,
    historicalAndOtherProjectScores:450000,elapsedMs,visibilityMs,exactVisibilityAndOwnershipParity:true,exactSummaryAndPercentileParity:true,searchUnionDeduplicated:true,paginationAndIsolation:true}));
} finally {
  await client.query('ROLLBACK'); client.release(); await pool.end();
}
