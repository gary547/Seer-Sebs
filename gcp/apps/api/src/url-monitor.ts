import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import type { PoolClient } from "pg";

import type { DatabasePool } from "../../../packages/runtime/src/database.js";
import { withTransaction } from "../../../packages/runtime/src/database.js";
import { HttpError, requireString } from "../../../packages/runtime/src/http.js";
import type { AuthenticatedUser } from "../../../packages/runtime/src/local-auth.js";
import {
  assertClientAccess,
  getUserRole,
} from "./authorization.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_REDIRECTS = 10;
const FETCH_TIMEOUT_MS = 15_000;

interface UrlSnapshot {
  canonicalUrl: string | null;
  errorMessage: string | null;
  finalUrl: string | null;
  httpStatus: number | null;
  pageTitle: string | null;
  redirectChain: Array<{ status: number; url: string }>;
  responseTimeMs: number;
}

type Resolver = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", "The request body is invalid.");
  }
  return value as Record<string, unknown>;
}

function uuid(value: unknown, field: string): string {
  const candidate = requireString(value, field, 36);
  if (!UUID_PATTERN.test(candidate)) {
    throw new HttpError(400, "invalid_request", `${field} is invalid.`);
  }
  return candidate;
}

function optionalString(
  value: unknown,
  field: string,
  maximumLength: number,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requireString(value, field, maximumLength);
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new HttpError(400, "invalid_request", `${field} is invalid.`);
  }
  return value;
}

function normalizeUrl(value: unknown, field = "url"): string {
  const candidate = requireString(value, field, 4_096);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new HttpError(400, "invalid_url", `${field} must be a valid URL.`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password
  ) {
    throw new HttpError(
      400,
      "invalid_url",
      `${field} must use HTTP or HTTPS without embedded credentials.`,
    );
  }
  parsed.hash = "";
  return parsed.toString();
}

function privateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const first = parts[0] ?? -1;
  const second = parts[1] ?? -1;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function privateIp(address: string): boolean {
  if (isIP(address) === 4) return privateIpv4(address);
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    return privateIpv4(normalized.slice("::ffff:".length));
  }
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
}

export async function assertPublicMonitorUrl(
  value: string,
  resolver: Resolver = lookup,
): Promise<void> {
  const parsed = new URL(value);
  const literalFamily = isIP(parsed.hostname);
  const addresses = literalFamily
    ? [{ address: parsed.hostname, family: literalFamily }]
    : await resolver(parsed.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((item) => privateIp(item.address))) {
    throw new HttpError(
      400,
      "private_network_url",
      "URLs resolving to private or reserved networks cannot be monitored.",
    );
  }
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1]?.trim().slice(0, 500) || null;
}

