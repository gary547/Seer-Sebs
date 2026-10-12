import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabasePool } from '../../dist/gcp/packages/runtime/src/database.js';

const pool = createDatabasePool('postgresql://seer_owner:local-owner-only@127.0.0.1:25432/seer');
const db = await pool.connect();
const clientId = randomUUID(), projectId = randomUUID(), otherProjectId = randomUUID();
try {
  await db.query('BEGIN');
  await db.query("INSERT INTO clients(id,company_name,domain) VALUES($1,'Coverage fixture','coverage.test')", [clientId]);
  await db.query("INSERT INTO navigator_projects(id,client_id,project_name) VALUES($1,$3,'Primary'),($2,$3,'Other')", [projectId,otherProjectId,clientId]);
  await db.query('SET LOCAL ROLE seer_api');
  await db.query("INSERT INTO local_provider_keyword_inputs(project_id,normalised_keyword,keyword) VALUES($1,'same','same'),($1,'target','target'),($2,'same','same')", [projectId,otherProjectId]);
  const parity = async () => {
    const actual = await db.query(`SELECT project_id,normalised_keyword,month_count,
      earliest_month::text,latest_month::text FROM provider_volume_coverage
      WHERE project_id IN ($1,$2) ORDER BY project_id,normalised_keyword`, [projectId,otherProjectId]);
    const expected = await db.query(`SELECT project_id,normalised_keyword,count(*)::integer AS month_count,
      min(month)::text AS earliest_month,max(month)::text AS latest_month
      FROM local_provider_keyword_monthly_volumes WHERE project_id IN ($1,$2)
      GROUP BY project_id,normalised_keyword ORDER BY project_id,normalised_keyword`, [projectId,otherProjectId]);
    assert.deepEqual(actual.rows,expected.rows);
  };
  await db.query(`INSERT INTO local_provider_keyword_monthly_volumes(project_id,normalised_keyword,month,volume)
    SELECT $1,'same',date '2026-01-01'+(n||' months')::interval,n FROM generate_series(0,5) n`, [projectId]);
  await db.query("INSERT INTO local_provider_keyword_monthly_volumes(project_id,normalised_keyword,month,volume) VALUES($1,'same','2020-01-01',0)", [otherProjectId]);
  await parity();
  await db.query(`INSERT INTO local_provider_keyword_monthly_volumes(project_id,normalised_keyword,month,volume)
    VALUES($1,'same','2026-01-01',100),($1,'same','2026-07-01',0)
    ON CONFLICT(project_id,normalised_keyword,month) DO UPDATE SET volume=EXCLUDED.volume`, [projectId]);
  await parity();
  await db.query("UPDATE local_provider_keyword_monthly_volumes SET volume=0 WHERE project_id=$1", [projectId]);
  await parity();
  await db.query("UPDATE local_provider_keyword_monthly_volumes SET month='2026-08-01' WHERE project_id=$1 AND month='2026-07-01'", [projectId]);
  await parity();
  await db.query("UPDATE local_provider_keyword_monthly_volumes SET normalised_keyword='target' WHERE project_id=$1 AND month='2026-02-01'", [projectId]);
  await parity();
  await db.query("DELETE FROM local_provider_keyword_monthly_volumes WHERE project_id=$1 AND month IN ('2026-01-01','2026-08-01')", [projectId]);
  await parity();
  await db.query('SAVEPOINT coverage_rollback');
  await db.query("DELETE FROM local_provider_keyword_monthly_volumes WHERE project_id=$1", [projectId]);
  await parity();
  await db.query('ROLLBACK TO SAVEPOINT coverage_rollback');
  await parity();
  await db.query('RESET ROLE');
  await db.query('SAVEPOINT coverage_truncate');
  await db.query('TRUNCATE local_provider_keyword_monthly_volumes');
  assert.equal((await db.query('SELECT count(*)::integer AS count FROM provider_volume_coverage')).rows[0].count,0);
  await db.query('ROLLBACK TO SAVEPOINT coverage_truncate');
  await db.query('SET LOCAL ROLE seer_api');
  await parity();
  await db.query("DELETE FROM local_provider_keyword_inputs WHERE project_id=$1 AND normalised_keyword='same'", [projectId]);
  await parity();
  await db.query("DELETE FROM local_provider_keyword_monthly_volumes WHERE project_id=$1", [otherProjectId]);
  await parity();
  await assert.rejects(db.query("UPDATE provider_volume_coverage SET month_count=99 WHERE project_id=$1", [projectId]), {code:'42501'});
  await db.query('ROLLBACK');
  await db.query("INSERT INTO clients(id,company_name,domain) VALUES($1,'Concurrent coverage','coverage.test')", [clientId]);
  await db.query("INSERT INTO navigator_projects(id,client_id,project_name) VALUES($1,$2,'Concurrent')", [projectId,clientId]);
  await db.query("INSERT INTO local_provider_keyword_inputs(project_id,normalised_keyword,keyword) VALUES($1,'same','same')", [projectId]);
  const writers = await Promise.all([pool.connect(),pool.connect()]);
  try {
    await Promise.all(writers.map(writer=>writer.query('SET ROLE seer_api')));
    await Promise.all(writers.map((writer,index)=>writer.query(`
      INSERT INTO local_provider_keyword_monthly_volumes(project_id,normalised_keyword,month,volume)
      SELECT $1,'same',date '2026-01-01'+(n||' months')::interval,n
      FROM generate_series($2::integer,$2::integer+5) n
      ON CONFLICT(project_id,normalised_keyword,month) DO UPDATE SET volume=EXCLUDED.volume`, [projectId,index*3])));
    await parity();
    assert.equal((await db.query('SELECT month_count FROM provider_volume_coverage WHERE project_id=$1',[projectId])).rows[0].month_count,9);
  } finally {
    for (const writer of writers) {await writer.query('RESET ROLE');writer.release();}
  }
  console.log(JSON.stringify({providerVolumeCoverage:true,actualApiRole:true,insertUpsertUpdateDelete:true,
    boundariesAndCascade:true,transactionRollback:true,truncateRollback:true,concurrentUpserts:true,projectIsolation:true,directProjectionWritesDenied:true}));
} finally {
  await db.query('ROLLBACK');
  await db.query('DELETE FROM clients WHERE id=$1',[clientId]);
  db.release(); await pool.end();
}
