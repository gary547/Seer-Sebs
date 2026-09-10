import { useCallback, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { importGscWorkbook, type GscWorkbookImportInput } from "@/integrations/gcp/project-data";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Upload } from "lucide-react";
import { toast } from "sonner";

interface Props {
  projectId: string | null | undefined;
  disabled?: boolean;
  disabledHint?: string;
  onUploaded?: (upload: { upload_id: string; row_count: number; source: string }) => void;
}

type Mode = "idle" | "reading" | "uploading" | "done" | "error";

interface UploadSummary {
  upload_id: string;
  source: string;
  row_count: number;
  pages_inserted: number;
  date_range_start: string;
  date_range_end: string;
  upload_device: string;
  warnings: string[];
  source_files: Array<{ filename: string; rowCount: number }>;
}

function mapErrorCode(code: string | undefined, fallback: string): string {
  switch (code) {
    case "queries_sheet_missing":
      return "Workbook is missing the Queries sheet — export the standard Performance report from Search Console.";
    case "chart_sheet_missing":
      return "Workbook is missing the Chart sheet — export the standard Performance report from Search Console.";
    case "queries_columns_missing":
      return "File is missing required columns. Expected Query / Clicks / Impressions / CTR / Position.";
    case "missing_date_range":
      return "CSV uploads require a start and end date for the export window.";
    case "date_range_out_of_bounds":
      return fallback;
    case "forbidden_project":
      return "You don't have access to this project.";
    case "invalid_workbook":
      return "Could not read the file — please upload a standard Search Console .xlsx export.";
    default:
      return fallback || "Upload failed";
  }
}

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function peekCsvHasDeviceColumn(file: File): Promise<boolean> {
  try {
    const text = await file.slice(0, 4096).text();
    const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
    return firstLine.toLowerCase().includes("device");
  } catch {
    return false;
  }
}