function extractCanonical(html: string, baseUrl: string): string | null {
  const match =
    html.match(/<link[^>]+rel=["']?canonical["']?[^>]*href=["']([^"']+)["']/i) ??
    html.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']?canonical["']?/i);
  if (!match?.[1]) return null;
  try {
    return new URL(match[1], baseUrl).toString();
  } catch {
    return match[1];
  }
}

export async function fetchUrlSnapshot(
  initialUrl: string,
  fetchImplementation: typeof fetch = fetch,
  resolver: Resolver = lookup,
): Promise<UrlSnapshot> {
  const startedAt = performance.now();
  const redirectChain: Array<{ status: number; url: string }> = [];
  let currentUrl = initialUrl;
  let finalUrl: string | null = initialUrl;
  let html = "";
  let httpStatus: number | null = null;
  let errorMessage: string | null = null;

  try {
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      await assertPublicMonitorUrl(currentUrl, resolver);
      const response = await fetchImplementation(currentUrl, {
        headers: {
          accept: "text/html,*/*;q=0.8",
          "user-agent": "SeerURLMonitor/2.0",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      httpStatus = response.status;
      redirectChain.push({ status: response.status, url: currentUrl });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) break;
        if (redirect === MAX_REDIRECTS) {
          throw new Error("The redirect limit was exceeded.");
        }
        currentUrl = new URL(location, currentUrl).toString();
        await response.body?.cancel();
        continue;
      }
      finalUrl = currentUrl;
      const reader = response.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        let bytesRead = 0;
        while (bytesRead < 65_536) {
          const chunk = await reader.read();
          if (chunk.done) break;
          html += decoder.decode(chunk.value, { stream: true });
          bytesRead += chunk.value.byteLength;
        }
        await reader.cancel().catch(() => undefined);
      }
      break;
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
    finalUrl = null;
  }

  return {
    canonicalUrl: html && finalUrl ? extractCanonical(html, finalUrl) : null,
    errorMessage,
    finalUrl,
    httpStatus,
    pageTitle: html ? extractTitle(html) : null,
    redirectChain,
    responseTimeMs: Math.round(performance.now() - startedAt),
  };
}

async function assertCampaignAccess(
  database: DatabasePool | PoolClient,
  user: AuthenticatedUser,
  campaignId: string,
  write = false,
): Promise<{ client_id: string }> {
  const result = await database.query<{ client_id: string }>(
    `
      SELECT campaign.client_id
      FROM monitor_campaigns AS campaign
      JOIN clients AS client ON client.id = campaign.client_id
      WHERE campaign.id = $1
        AND client.archived_at IS NULL
    `,
    [campaignId],
  );
  const campaign = result.rows[0];
  if (!campaign) {
    throw new HttpError(404, "monitor_campaign_not_found", "Monitoring campaign not found.");
  }
  try {
    await assertClientAccess(database, user.id, campaign.client_id, write);
  } catch (error) {
    if (
      error instanceof HttpError &&
      error.statusCode === 404
    ) {
      throw new HttpError(
        404,
        "monitor_campaign_not_found",
        "Monitoring campaign not found.",
      );
    }
    throw error;
  }
  return campaign;
}

async function assertUrlAccess(
  database: DatabasePool | PoolClient,
  user: AuthenticatedUser,
  monitoredUrlId: string,
  write = false,
): Promise<{ campaign_id: string }> {
  const result = await database.query<{ campaign_id: string }>(
    "SELECT campaign_id FROM monitored_urls WHERE id = $1",
    [monitoredUrlId],
  );
  const monitoredUrl = result.rows[0];
  if (!monitoredUrl) {
    throw new HttpError(404, "monitored_url_not_found", "Monitored URL not found.");
  }
  await assertCampaignAccess(database, user, monitoredUrl.campaign_id, write);
  return monitoredUrl;
}

export async function getUrlMonitorOverview(
  pool: DatabasePool,
  user: AuthenticatedUser,
): Promise<Record<string, unknown>> {
  const role = await getUserRole(pool, user.id);
  const accessParameters = [role, user.id];
  const campaigns = await pool.query(
    `
      SELECT
        campaign.id,
        campaign.name,
        campaign.status,
        campaign.check_frequency,
        campaign.client_id,
        campaign.navigator_project_id,
        client.company_name AS client_name,
        project.project_name
      FROM monitor_campaigns AS campaign
      JOIN clients AS client ON client.id = campaign.client_id
      LEFT JOIN navigator_projects AS project ON project.id = campaign.navigator_project_id
      WHERE client.archived_at IS NULL
        AND (
          $1::text IN ('super_admin', 'admin', 'user')
          OR EXISTS (
            SELECT 1
            FROM user_client_access AS access
            WHERE access.user_id = $2
              AND access.client_id = campaign.client_id
          )
        )
      ORDER BY campaign.created_at DESC, campaign.id
    `,
    accessParameters,
  );
  const urls = await pool.query<{ current_status: string | null }>(
    `
      SELECT monitored_url.current_status
      FROM monitored_urls AS monitored_url
      JOIN monitor_campaigns AS campaign ON campaign.id = monitored_url.campaign_id
      JOIN clients AS client ON client.id = campaign.client_id
      WHERE client.archived_at IS NULL
        AND (
          $1::text IN ('super_admin', 'admin', 'user')
          OR EXISTS (
            SELECT 1
            FROM user_client_access AS access
            WHERE access.user_id = $2
              AND access.client_id = campaign.client_id
          )
        )
    `,
    accessParameters,
  );
  const issues = await pool.query(
    `
      SELECT
        issue.id,
        issue.severity,
        issue.issue_type,
        issue.detected_at,
        issue.previous_value,
        issue.current_value,
        issue.resolved_at,
        monitored_url.id AS monitored_url_id,
        monitored_url.url,
        monitored_url.label,
        campaign.id AS campaign_id,
        campaign.name AS campaign_name,
        client.company_name AS client_name
      FROM url_issues AS issue
      JOIN monitored_urls AS monitored_url ON monitored_url.id = issue.monitored_url_id
      JOIN monitor_campaigns AS campaign ON campaign.id = monitored_url.campaign_id
      JOIN clients AS client ON client.id = campaign.client_id
      WHERE issue.resolved_at IS NULL
        AND client.archived_at IS NULL
        AND (
          $1::text IN ('super_admin', 'admin', 'user')
          OR EXISTS (
            SELECT 1
            FROM user_client_access AS access
            WHERE access.user_id = $2
              AND access.client_id = campaign.client_id
          )
        )
      ORDER BY issue.detected_at DESC, issue.id
      LIMIT 100
    `,
    accessParameters,
  );
  return {
    campaigns: campaigns.rows.map((campaign) => ({
      ...campaign,
      clients: { company_name: campaign.client_name },
      navigator_projects: campaign.project_name
        ? { project_name: campaign.project_name }
        : null,
    })),
    issues: issues.rows.map((issue) => ({
      id: issue.id,
      severity: issue.severity,
      issue_type: issue.issue_type,
      detected_at: issue.detected_at,
      previous_value: issue.previous_value,
      current_value: issue.current_value,
      resolved_at: issue.resolved_at,
      monitored_url: {
        id: issue.monitored_url_id,
        url: issue.url,
        label: issue.label,
        campaign: {
          id: issue.campaign_id,
          name: issue.campaign_name,
          client: { company_name: issue.client_name },
        },
      },
    })),
    kpis: {
      campaigns: campaigns.rowCount ?? 0,
      urls: urls.rowCount ?? 0,
      critical: urls.rows.filter((row) => row.current_status === "critical").length,
      warning: urls.rows.filter((row) => row.current_status === "warning").length,
      good: urls.rows.filter((row) => row.current_status === "ok").length,
    },
  };
}

export async function createMonitorCampaign(
  pool: DatabasePool,
  user: AuthenticatedUser,
  body: unknown,
): Promise<Record<string, unknown>> {
  const input = record(body);
  const clientId = uuid(input.clientId, "clientId");
  await assertClientAccess(pool, user.id, clientId, true);
  const projectId =
    input.projectId === null || input.projectId === undefined || input.projectId === ""
      ? null
      : uuid(input.projectId, "projectId");
  if (projectId) {
    const project = await pool.query(
      `
        SELECT 1
        FROM navigator_projects
        WHERE id = $1
          AND client_id = $2
          AND archived_at IS NULL
      `,
      [projectId, clientId],
    );
    if (project.rowCount !== 1) {
      throw new HttpError(400, "invalid_project", "The selected project is invalid.");
    }
  }
  const name = requireString(input.name, "name", 200);
  const description = optionalString(input.description, "description", 5_000);
  const owner = optionalString(input.owner, "owner", 300);
  const checkFrequency = optionalString(
    input.checkFrequency,
    "checkFrequency",
    3,
  ) ?? "24h";
  if (!new Set(["1h", "6h", "24h"]).has(checkFrequency)) {
    throw new HttpError(400, "invalid_request", "checkFrequency is invalid.");
  }
  const dailyCheckTime =
    optionalString(input.dailyCheckTime, "dailyCheckTime", 5) ?? "07:00";
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(dailyCheckTime)) {
    throw new HttpError(400, "invalid_request", "dailyCheckTime is invalid.");
  }
  const id = randomUUID();
  try {
    await withTransaction(pool, async (client) => {
      await client.query(
        `
          INSERT INTO monitor_campaigns (
            id,
            client_id,
            navigator_project_id,
            name,
            description,
            owner,
            check_frequency,
            daily_check_time,
            created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::time, $9)
        `,
        [
          id,
          clientId,
          projectId,
          name,
          description,
          owner,
          checkFrequency,
          dailyCheckTime,
          user.id,
        ],
      );
      await client.query(
        "INSERT INTO monitor_alert_settings (campaign_id) VALUES ($1)",
        [id],
      );
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "23505"
    ) {
      throw new HttpError(
        409,
        "monitor_campaign_conflict",
        "A monitoring campaign with this name already exists for the client.",
      );
    }
    throw error;
  }
  return getMonitorCampaign(pool, user, id);
}

export async function getMonitorCampaign(
  pool: DatabasePool,
  user: AuthenticatedUser,
  campaignId: string,
): Promise<Record<string, unknown>> {
  await assertCampaignAccess(pool, user, campaignId);
  const [campaign, urls, alerts] = await Promise.all([
    pool.query(
      `
        SELECT
          campaign.*,
          client.company_name AS client_name,
          client.logo_url AS client_logo_url,
          project.project_name
        FROM monitor_campaigns AS campaign
        JOIN clients AS client ON client.id = campaign.client_id
        LEFT JOIN navigator_projects AS project ON project.id = campaign.navigator_project_id
        WHERE campaign.id = $1
      `,
      [campaignId],
    ),
    pool.query(
      `
        SELECT
          id, url, label, notes, is_active, current_status,
          current_http_status, last_checked_at, next_check_at, created_at
        FROM monitored_urls
        WHERE campaign_id = $1
        ORDER BY created_at DESC, id
      `,
      [campaignId],
    ),
    pool.query(
      `
        SELECT
          campaign_id, alert_on_critical, alert_on_warning,
          alert_on_watch, weekly_summary, weekly_summary_day
        FROM monitor_alert_settings
        WHERE campaign_id = $1
      `,
      [campaignId],
    ),
  ]);
  const row = campaign.rows[0];
  return {
    campaign: {
      ...row,
      clients: {
        company_name: row.client_name,
        logo_url: row.client_logo_url,
      },
      navigator_projects: row.project_name
        ? { project_name: row.project_name }
        : null,
    },
    urls: urls.rows,
    alertSettings: alerts.rows[0] ?? null,
  };
}

export async function updateMonitorCampaign(
  pool: DatabasePool,
  user: AuthenticatedUser,
  campaignId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  await assertCampaignAccess(pool, user, campaignId, true);
  const input = record(body);
  const allowedKeys = new Set([
    "checkFrequency",
    "dailyCheckTime",
    "description",
    "name",
    "owner",
    "status",
  ]);
  if (
    Object.keys(input).length === 0 ||
    Object.keys(input).some((key) => !allowedKeys.has(key))
  ) {
    throw new HttpError(400, "invalid_request", "No valid campaign fields were provided.");
  }
  const current = await pool.query(
    "SELECT * FROM monitor_campaigns WHERE id = $1",
    [campaignId],
  );
  const campaign = current.rows[0];
  const status =
    input.status === undefined
      ? campaign.status
      : requireString(input.status, "status", 16);
  const checkFrequency =
    input.checkFrequency === undefined
      ? campaign.check_frequency
      : requireString(input.checkFrequency, "checkFrequency", 3);
  if (!new Set(["active", "archived", "paused"]).has(status)) {
    throw new HttpError(400, "invalid_request", "status is invalid.");
  }
  if (!new Set(["1h", "6h", "24h"]).has(checkFrequency)) {
    throw new HttpError(400, "invalid_request", "checkFrequency is invalid.");
  }
  const dailyCheckTime =
    input.dailyCheckTime === undefined
      ? String(campaign.daily_check_time).slice(0, 5)
      : requireString(input.dailyCheckTime, "dailyCheckTime", 5);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(dailyCheckTime)) {
    throw new HttpError(400, "invalid_request", "dailyCheckTime is invalid.");
  }
  await pool.query(
    `
      UPDATE monitor_campaigns
      SET
        name = $2,
        description = $3,
        owner = $4,
        status = $5,
        check_frequency = $6,
        daily_check_time = $7::time,
        updated_at = now()
      WHERE id = $1
    `,
    [
      campaignId,
      input.name === undefined
        ? campaign.name
        : requireString(input.name, "name", 200),
      input.description === undefined
        ? campaign.description
        : optionalString(input.description, "description", 5_000),
      input.owner === undefined
        ? campaign.owner
        : optionalString(input.owner, "owner", 300),
      status,
      checkFrequency,
      dailyCheckTime,
    ],
  );
  return getMonitorCampaign(pool, user, campaignId);
}

