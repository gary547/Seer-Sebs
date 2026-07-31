/**
 * Phase 9A — Navigation smoke suite
 *
 * Covers the new hierarchical IA:
 *   Global Dashboard → Client Dashboard → Project Workspace
 *
 * Auth model: uses the standard Playwright fixture re-exported from the repo
 * root `playwright-fixture.ts`. When env credentials for an approved
 * user are not present the tests skip rather than failing, so the file is safe
 * to land before fixture credentials are wired up.
 *
 * Required env vars (set in CI / local .env.test):
 *   E2E_BASE_URL          — defaults to http://localhost:8080
 *   E2E_USER_EMAIL        — an approved (non view_only) user
 *   E2E_USER_PASSWORD
 *   E2E_VIEW_ONLY_EMAIL   — optional, enables view_only CTA test
 *   E2E_VIEW_ONLY_PASSWORD
 *
 * Data assumptions: the approved account can see ≥ 1 client with ≥ 1
 * navigator_project. No specific client/project IDs are hard-coded — the suite
 * walks the UI to discover them.
 */

import { test, expect, type Page } from "../playwright-fixture";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:8080";
const EMAIL = process.env.E2E_USER_EMAIL;
const PASSWORD = process.env.E2E_USER_PASSWORD;
const VIEW_ONLY_EMAIL = process.env.E2E_VIEW_ONLY_EMAIL;
const VIEW_ONLY_PASSWORD = process.env.E2E_VIEW_ONLY_PASSWORD;

const PROJECT_PATH_RE =
  /\/clients\/[0-9a-f-]+\/projects\/[0-9a-f-]+(\/[a-z-]+)?$/i;
const CLIENT_PATH_RE = /\/clients\/[0-9a-f-]+$/i;

/**
 * Sign in via the /auth page. Replace with the project's preferred fixture
 * (e.g. storageState injection) once available — see TODO at top of file.
 */
async function signIn(page: Page, email: string, password: string) {
  await page.goto(`${BASE_URL}/auth`);
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
}

