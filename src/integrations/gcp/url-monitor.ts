import { getAccessToken } from "./auth";
import { seerApiRequest } from "./api";

export interface MonitorCampaign {
  check_frequency: string;
  client_id: string;
  clients: { company_name: string; logo_url?: string | null } | null;
  daily_check_time: string;
  description: string | null;
  id: string;
  name: string;
  navigator_project_id: string | null;
  navigator_projects: { project_name: string } | null;
  owner: string | null;
  status: string;
}

export interface MonitoredUrl {
  created_at: string;
  current_http_status: number | null;
  current_status: string | null;
  id: string;
  is_active: boolean;
  label: string | null;
  last_checked_at: string | null;
  next_check_at: string;
  notes: string | null;
  url: string;
}

export interface UrlMonitorSnapshot {
  canonical_url: string | null;
  checked_at: string;
  error_message: string | null;
  final_url: string | null;
  http_status: number | null;
  id: string;
  monitored_url_id: string;
  page_title: string | null;
  redirect_chain: Array<{ status: number; url: string }>;
  response_time_ms: number | null;
}

export interface UrlMonitorIssue {
  current_value: string | null;
  detected_at: string;
  id: string;
  issue_type: string;
  monitored_url_id: string;
  previous_value: string | null;
  resolved_at: string | null;
  severity: string;
  snapshot_id: string;
}

export interface MonitorAlertSettings {
  alert_on_critical: boolean;
  alert_on_warning: boolean;
  alert_on_watch: boolean;
  campaign_id: string;
  weekly_summary: boolean;
  weekly_summary_day: number;
}

export interface MonitorCampaignDetail {
  alertSettings: MonitorAlertSettings | null;
  campaign: MonitorCampaign;
  urls: MonitoredUrl[];
}

export interface UrlMonitorOverview {
  campaigns: MonitorCampaign[];
  issues: Array<
    UrlMonitorIssue & {
      monitored_url: {
        campaign: {
          client: { company_name: string } | null;
          id: string;
          name: string;
        } | null;
        id: string;
        label: string | null;
        url: string;
      } | null;
    }
  >;
  kpis: {
    campaigns: number;
    critical: number;
    good: number;
    urls: number;
    warning: number;
  };
}

export interface MonitorCampaignHistory {
  issues: UrlMonitorIssue[];
  snapshots: UrlMonitorSnapshot[];
  urls: Array<{
    id: string;
    is_active: boolean;
    last_checked_at: string | null;
    next_check_at: string;
  }>;
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new Error("Authentication is required.");
  return seerApiRequest<T>(path, options, token);
}

export function getUrlMonitorOverview(): Promise<UrlMonitorOverview> {
  return request("/v1/url-monitor/overview");
}

export function createMonitorCampaign(input: {
  checkFrequency: string;
  clientId: string;
  dailyCheckTime: string;
  description: string | null;
  name: string;
  owner: string | null;
  projectId: string | null;
}): Promise<MonitorCampaignDetail> {
  return request("/v1/url-monitor/campaigns", {
    body: JSON.stringify(input),
    method: "POST",
  });
}

export function getMonitorCampaign(
  campaignId: string,
): Promise<MonitorCampaignDetail> {
  return request(`/v1/url-monitor/campaigns/${campaignId}`);
}

export function updateMonitorCampaign(
  campaignId: string,
  input: {
    checkFrequency?: string;
    dailyCheckTime?: string;
    description?: string | null;
    name?: string;
    owner?: string | null;
    status?: string;
  },
): Promise<MonitorCampaignDetail> {
  return request(`/v1/url-monitor/campaigns/${campaignId}`, {
    body: JSON.stringify(input),
    method: "PATCH",
  });
}

export function addMonitoredUrls(
  campaignId: string,
  urls: Array<{ label?: string; notes?: string; url: string }>,
): Promise<{
  added: number;
  duplicates: number;
  invalid: number;
  submitted: number;
}> {
  return request(`/v1/url-monitor/campaigns/${campaignId}/urls`, {
    body: JSON.stringify({ urls }),
    method: "POST",
  });
}

export function deleteMonitoredUrl(monitoredUrlId: string): Promise<void> {
  return request(`/v1/url-monitor/urls/${monitoredUrlId}`, {
    method: "DELETE",
  });
}

export function getMonitorCampaignHistory(
  campaignId: string,
  days = 90,
): Promise<MonitorCampaignHistory> {
  return request(
    `/v1/url-monitor/campaigns/${campaignId}/history?days=${days}`,
  );
}

export function getMonitoredUrlHistory(
  monitoredUrlId: string,
): Promise<{
  issues: UrlMonitorIssue[];
  snapshots: UrlMonitorSnapshot[];
}> {
  return request(`/v1/url-monitor/urls/${monitoredUrlId}/history`);
}

export function updateMonitorAlerts(
  campaignId: string,
  input: {
    alertOnCritical?: boolean;
    alertOnWarning?: boolean;
    alertOnWatch?: boolean;
    weeklySummary?: boolean;
  },
): Promise<MonitorAlertSettings> {
  return request(`/v1/url-monitor/campaigns/${campaignId}/alerts`, {
    body: JSON.stringify(input),
    method: "PATCH",
  });
}

export function resolveMonitorIssue(issueId: string): Promise<UrlMonitorIssue> {
  return request(`/v1/url-monitor/issues/${issueId}/resolve`, {
    method: "PATCH",
  });
}

export function runMonitorCampaign(
  campaignId: string,
): Promise<{
  checked: number;
  results: Array<{ error: string | null; status: number | null; url: string }>;
}> {
  return request(`/v1/url-monitor/campaigns/${campaignId}/run`, {
    method: "POST",
  });
}