export async function addMonitoredUrls(
  pool: DatabasePool,
  user: AuthenticatedUser,
  campaignId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  await assertCampaignAccess(pool, user, campaignId, true);
  const input = record(body);
  if (!Array.isArray(input.urls) || input.urls.length === 0 || input.urls.length > 5_000) {
    throw new HttpError(400, "invalid_request", "urls is invalid.");
  }
  const normalized = new Map<
    string,
    { label: string | null; notes: string | null; url: string }
  >();
  let invalid = 0;
  for (const [index, item] of input.urls.entries()) {
    try {
      const urlInput = record(item);
      const url = normalizeUrl(urlInput.url, `urls[${index}].url`);
      normalized.set(url.toLowerCase(), {
        label: optionalString(urlInput.label, `urls[${index}].label`, 500),
        notes: optionalString(urlInput.notes, `urls[${index}].notes`, 5_000),
        url,
      });
    } catch (error) {
      if (error instanceof HttpError) {
        invalid += 1;
        continue;
      }
      throw error;
    }
  }
  let added = 0;
  await withTransaction(pool, async (client) => {
    for (const item of normalized.values()) {
      const result = await client.query(
        `
          INSERT INTO monitored_urls (
            id, campaign_id, url, normalized_url, label, notes, created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (campaign_id, normalized_url) DO NOTHING
          RETURNING id
        `,
        [
          randomUUID(),
          campaignId,
          item.url,
          item.url.toLowerCase(),
          item.label,
          item.notes,
          user.id,
        ],
      );
      added += result.rowCount ?? 0;
    }
  });
  return {
    added,
    duplicates: input.urls.length - invalid - added,
    invalid,
    submitted: input.urls.length,
  };
}

