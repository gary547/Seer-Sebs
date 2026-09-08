import { describe, expect, it, vi } from "vitest";
vi.mock("./auth", () => ({ getAccessToken: vi.fn() }));
import { calculationCsvCell } from "./calculation-export";

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
});
