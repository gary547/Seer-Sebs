import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ArrowUp, ArrowDown, ChevronsUpDown } from "lucide-react";
import {
  listAllProjectKeywords,
} from "@/integrations/gcp/project-data";

interface Props {
  projectId: string;
}

type SortField = "text" | "rankingUrl" | "baseRank" | "searchIntent" | "avgMonthlyVolume";
type SortDir = "asc" | "desc";

export default function RankingUrlResults({ projectId }: Props) {
  const [sortField, setSortField] = useState<SortField>("baseRank");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["ranking_url_results", projectId],
    queryFn: () =>
      listAllProjectKeywords(projectId, {
        detoxStatus: "keep",
        rankingUrlOnly: true,
      }),
    refetchInterval: 15000,
  });

  if (isLoading) {
    return <p className="text-sm text-muted-foreground py-2">Loading results…</p>;
  }

  if (!rows.length) return null;

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  const sorted = [...rows].sort((a, b) => {
    const av = a[sortField];
    const bv = b[sortField];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "number" && typeof bv === "number") {
      return sortDir === "asc" ? av - bv : bv - av;
    }
    const cmp = String(av).localeCompare(String(bv), undefined, { sensitivity: "base" });
    return sortDir === "asc" ? cmp : -cmp;
  });

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ChevronsUpDown className="h-3 w-3 opacity-40" />;
    return sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
  };

  const headerClass = "cursor-pointer select-none hover:text-foreground transition-colors";

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium text-muted-foreground">{rows.length} keywords with ranking URLs</h4>
      <div className="rounded-md border max-h-[500px] overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className={headerClass} onClick={() => toggleSort("text")}>
                <span className="flex items-center gap-1">Keyword <SortIcon field="text" /></span>
              </TableHead>
              <TableHead className={headerClass} onClick={() => toggleSort("rankingUrl")}>
                <span className="flex items-center gap-1">Ranking URL <SortIcon field="rankingUrl" /></span>
              </TableHead>
              <TableHead className={`${headerClass} text-right`} onClick={() => toggleSort("baseRank")}>
                <span className="flex items-center gap-1 justify-end">Position <SortIcon field="baseRank" /></span>
              </TableHead>
              <TableHead className={headerClass} onClick={() => toggleSort("searchIntent")}>
                <span className="flex items-center gap-1">Intent <SortIcon field="searchIntent" /></span>
              </TableHead>
              <TableHead className={`${headerClass} text-right`} onClick={() => toggleSort("avgMonthlyVolume")}>
                <span className="flex items-center gap-1 justify-end">Volume <SortIcon field="avgMonthlyVolume" /></span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-medium text-sm max-w-[200px] truncate">{row.text}</TableCell>
                <TableCell className="text-sm text-muted-foreground max-w-[300px] truncate" title={row.rankingUrl ?? ""}>
                  {row.rankingUrl}
                </TableCell>
                <TableCell className="text-sm text-right tabular-nums">{row.baseRank ?? "—"}</TableCell>
                <TableCell className="text-sm capitalize">{row.searchIntent ?? "—"}</TableCell>
                <TableCell className="text-sm text-right tabular-nums">
                  {row.avgMonthlyVolume != null ? row.avgMonthlyVolume.toLocaleString() : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