export async function deleteMonitoredUrl(
  pool: DatabasePool,
  user: AuthenticatedUser,
  monitoredUrlId: string,
): Promise<Record<string, unknown>> {
  await assertUrlAccess(pool, user, monitoredUrlId, true);
  await pool.query("DELETE FROM monitored_urls WHERE id = $1", [monitoredUrlId]);
  return { id: monitoredUrlId };
}

export async function updateMonitorAlerts(
  pool: DatabasePool,
  user: AuthenticatedUser,
  campaignId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  await assertCampaignAccess(pool, user, campaignId, true);
  const input = record(body);
  const current = await pool.query(
    "SELECT * FROM monitor_alert_settings WHERE campaign_id = $1",
    [campaignId],
  );
  const alerts = current.rows[0];
  if (!alerts) {
    throw new HttpError(404, "monitor_alerts_not_found", "Alert settings not found.");
  }
  const next = {
    alertOnCritical:
      input.alertOnCritical === undefined
        ? alerts.alert_on_critical
        : booleanValue(input.alertOnCritical, "alertOnCritical"),
    alertOnWarning:
      input.alertOnWarning === undefined
        ? alerts.alert_on_warning
        : booleanValue(input.alertOnWarning, "alertOnWarning"),
    alertOnWatch:
      input.alertOnWatch === undefined
        ? alerts.alert_on_watch
        : booleanValue(input.alertOnWatch, "alertOnWatch"),
    weeklySummary:
      input.weeklySummary === undefined
        ? alerts.weekly_summary
        : booleanValue(input.weeklySummary, "weeklySummary"),
  };
  const result = await pool.query(
    `
      UPDATE monitor_alert_settings
      SET
        alert_on_critical = $2,
        alert_on_warning = $3,
        alert_on_watch = $4,
        weekly_summary = $5,
        updated_at = now()
      WHERE campaign_id = $1
      RETURNING
        campaign_id, alert_on_critical, alert_on_warning,
        alert_on_watch, weekly_summary, weekly_summary_day
    `,
    [
      campaignId,
      next.alertOnCritical,
      next.alertOnWarning,
      next.alertOnWatch,
      next.weeklySummary,
    ],
  );
  return result.rows[0];
}

