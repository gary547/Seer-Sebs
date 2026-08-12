import { expect, test } from "@playwright/test";

const projectId = "00000000-0000-4000-8000-000000000003";
const runId = "00000000-0000-4000-8000-000000000004";
const completedAt = "2026-08-12T10:00:00.000Z";
const artifactDirectory = process.env.E2E_ARTIFACT_DIR;

const sectionTitles = [
  "GSC data readiness",
  "CTR curves (v2)",
  "Calibration (modelled vs actual)",
  "base_rank source reconciliation",
  "DFS cluster keys (core_keyword backfill)",
  "Keyword clustering (form-based)",
  "Volume History",
  "Demand signals",
  "Demand intelligence",
  "SERP visibility v2 preview",
  "Link Power Score",
  "Content-fit diagnostics",
  "HAR v1 vs v2 comparison",
  "Revenue v1 vs v2 comparison",
  "Brand classification",
  "Recent runs",
] as const;

test("renders and opens every restored calculation panel", async ({ page }) => {
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
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (body: unknown) => route.fulfill({
      body: JSON.stringify(body),
      contentType: "application/json",
      status: 200,
    });

    if (path === "/v1/me") return json({ approvalStatus: "approved", createdAt: completedAt, email: "e2e-admin@example.dev", emailVerified: true, fullName: "E2E Admin", id: "00000000-0000-4000-8000-000000000001", notifyUrlMonitor: false, rejectionReason: null, role: "admin", themePreference: "light" });
    if (path === "/v1/projects") return json({ projects: [{ archived_at: null, client_archived_at: null, client_name: "No Brainer", id: projectId, project_name: "Seer" }] });
    if (path === `/v1/projects/${projectId}/calculations`) return json({ calibration: { byIntent: { informational: { ratio: 1.04 } }, byRankBand: { "1-3": { ratio: 0.98 } }, matched: 180, modelVersion: "calibration_v2", overallRatio: 1.02, promotionEligible: true, status: "green" }, completedAt, har: [{ averageConfidence: 0.82, averageHarPosition: 6, forecastCount: 10, modelVersion: "har_v2", scenario: "realistic" }], opportunities: [], projectId, revenue: [{ expectedIncremental: 120000, forecastCount: 10, scenario: "realistic", targetIncremental: 160000 }], runId, siteActions: [] });
    if (path === `/v1/projects/${projectId}/ctr-curves`) return json({ completedAt, curves: [{ device: "mobile", isBranded: false, points: [{ confidence: "high", ctr: 0.32, impressions: 10000, rank: 1, source: "gsc" }], searchIntent: "commercial" }], projectId, runId });
    if (path === `/v1/projects/${projectId}/pipeline-runs`) return json({ projectId, run: { completedAt, createdAt: completedAt, deliveredEventCount: 19, id: runId, input: { projectId }, stages: [], startedAt: completedAt, status: "succeeded" } });
    if (path === `/v1/projects/${projectId}/link-power-inspector`) return json({ completedAt, domains: [], items: [{ backlinks: 100, confidence: "high", domain: "seer.example", domainRating: 70, isClientDomain: true, keyword: "seo agency", keywordId: "00000000-0000-4000-8000-000000000006", rank: 4, referringDomains: 20, score: 72, url: "https://seer.example/seo", urlRating: 55 }], limit: 50, offset: 0, projectId, runId, search: "", summary: { averageScore: 72, confidence: { high: 1, low: 0, medium: 0 }, keywordCount: 1, p10: 72, p50: 72, p90: 72, scoredCount: 1 }, total: 1 });
    if (path === `/v1/projects/${projectId}/calculation-control`) return json({
      archived: false,
      baseRank: { missing: 1, sources: { gsc: 9 }, total: 10, withRank: 9 },
      brandClassification: { brandTerms: ["Seer"], branded: 2, total: 10, unbranded: 7, unclassified: 1 },
      clustering: { canonicalBases: { volume: 3 }, clusterCount: 3, largestCluster: 5, memberCount: 10, multiMemberCount: 2, topClusters: [{ canonicalKeyword: "seo agency", clusterKey: "seo-agency", memberCount: 5 }] },
      comparisons: { averageHarDelta: 1.5, comparableHarCount: 1, comparableRevenueCount: 1, items: [{ currentRevenueV1: 100, currentRevenueV2: 120, harV1: 7, harV2: 5, keyword: "seo agency", keywordId: "00000000-0000-4000-8000-000000000006", targetIncrementalRevenueV1: 500, targetIncrementalRevenueV2: 650 }], keywordCount: 1 },
      contentFit: { averageScore: 72, matched: 9, missing: 1, scored: 9, total: 10, zero: 1, zeroRows: [{ keyword: "missing page", rankingUrl: null, tacticalStatus: "create_content" }] },
      demand: { averageCoverageMonths: 23.4, categories: [{ category: "SEO", keywordCount: 10, monthlyVolume: 12000, warningCount: 1 }], signals: 10, trendDirections: { growing: 8, stable: 2 }, warnings: 1 },
      generatedAt: completedAt,
      gscReadiness: { uploads: [{ createdAt: completedAt, dateRangeEnd: "2026-06-30", dateRangeStart: "2026-04-01", device: "mobile", id: "00000000-0000-4000-8000-000000000005", originalFilename: "gsc.xlsx", pageRows: 8, queryRows: 240, rowCount: 240, sourceName: "gsc_workbook_v1" }] },
      latestSuccessfulRun: { completedAt, id: runId },
      projectId,
      recentRuns: [{ completedAt, createdAt: completedAt, failureStage: null, id: runId, startedAt: completedAt, status: "succeeded" }],
      serpVisibility: { averageMultiplier: 0.82, featureCount: 16, featureTypes: [{ count: 10, ownedCount: 2, resultType: "organic" }], keywordCount: 10, ownedCount: 2 },
      volumeHistory: { earliestMonth: "2024-01-01", historyRows: 240, keptKeywords: 10, latestMonth: "2025-12-01", maximumMonths: 24, medianMonths: 24, minimumMonths: 0, sample: [{ keyword: "seo agency", keywordId: "00000000-0000-4000-8000-000000000006", monthCount: 24, months: [{ month: "2025-12-01", volume: 1200 }] }], with12Months: 9, with24Months: 8, withHistory: 9 },
    });
    return route.fulfill({ body: JSON.stringify({ error: { code: "not_found", message: path } }), contentType: "application/json", status: 404 });
  });

  await page.goto(`/admin/calculations?projectId=${projectId}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Calculation Runs (v2)" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Conversion overrides" })).toBeVisible();

  for (const title of sectionTitles) {
    const trigger = page.locator('button[aria-expanded]').filter({ hasText: title });
    await expect(trigger).toBeVisible();
    if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
  }

  await expect(page.getByText("seo-agency", { exact: true })).toBeVisible();
  await expect(page.getByText("Migration archive", { exact: true })).toBeVisible();
  await expect(page.getByText("seer.example", { exact: true })).toBeVisible();
  await expect(page.getByText("create_content", { exact: true })).toBeVisible();
  if (artifactDirectory) {
    await page.screenshot({
      fullPage: true,
      path: `${artifactDirectory}/calculation-control-all-panels.png`,
    });
  }
});
