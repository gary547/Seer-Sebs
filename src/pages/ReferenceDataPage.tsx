import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createSerpFeatures,
  getReferenceData,
  updateSerpFeature,
} from "@/integrations/gcp/admin-reference";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Upload, Plus, Save, X, Database } from "lucide-react";
import { toast } from "sonner";

type SerpFeatureRow = {
  id: string;
  serp_feature_raw: string;
  result_type: string;
  serp_intent: string;
};

export default function ReferenceDataPage() {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Partial<SerpFeatureRow>>({});
  const [newRow, setNewRow] = useState<Omit<SerpFeatureRow, "id"> | null>(null);

  const { data: referenceData, isLoading } = useQuery({
    queryKey: ["serp-feature-index"],
    queryFn: getReferenceData,
  });
  const rows = referenceData?.serpFeatures ?? [];
  const scoringCfg = referenceData?.harScoringConfig ?? null;
  const cfgLoading = isLoading;

  const startEdit = (row: SerpFeatureRow) => {
    setEditingId(row.id);
    setEditValues({ serp_feature_raw: row.serp_feature_raw, result_type: row.result_type, serp_intent: row.serp_intent });
  };

  const cancelEdit = () => {
    if (!window.confirm("Are you sure you want to cancel editing this row?")) return;
    setEditingId(null);
    setEditValues({});
  };

  const saveEdit = async () => {
    if (!editingId) return;
    try {
      const current = rows.find((row) => row.id === editingId);
      if (!current) return;
      await updateSerpFeature(editingId, {
        serp_feature_raw: editValues.serp_feature_raw ?? current.serp_feature_raw,
        result_type: editValues.result_type ?? current.result_type,
        serp_intent: editValues.serp_intent ?? current.serp_intent,
      });
      toast.success("Row updated");
      setEditingId(null);
      setEditValues({});
      queryClient.invalidateQueries({ queryKey: ["serp-feature-index"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Update failed");
    }
  };

  const addNewRow = async () => {
    if (!newRow || !newRow.serp_feature_raw.trim()) { toast.error("SERP Feature is required"); return; }
    try {
      await createSerpFeatures([newRow]);
      toast.success("Row added");
      setNewRow(null);
      queryClient.invalidateQueries({ queryKey: ["serp-feature-index"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Create failed");
    }
  };

  const handleCsvImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const lines = text.trim().split("\n");
    const header = lines[0].split(",").map(h => h.trim());
    const featureIdx = header.findIndex(h => h.toLowerCase().includes("serp feature"));
    const typeIdx = header.findIndex(h => h.toLowerCase().includes("result type"));
    const intentIdx = header.findIndex(h => h.toLowerCase().includes("serp intent"));

    if (featureIdx === -1 || typeIdx === -1 || intentIdx === -1) {
      toast.error("CSV must have columns: SERP Feature, Result Type, SERP Intent");
      e.target.value = "";
      return;
    }

    const records = lines.slice(1).filter(l => l.trim()).map(line => {
      const cols = line.split(",").map(c => c.trim());
      return {
        serp_feature_raw: cols[featureIdx],
        result_type: cols[typeIdx],
        serp_intent: cols[intentIdx],
      };
    });

    try {
      await createSerpFeatures(records);
      toast.success(`${records.length} rows upserted`);
      queryClient.invalidateQueries({ queryKey: ["serp-feature-index"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Import failed");
    }
    e.target.value = "";
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-heading font-bold text-foreground">Reference Data</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Global reference tables used across all Seer® projects
          </p>
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <Database className="h-5 w-5" /> SERP Feature Index
            </CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              {rows.length} SERP feature mappings loaded
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setNewRow({ serp_feature_raw: "", result_type: "", serp_intent: "" })}
            >
              <Plus className="h-4 w-4 mr-1" /> Add Row
            </Button>
            <label>
              <Button variant="outline" size="sm" asChild>
                <span><Upload className="h-4 w-4 mr-1" /> Import CSV</span>
              </Button>
              <input type="file" accept=".csv" className="hidden" onChange={handleCsvImport} />
            </label>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-muted-foreground text-sm py-8 text-center">Loading…</p>
          ) : (
            <div className="max-h-[600px] overflow-auto border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[300px]">SERP Feature</TableHead>
                    <TableHead className="min-w-[180px]">Result Type</TableHead>
                    <TableHead className="min-w-[150px]">SERP Intent</TableHead>
                    <TableHead className="w-[100px]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {newRow && (
                    <TableRow className="bg-accent/30">
                      <TableCell>
                        <Input
                          value={newRow.serp_feature_raw}
                          onChange={e => setNewRow({ ...newRow, serp_feature_raw: e.target.value })}
                          placeholder="e.g. answers / paragraph"
                          className="h-8 text-sm"
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          value={newRow.result_type}
                          onChange={e => setNewRow({ ...newRow, result_type: e.target.value })}
                          placeholder="e.g. Featured Snippets"
                          className="h-8 text-sm"
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          value={newRow.serp_intent}
                          onChange={e => setNewRow({ ...newRow, serp_intent: e.target.value })}
                          placeholder="e.g. Answer"
                          className="h-8 text-sm"
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={addNewRow}><Save className="h-3.5 w-3.5" /></Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => {
                            const hasContent = newRow && (newRow.serp_feature_raw.trim() || newRow.result_type.trim() || newRow.serp_intent.trim());
                            if (hasContent && !window.confirm("Discard this new row?")) return;
                            setNewRow(null);
                          }}><X className="h-3.5 w-3.5" /></Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                  {rows.map(row => (
                    <TableRow
                      key={row.id}
                      className="cursor-pointer hover:bg-muted/50"
                      onDoubleClick={() => startEdit(row)}
                    >
                      {editingId === row.id ? (
                        <>
                          <TableCell>
                            <Input value={editValues.serp_feature_raw ?? ""} onChange={e => setEditValues({ ...editValues, serp_feature_raw: e.target.value })} className="h-8 text-sm" />
                          </TableCell>
                          <TableCell>
                            <Input value={editValues.result_type ?? ""} onChange={e => setEditValues({ ...editValues, result_type: e.target.value })} className="h-8 text-sm" />
                          </TableCell>
                          <TableCell>
                            <Input value={editValues.serp_intent ?? ""} onChange={e => setEditValues({ ...editValues, serp_intent: e.target.value })} className="h-8 text-sm" />
                          </TableCell>
                          <TableCell>
                            <div className="flex gap-1">
                              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={saveEdit}><Save className="h-3.5 w-3.5" /></Button>
                              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={cancelEdit}><X className="h-3.5 w-3.5" /></Button>
                            </div>
                          </TableCell>
                        </>
                      ) : (
                        <>
                          <TableCell className="text-sm font-mono">{row.serp_feature_raw}</TableCell>
                          <TableCell className="text-sm">{row.result_type}</TableCell>
                          <TableCell className="text-sm">{row.serp_intent}</TableCell>
                          <TableCell />
                        </>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-lg flex items-center gap-2">
            <Database className="h-5 w-5" /> HAR Scoring Config (active)
          </CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Read-only view of the deployed HAR model contract.
          </p>
        </CardHeader>
        <CardContent className="space-y-6">
          {cfgLoading ? (
            <p className="text-muted-foreground text-sm py-8 text-center">Loading…</p>
          ) : !scoringCfg ? (
            <p className="text-muted-foreground text-sm py-8 text-center">No active config row.</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                <div><span className="text-muted-foreground">Version:</span> <span className="font-mono">{scoringCfg.version}</span></div>
                <div><span className="text-muted-foreground">Config ID:</span> <span className="font-mono text-xs">{scoringCfg.id}</span></div>
                <div><span className="text-muted-foreground">Updated:</span> {new Date(scoringCfg.updated_at).toLocaleString()}</div>
              </div>

              <section>
                <div className="flex items-baseline justify-between mb-2">
                  <h3 className="text-sm font-semibold">thresholds_json</h3>
                  <span className="text-xs uppercase tracking-wide text-primary">deployed model settings</span>
                </div>
                <p className="text-xs text-muted-foreground mb-2">
                  Scenario thresholds, temperatures, floor multipliers, prob factors, and <code className="font-mono">min_confidence</code>
                  document the thresholds used by the target HAR calculation.
                </p>
                <pre className="text-xs bg-muted rounded-md p-3 overflow-auto max-h-64">
{JSON.stringify(scoringCfg.thresholds_json, null, 2)}
                </pre>
              </section>

              <section>
                <div className="flex items-baseline justify-between mb-2">
                  <h3 className="text-sm font-semibold">weights_json</h3>
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">diagnostic weighting — not consumed by the ladder</span>
                </div>
                <p className="text-xs text-muted-foreground mb-2">
                  Retained for reporting/diagnostics. The v2 ladder does not read these weights.
                </p>
                <pre className="text-xs bg-muted rounded-md p-3 overflow-auto max-h-64">
{JSON.stringify(scoringCfg.weights_json, null, 2)}
                </pre>
              </section>

              {scoringCfg.notes && (
                <p className="text-xs text-muted-foreground italic">{scoringCfg.notes}</p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