export async function resolveMonitorIssue(
  pool: DatabasePool,
  user: AuthenticatedUser,
  issueId: string,
): Promise<Record<string, unknown>> {
  const result = await pool.query<{ campaign_id: string }>(
    `
      SELECT monitored_url.campaign_id
      FROM url_issues AS issue
      JOIN monitored_urls AS monitored_url ON monitored_url.id = issue.monitored_url_id
      WHERE issue.id = $1
    `,
    [issueId],
  );
  const issue = result.rows[0];
  if (!issue) {
    throw new HttpError(404, "monitor_issue_not_found", "Monitoring issue not found.");
  }
  await assertCampaignAccess(pool, user, issue.campaign_id, true);
  const updated = await pool.query(
    `
      UPDATE url_issues
      SET resolved_at = COALESCE(resolved_at, now())
      WHERE id = $1
      RETURNING *
    `,
    [issueId],
  );
  return updated.rows[0];
}

export async function getMonitorCampaignHistory(
  pool: DatabasePool,
  user: AuthenticatedUser,
  campaignId: string,
  daysValue: string | null,
): Promise<Record<string, unknown>> {
  await assertCampaignAccess(pool, user, campaignId);
  const parsedDays = daysValue === null ? 90 : Number(daysValue);
  if (!Number.isInteger(parsedDays) || parsedDays < 1 || parsedDays > 365) {
    throw new HttpError(400, "invalid_request", "days is invalid.");
  }
  const [snapshots, issues, urls] = await Promise.all([
    pool.query(
      `
        SELECT snapshot.*
        FROM url_check_snapshots AS snapshot
        JOIN monitored_urls AS monitored_url ON monitored_url.id = snapshot.monitored_url_id
        WHERE monitored_url.campaign_id = $1
          AND snapshot.checked_at >= now() - ($2::text || ' days')::interval
        ORDER BY snapshot.checked_at ASC, snapshot.id
        LIMIT 10000
      `,
      [campaignId, parsedDays],
    ),
    pool.query(
      `
        SELECT issue.*
        FROM url_issues AS issue
        JOIN monitored_urls AS monitored_url ON monitored_url.id = issue.monitored_url_id
        WHERE monitored_url.campaign_id = $1
          AND issue.detected_at >= now() - ($2::text || ' days')::interval
        ORDER BY issue.detected_at DESC, issue.id
        LIMIT 10000
      `,
      [campaignId, parsedDays],
    ),
    pool.query(
      `
        SELECT id, is_active, last_checked_at, next_check_at
        FROM monitored_urls
        WHERE campaign_id = $1
        ORDER BY created_at, id
      `,
      [campaignId],
    ),
  ]);
  return { snapshots: snapshots.rows, issues: issues.rows, urls: urls.rows };
}

