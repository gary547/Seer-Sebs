import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./auth", () => ({ getAccessToken: vi.fn() }));
vi.mock("./api", async (importOriginal) => ({ ...await importOriginal<typeof import("./api")>(), seerApiRequest: vi.fn() }));
import { getAccessToken } from "./auth";
import { seerApiRequest } from "./api";
import { downloadLinkPowerDomains } from "./link-power-domains";

afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

describe("domain benchmark CSV integrity", () => {
  it.each(["failed export", "different run", "missing CSV", "invalid count", "timeout", "network failure"])("does not download a partial or inconsistent CSV after a %s", async (failure) => {
    vi.mocked(getAccessToken).mockResolvedValue("local-test-token");
    if (failure === "failed export") vi.mocked(seerApiRequest).mockRejectedValueOnce(new Error("Domain export unavailable"));
    else if (failure === "timeout") vi.mocked(seerApiRequest).mockRejectedValueOnce(new DOMException("Request timed out", "TimeoutError"));
    else if (failure === "network failure") vi.mocked(seerApiRequest).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    else vi.mocked(seerApiRequest).mockResolvedValueOnce({
      csv: failure === "missing CSV" ? "" : '"Domain"\r\n"competitor.test"',
      total: failure === "invalid count" ? -1 : 1,
      runId: failure === "different run" ? "run-two" : "run-one",
    });
    const createUrl = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: createUrl }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const message = failure === "timeout" ? "Domain export timed out. Please retry the download." : failure === "network failure" ? "Domain export could not be downloaded. Please retry the download." : undefined;
    await expect(downloadLinkPowerDomains("project", "run-one", "appearances", "desc")).rejects.toThrow(message);
    expect(createUrl).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it("downloads a complete 31,730-domain CSV through one bounded request", async () => {
    vi.mocked(getAccessToken).mockResolvedValue("local-test-token");
    const csv = ['"Domain","Mean LPS","Best rank","Appearances","Client domain"',
      ...Array.from({ length: 31_730 }, (_, index) => `"competitor-${index}.test","0","1","1","No"`)].join("\r\n");
    vi.mocked(seerApiRequest).mockResolvedValueOnce({ csv, total: 31_730, runId: "run-one" });
    const createUrl = vi.fn((_blob: Blob) => "blob:test-domains");
    const revokeUrl = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: revokeUrl }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    await expect(downloadLinkPowerDomains("project", "run-one", "appearances", "desc")).resolves.toBe(31_730);
    expect(seerApiRequest).toHaveBeenCalledTimes(1);
    expect(seerApiRequest).toHaveBeenCalledWith("/v1/projects/project/link-power-domains-export?runId=run-one&sort=appearances&direction=desc", { signal: expect.any(AbortSignal) }, "local-test-token");
    expect(createUrl).toHaveBeenCalledWith(expect.any(Blob));
    expect(createUrl.mock.calls[0][0].size).toBe(new TextEncoder().encode("\uFEFF" + csv).length);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeUrl).toHaveBeenCalledWith("blob:test-domains");
    expect(document.querySelector('a[download]')).toBeNull();
  });
});
