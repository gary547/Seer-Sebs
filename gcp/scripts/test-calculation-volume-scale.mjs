import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabasePool } from '../../dist/gcp/packages/runtime/src/database.js';
import { projectVolumeSampleSql, projectVolumeSummarySql } from '../../dist/gcp/packages/runtime/src/project-volume-history.js';
const pool = createDatabasePool('postgresql://seer_owner:local-owner-only@127.0.0.1:25432/seer');
const client = await pool.connect();
const project = randomUUID();
try {
  await client.query('BEGIN');
  await client.query("SET LOCAL statement_timeout = '120s'");
  for (const table of ['keywords','keyword_monthly_volumes','local_provider_keyword_monthly_volumes']) await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL) ON COMMIT DROP`);
  await client.query("INSERT INTO keywords (id,project_id,keyword,normalised_keyword,detox_status) SELECT gen_random_uuid(),$1, 'query '||n,'query '||n,'keep' FROM generate_series(1,44135) n",[project]);
  await client.query("INSERT INTO local_provider_keyword_monthly_volumes (project_id,normalised_keyword,month,volume) SELECT project_id,normalised_keyword, date '2023-09-01' + (n||' months')::interval, 100+n FROM keywords CROSS JOIN generate_series(0,35) n");
  await client.query("INSERT INTO keyword_monthly_volumes (id,keyword_id,month,volume,source) SELECT gen_random_uuid(),id,date '2026-08-01',0,'upload' FROM keywords LIMIT 450");
  for (const table of ['keywords','keyword_monthly_volumes','local_provider_keyword_monthly_volumes']) await client.query(`ANALYZE ${table}`);
  await client.query("SET LOCAL statement_timeout = '30s'");
  for(const [name, sql] of [['summary',projectVolumeSummarySql()],['sample',projectVolumeSampleSql()]]) {
    const result = await client.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+sql,[project]);
    const plan = result.rows[0]['QUERY PLAN'][0];
    console.log(JSON.stringify({name,keywordCount:44135,historyRows:1588860,plan}));
    assert.ok(plan['Execution Time'] < 5000, `${name} exceeded the 5s large-history query budget: ${plan['Execution Time']}ms`);
    const data = await client.query(sql,[project]);
    if (name === 'summary') {
      assert.equal(Number(data.rows[0].kept_keyword_count),44135);
      assert.equal(Number(data.rows[0].history_row_count),1588860);
      assert.equal(Number(data.rows[0].with_24_months_count),44135);
    } else {
      assert.equal(data.rows.length,20);
      for(const row of data.rows) {
        assert.equal(row.months.length,36);
        const index=Number(row.keyword.replace('query ',''));
        assert.equal(row.months.at(-1).volume,index<=450?0:135);
      }
    }
  }

} finally {await client.query('ROLLBACK');client.release();await pool.end();}