export async function getMonitoredUrlHistory(
  pool: DatabasePool,
  user: AuthenticatedUser,
  monitoredUrlId: string,
): Promise<Record<string, unknown>> {
  await assertUrlAccess(pool, user, monitoredUrlId);
  const [snapshots, issues] = await Promise.all([
    pool.query(
      `
        SELECT *
        FROM url_check_snapshots
        WHERE monitored_url_id = $1
        ORDER BY checked_at DESC, id
        LIMIT 50
      `,
      [monitoredUrlId],
    ),
    pool.query(
      `
        SELECT *
        FROM url_issues
        WHERE monitored_url_id = $1
        ORDER BY detected_at DESC, id
        LIMIT 50
      `,
      [monitoredUrlId],
    ),
  ]);
  return { snapshots: snapshots.rows, issues: issues.rows };
}

export function nextCheckAt(
  frequency: string,
  dailyTime: string,
  now = new Date(),
): Date {
  if (frequency === "1h") return new Date(now.getTime() + 60 * 60_000);
  if (frequency === "6h") return new Date(now.getTime() + 6 * 60 * 60_000);
  const [hour = 7, minute = 0] = dailyTime.split(":").map(Number);
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone: "Europe/London",
    year: "numeric",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const wallNow = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour === "24" ? "0" : values.hour),
    Number(values.minute),
    Number(values.second),
  );
  const utcOffset = now.getTime() - wallNow;
  let wallTarget = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    hour,
    minute,
  );
  if (wallTarget <= wallNow) wallTarget += 24 * 60 * 60_000;
  return new Date(wallTarget + utcOffset);
}

