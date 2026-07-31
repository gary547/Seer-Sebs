import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  applyCategoryConsolidation,
  getLastCategoryBatch,
  previewCategoryConsolidation,
  undoCategoryConsolidation,
} from "@/integrations/gcp/admin-reference";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Loader2, Tags, Undo2, Eye, CheckCircle2, Trash2, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { Navigate } from "react-router";
import { Shimmer } from "@/components/ui/shimmer";
import { useClients } from "@/hooks/useClients";

/**
 * Admin Categories — Tag 1 consolidation tool.
 *
 * Operator picks a client, previews the proposed mapping with
 * exact row counts, then Apply commits the rename inside an audited
 * transaction. Undo replays the most recent batch in reverse.
 *
 * This screen never touches forecast math, CTR curves, HAR, revenue, or
 * opportunity tagging — it only renames category labels.
 */

type DistinctTag = { tag: string; count: number };
type Mapping = Record<string, string | null>;
type PreviewResponse = {
  distinctTags: DistinctTag[];
  nullCount: number;
  mapping: Mapping;
  totalAffected: number;
  intentMerges: number;
  aiRenames: number;
  normalizedRenames?: number;
  message?: string;
};

export default function CategoriesPage() {
  const { canManageUsers } = useAuth();
  const queryClient = useQueryClient();
  const [selectedClient, setSelectedClient] = useState<string>("");
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [undoOpen, setUndoOpen] = useState(false);
  const [undoing, setUndoing] = useState(false);

  const { clients, isLoading: clientsLoading } = useClients(canManageUsers);

  // Last consolidate batch for this client (drives Undo affordance)
  const { data: lastBatch } = useQuery({
    queryKey: ["consolidate_last_batch", selectedClient],
    queryFn: () =>
      getLastCategoryBatch(selectedClient).then((result) => result.batch),
    enabled: !!selectedClient,
  });

  if (!canManageUsers) return <Navigate to="/dashboard" replace />;

  const runPreview = async () => {
    if (!selectedClient) return;
    setPreviewing(true);
    setPreview(null);
    try {
      setPreview(await previewCategoryConsolidation(selectedClient));
    } catch (err: any) {
      toast.error("Preview failed", { description: err.message });
    } finally {
      setPreviewing(false);
    }
  };

  const runApply = async () => {
    if (!preview || !selectedClient) return;
    setApplying(true);
    setConfirmOpen(false);
    try {
      const data = await applyCategoryConsolidation(
        selectedClient,
        preview.mapping,
      );
      toast.success("Consolidation applied", {
        description: `${data.applied} keywords updated. Forecasts and revenue numbers are unchanged.`,
      });
      setPreview(null);
      queryClient.invalidateQueries({ queryKey: ["consolidate_last_batch", selectedClient] });
    } catch (err: any) {
      toast.error("Apply failed", { description: err.message });
    } finally {
      setApplying(false);
    }
  };

  const runUndo = async () => {
    if (!selectedClient) return;
    setUndoing(true);
    setUndoOpen(false);
    try {
      const data = await undoCategoryConsolidation(selectedClient);
      toast.success("Undo complete", {
        description: `${data.restored ?? 0} keywords restored to their previous category.`,
      });
      setPreview(null);
      queryClient.invalidateQueries({ queryKey: ["consolidate_last_batch", selectedClient] });
    } catch (err: any) {
      toast.error("Undo failed", { description: err.message });
    } finally {
      setUndoing(false);
    }
  };

  // Build a flat list of {from, to, count, kind} rows for the preview table.
  const previewRows = preview
    ? Object.entries(preview.mapping)
        .map(([from, to]) => {
          const count = preview.distinctTags.find((t) => t.tag === from)?.count ?? 0;
          const kind: "clear" | "rename" = to === null ? "clear" : "rename";
          return { from, to, count, kind };
        })
        .sort((a, b) => b.count - a.count)
    : [];

  const distinctBefore = preview?.distinctTags.length ?? 0;
  // Compute distinct count after merge: starts at distinctBefore, subtract
  // each remapped key, add each unique destination not already present.
  const distinctAfter = (() => {
    if (!preview) return 0;
    const remaining = new Set(preview.distinctTags.map((t) => t.tag));
    const renamedSources = Object.keys(preview.mapping);
    for (const src of renamedSources) remaining.delete(src);
    for (const dest of Object.values(preview.mapping)) {
      if (dest && !remaining.has(dest)) remaining.add(dest);
    }
    return remaining.size;
  })();

  return (
    <div className="max-w-5xl mx-auto py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Tags className="h-6 w-6 text-primary" />
          Keyword categories
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Merge equivalent category labels for a client and clear intent labels that leaked into the topic column.
          Forecasts, opportunity scores, CTR curves and revenue numbers are unaffected. Reversible from the audit log.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Pick a client</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-2 items-end">
            <div className="space-y-1.5">
              <Select
                value={selectedClient}
                onValueChange={(v) => {
                  setSelectedClient(v);
                  setPreview(null);
                }}
                disabled={clientsLoading}
              >
                <SelectTrigger>
                  <SelectValue placeholder={clientsLoading ? "Loading clients…" : "Select client"} />
                </SelectTrigger>
                <SelectContent>
                  {clients.map((c: any) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.company_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={runPreview} disabled={!selectedClient || previewing} className="gap-1.5">
              {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
              {previewing ? "Analysing…" : "Preview consolidation"}
            </Button>
            {lastBatch && (
              <Button
                onClick={() => setUndoOpen(true)}
                variant="outline"
                disabled={undoing}
                className="gap-1.5"
                title={`Last consolidate: ${new Date(lastBatch.changed_at).toLocaleString()}`}
              >
                {undoing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />}
                Undo last
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {previewing && (
        <Card>
          <CardContent className="py-6 space-y-2">
            <Shimmer className="h-4 w-1/3" />
            <Shimmer className="h-4 w-1/2" />
            <Shimmer className="h-4 w-2/3" />
          </CardContent>
        </Card>
      )}

      {preview && previewRows.length === 0 && (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            <CheckCircle2 className="h-5 w-5 text-accent inline mr-2" />
            No consolidations needed — no equivalent labels or misplaced intent values were found.
          </CardContent>
        </Card>
      )}

      {preview && previewRows.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <CardTitle className="text-base">
                2. Review proposed changes
              </CardTitle>
              <div className="flex items-center gap-2 text-xs">
                <Badge variant="secondary">
                  {distinctBefore} → {distinctAfter} categories
                </Badge>
                <Badge variant="secondary">
                  {preview.totalAffected} keywords affected
                </Badge>
                {preview.intentMerges > 0 && (
                  <Badge variant="secondary">{preview.intentMerges} intent labels cleared</Badge>
                )}
                {(preview.normalizedRenames ?? 0) > 0 && (
                  <Badge variant="secondary">{preview.normalizedRenames} equivalent labels merged</Badge>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md border border-border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-[11px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="text-left px-3 py-2">From</th>
                    <th className="text-left px-3 py-2 w-12"></th>
                    <th className="text-left px-3 py-2">To</th>
                    <th className="text-right px-3 py-2">Keywords</th>
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((r) => (
                    <tr key={r.from} className="border-t border-border">
                      <td className="px-3 py-2 font-medium">{r.from}</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        <ArrowRight className="h-3.5 w-3.5" />
                      </td>
                      <td className="px-3 py-2">
                        {r.kind === "clear" ? (
                          <span className="inline-flex items-center gap-1 text-warning">
                            <Trash2 className="h-3.5 w-3.5" />
                            Cleared (Uncategorised) · intent unchanged
                          </span>
                        ) : (
                          <span className="font-medium text-primary">{r.to}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p className="text-xs text-muted-foreground max-w-xl">
                Only renames category labels. <strong>Forecasts, opportunity scores, CTR curves and revenue numbers
                are unaffected.</strong> A snapshot of every change is written to the audit log so this run can be
                reversed with one click.
              </p>
              <Button onClick={() => setConfirmOpen(true)} disabled={applying} className="gap-1.5">
                {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                Apply consolidation
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Merge {distinctBefore} categories into {distinctAfter}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  <strong>{preview?.totalAffected ?? 0} keywords</strong> will have their category updated.
                </p>
                <p className="text-muted-foreground">
                  Only renames category labels. Forecasts, opportunity scores, CTR curves and revenue numbers are
                  unaffected. Reversible from the audit log via the Undo button.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={runApply}>Apply</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={undoOpen} onOpenChange={setUndoOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Undo last consolidation?</AlertDialogTitle>
            <AlertDialogDescription>
              Restores every keyword in the most recent consolidate batch back to its previous category
              {lastBatch && (
                <>
                  {" "}(from {new Date(lastBatch.changed_at).toLocaleString()})
                </>
              )}.
              The audit rows for that batch will be removed once the restore completes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={runUndo}>Undo</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