test.describe("Navigation smoke — approved user", () => {
  test.skip(!EMAIL || !PASSWORD, "E2E_USER_EMAIL / E2E_USER_PASSWORD not set");

  test.beforeEach(async ({ page }) => {
    await signIn(page, EMAIL!, PASSWORD!);
  });

  test("1. lands on /dashboard after sign-in", async ({ page }) => {
    await expect(page).toHaveURL(/\/dashboard$/);
    // Briefing OS hero — first H1 on the page.
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  });

  test("2-5. dashboard → client → project drill-down", async ({ page }) => {
    // Client Portfolio section renders client links of shape /clients/:id.
    const clientLink = page.locator('a[href^="/clients/"]').first();
    await expect(clientLink).toBeVisible();
    await clientLink.click();
    await expect(page).toHaveURL(CLIENT_PATH_RE);

    // Client dashboard lists project links.
    const projectLink = page.locator('a[href*="/projects/"]').first();
    await expect(projectLink).toBeVisible();
    await projectLink.click();
    await expect(page).toHaveURL(PROJECT_PATH_RE);
  });

  test("6-7. project sub-nav routes + history hygiene", async ({ page }) => {
    // Reach a project via the dashboard so prior history = /dashboard.
    await page.locator('a[href^="/clients/"]').first().click();
    await expect(page).toHaveURL(CLIENT_PATH_RE);
    const clientUrl = page.url();

    await page.locator('a[href*="/projects/"]').first().click();
    await expect(page).toHaveURL(PROJECT_PATH_RE);

    // Navigate to /forecast via sub-nav. The sub-nav uses role=tab or link.
    const forecastNav = page
      .getByRole("link", { name: /forecast/i })
      .or(page.getByRole("tab", { name: /forecast/i }))
      .first();
    await forecastNav.click();
    await expect(page).toHaveURL(/\/forecast$/);

    // Switch to /setup.
    const setupNav = page
      .getByRole("link", { name: /^setup$/i })
      .or(page.getByRole("tab", { name: /^setup$/i }))
      .first();
    await setupNav.click();
    await expect(page).toHaveURL(/\/setup$/);

    // History hygiene: in-project view switches use replace(), so one
    // browser back should land on the prior non-tab page (client dashboard).
    await page.goBack();
    await expect(page).toHaveURL(clientUrl);
  });

  test("8. header ClientProjectSwitcher exposes client + project menus", async ({
    page,
  }) => {
    await page.locator('a[href^="/clients/"]').first().click();
    await page.locator('a[href*="/projects/"]').first().click();
    await expect(page).toHaveURL(PROJECT_PATH_RE);

    // Switcher lives in the sticky AppLayout header. We don't assume exact
    // copy — open any combobox/button in the header banner that mentions
    // "client" or "switch".
    const switcher = page
      .getByRole("banner")
      .getByRole("button", { name: /client|switch|project/i })
      .first();
    await expect(switcher).toBeVisible();
    await switcher.click();
    // Menu/dialog opens — assert at least one option is rendered.
    await expect(
      page.getByRole("menu").or(page.getByRole("dialog")).first(),
    ).toBeVisible();
  });

  test("9. legacy /navigator/:id redirects to canonical project URL", async ({
    page,
  }) => {
    // Discover a real project id first.
    await page.locator('a[href^="/clients/"]').first().click();
    const projectAnchor = page.locator('a[href*="/projects/"]').first();
    const href = await projectAnchor.getAttribute("href");
    expect(href).toBeTruthy();
    const projectId = href!.match(/\/projects\/([0-9a-f-]+)/i)?.[1];
    expect(projectId, "could not extract project id from href").toBeTruthy();

    await page.goto(`${BASE_URL}/navigator/${projectId}`);
    await expect(page).toHaveURL(PROJECT_PATH_RE, { timeout: 10_000 });
  });

  // ── Phase G regressions ──────────────────────────────────────────────────

  test("11. project overview KPIs show real numeric text", async ({ page }) => {
    await page.locator('a[href^="/clients/"]').first().click();
    await page.locator('a[href*="/projects/"]').first().click();
    await expect(page).toHaveURL(PROJECT_PATH_RE);

    const labels = [
      /performance output/i,
      /tp revenue/i,
      /tp\s*[≤<=]\s*3|keywords at tp/i,
      /avg site relevancy|site relevancy/i,
    ];
    for (const label of labels) {
      // The KpiCard renders <label> + <value> stacked. Find any element
      // whose text matches the label, then assert a sibling/descendant of
      // the same card contains a number-like token (£, digit, or %).
      const card = page.locator("a, div").filter({ hasText: label }).first();
      await expect(card).toBeVisible({ timeout: 15_000 });
      const txt = (await card.innerText()).trim();
      expect(txt, `KPI '${label}' should expose numeric value, got: ${txt}`)
        .toMatch(/£|\d|%/);
      expect(txt).not.toMatch(/^…$|^—$/);
    }
  });

  test("12. project sub-nav lists all 7 first-class views + active aria-current", async ({
    page,
  }) => {
    await page.locator('a[href^="/clients/"]').first().click();
    await page.locator('a[href*="/projects/"]').first().click();
    await expect(page).toHaveURL(PROJECT_PATH_RE);

    const expected = [
      /^setup$/i,
      /serps?\s*&?\s*backlinks/i,
      /ranking urls/i,
      /^forecast$/i,
      /site architecture/i,
      /^roadmap$/i,
      /content plans/i,
    ];
    for (const name of expected) {
      const item = page
        .getByRole("tab", { name })
        .or(page.getByRole("link", { name }))
        .or(page.getByRole("button", { name }))
        .first();
      await expect(item, `sub-nav item ${name} should be visible`).toBeVisible();
    }

    // Active item announces aria-current="page" (Phase F a11y).
    await expect(page.locator('[aria-current="page"]').first()).toBeVisible();
  });

  test("13. scoped sidebar group only appears with project context", async ({
    page,
  }) => {
    // No project context on /dashboard.
    await expect(page).toHaveURL(/\/dashboard$/);
    const nav = page.getByRole("navigation").first();
    await expect(nav).toBeVisible();
    await expect(nav.getByText(/in context/i)).toHaveCount(0);

    // Drill into a project, then assert the scoped group appears.
    await page.locator('a[href^="/clients/"]').first().click();
    await page.locator('a[href*="/projects/"]').first().click();
    await expect(page).toHaveURL(PROJECT_PATH_RE);

    await expect(
      page.getByRole("navigation").first().getByText(/in context/i),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("14. legacy 'Seer® Projects' sidebar item is gone", async ({ page }) => {
    await expect(page).toHaveURL(/\/dashboard$/);
    const nav = page.getByRole("navigation").first();
    await expect(nav).toBeVisible();
    await expect(
      nav.getByRole("link", { name: /seer.*projects?/i }),
    ).toHaveCount(0);
  });

  test("15. legacy /navigator (no id) redirects away from /navigator", async ({
    page,
  }) => {
    await page.goto(`${BASE_URL}/navigator`);
    await page.waitForLoadState("domcontentloaded");
    await expect
      .poll(() => page.url(), { timeout: 10_000 })
      .not.toMatch(/\/navigator(\/|$)/);
  });

  test("16. scope chips render on Capture Window and Audience Insights", async ({
    page,
  }) => {
    const clientLink = page.locator('a[href^="/clients/"]').first();
    const href = await clientLink.getAttribute("href");
    const clientId = href?.match(/\/clients\/([0-9a-f-]+)/i)?.[1];
    expect(clientId, "could not discover a clientId from dashboard").toBeTruthy();

    for (const path of ["/capture-window", "/audience-insights"]) {
      await page.goto(`${BASE_URL}${path}?clientId=${clientId}`);
      await expect(page.getByText(/filtered to/i).first()).toBeVisible({
        timeout: 10_000,
      });
      await expect(
        page.getByRole("button", { name: /clear/i }).or(
          page.getByRole("link", { name: /clear/i }),
        ).first(),
      ).toBeVisible();
    }
  });
});

test.describe("Navigation smoke — view_only user", () => {
  test.skip(
    !VIEW_ONLY_EMAIL || !VIEW_ONLY_PASSWORD,
    "E2E_VIEW_ONLY_EMAIL / E2E_VIEW_ONLY_PASSWORD not set — view_only CTAs untested",
  );

  test("10. view_only user does not see create CTAs", async ({ page }) => {
    await signIn(page, VIEW_ONLY_EMAIL!, VIEW_ONLY_PASSWORD!);
    await expect(page).toHaveURL(/\/dashboard$/);

    // "New client" / "New Seer® project" buttons are gated by canEdit.
    await expect(
      page.getByRole("link", { name: /new client/i }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: /new seer.* project/i }),
    ).toHaveCount(0);
  });

  // Phase G — archive nav-item must not appear for non-admin roles.
  test("17. view_only does not see Archive sidebar item or palette action", async ({
    page,
  }) => {
    await signIn(page, VIEW_ONLY_EMAIL!, VIEW_ONLY_PASSWORD!);
    await expect(page).toHaveURL(/\/dashboard$/);

    const nav = page.getByRole("navigation").first();
    await expect(nav.getByRole("link", { name: /^archive$/i })).toHaveCount(0);

    // Open command palette (⌘K / Ctrl+K) and search.
    await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
    const palette = page.getByRole("dialog").first();
    if (await palette.isVisible().catch(() => false)) {
      await page.keyboard.type("archive");
      await expect(page.getByText(/go to archive/i)).toHaveCount(0);
    }
  });
});

// Phase G — Archive sidebar visibility for an admin account.
test.describe("Navigation smoke — admin archive item", () => {
  const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
  const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    "E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD not set — admin nav untested",
  );

  test("18. admin sees Archive sidebar item + palette action", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    await expect(page).toHaveURL(/\/dashboard$/);

    const nav = page.getByRole("navigation").first();
    await expect(
      nav.getByRole("link", { name: /^archive$/i }).first(),
    ).toBeVisible({ timeout: 10_000 });

    await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
    const palette = page.getByRole("dialog").first();
    if (await palette.isVisible().catch(() => false)) {
      await page.keyboard.type("archive");
      await expect(page.getByText(/go to archive/i).first()).toBeVisible({
        timeout: 5_000,
      });
    }
  });
});