async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await operation(items[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function runDueUrlMonitorChecks(
  pool: DatabasePool,
  options: {
    campaignId?: string;
    fetchImplementation?: typeof fetch;
    limit?: number;
    now?: Date;
    resolver?: Resolver;
  } = {},
): Promise<Record<string, unknown>> {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new HttpError(400, "invalid_request", "limit is invalid.");
  }
  if (options.campaignId && !UUID_PATTERN.test(options.campaignId)) {
    throw new HttpError(400, "invalid_request", "campaignId is invalid.");
  }
  const leaseToken = randomUUID();
  const claimed = await pool.query<{
    check_frequency: string;
    daily_check_time: string;
    id: string;
    url: string;
  }>(
    `
      WITH due AS (
        SELECT monitored_url.id
        FROM monitored_urls AS monitored_url
        JOIN monitor_campaigns AS campaign
          ON campaign.id = monitored_url.campaign_id
        WHERE monitored_url.is_active
          AND campaign.status = 'active'
          AND monitored_url.next_check_at <= now()
          AND ($3::uuid IS NULL OR monitored_url.campaign_id = $3)
          AND (
            monitored_url.lease_expires_at IS NULL
            OR monitored_url.lease_expires_at <= now()
          )
        ORDER BY monitored_url.next_check_at, monitored_url.id
        FOR UPDATE OF monitored_url SKIP LOCKED
        LIMIT $1
      ),
      leased AS (
        UPDATE monitored_urls AS monitored_url
        SET
          lease_token = $2,
          lease_expires_at = now() + interval '20 minutes'
        FROM due
        WHERE monitored_url.id = due.id
        RETURNING monitored_url.id, monitored_url.campaign_id, monitored_url.url
      )
      SELECT
        leased.id,
        leased.url,
        campaign.check_frequency,
        campaign.daily_check_time::text
      FROM leased
      JOIN monitor_campaigns AS campaign ON campaign.id = leased.campaign_id
      ORDER BY leased.id
    `,
    [limit, leaseToken, options.campaignId ?? null],
  );
  const now = options.now ?? new Date();
  const results = await runWithConcurrency(
    claimed.rows,
    5,
    async (monitoredUrl) => {
      const snapshot = await fetchUrlSnapshot(
        monitoredUrl.url,
        options.fetchImplementation ?? fetch,
        options.resolver ?? lookup,
      );
      const stored = await withTransaction(pool, async (client) => {
        const owned = await client.query(
          `
            SELECT 1
            FROM monitored_urls
            WHERE id = $1
              AND lease_token = $2
            FOR UPDATE
          `,
          [monitoredUrl.id, leaseToken],
        );
        if ((owned.rowCount ?? 0) === 0) return false;
        await client.query(
          `
            INSERT INTO url_check_snapshots (
              id,
              monitored_url_id,
              http_status,
              final_url,
              redirect_chain,
              page_title,
              canonical_url,
              response_time_ms,
              error_message
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `,
          [
            randomUUID(),
            monitoredUrl.id,
            snapshot.httpStatus,
            snapshot.finalUrl,
            JSON.stringify(snapshot.redirectChain),
            snapshot.pageTitle,
            snapshot.canonicalUrl,
            snapshot.responseTimeMs,
            snapshot.errorMessage,
          ],
        );
        await client.query(
          `
            UPDATE monitored_urls
            SET
              next_check_at = $3,
              lease_token = NULL,
              lease_expires_at = NULL
            WHERE id = $1
              AND lease_token = $2
          `,
          [
            monitoredUrl.id,
            leaseToken,
            nextCheckAt(
              monitoredUrl.check_frequency,
              monitoredUrl.daily_check_time,
              now,
            ),
          ],
        );
        return true;
      });
      return {
        error: snapshot.errorMessage,
        status: snapshot.httpStatus,
        stored,
        url: monitoredUrl.url,
      };
    },
  );
  return {
    checked: results.filter((result) => result.stored).length,
    claimed: claimed.rowCount ?? 0,
    results,
  };
}

export async function pruneUrlMonitorSnapshots(
  pool: DatabasePool,
  retentionDays = 90,
): Promise<Record<string, unknown>> {
  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < 30 ||
    retentionDays > 3_650
  ) {
    throw new HttpError(
      400,
      "invalid_request",
      "retentionDays is invalid.",
    );
  }
  const result = await pool.query(
    `
      DELETE FROM url_check_snapshots
      WHERE checked_at < now() - ($1::text || ' days')::interval
    `,
    [retentionDays],
  );
  return { pruned: result.rowCount ?? 0, retentionDays };
}

