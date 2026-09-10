import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./auth", () => ({ getAccessToken: vi.fn() }));
vi.mock("./api", () => ({ seerApiRequest: vi.fn() }));
import { getAccessToken } from "./auth";
import { seerApiRequest } from "./api";
import { calculationCsvCell, downloadCalculationResults } from "./calculation-export";

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
  it("refuses to download mixed-run pages", async () => {
    vi.mocked(getAccessToken).mockResolvedValue("local-test-token");
    vi.mocked(seerApiRequest).mockResolvedValueOnce({ columns: ["keyword"], rows: [{ keyword: "tv" }], runId: "one", nextAfter: "next", filename: "test.csv" })
      .mockResolvedValueOnce({ columns: ["keyword"], rows: [{ keyword: "oven" }], runId: "two", nextAfter: null, filename: "test.csv" });
    await expect(downloadCalculationResults("project", "stretch")).rejects.toThrow("completed run changed");
  });
});
