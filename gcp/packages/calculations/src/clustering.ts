export interface ClusterMember {
  annualVolume: number;
  baseRank: number | null;
  gscClicks: number;
  id: string;
  rankingUrl: string | null;
  text: string;
}

export function clusterKey(value: string): string {
  const normalised = value
    .toLowerCase()
    .replace(/([0-9]+)(inches|inch|in)\b/g, "$1 $2")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!normalised) return "";
  const tokens = normalised.split(/\s+/).map((token) => {
    if (["in", "inch", "inches"].includes(token)) return "inch";
    if (["television", "televisions"].includes(token)) return "tv";
    return token;
  });
  const last = tokens.at(-1);
  if (last && last.length > 1 && last.endsWith("s")) {
    tokens[tokens.length - 1] = last.slice(0, -1);
  }
  return tokens.sort().join(" ");
}

export function pickCanonical(members: ClusterMember[]): {
  basis: "alphabetical" | "base_rank" | "gsc_clicks" | "volume";
  member: ClusterMember;
} {
  if (members.length === 0) throw new Error("Cannot pick an empty cluster.");
  const sortStable = (items: ClusterMember[]): ClusterMember =>
    [...items].sort((left, right) => {
      const leftRank = left.baseRank ?? Number.POSITIVE_INFINITY;
      const rightRank = right.baseRank ?? Number.POSITIVE_INFINITY;
      if (leftRank !== rightRank) return leftRank - rightRank;
      if (left.annualVolume !== right.annualVolume) {
        return right.annualVolume - left.annualVolume;
      }
      return left.text.localeCompare(right.text);
    })[0]!;
  const clicks = Math.max(...members.map((member) => member.gscClicks));
  if (clicks > 0) {
    return {
      basis: "gsc_clicks",
      member: sortStable(
        members.filter((member) => member.gscClicks === clicks),
      ),
    };
  }
  const volume = Math.max(...members.map((member) => member.annualVolume));
  if (volume > 0) {
    return {
      basis: "volume",
      member: sortStable(
        members.filter((member) => member.annualVolume === volume),
      ),
    };
  }
  if (members.some((member) => member.baseRank !== null)) {
    return { basis: "base_rank", member: sortStable(members) };
  }
  return {
    basis: "alphabetical",
    member: [...members].sort((left, right) =>
      left.text.localeCompare(right.text),
    )[0]!,
  };
}
