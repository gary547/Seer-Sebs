function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function verifiedHarNoTargetReason(explanation: unknown): "authority_below_threshold" | "client_only_serp" | null {
  const evidence = record(explanation);
  const reason = record(evidence.no_beat_reason);
  if (reason.reason === "authority_below_threshold") return "authority_below_threshold";
  const inputs = record(evidence.inputs);
  if (reason.reason !== "no_comparable_competitors" || reason.ladder_considered !== 0
    || evidence.serpStatus !== "matched" || inputs.competitor_count !== 0
    || inputs.client_lps_source !== "serp_row"
    || !["ranking_url", "domain_fallback"].includes(String(inputs.client_lps_match))
    || typeof inputs.base_rank !== "number" || !Number.isFinite(inputs.base_rank) || inputs.base_rank < 1
    || typeof inputs.client_resolved_url !== "string" || typeof evidence.clientDomain !== "string") return null;
  try {
    const client = new URL(/^https?:\/\//i.test(evidence.clientDomain)
      ? evidence.clientDomain : `https://${evidence.clientDomain}`);
    const observed = new URL(inputs.client_resolved_url);
    if (!["http:", "https:"].includes(observed.protocol)) return null;
    const domain = client.hostname.replace(/^www\./, "").toLowerCase();
    const host = observed.hostname.replace(/^www\./, "").toLowerCase();
    return domain && (host === domain || host.endsWith(`.${domain}`)) ? "client_only_serp" : null;
  } catch {
    return null;
  }
}
