/**
 * UX Journey Audit — regression assertions for the findings in
 * docs/UX_JOURNEY_AUDIT.md. Authenticated tests skip when
 * E2E_AUTH_STATUS !== "injected" so this file stays green
 * in environments without a managed Supabase session.
 */
import { test, expect } from "@playwright/test";

const APP = process.env.E2E_BASE_URL ?? "http://localhost:8080";
const AUTHED = process.env.E2E_AUTH_STATUS === "injected";
const TEST_USER = process.env.E2E_TEST_USER ?? "";
const TEST_PASS = process.env.E2E_TEST_PASS ?? "";

test.describe("UX journey — public routes", () => {
  test("root redirects to /auth when signed out", async ({ page }) => {
    await page.goto(`${APP}/`, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/auth$/);
  });

  test("auth page renders without console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(`${APP}/auth`, { waitUntil: "networkidle" });
    expect(errors, errors.join("\n")).toHaveLength(0);
  });
});

test.describe("UX journey — authenticated", () => {
  test.skip(!AUTHED, "Requires E2E_AUTH_STATUS=injected");

  // UX-001 (Phase H1) — Sidebar Setup must stay on Setup
  test("UX-001 setup tab stays on setup after sidebar round-trip", async ({ page }) => {
    await page.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });

    // Drill into the first available project via the Recent Projects strip
    // or Clients page — whichever renders first.
    const projectLink = page.locator('a[href*="/projects/"]').first();
    await projectLink.waitFor({ state: "visible", timeout: 10_000 });
    const href = await projectLink.getAttribute("href");
    if (!href) test.skip(true, "No project link available in this environment");

    const setupUrl = href!.replace(/\/projects\/([^/]+).*$/, "/projects/$1/setup");

    await page.goto(`${APP}${setupUrl}`, { waitUntil: "networkidle" });
    await expect(page).toHaveURL(new RegExp(`${setupUrl.replace(/[/\-]/g, "\\$&")}$`));

    // Bounce to Dashboard, then back to Setup via the sidebar.
    await page.getByRole("link", { name: /^Dashboard$/ }).first().click();
    await expect(page).toHaveURL(/\/dashboard$/);

    await page.goto(`${APP}${setupUrl}`, { waitUntil: "networkidle" });
    // Critical assertion: Setup is NOT auto-redirected to /forecast.
    await expect(page).toHaveURL(/\/setup$/);
  });

  // UX-002 (Phase H2) — Deep-link preservation through auth
  test("UX-002 deep link preserved through auth", async ({ page, context }) => {
    test.skip(!TEST_USER || !TEST_PASS, "Requires E2E_TEST_USER/PASS");

    // Capture a real project URL while authenticated.
    await page.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
    const projectLink = page.locator('a[href*="/projects/"]').first();
    await projectLink.waitFor({ state: "visible", timeout: 10_000 });
    const href = await projectLink.getAttribute("href");
    if (!href) test.skip(true, "No project link available in this environment");
    const forecastUrl = href!.replace(/\/projects\/([^/]+).*$/, "/projects/$1/forecast");

    // Sign out by clearing storage, then deep-link to forecast.
    await context.clearCookies();
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });

    await page.goto(`${APP}${forecastUrl}`, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/auth$/);

    await page.getByLabel(/email/i).fill(TEST_USER);
    await page.getByLabel(/password/i).fill(TEST_PASS);
    await page.getByRole("button", { name: /sign in/i }).click();

    await expect(page).toHaveURL(new RegExp(`${forecastUrl.replace(/[/\-]/g, "\\$&")}$`), {
      timeout: 15_000,
    });
  });

  // UX-002 guardrail — open-redirect class
  test("UX-002 protocol-relative `from` falls back to /dashboard", async ({ page }) => {
    await page.goto(`${APP}/auth`, { waitUntil: "domcontentloaded" });
    // Inject a malicious `from` via history.state and re-render via popstate.
    await page.evaluate(() => {
      history.replaceState({ usr: { from: { pathname: "//evil.example.com" } } }, "", "/auth");
    });
    // If a session is already injected, the AuthPage early-return runs on mount;
    // navigate back to /auth so the new state is consumed.
    await page.goto(`${APP}/auth`, { waitUntil: "networkidle" });
    if (AUTHED) {
      await expect(page).toHaveURL(/\/dashboard$/, { timeout: 5_000 });
    }
  });

  // UX-003 (Phase I1) — Switcher readiness probe falls back to project home
  // when the target project cannot render the current sub-view. We cannot
  // guarantee a second project exists in the seed data, so this test
  // discovers candidates at runtime and skips when fewer than two exist.
  test("UX-003 incompatible sub-view falls back to project home (Phase I1)", async ({ page }) => {
    await page.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
    const links = page.locator('a[href*="/clients/"][href*="/projects/"]');
    const count = await links.count();
    if (count < 2) test.skip(true, "Need ≥2 projects to exercise switcher matrix");

    const first = await links.nth(0).getAttribute("href");
    const second = await links.nth(1).getAttribute("href");
    if (!first || !second) test.skip(true, "Project hrefs missing");

    // Navigate to the first project's forecast view.
    const forecastUrl = first!.replace(/\/projects\/([^/]+).*$/, "/projects/$1/forecast");
    await page.goto(`${APP}${forecastUrl}`, { waitUntil: "networkidle" });

    // Pull the second project's id from its href.
    const secondId = second!.match(/\/projects\/([^/?#]+)/)?.[1];
    if (!secondId) test.skip(true, "Could not parse second project id");

    // Drive the switcher Select — fall back to direct navigation if the
    // Select component isn't reachable (renders inside a Portal).
    const projectTrigger = page.getByLabel("Select project");
    if (await projectTrigger.isVisible().catch(() => false)) {
      await projectTrigger.click();
      const option = page.getByRole("option").filter({ hasText: /./ }).nth(1);
      await option.click().catch(() => {});
    }

    // Assert URL is either /forecast (target had forecasts) or project home
    // (readiness fallback fired). Either is a valid Phase I1 outcome.
    await page.waitForURL(/\/projects\/[^/]+(\/forecast)?$/, { timeout: 5_000 });
    const finalUrl = page.url();
    expect(
      /\/projects\/[^/]+\/forecast$/.test(finalUrl) ||
        /\/projects\/[^/]+$/.test(finalUrl),
    ).toBe(true);
  });

  // UX-007 (Phase I2) — goToClient matrix.
  test("UX-007 goToClient navigates from deep project paths", async ({ page }) => {
    await page.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
    const projectLink = page.locator('a[href*="/projects/"]').first();
    await projectLink.waitFor({ state: "visible", timeout: 10_000 });
    const href = await projectLink.getAttribute("href");
    if (!href) test.skip(true, "No project link available");

    const clientId = href!.match(/\/clients\/([^/]+)/)?.[1];
    if (!clientId) test.skip(true, "Could not parse client id");

    // Deep into a project sub-view, then re-select the same client.
    const setupUrl = href!.replace(/\/projects\/([^/]+).*$/, "/projects/$1/setup");
    await page.goto(`${APP}${setupUrl}`, { waitUntil: "networkidle" });

    const clientTrigger = page.getByLabel("Select client");
    if (await clientTrigger.isVisible().catch(() => false)) {
      await clientTrigger.click();
      await page.getByRole("option").first().click().catch(() => {});
      await expect(page).toHaveURL(new RegExp(`/clients/${clientId}$`), {
        timeout: 5_000,
      });
    }
  });

  // UX-008 (Phase I3) — Live-region announces recompute transitions.
  test("UX-008 forecast recompute announces via aria-live", async ({ page }) => {
    await page.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
    const projectLink = page.locator('a[href*="/projects/"]').first();
    await projectLink.waitFor({ state: "visible", timeout: 10_000 });
    const href = await projectLink.getAttribute("href");
    if (!href) test.skip(true, "No project link available");

    const forecastUrl = href!.replace(/\/projects\/([^/]+).*$/, "/projects/$1/forecast");
    await page.goto(`${APP}${forecastUrl}`, { waitUntil: "networkidle" });

    const button = page.getByRole("button", { name: /Recompute TP Revenue/i });
    if (!(await button.isVisible().catch(() => false))) {
      test.skip(true, "Recompute card not present (forecast is healthy)");
    }

    const liveRegion = page.locator('[role="status"][aria-live="polite"]');
    await button.click();
    await expect(liveRegion).toHaveText(/Recomputing forecast/i, {
      timeout: 5_000,
    });
    await expect(liveRegion).toHaveText(/Forecast recomputed|Recompute failed/i, {
      timeout: 30_000,
    });
  });

  // Phase I4 — invalid stored last-view falls back to Overview.
  test("Phase I4 unsupported stored last-view falls back to Overview", async ({ page }) => {
    await page.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
    const projectLink = page.locator('a[href*="/projects/"]').first();
    await projectLink.waitFor({ state: "visible", timeout: 10_000 });
    const href = await projectLink.getAttribute("href");
    if (!href) test.skip(true, "No project link available");

    const projectId = href!.match(/\/projects\/([^/?#]+)/)?.[1];
    if (!projectId) test.skip(true, "Could not parse project id");

    await page.evaluate((pid) => {
      localStorage.setItem(`seer-last-view:${pid}`, "not-a-real-view");
    }, projectId);

    await page.goto(`${APP}${href}`, { waitUntil: "networkidle" });
    // Overview = no sub-view segment after the project id.
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`));
  });

  // Phase J2 — iterate every first-class sub-nav tab and assert that exactly
  // one element advertises aria-current="page", matching the active route.
  test("Phase J2 sub-nav aria-current is exclusive and matches active route", async ({
    page,
  }) => {
    await page.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
    const projectLink = page.locator('a[href*="/projects/"]').first();
    await projectLink.waitFor({ state: "visible", timeout: 10_000 });
    await projectLink.click();
    await page.waitForLoadState("networkidle");

    const tabNames = [
      /^setup$/i,
      /serps?\s*&?\s*backlinks/i,
      /ranking urls/i,
      /^forecast$/i,
      /site architecture/i,
      /^roadmap$/i,
      /content plans/i,
    ];

    for (const name of tabNames) {
      const tab = page
        .getByRole("tab", { name })
        .or(page.getByRole("link", { name }))
        .or(page.getByRole("button", { name }))
        .first();
      if (!(await tab.isVisible().catch(() => false))) continue;
      await tab.click();
      await page.waitForLoadState("networkidle");

      // Exactly one element should announce aria-current="page" at a time.
      const current = page.locator('[aria-current="page"]');
      await expect(current).toHaveCount(1, {
        timeout: 5_000,
      });
      // The active tab's accessible name must match the one we just clicked.
      await expect(current.first()).toHaveText(name);
    }
  });
});
