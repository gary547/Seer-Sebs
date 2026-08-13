import { mkdir } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";

const email = process.env.E2E_PIPELINE_EMAIL;
const password = process.env.E2E_PIPELINE_PASSWORD;
const projectId = process.env.E2E_PIPELINE_PROJECT_ID;
const csvPath = process.env.E2E_GSC_CSV_PATH;
const artifactDirectory = process.env.E2E_ARTIFACT_DIR;

test.describe("autonomous pipeline live proof", () => {
  test.skip(
    !email || !password || !projectId || !csvPath || !artifactDirectory,
    "Requires the live local pipeline environment and evidence paths.",
  );

  test("uploads SAFS data and completes all four tracks after a page reload", async ({
    page,
  }) => {
    test.setTimeout(8 * 60_000);
    await mkdir(artifactDirectory!, { recursive: true });
    const consoleErrors: string[] = [];
    const firstPartyFailures: string[] = [];
    const transientStatusFailures: string[] = [];
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        message.text() !== "Failed to load resource: the server responded with a status of 404 ()"
      ) {
        consoleErrors.push(message.text());
      }
    });
    page.on("response", (response) => {
      const url = response.url();
      if (
        response.status() >= 400 &&
        (url.startsWith("http://127.0.0.1:5173") ||
          url.startsWith("http://127.0.0.1:18080"))
      ) {
        const failure = `${response.status()} ${url}`;
        if (
          response.status() === 500 &&
          response.request().method() === "GET" &&
          url.includes(`/v1/projects/${projectId}/pipeline-runs`)
        ) {
          transientStatusFailures.push(failure);
        } else {
          firstPartyFailures.push(failure);
        }
      }
    });

    await page.goto("/auth", { waitUntil: "domcontentloaded" });
    await page.getByLabel("Email").fill(email!);
    await page.getByLabel("Password").fill(password!);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((url) => url.pathname !== "/auth");

    await page.goto(`/admin/calculations?projectId=${projectId}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByRole("heading", { name: "Calculation Runs (v2)" }),
    ).toBeVisible();
    await expect(page.getByText("Autonomous forecast pipeline")).toBeVisible();
    await expect(page.getByText("TRACK A")).toBeVisible();
    await expect(page.getByText("TRACK B")).toBeVisible();
    await expect(page.getByText("TRACK C")).toBeVisible();
    await expect(page.getByText("TRACK D")).toBeVisible();
    await expect(page.getByText("Critical path")).toBeVisible();
    await expect(page.getByText("Reviewed brand terms:")).toBeVisible();

    await page.getByLabel("Minimum GSC impressions").fill("1000000000");
    await page.getByRole("button", { name: "Save policy" }).click();
    await expect(page.getByText("Pipeline policy saved")).toBeVisible();

    const fileInput = page.locator('input[type="file"][accept=".csv,.xlsx"]');
    await expect(fileInput).toHaveCount(1);
    await fileInput.setInputFiles(path.resolve(csvPath!));
    await page.getByLabel("Export period start").fill("2025-03-21");
    await page.getByLabel("Export period end").fill("2026-08-01");
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    await expect(page.getByText("Upload complete")).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText("Rows imported:").locator("..")).toContainText("23,787");
    await page.screenshot({
      fullPage: true,
      path: path.join(artifactDirectory!, "01-safs-upload-and-readiness.png"),
    });

    const runStarted = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/v1/projects/${projectId}/pipeline-runs`) &&
        response.status() === 202,
    );
    await page.getByRole("button", { name: "Full pipeline" }).click();
    const runResponse = await runStarted;
    const startedRun = (await runResponse.json()) as { id: string };
    await expect(page.getByText("Full autonomous pipeline started")).toBeVisible();

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForResponse(
      async (response) => {
        if (
          response.request().method() !== "GET" ||
          !response.url().includes(`/v1/projects/${projectId}/pipeline-runs`)
        ) {
          return false;
        }
        const body = (await response.json()) as {
          run?: { id?: string; status?: string } | null;
        };
        return body.run?.id === startedRun.id && body.run.status === "succeeded";
      },
      { timeout: 300_000 },
    );
    const header = page
      .locator("header")
      .filter({ has: page.getByRole("heading", { name: "Calculation Runs (v2)" }) });
    await expect(header).toContainText(startedRun.id.slice(0, 8));
    await expect(header.getByText("succeeded", { exact: true })).toBeVisible({
      timeout: 300_000,
    });

    for (const stage of [
      "brand classification",
      "ctr curves",
      "historical volume",
      "demand signals",
      "serp collection",
      "authority",
      "backlinks",
      "link power score",
      "ranking url",
      "site architecture",
    ]) {
      await expect(page.getByText(stage, { exact: true })).toBeVisible();
    }
    await expect(page.getByText("Top clusters")).toBeVisible();
    await expect(page.locator("p").filter({ hasText: /^Categories$/ })).toBeVisible();
    await expect(page.getByText("Quarter plan")).toBeVisible();
    await expect(page.getByText("Demand trend")).toBeVisible();
    await expect(page.getByText("Cluster-deduped opportunity").first()).toBeVisible();
    await page.screenshot({
      fullPage: true,
      path: path.join(artifactDirectory!, "02-pipeline-succeeded-and-rollups.png"),
    });

    expect(consoleErrors.filter((message) => !message.startsWith("Failed to load resource:"))).toEqual([]);
    expect(firstPartyFailures).toEqual([]);
    expect(transientStatusFailures.length).toBeLessThanOrEqual(1);
  });
});
