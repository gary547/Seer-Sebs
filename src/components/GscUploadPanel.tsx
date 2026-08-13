import { useCallback, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { importGscWorkbook } from "@/integrations/gcp/project-data";
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

  const [file, setFile] = useState<File | null>(null);
  const [fileKind, setFileKind] = useState<"csv" | "xlsx" | null>(null);
  const [csvHasDevice, setCsvHasDevice] = useState<boolean>(false);
  const [device, setDevice] = useState<string>(""); // "", "all", "mobile", "desktop"
  const [dateStart, setDateStart] = useState<string>("");
  const [dateEnd, setDateEnd] = useState<string>("");
  const [mode, setMode] = useState<Mode>("idle");
  const [progressMsg, setProgressMsg] = useState<string>("");
  const [summary, setSummary] = useState<UploadSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const needsDeviceSelector = useMemo(() => {
    if (!file) return false;
    if (fileKind === "csv" && csvHasDevice) return false;
    return true;
  }, [file, fileKind, csvHasDevice]);

  const needsDateRange = fileKind === "csv";

  const canSubmit = useMemo(() => {
    if (!projectId || disabled) return false;
    if (!file || !fileKind) return false;
    if (needsDeviceSelector && !device) return false;
    if (needsDateRange && (!dateStart || !dateEnd)) return false;
    return mode === "idle" || mode === "done" || mode === "error";
  }, [projectId, disabled, file, fileKind, needsDeviceSelector, device, needsDateRange, dateStart, dateEnd, mode]);

  const resetAfter = useCallback(() => {
    setFile(null);
    setFileKind(null);
    setCsvHasDevice(false);
    setDevice("");
    setDateStart("");
    setDateEnd("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const onFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setSummary(null);
    setError(null);
    setMode("idle");
    if (!f) {
      setFile(null);
      setFileKind(null);
      return;
    }
    const lower = f.name.toLowerCase();
    if (lower.endsWith(".csv")) {
      setFile(f);
      setFileKind("csv");
      const hasDev = await peekCsvHasDeviceColumn(f);
      setCsvHasDevice(hasDev);
      if (hasDev) setDevice(""); // per-row overrides
    } else if (lower.endsWith(".xlsx")) {
      setFile(f);
      setFileKind("xlsx");
      setCsvHasDevice(false);
    } else {
      setFile(null);
      setFileKind(null);
      setError("Please choose a .csv or .xlsx file exported from Search Console.");
      toast.error("Unsupported file type — CSV or XLSX only.");
    }
  }, []);

  const onSubmit = useCallback(async () => {
    if (!projectId || !file || !fileKind) return;
    setMode("reading");
    setProgressMsg(fileKind === "csv" ? "Reading CSV…" : "Reading workbook…");
    setError(null);
    setSummary(null);
    try {
      let body:
        | {
            csvText: string;
            dateRangeEnd: string;
            dateRangeStart: string;
            device?: string;
            filename: string;
            format: "csv_text";
          }
        | {
            device?: string;
            fileBase64: string;
            filename: string;
            format: "xlsx_base64";
          };
      if (fileKind === "csv") {
        const text = await file.text();
        body = {
          format: "csv_text",
          csvText: text,
          dateRangeStart: dateStart,
          dateRangeEnd: dateEnd,
          filename: file.name,
        };
        if (!csvHasDevice) body.device = device;
      } else {
        const fileBase64 = await fileToBase64(file);
        body = {
          format: "xlsx_base64",
          fileBase64,
          filename: file.name,
          device: device || undefined,
        };
      }
      setMode("uploading");
      setProgressMsg("Importing to Seer…");
      const data = await importGscWorkbook(projectId, body);

      const s: UploadSummary = {
        upload_id: data.upload_id,
        source: data.source ?? "gsc_workbook_v1",
        row_count: data.row_count,
        pages_inserted: data.pages_inserted ?? 0,
        date_range_start: data.date_range_start,
        date_range_end: data.date_range_end,
        upload_device: data.upload_device,
        warnings: data.warnings ?? [],
      };
      setSummary(s);
      setMode("done");
      setProgressMsg("");
      toast.success(
        `Imported ${s.row_count.toLocaleString()} keywords · ${s.date_range_start} → ${s.date_range_end}`,
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
  }, [projectId, file, fileKind, csvHasDevice, device, dateStart, dateEnd, queryClient, onUploaded, resetAfter]);

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
          {file ? "Choose different file" : "Choose CSV or XLSX"}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.xlsx"
          className="hidden"
          onChange={onFileChange}
        />
        {file && (
          <span className="text-xs text-muted-foreground truncate max-w-[260px]">
            {file.name} · {fileKind?.toUpperCase()}
          </span>
        )}
      </div>

      {file && (
        <div className="grid gap-3 sm:grid-cols-2">
          {needsDeviceSelector && (
            <div className="space-y-1">
              <Label className="text-xs">Device</Label>
              <Select value={device} onValueChange={setDevice} disabled={disabled}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Select device…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All (aggregate)</SelectItem>
                  <SelectItem value="mobile">Mobile</SelectItem>
                  <SelectItem value="desktop">Desktop</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {fileKind === "csv" && csvHasDevice && (
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
                  disabled={disabled}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs" htmlFor="gsc-export-period-end">Export period end</Label>
                <Input
                  id="gsc-export-period-end"
                  type="date"
                  value={dateEnd}
                  onChange={(e) => setDateEnd(e.target.value)}
                  disabled={disabled}
                />
              </div>
            </>
          )}
        </div>
      )}

      {file && (() => {
        const missing: string[] = [];
        if (!file || !fileKind) missing.push("select a file");
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
              Upload
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
