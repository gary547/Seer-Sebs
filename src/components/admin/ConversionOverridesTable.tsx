import { format } from "date-fns";
import { Pencil, Trash2 } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ConversionOverrideWithActor } from "@/hooks/useConversionOverrides";

type Props = {
  rows: ConversionOverrideWithActor[];
  canWrite: boolean;
  onEdit: (row: ConversionOverrideWithActor) => void;
  onDelete: (row: ConversionOverrideWithActor) => void;
};

function fmtPct(dec: number | null): string {
  if (dec == null) return "—";
  return `${(dec * 100).toFixed(2)}%`;
}
function fmtNum(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function fmtDate(iso: string): string {
  try {
    return format(new Date(iso), "dd MMM yyyy, HH:mm");
  } catch {
    return iso;
  }
}

export default function ConversionOverridesTable({ rows, canWrite, onEdit, onDelete }: Props) {
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed py-10 text-center text-sm text-muted-foreground">
        No conversion overrides yet.
      </div>
    );
  }
  return (
    <div className="rounded-md border overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[110px]">Scope</TableHead>
            <TableHead>Value</TableHead>
            <TableHead className="w-[100px]">CVR</TableHead>
            <TableHead className="w-[120px]">AOV</TableHead>
            <TableHead className="w-[110px]">Confidence</TableHead>
            <TableHead>Note</TableHead>
            <TableHead className="w-[220px]">Updated</TableHead>
            {canWrite && <TableHead className="w-[100px] text-right">Actions</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell>
                <Badge variant="outline" className="capitalize">
                  {r.scope_type}
                </Badge>
              </TableCell>
              <TableCell className="font-mono text-xs break-all">
                {r.scope_type === "project" ? (
                  <span className="text-muted-foreground">Project-wide</span>
                ) : (
                  r.scope_value ?? "—"
                )}
              </TableCell>
              <TableCell>{fmtPct(r.conversion_rate)}</TableCell>
              <TableCell>{fmtNum(r.average_order_value)}</TableCell>
              <TableCell>
                <Badge
                  variant={
                    r.confidence === "high"
                      ? "default"
                      : r.confidence === "low"
                        ? "destructive"
                        : "secondary"
                  }
                  className="capitalize"
                >
                  {r.confidence}
                </Badge>
              </TableCell>
              <TableCell className="text-xs max-w-[280px]">
                {r.note ? (
                  <span className="line-clamp-3 whitespace-pre-wrap">{r.note}</span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                <div>{fmtDate(r.updated_at)}</div>
                {r.updated_by_email && <div className="truncate">{r.updated_by_email}</div>}
              </TableCell>
              {canWrite && (
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button size="icon" variant="ghost" onClick={() => onEdit(r)} title="Edit">
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => onDelete(r)}
                      title="Delete"
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
