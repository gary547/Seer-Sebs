import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./auth", () => ({ getAccessToken: vi.fn() }));
vi.mock("./api", () => ({ seerApiRequest: vi.fn() }));
import { getAccessToken } from "./auth";
import { seerApiRequest } from "./api";
import { calculationCsvCell, calculationPartFilename, downloadCalculationResults } from "./calculation-export";

afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });

describe("complete calculation CSV", () => {
  it("escapes commas, quotes and multiline values", () => {
    expect(calculationCsvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
  });
  it("preserves numeric zero and negative numeric values", () => {
    expect(calculationCsvCell(0)).toBe('"0"');
    expect(calculationCsvCell(-0.25)).toBe('"-0.25"');
    expect(calculationCsvCell(null)).toBe("");
  });
  it.each(["=SUM(A1:A2)", "+command", "-command", "@command", "\tcommand", "\n=command", "  =command"])("prevents spreadsheet formula execution for text: %s", (value) => {
    expect(calculationCsvCell(value)).toBe(`"'${value}"`);
  });
  it("keeps the selected scenario and completed run pinned on every download page", async () => {
    vi.mocked(getAccessToken).mockResolvedValue("local-test-token");
    vi.mocked(seerApiRequest).mockResolvedValueOnce({ columns: ["keyword", "scenario"], rows: [{ keyword: "tv", scenario: "realistic" }], runId: "run-one", nextAfter: "keyword-one", filename: "realistic.csv" })
      .mockResolvedValueOnce({ columns: ["keyword", "scenario"], rows: [{ keyword: "oven", scenario: "realistic" }], runId: "run-one", nextAfter: null, filename: "realistic.csv" });
    const createUrl = vi.fn(() => "blob:local-export");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    await downloadCalculationResults("project", "realistic");
    const requests = vi.mocked(seerApiRequest).mock.calls.map(([url]) => new URL(String(url), "https://example.test"));
    expect(requests.map((url) => url.searchParams.get("scenario"))).toEqual(["realistic", "realistic"]);
    expect(requests[1]?.searchParams.get("runId")).toBe("run-one");
    expect(requests[1]?.searchParams.get("after")).toBe("keyword-one");
    expect(createUrl).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
  });
  it("numbers parts only when the export is split, preserving the single-file name", () => {
    expect(calculationPartFilename("seer-results.csv", 1, 1)).toBe("seer-results.csv");
    expect(calculationPartFilename("seer-results.csv", 2, 3)).toBe("seer-results-part-2-of-3.csv");
    expect(calculationPartFilename("seer-results.csv", 7, 12)).toBe("seer-results-part-07-of-12.csv");
  });
  it("splits oversized exports into parts that repeat the header and keep every column", async () => {
    vi.mocked(getAccessToken).mockResolvedValue("local-test-token");
    const columns = ["keyword", "scenario", "har_explanation", "peak_month", "peak_months"];
    const filler = "x".repeat(16 * 1024 * 1024);
    const page = (keyword: string, nextAfter: string | null) => ({ columns,
      rows: [{ keyword, scenario: "realistic", har_explanation: filler, peak_month: 11, peak_months: "11,12" }],
      runId: "run-one", nextAfter, filename: "seer-results-project-run-one.csv" });
    vi.mocked(seerApiRequest).mockResolvedValueOnce(page("tv", "tv-id"))
      .mockResolvedValueOnce(page("oven", "oven-id"))
      .mockResolvedValueOnce(page("fridge", null));
    const blobs: Blob[] = [];
    const names: string[] = [];
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn((blob: Blob) => { blobs.push(blob); return "blob:local-export"; }) });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });
    const summary = await downloadCalculationResults("project");
    expect(summary).toEqual({ parts: 2, rows: 3 });
    expect(names).toEqual(["seer-results-project-run-one-part-1-of-2.csv", "seer-results-project-run-one-part-2-of-2.csv"]);
    const header = columns.map(calculationCsvCell).join(",");
    const contents = await Promise.all(blobs.map((blob) => blob.text()));
    expect(contents).toHaveLength(2);
    // Blob.text() UTF-8 decoding consumes the leading BOM the export still writes.
    for (const part of contents) expect(part.startsWith(`${header}\r\n`)).toBe(true);
    expect(contents[0]?.split("\r\n")).toHaveLength(3);
    expect(contents[1]?.split("\r\n")).toHaveLength(2);
    expect(contents[1]).toContain('"fridge","realistic"');
    expect(contents[0]).toContain('"11","11,12"');
  });
  it("downloads a single unsplit file when the export fits one part", async () => {
    vi.mocked(getAccessToken).mockResolvedValue("local-test-token");
    vi.mocked(seerApiRequest).mockResolvedValueOnce({ columns: ["keyword", "peak_month"], rows: [{ keyword: "tv", peak_month: 3 }], runId: "run-one", nextAfter: null, filename: "seer-results-project-run-one.csv" });
    const names: string[] = [];
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:local-export") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });
    await expect(downloadCalculationResults("project")).resolves.toEqual({ parts: 1, rows: 1 });
    expect(names).toEqual(["seer-results-project-run-one.csv"]);
  });
  it("refuses to download mixed-run pages", async () => {
    vi.mocked(getAccessToken).mockResolvedValue("local-test-token");
    vi.mocked(seerApiRequest).mockResolvedValueOnce({ columns: ["keyword"], rows: [{ keyword: "tv" }], runId: "one", nextAfter: "next", filename: "test.csv" })
      .mockResolvedValueOnce({ columns: ["keyword"], rows: [{ keyword: "oven" }], runId: "two", nextAfter: null, filename: "test.csv" });
    await expect(downloadCalculationResults("project", "stretch")).rejects.toThrow("completed run changed");
  });
});
