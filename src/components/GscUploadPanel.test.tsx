import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GscUploadPanel from "./GscUploadPanel";
import { importGscWorkbook } from "@/integrations/gcp/project-data";
import { MAXIMUM_GSC_UPLOAD_BYTES } from "@/integrations/gcp/gsc-import-limits";

vi.mock("@/integrations/gcp/project-data", () => ({ importGscWorkbook: vi.fn() }));

describe("GSC upload selection", () => {
  beforeEach(() => { vi.mocked(importGscWorkbook).mockReset(); });
  it("submits all selected CSV files in one request and shows their provenance", async () => {
    const csv = "Query,Device,Clicks,Impressions,CTR,Position\ntv,mobile,10,100,10%,8";
    const files = ["tv.csv", "oven.csv", "fridge.csv"].map((filename) => {
      const file = new File([csv], filename, { type: "text/csv" });
      Object.defineProperty(file, "text", { value: async () => csv });
      Object.defineProperty(file, "slice", { value: () => ({ text: async () => csv }) });
      return file;
    });
    vi.mocked(importGscWorkbook).mockResolvedValue({
      upload_id: "batch", source: "gsc_batch_v1", row_count: 1, pages_inserted: 0,
      date_range_start: "2026-01-01", date_range_end: "2026-04-01", upload_device: "mobile", sheets_seen: [], warnings: [],
      source_files: files.map((file) => ({ filename: file.name, rowCount: 1, sha256: "a".repeat(64) })),
    });
    const onUploaded = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><GscUploadPanel projectId="project" onUploaded={onUploaded} /></QueryClientProvider>);
    expect(screen.getByLabelText("Choose GSC export files")).toHaveAttribute("multiple");
    fireEvent.change(screen.getByLabelText("Choose GSC export files"), { target: { files } });
    await screen.findByRole("button", { name: "Upload 3 files as one dataset" });
    fireEvent.change(screen.getByLabelText("Export period start"), { target: { value: "2026-01-01" } });
    fireEvent.change(screen.getByLabelText("Export period end"), { target: { value: "2026-04-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Upload 3 files as one dataset" }));
    await waitFor(() => expect(onUploaded).toHaveBeenCalledOnce());
    expect(importGscWorkbook).toHaveBeenCalledTimes(1);
    expect(importGscWorkbook).toHaveBeenCalledWith("project", { files: files.map((file) => ({
      format: "csv_text", csvText: csv, dateRangeStart: "2026-01-01", dateRangeEnd: "2026-04-01", filename: file.name, device: undefined,
    })) });
    expect(screen.getByText("Included files:")).toBeInTheDocument();
    expect(screen.getByText("Upload complete")).toBeInTheDocument();
    client.clear();
  });

  function renderPanel() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><GscUploadPanel projectId="project" /></QueryClientProvider>);
    return client;
  }
  function csvFile(name: string, size: number) {
    const csv = "Query,Device,Clicks,Impressions,CTR,Position\nquery,all,10,100,10%,8";
    const file = new File([csv], name, { type: "text/csv" });
    Object.defineProperties(file, {
      size: { value: size }, text: { value: async () => csv }, slice: { value: () => ({ text: async () => csv }) },
    });
    return file;
  }
  async function submit(file: File) {
    fireEvent.change(screen.getByLabelText("Choose GSC export files"), { target: { files: [file] } });
    await screen.findByText(file.name, { exact: false });
    fireEvent.change(screen.getByLabelText("Export period start"), { target: { value: "2025-09-01" } });
    fireEvent.change(screen.getByLabelText("Export period end"), { target: { value: "2026-08-31" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Upload" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
  }

  it("allows a 50 MB file and displays the observation limit", async () => {
    vi.mocked(importGscWorkbook).mockResolvedValue({ upload_id: "large", source: "gsc_csv_v2", row_count: 131_535, pages_inserted: 0,
      date_range_start: "2025-09-01", date_range_end: "2026-08-31", upload_device: "all", sheets_seen: [], warnings: [] });
    const client = renderPanel();
    expect(screen.getByText(/50 MB in total and 250,000 query and page observations/)).toBeInTheDocument();
    await submit(csvFile("large.csv", MAXIMUM_GSC_UPLOAD_BYTES));
    await screen.findByText("Upload complete");
    expect(importGscWorkbook).toHaveBeenCalledOnce();
    client.clear();
  });

  it("rejects the combined byte size before reading or submitting files", () => {
    const client = renderPanel();
    fireEvent.change(screen.getByLabelText("Choose GSC export files"), { target: { files: [csvFile("first.csv", 26 * 1024 * 1024), csvFile("second.csv", 25 * 1024 * 1024)] } });
    expect(screen.getByText(/total 51.00 MB.*maximum is 50 MB/)).toBeInTheDocument();
    expect(importGscWorkbook).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Upload" })).not.toBeInTheDocument();
    client.clear();
  });

  it("shows the server's actual observation count and supported maximum", async () => {
    const message = "This GSC upload contains 250,001 query and page observations. The maximum is 250,000 per upload. Use a smaller export; no files were imported.";
    vi.mocked(importGscWorkbook).mockRejectedValue(Object.assign(new Error(message), { code: "gsc_batch_too_large", status: 400 }));
    const client = renderPanel();
    await submit(csvFile("too-many-rows.csv", 20_000_000));
    expect(await screen.findByText(message)).toBeInTheDocument();
    client.clear();
  });

  it("explains HTTP 413 even when a proxy supplies no structured error", async () => {
    vi.mocked(importGscWorkbook).mockRejectedValue(Object.assign(new Error("The request could not be completed."), { code: "request_failed", status: 413 }));
    const client = renderPanel();
    await submit(csvFile("large.csv", MAXIMUM_GSC_UPLOAD_BYTES));
    expect(await screen.findByText("The GSC upload is too large. Choose files totalling at most 50 MB; no files were imported.")).toBeInTheDocument();
    client.clear();
  });
});
