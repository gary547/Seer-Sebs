import process from "node:process";

import { pruneUrlMonitorSnapshots, runDueUrlMonitorChecks } from "../../dist/gcp/apps/api/src/url-monitor.js";
import { createDatabasePool } from "../../dist/gcp/packages/runtime/src/database.js";

const databaseUrl =
  process.env.SEER_TEST_DATABASE_URL ??
  "postgresql://seer_owner:local-owner-only@127.0.0.1:25432/seer";
const clientId = "71717171-7171-4171-8171-717171717171";
const campaignId = "72727272-7272-4272-8272-727272727272";
const monitoredUrlId = "73737373-7373-4373-8373-737373737373";
const pool = createDatabasePool(databaseUrl);
const resolver = async () => [{ address: "93.184.216.34", family: 4 }];

async function cleanup() {
  await pool.query("DELETE FROM clients WHERE id = $1", [clientId]);
}

try {
  await cleanup();
  await pool.query(
    `
      INSERT INTO clients (id, company_name, domain, domain_normalized)
      VALUES ($1, 'Maintenance integration', 'maintenance.example.test', 'maintenance.example.test')
    `,
    [clientId],
  );
  await pool.query(
    `
      INSERT INTO monitor_campaigns (
        id, client_id, name, status, check_frequency, daily_check_time
      )
      VALUES ($1, $2, 'Maintenance integration', 'active', '1h', '07:00')
    `,
    [campaignId, clientId],
  );
  await pool.query(
    `
      INSERT INTO monitored_urls (
        id, campaign_id, url, normalized_url, is_active, next_check_at
      )
      VALUES (
        $1,
        $2,
        'https://public.example.test/page',
        'https://public.example.test/page',
        true,
        now() - interval '1 minute'
      )
    `,
    [monitoredUrlId, campaignId],
  );

  const first = await runDueUrlMonitorChecks(pool, {
    campaignId,
    fetchImplementation: async () =>
      new Response("<html><title>Alpha</title></html>", { status: 200 }),
    now: new Date("2026-07-30T12:00:00Z"),
    resolver,
  });
  if (first.checked !== 1 || first.claimed !== 1) {
    throw new Error(`Unexpected first tick: ${JSON.stringify(first)}.`);
  }

  await pool.query(
    "UPDATE monitored_urls SET next_check_at = now() - interval '1 minute' WHERE id = $1",
    [monitoredUrlId],
  );
  const second = await runDueUrlMonitorChecks(pool, {
    campaignId,
    fetchImplementation: async () =>
      new Response("<html><title>Beta</title></html>", { status: 500 }),
    now: new Date("2026-07-30T13:00:00Z"),
    resolver,
  });
  if (second.checked !== 1 || second.claimed !== 1) {
    throw new Error(`Unexpected second tick: ${JSON.stringify(second)}.`);
  }

  const state = await pool.query(
    `
      SELECT
        (SELECT count(*)::integer FROM url_check_snapshots WHERE monitored_url_id = $1) AS snapshots,
        (SELECT count(*)::integer FROM url_issues WHERE monitored_url_id = $1) AS issues,
        current_status,
        lease_token,
        lease_expires_at
      FROM monitored_urls
      WHERE id = $1
    `,
    [monitoredUrlId],
  );
  const row = state.rows[0];
  if (
    row?.snapshots !== 2 ||
    row.issues < 1 ||
    row.current_status !== "critical" ||
    row.lease_token !== null ||
    row.lease_expires_at !== null
  ) {
    throw new Error(`Unexpected URL monitor state: ${JSON.stringify(row)}.`);
  }

  await pool.query(
    `
      UPDATE url_check_snapshots
      SET checked_at = now() - interval '100 days'
      WHERE id = (
        SELECT id
        FROM url_check_snapshots
        WHERE monitored_url_id = $1
        ORDER BY checked_at, id
        LIMIT 1
      )
    `,
    [monitoredUrlId],
  );
  const prune = await pruneUrlMonitorSnapshots(pool);
  if (prune.pruned < 1) {
    throw new Error(`Unexpected prune result: ${JSON.stringify(prune)}.`);
  }

  console.log("URL monitor maintenance integration test passed.");
} finally {
  await cleanup().catch(() => undefined);
  await pool.end();
}
