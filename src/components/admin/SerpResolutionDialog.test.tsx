import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SerpResolutionDialog from "./SerpResolutionDialog";
import { approveSerpExclusions, getSerpResolution } from "@/integrations/gcp/pipeline";

vi.mock("@/integrations/gcp/pipeline", () => ({ getSerpResolution: vi.fn(), approveSerpExclusions: vi.fn() }));
const review = { runId: "saved-run", projectId: "project", approved: false, queryCount: 1, keywordCount: 2, remainingKeywordCount: 100,
  queries: ["empty query"], keywords: [
    { id: "canonical", text: "empty query", query: "empty query", sourceKeywordId: "canonical", normalisedText: "empty query" },
    { id: "variant", text: "query variant", query: "empty query", sourceKeywordId: "canonical", normalisedText: "query variant" },
  ] };

describe("SERP exclusion review", () => {
  beforeEach(() => { vi.resetAllMocks(); vi.mocked(getSerpResolution).mockResolvedValue(review); vi.mocked(approveSerpExclusions).mockResolvedValue({ approved: true }); });

  it("requires explicit approval of the full affected scope before resuming the saved run", async () => {
    const resume = vi.fn().mockResolvedValue(undefined);
    render(<SerpResolutionDialog runId="saved-run" disabled={false} onResume={resume} />);
    fireEvent.click(screen.getByRole("button", { name: "Review queries without results" }));
    await screen.findByText("1 searches · 2 keywords excluded from forecasts");
    expect(screen.getByText("Shares search results with: empty query")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Exclude and resume" })).toBeDisabled();
    expect(approveSerpExclusions).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Exclude and resume" }));
    await waitFor(() => expect(resume).toHaveBeenCalledOnce());
    expect(approveSerpExclusions).toHaveBeenCalledWith("saved-run", ["canonical", "variant"]);
  });

  it("does not change the forecast scope or resume when review fails or the operator cancels", async () => {
    const resume = vi.fn();
    vi.mocked(getSerpResolution).mockRejectedValueOnce(new Error("Review is unavailable."));
    render(<SerpResolutionDialog runId="saved-run" disabled={false} onResume={resume} />);
    fireEvent.click(screen.getByRole("button", { name: "Review queries without results" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Review is unavailable.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(approveSerpExclusions).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it("keeps the pipeline stopped when the approved scope is rejected", async () => {
    vi.mocked(approveSerpExclusions).mockRejectedValueOnce(new Error("The affected list changed."));
    const resume = vi.fn();
    render(<SerpResolutionDialog runId="saved-run" disabled={false} onResume={resume} />);
    fireEvent.click(screen.getByRole("button", { name: "Review queries without results" }));
    await screen.findByText("1 searches · 2 keywords excluded from forecasts");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Exclude and resume" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The affected list changed.");
    expect(resume).not.toHaveBeenCalled();
  });
});
