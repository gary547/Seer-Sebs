import { getAccessToken } from "./auth";
import { SeerApiError, seerApiRequest } from "./api";
import type { LinkPowerInspectorPage } from "./calculations";

export type DomainSort = "meanScore" | "appearances";
export type DomainDirection = "asc" | "desc";
export interface LinkPowerDomainPage {
  completedAt: string | null;
  domains: LinkPowerInspectorPage["domains"];
  runId: string | null;
  total: number;
}

export async function getProjectLinkPowerDomains(
  projectId: string,
  input: { runId: string; sort: DomainSort; direction: DomainDirection; limit: number; offset: number },
): Promise<LinkPowerDomainPage> {
  const token = await getAccessToken();
  if (!token) throw new Error("Authentication is required.");
  const params = new URLSearchParams({ ...input, limit: String(input.limit), offset: String(input.offset) });
  return seerApiRequest(`/v1/projects/${projectId}/link-power-domains?${params}`, {}, token);
}

export async function downloadLinkPowerDomains(
  projectId: string, runId: string, sort: DomainSort, direction: DomainDirection,
): Promise<number> {
  const token = await getAccessToken();
  if (!token) throw new Error("Authentication is required.");
  const params = new URLSearchParams({ runId, sort, direction });
  let result: { csv: string; runId: string; total: number };
  try {
    result = await seerApiRequest(`/v1/projects/${projectId}/link-power-domains-export?${params}`, { signal: AbortSignal.timeout(60000) }, token);
  } catch (error) {
    if (typeof error === "object" && error !== null && "name" in error && ["TimeoutError", "AbortError"].includes(String(error.name))) {
      throw new Error("Domain export timed out. Please retry the download.");
    }
    if (error instanceof TypeError || (error instanceof SeerApiError && error.status >= 500)) {
      throw new Error("Domain export could not be downloaded. Please retry the download.");
    }
    throw error;
  }
  if (result.runId !== runId) throw new Error("Domain results changed. Refresh the benchmark and retry.");
  if (!Number.isSafeInteger(result.total) || result.total < 1 || typeof result.csv !== "string" || !result.csv.length) {
    throw new Error("No complete domain results are available for this export.");
  }

  const url = URL.createObjectURL(new Blob(["\uFEFF", result.csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `seer-link-power-domains-${projectId}-${runId}.csv`;
  try { document.body.appendChild(link); link.click(); }
  finally { link.remove(); URL.revokeObjectURL(url); }
  return result.total;
}