export default function GscUploadPanel({ projectId, disabled, disabledHint, onUploaded }: Props) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [files, setFiles] = useState<Array<{ file: File; kind: "csv" | "xlsx"; hasDevice: boolean }>>([]);
  const [device, setDevice] = useState<string>(""); // "", "all", "mobile", "desktop"
  const [dateStart, setDateStart] = useState<string>("");
  const [dateEnd, setDateEnd] = useState<string>("");
  const [mode, setMode] = useState<Mode>("idle");
  const [progressMsg, setProgressMsg] = useState<string>("");
  const [summary, setSummary] = useState<UploadSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const needsDeviceSelector = files.some((item) => !item.hasDevice);
  const needsDateRange = files.some((item) => item.kind === "csv");
  const busy = mode === "reading" || mode === "uploading";

  const canSubmit = useMemo(() => {
    if (!projectId || disabled) return false;
    if (!files.length) return false;
    if (needsDeviceSelector && !device) return false;
    if (needsDateRange && (!dateStart || !dateEnd)) return false;
    return mode === "idle" || mode === "done" || mode === "error";
  }, [projectId, disabled, files.length, needsDeviceSelector, device, needsDateRange, dateStart, dateEnd, mode]);

  const resetAfter = useCallback(() => {
    setFiles([]);
    setDevice("");
    setDateStart("");
    setDateEnd("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const onFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files ?? []);
    setSummary(null);
    setError(null);
    setFiles([]);
    if (selected.length > 10 || selected.some((file) => !/\.(csv|xlsx)$/i.test(file.name))) {
      setMode("error");
      setError("Choose up to 10 CSV or XLSX exports from the same Search Console property.");
      return;
    }
    if (selected.reduce((sum, file) => sum + file.size, 0) > 20 * 1024 * 1024) {
      setMode("error");
      setError("The selected files exceed the 20 MB upload limit. Use smaller exports.");
      return;
    }
    setMode("reading");
    setProgressMsg("Checking selected files…");
    setFiles(await Promise.all(selected.map(async (file) => ({
      file,
      kind: file.name.toLowerCase().endsWith(".csv") ? "csv" as const : "xlsx" as const,
      hasDevice: file.name.toLowerCase().endsWith(".csv") && await peekCsvHasDeviceColumn(file),
    }))));
    setMode("idle");
    setProgressMsg("");
  }, []);

  const onSubmit = useCallback(async () => {
    if (!projectId || !canSubmit) return;
    setMode("reading");
    setProgressMsg(`Reading ${files.length} selected ${files.length === 1 ? "file" : "files"}…`);
    setError(null);
    setSummary(null);
    try {
      const inputs: GscWorkbookImportInput[] = [];
      for (const { file, kind, hasDevice } of files) {
        setProgressMsg(`Reading ${inputs.length + 1} of ${files.length}: ${file.name}`);
        if (kind === "csv") inputs.push({
          format: "csv_text",
          csvText: await file.text(),
          dateRangeStart: dateStart,
          dateRangeEnd: dateEnd,
          filename: file.name,
          device: hasDevice ? undefined : device,
        });
        else inputs.push({
          format: "xlsx_base64",
          fileBase64: await fileToBase64(file),
          filename: file.name,
          device: device || undefined,
        });
      }
      setMode("uploading");
      setProgressMsg("Validating and combining files into one GSC dataset…");
      const data = await importGscWorkbook(projectId, inputs.length === 1 ? inputs[0] : { files: inputs });

      const s: UploadSummary = {
        upload_id: data.upload_id,
        source: data.source ?? "gsc_workbook_v1",
        row_count: data.row_count,
        pages_inserted: data.pages_inserted ?? 0,
        date_range_start: data.date_range_start,
        date_range_end: data.date_range_end,
        upload_device: data.upload_device,
        warnings: data.warnings ?? [],
        source_files: data.source_files ?? [],
      };
      setSummary(s);
      setMode("done");
      setProgressMsg("");
      toast.success(
        `Imported ${s.row_count.toLocaleString()} GSC observations · ${s.date_range_start} → ${s.date_range_end}`,
      );

      queryClient.invalidateQueries({ queryKey: ["gsc_upload_latest", projectId] });
      queryClient.invalidateQueries({ queryKey: ["gsc_upload_keywords"] });
      queryClient.invalidateQueries({ queryKey: ["project-data", projectId] });
      queryClient.invalidateQueries({ queryKey: ["project_sync_state", projectId] });
      queryClient.invalidateQueries({ queryKey: ["ctr_curves"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "gsc-uploads"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "pipeline-readiness", projectId] });
      queryClient.invalidateQueries({ queryKey: ["admin", "calculation-pipeline", projectId] });

      onUploaded?.({ upload_id: s.upload_id, row_count: s.row_count, source: s.source });
      resetAfter();
    } catch (error: unknown) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : undefined;
      const fallback =
        error instanceof Error ? error.message : "Upload failed";
      const msg = mapErrorCode(code, fallback);
      setError(msg);
      setMode("error");
      setProgressMsg("");
      toast.error(msg);
    }
  }, [projectId, canSubmit, files, device, dateStart, dateEnd, queryClient, onUploaded, resetAfter]);

  return (
    <div className="space-y-3">
      {disabled && disabledHint && (
        <p className="text-xs text-muted-foreground italic">{disabledHint}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || mode === "reading" || mode === "uploading"}
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="h-4 w-4 mr-1" />
          {files.length ? "Change selected files" : "Choose CSV or XLSX files"}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.xlsx"
          multiple
          disabled={disabled || busy}
          aria-label="Choose GSC export files"
          className="hidden"
          onChange={onFileChange}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Select all exports for this dataset together (up to 10 files, 20 MB). Use the same Search Console property and export period.
        Identical overlapping rows are counted once. This batch replaces the previous GSC input; it does not append to earlier uploads.
      </p>
      {files.length > 0 && (
        <ul className="divide-y rounded-md border px-3 text-xs">
          {files.map(({ file }, index) => (
            <li key={`${index}-${file.name}`} className="flex items-start justify-between gap-3 py-2">
              <span className="min-w-0 break-words">{file.name}</span>
              <span className="shrink-0 text-muted-foreground">{Math.ceil(file.size / 1024).toLocaleString()} KB</span>
            </li>
          ))}
        </ul>
      )}

      {files.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {needsDeviceSelector && (
            <div className="space-y-1">
              <Label className="text-xs">Device</Label>
              <Select value={device} onValueChange={setDevice} disabled={disabled || busy}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Select device…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All (aggregate)</SelectItem>
                  <SelectItem value="mobile">Mobile</SelectItem>
                  <SelectItem value="desktop">Desktop</SelectItem>
                  <SelectItem value="tablet">Tablet</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {files.some((item) => item.hasDevice) && (
            <div className="space-y-1 sm:col-span-2">
              <Label className="text-xs">Device</Label>
              <p className="text-xs text-muted-foreground">
                Per-row Device column detected — upload will be stored as <strong>mixed</strong>.
              </p>
            </div>
          )}
          {needsDateRange && (
            <>
              <div className="space-y-1">
                <Label className="text-xs" htmlFor="gsc-export-period-start">Export period start</Label>
                <Input
                  id="gsc-export-period-start"
                  type="date"
                  value={dateStart}
                  onChange={(e) => setDateStart(e.target.value)}
                  disabled={disabled || busy}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs" htmlFor="gsc-export-period-end">Export period end</Label>
                <Input
                  id="gsc-export-period-end"
                  type="date"
                  value={dateEnd}
                  onChange={(e) => setDateEnd(e.target.value)}
                  disabled={disabled || busy}
                />
              </div>
            </>
          )}
        </div>
      )}

      {files.length > 0 && (() => {
        const missing: string[] = [];
        if (needsDeviceSelector && !device) missing.push("choose a device");
        if (needsDateRange && !dateStart) missing.push("set export period start");
        if (needsDateRange && !dateEnd) missing.push("set export period end");
        const showHint =
          !disabled &&
          !canSubmit &&
          mode !== "reading" &&
          mode !== "uploading" &&
          missing.length > 0;
        return (
          <div className="space-y-1">
            <Button size="sm" onClick={onSubmit} disabled={!canSubmit}>
              {files.length > 1 ? `Upload ${files.length} files as one dataset` : "Upload"}
            </Button>
            {showHint && (
              <p className="text-xs text-muted-foreground">
                To upload: {missing.join(" · ")}
              </p>
            )}
          </div>
        );
      })()}

      {(mode === "reading" || mode === "uploading") && (
        <div className="space-y-2 py-2">
          <p className="text-sm text-muted-foreground">{progressMsg}</p>
          <Progress className="h-2" />
        </div>
      )}

      {error && mode === "error" && (
        <div className="text-xs text-destructive border border-destructive/40 rounded-md p-2 bg-destructive/5">
          {error}
        </div>
      )}

      {summary && (
        <div className="text-xs space-y-1 border rounded-md p-3 bg-background">
          <p className="font-medium text-sm">Upload complete</p>
          <p><span className="text-muted-foreground">Source:</span> {summary.source}</p>
          <p><span className="text-muted-foreground">Date range:</span> {summary.date_range_start} → {summary.date_range_end}</p>
          <p><span className="text-muted-foreground">Device:</span> {summary.upload_device}</p>
          <p><span className="text-muted-foreground">Rows imported:</span> {summary.row_count.toLocaleString()}</p>
          {summary.source_files.length > 0 && (
            <div className="pt-1">
              <p className="text-muted-foreground">Included files:</p>
              <ul className="list-disc pl-4 break-words">
                {summary.source_files.map((source, index) => <li key={index}>{source.filename} · {source.rowCount.toLocaleString()} observations</li>)}
              </ul>
            </div>
          )}
          {summary.pages_inserted > 0 && (
            <p><span className="text-muted-foreground">Pages:</span> {summary.pages_inserted.toLocaleString()} rows</p>
          )}
          {summary.warnings.length > 0 && (
            <div className="pt-1">
              <p className="text-muted-foreground">Warnings:</p>
              <ul className="list-disc pl-4">
                {summary.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