export async function runMonitorCampaign(
  pool: DatabasePool,
  user: AuthenticatedUser,
  campaignId: string,
): Promise<Record<string, unknown>> {
  await assertCampaignAccess(pool, user, campaignId, true);
  const result = await pool.query<{
    check_frequency: string;
    daily_check_time: string;
    id: string;
    url: string;
  }>(
    `
      SELECT
        monitored_url.id,
        monitored_url.url,
        campaign.check_frequency,
        campaign.daily_check_time::text
      FROM monitored_urls AS monitored_url
      JOIN monitor_campaigns AS campaign ON campaign.id = monitored_url.campaign_id
      WHERE monitored_url.campaign_id = $1
        AND monitored_url.is_active
        AND campaign.status = 'active'
      ORDER BY monitored_url.id
      LIMIT 500
    `,
    [campaignId],
  );
  const checks: Array<Record<string, unknown>> = [];
  for (const monitoredUrl of result.rows) {
    const snapshot = await fetchUrlSnapshot(monitoredUrl.url);
    await withTransaction(pool, async (client) => {
      await client.query(
        `
          INSERT INTO url_check_snapshots (
            id,
            monitored_url_id,
            http_status,
            final_url,
            redirect_chain,
            page_title,
            canonical_url,
            response_time_ms,
            error_message
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `,
        [
          randomUUID(),
          monitoredUrl.id,
          snapshot.httpStatus,
          snapshot.finalUrl,
          JSON.stringify(snapshot.redirectChain),
          snapshot.pageTitle,
          snapshot.canonicalUrl,
          snapshot.responseTimeMs,
          snapshot.errorMessage,
        ],
      );
      await client.query(
        "UPDATE monitored_urls SET next_check_at = $2 WHERE id = $1",
        [
          monitoredUrl.id,
          nextCheckAt(
            monitoredUrl.check_frequency,
            monitoredUrl.daily_check_time,
          ),
        ],
      );
    });
    checks.push({
      error: snapshot.errorMessage,
      status: snapshot.httpStatus,
      url: monitoredUrl.url,
    });
  }
  return { checked: checks.length, results: checks };
}
