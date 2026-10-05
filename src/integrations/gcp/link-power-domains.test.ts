import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./auth", () => ({ getAccessToken: vi.fn() }));
vi.mock("./api", () => ({ seerApiRequest: vi.fn() }));
import { getAccessToken } from "./auth";
import { seerApiRequest } from "./api";
import { downloadLinkPowerDomains } from "./link-power-domains";

afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

describe("domain benchmark CSV integrity", () => {
  it.each(["failed page", "different run", "different total", "missing rows"])("does not download a partial or inconsistent CSV after a %s", async (failure) => {
    vi.mocked(getAccessToken).mockResolvedValue("local-test-token");
    const domains = Array.from({ length: 200 }, (_, index) => ({
      domain: `competitor-${index}.test`, meanScore: 0, bestRank: 1, appearances: 1, isClientDomain: false,
    }));
    vi.mocked(seerApiRequest).mockResolvedValueOnce({ domains, total: 201, runId: "run-one" });
    if (failure === "failed page") vi.mocked(seerApiRequest).mockRejectedValueOnce(new Error("Domain page unavailable"));
    else vi.mocked(seerApiRequest).mockResolvedValueOnce({
      domains: failure === "missing rows" ? [] : [domains[0]],
      total: failure === "different total" ? 202 : 201,
      runId: failure === "different run" ? "run-two" : "run-one",
    });
    const createUrl = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: createUrl }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    await expect(downloadLinkPowerDomains("project", "run-one", "appearances", "desc")).rejects.toThrow();
    expect(createUrl).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });
});
