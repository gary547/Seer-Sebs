import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import GscUploadPanel from "./GscUploadPanel";
import { importGscWorkbook } from "@/integrations/gcp/project-data";

vi.mock("@/integrations/gcp/project-data", () => ({ importGscWorkbook: vi.fn() }));

describe("GSC upload selection", () => {
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
});
