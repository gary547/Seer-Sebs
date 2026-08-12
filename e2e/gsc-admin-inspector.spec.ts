import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { parseGscWorkbookImport } from "../gcp/apps/api/src/gsc-workbook";

const PIPELINE_STAGE_IDS = [
  "intake",
  "gsc-promotion",
  "detox",
  "categorisation",
  "brand-classification",
  "keyword-enrichment",
  "ranking-url",
  "gsc-intent",
  "serp-collection",
  "authority",
  "backlinks",
  "site-architecture",
  "link-power-score",
  "demand-signals",
  "ctr-curves",
  "clustering",
  "har-v2",
  "revenue-v2",
  "calibration",
] as const;

const csvPath = process.env.E2E_GSC_CSV_PATH;
const artifactDirectory = process.env.E2E_ARTIFACT_DIR;
const projectId = "00000000-0000-4000-8000-000000000003";
const runId = "00000000-0000-4000-8000-000000000004";
const keywordId = "00000000-0000-4000-8000-000000000005";

test.describe("GSC upload and calculation inspection", () => {
  test.skip(!csvPath, "Requires E2E_GSC_CSV_PATH");

  test("uploads the supplied CSV and exposes the restored inspection panels", async ({
    page,
  }) => {
    let parsedUpload: ReturnType<typeof parseGscWorkbookImport> | null = null;
    const completedAt = "2026-08-12T10:00:00.000Z";

    await page.addInitScript(() => {
      localStorage.setItem(
        "seer-gcp-local-session",
        JSON.stringify({
          expiresAt: "2099-01-01T00:00:00.000Z",
          token: "e2e-admin-token",
          user: {
            email: "e2e-admin@example.dev",
            id: "00000000-0000-4000-8000-000000000001",
          },
        }),
      );
    });

    await page.route("**/v1/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const json = (body: unknown, status = 200) =>
        route.fulfill({
          body: JSON.stringify(body),
          contentType: "application/json",
          status,
        });

      if (path === "/v1/me") {
        return json({
          approvalStatus: "approved",
          createdAt: completedAt,
          email: "e2e-admin@example.dev",
          emailVerified: true,
          fullName: "E2E Admin",
          id: "00000000-0000-4000-8000-000000000001",
          notifyUrlMonitor: false,
          rejectionReason: null,
          role: "admin",
          themePreference: "light",
        });
      }
      if (path === "/v1/projects") {
        return json({
          projects: [
            {
              client_name: "Pilltime",
              id: projectId,
              project_name: "Pilltime · Weightloss",
            },
          ],
        });
      }
      if (path === "/v1/clients") {
        return json({
          clients: [
            {
              analytics_connected: false,
              archive_reason: null,
              archived_at: null,
              archived_by: null,
              brand_terms: ["pilltime"],
              brand_type: null,
              campaign_type: null,
              company_name: "Pilltime",
              created_at: completedAt,
              domain: "pilltime.co.uk",
              domain_normalized: "pilltime.co.uk",
              gsc_connected: true,
              id: "00000000-0000-4000-8000-000000000002",
              industry: "Healthcare",
              logo_url: null,
              team_members: null,
              updated_at: completedAt,
            },
          ],
        });
      }
      if (path === `/v1/projects/${projectId}`) {
        return json({
          calculationCounts: {
            calibrationSnapshots: 1,
            clusters: 23_787,
            ctrCurves: 12,
            demandSignals: 23_787,
            harForecasts: 71_361,
            linkPowerScores: 61_200,
            revenueForecasts: 71_361,
            siteArchitecture: 23_787,
          },
          gscRowCount: 23_787,
          id: projectId,
          keywordCount: 23_787,
          keywordStatusCounts: {
            categorised: 23_787,
            keep: 23_787,
            pending: 0,
            rankingUrls: 23_500,
            remove: 0,
            review: 0,
          },
          keywords: [],
          rules: {
            blacklist: [],
            competitorBrands: [],
            ownBrands: [],
            relevantTerms: [],
            whitelist: [],
          },
          serpResultCount: 61_200,
        });
      }
      if (path === `/v1/projects/${projectId}/calculations`) {
        return json({
          calibration: {
            matched: 1_280,
            modelVersion: "calibration_v2_1",
            promotionEligible: true,
            status: "green",
          },
          completedAt,
          har: [
            ["conservative", 23_787, 11.2, 0.72],
            ["realistic", 23_787, 7.8, 0.81],
            ["stretch", 23_787, 4.6, 0.68],
          ].map(([scenario, forecastCount, averageHarPosition, averageConfidence]) => ({
            averageConfidence,
            averageHarPosition,
            forecastCount,
            modelVersion: "har_v2_1",
            scenario,
          })),
          opportunities: [],
          projectId,
          revenue: [
            ["conservative", 250_000],
            ["realistic", 480_000],
            ["stretch", 780_000],
          ].map(([scenario, expectedIncremental]) => ({
            expectedIncremental,
            forecastCount: 23_787,
            scenario,
            targetIncremental: Number(expectedIncremental) * 1.2,
          })),
          runId,
          siteActions: [],
        });
      }
      if (path === `/v1/projects/${projectId}/ctr-curves`) {
        return json({ completedAt, curves: [], projectId, runId });
      }
      if (path === `/v1/projects/${projectId}/calculation-control`) {
        return json({
          archived: false,
          baseRank: { missing: 0, sources: { gsc: 23_787 }, total: 23_787, withRank: 23_787 },
          brandClassification: { brandTerms: ["pilltime"], branded: 850, total: 23_787, unbranded: 22_937, unclassified: 0 },
          clustering: { canonicalBases: { volume: 23_787 }, clusterCount: 23_787, largestCluster: 1, memberCount: 23_787, multiMemberCount: 0, topClusters: [] },
          comparisons: { averageHarDelta: null, comparableHarCount: 0, comparableRevenueCount: 0, items: [], keywordCount: 23_787 },
          contentFit: { averageScore: 72, matched: 23_500, missing: 287, scored: 23_500, total: 23_787, zero: 0, zeroRows: [] },
          demand: { averageCoverageMonths: 24, categories: [], signals: 23_787, trendDirections: { stable: 23_787 }, warnings: 0 },
          generatedAt: completedAt,
          gscReadiness: { uploads: [] },
          latestSuccessfulRun: { completedAt, id: runId },
          projectId,
          recentRuns: [{ completedAt, createdAt: completedAt, failureStage: null, id: runId, startedAt: completedAt, status: "succeeded" }],
          serpVisibility: { averageMultiplier: 0.92, featureCount: 0, featureTypes: [], keywordCount: 0, ownedCount: 0 },
          volumeHistory: { earliestMonth: "2024-01-01", historyRows: 570_888, keptKeywords: 23_787, latestMonth: "2025-12-01", maximumMonths: 24, medianMonths: 24, minimumMonths: 24, sample: [], with12Months: 23_787, with24Months: 23_787, withHistory: 23_787 },
        });
      }
      if (path === `/v1/projects/${projectId}/pipeline-runs`) {
        return json({
          projectId,
          run: {
            completedAt,
            createdAt: completedAt,
            deliveredEventCount: 19,
            id: runId,
            input: { projectId },
            stages: PIPELINE_STAGE_IDS.map((id) => ({
              attempts: 1,
              completedAt,
              dependencies: [],
              execution: "job",
              id,
              startedAt: completedAt,
              state: "succeeded",
            })),
            startedAt: completedAt,
            status: "succeeded",
          },
        });
      }
      if (path === `/v1/projects/${projectId}/calculation-inspector`) {
        const scenario = (harPosition: number, expected: number) => ({
          averageOrderValueOverrideId: null,
          contentFitScore: 0.84,
          conversionRateOverrideId: null,
          ctrNow: 0.012,
          ctrTarget: 0.082,
          currentRevenueAnnual: 12_400,
          expectedIncrementalAnnual: expected,
          explanation: { drivers: ["authority", "content fit", "CTR curve"] },
          harConfidence: 0.82,
          harPosition,
          linkPowerScore: 64.2,
          rankAttainmentProbability: 0.74,
          targetAbsoluteRevenueAnnual: 31_800,
          targetIncrementalRevenueAnnual: 19_400,
        });
        return json({
          completedAt,
          items: [
            {
              baseRank: 18,
              device: "mobile",
              keyword: "weight loss medication",
              keywordId,
              scenarios: {
                conservative: scenario(10, 8_200),
                realistic: scenario(6, 14_600),
                stretch: scenario(3, 22_900),
              },
            },
          ],
          limit: 50,
          offset: 0,
          projectId,
          runId,
          search: "",
          total: 1,
        });
      }
      if (path === `/v1/projects/${projectId}/link-power-inspector`) {
        return json({
          completedAt,
          domains: [
            {
              appearances: 420,
              bestRank: 1,
              domain: "pilltime.co.uk",
              isClientDomain: true,
              meanScore: 66.4,
            },
            {
              appearances: 385,
              bestRank: 1,
              domain: "boots.com",
              isClientDomain: false,
              meanScore: 78.1,
            },
          ],
          items: [
            {
              backlinks: 950,
              confidence: "high",
              domain: "pilltime.co.uk",
              domainRating: 68,
              isClientDomain: true,
              keyword: "weight loss medication",
              keywordId,
              rank: 7,
              referringDomains: 110,
              score: 72.4,
              url: "https://pilltime.co.uk/weight-loss",
              urlRating: 51,
            },
          ],
          limit: 50,
          offset: 0,
          projectId,
          runId,
          search: "",
          summary: {
            averageScore: 54.2,
            confidence: { high: 31_000, low: 7_200, medium: 23_000 },
            keywordCount: 23_787,
            p10: 20,
            p50: 55,
            p90: 88,
            scoredCount: 61_200,
          },
          total: 1,
        });
      }
      if (
        path === `/v1/projects/${projectId}/gsc-workbook` &&
        request.method() === "POST"
      ) {
        const body = request.postDataJSON();
        parsedUpload = parseGscWorkbookImport(body);
        return json({
          date_range_end: parsedUpload.dateRangeEnd,
          date_range_start: parsedUpload.dateRangeStart,
          pages_inserted: parsedUpload.pages.length,
          row_count: parsedUpload.rows.length,
          sheets_seen: parsedUpload.sheetsSeen,
          source: parsedUpload.sourceName,
          upload_device: parsedUpload.device,
          upload_id: "00000000-0000-4000-8000-000000000006",
          warnings: parsedUpload.warnings,
        }, 201);
      }
      return json({ error: { code: "not_found", message: path } }, 404);
    });

    await page.goto(`/admin/calculations?projectId=${projectId}`, {
      waitUntil: "networkidle",
    });
    await expect(page.getByRole("heading", { name: "Calculation Runs (v2)" })).toBeVisible();
    await expect(page.getByText("GSC data readiness")).toBeVisible();
    await expect(page.getByText("CTR curves (v2)")).toBeVisible();
    await expect(page.getByText("Link Power Score", { exact: true })).toBeVisible();

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(csvPath as string);
    const dateInputs = page.locator('input[type="date"]');
    await dateInputs.nth(0).fill("2025-03-21");
    await dateInputs.nth(1).fill("2026-08-01");
    await page.getByRole("button", { name: "Upload", exact: true }).click();

    await expect(page.getByText("Upload complete")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Rows imported:").locator("..")).toContainText("23,787");
    await expect(
      page.getByText("1,198 duplicate rows were merged into 23,787 unique GSC entries."),
    ).toBeVisible();
    expect(parsedUpload?.rows).toHaveLength(23_787);
    expect(parsedUpload?.warnings).toContain(
      "15 queries were skipped because it exceeded 200 characters.",
    );

    await page.getByText("Calibration (modelled vs actual)").click();
    await expect(page.getByText("Promotion eligible")).toBeVisible();
    await page.getByText("Link Power Score", { exact: true }).click();
    await expect(page.getByText("pilltime.co.uk", { exact: true }).last()).toBeVisible();

    if (artifactDirectory) {
      await page.screenshot({
        fullPage: true,
        path: `${artifactDirectory}/gsc-upload-and-calculation-inspectors.png`,
      });
    }
  });
});
