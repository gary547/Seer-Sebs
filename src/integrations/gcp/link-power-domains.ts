import { getAccessToken } from "./auth";
import { seerApiRequest } from "./api";
import { calculationCsvCell } from "./calculation-export";
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
  const lines = [["Domain", "Mean LPS", "Best rank", "Appearances", "Client domain"].map(calculationCsvCell).join(",")];
  let offset = 0;
  let total: number | undefined;
  do {
    const page = await getProjectLinkPowerDomains(projectId, { runId, sort, direction, limit: 200, offset });
    if (page.runId !== runId || (total !== undefined && page.total !== total)) {
      throw new Error("Domain results changed. Refresh the benchmark and retry.");
    }
    total = page.total;
    if (!page.domains.length) throw new Error("No domain results are available for this export.");
    for (const domain of page.domains) {
      lines.push([domain.domain, domain.meanScore, domain.bestRank, domain.appearances, domain.isClientDomain ? "Yes" : "No"].map(calculationCsvCell).join(","));
    }
    offset += page.domains.length;
  } while (offset < total);

  const url = URL.createObjectURL(new Blob(["\uFEFF", lines.join("\r\n")], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `seer-link-power-domains-${projectId}-${runId}.csv`;
  document.body.appendChild(link); link.click(); link.remove();
  URL.revokeObjectURL(url);
  return offset;
}
