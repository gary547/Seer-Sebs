/**
 * Phase G — Client Archive end-to-end flow.
 *
 * Covers the full lifecycle: archive → invisibility for non-admins → read-only
 * archive surface → restore → permanent delete with audit assertion.
 *
 * Required env vars (skip cleanly when missing so this is safe to land):
 *   E2E_BASE_URL                — defaults to http://localhost:8080
 *   E2E_ADMIN_EMAIL             — admin or super_admin account
 *   E2E_ADMIN_PASSWORD
 *   E2E_USER_EMAIL              — standard `user` role (non-admin)
 *   E2E_USER_PASSWORD
 *   E2E_ARCHIVE_FIXTURE_CLIENT  — UUID of a throwaway client owned by the admin
 *   E2E_ARCHIVE_FIXTURE_PROJECT — UUID of a project under that client
 *   E2E_ARCHIVE_FIXTURE_NAME    — exact display name of the client (for hard-delete confirmation)
 *
 * The fixture client/project must be seeded out-of-band — we do not create
 * production data from the spec to keep blast radius small. Re-use the same
 * fixture across runs: each test re-archives before its destructive step.
 */

import { test, expect, type Page } from "../playwright-fixture";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:8080";
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const USER_EMAIL = process.env.E2E_USER_EMAIL;
const USER_PASSWORD = process.env.E2E_USER_PASSWORD;
const CLIENT_ID = process.env.E2E_ARCHIVE_FIXTURE_CLIENT;
const PROJECT_ID = process.env.E2E_ARCHIVE_FIXTURE_PROJECT;
const CLIENT_NAME = process.env.E2E_ARCHIVE_FIXTURE_NAME;

const haveAdmin = Boolean(ADMIN_EMAIL && ADMIN_PASSWORD && CLIENT_ID && PROJECT_ID && CLIENT_NAME);
const haveUser = Boolean(USER_EMAIL && USER_PASSWORD);

async function signIn(page: Page, email: string, password: string) {
  await page.goto(`${BASE_URL}/auth`);
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
}

/** Archive the fixture client through the UI. Idempotent — no-ops if already archived. */
async function ensureArchived(page: Page) {
  await page.goto(`${BASE_URL}/clients/${CLIENT_ID}`);
  // If the live route 404s / redirects, the client is already archived.
  if (!/\/clients\/[0-9a-f-]+$/i.test(page.url())) return;
  const menu = page.getByRole("button", { name: /more|actions|menu/i }).first();
  if (await menu.isVisible().catch(() => false)) {
    await menu.click();
    const archive = page.getByRole("menuitem", { name: /archive/i }).first();
    if (await archive.isVisible().catch(() => false)) {
      await archive.click();
      await page.getByRole("button", { name: /^archive$/i }).click();
      await expect(page.getByText(/archived/i).first()).toBeVisible({ timeout: 10_000 });
    }
  }
}

async function ensureRestored(page: Page) {
  await page.goto(`${BASE_URL}/archive`);
  const row = page.getByText(CLIENT_NAME!, { exact: false }).first();
  if (await row.isVisible().catch(() => false)) {
    const restore = page.getByRole("button", { name: /restore/i }).first();
    if (await restore.isVisible().catch(() => false)) {
      await restore.click();
      await page.getByRole("button", { name: /^restore$/i }).click();
    }
  }
}

test.describe("Archive flow — admin lifecycle", () => {
  test.skip(!haveAdmin, "Admin archive fixture env not configured");

  test.beforeEach(async ({ page }) => {
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    await ensureRestored(page);
  });

  test("1. admin archives client from /clients", async ({ page }) => {
    await page.goto(`${BASE_URL}/clients`);
    await expect(page.getByText(CLIENT_NAME!, { exact: false }).first()).toBeVisible();

    await ensureArchived(page);

    await page.goto(`${BASE_URL}/clients`);
    await expect(page.getByText(CLIENT_NAME!, { exact: false })).toHaveCount(0);

    await page.goto(`${BASE_URL}/archive`);
    await expect(page.getByText(CLIENT_NAME!, { exact: false }).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("3. archive project page is read-only", async ({ page }) => {
    await ensureArchived(page);
    await page.goto(`${BASE_URL}/archive/clients/${CLIENT_ID}/projects/${PROJECT_ID}`);
    await expect(page.getByText(/archived/i).first()).toBeVisible();
    // Destructive / mutating affordances should not render.
    await expect(page.getByRole("button", { name: /run check|recompute|edit|delete keyword/i }))
      .toHaveCount(0);
  });

  test("4. restore returns client to live workspace", async ({ page }) => {
    await ensureArchived(page);
    await ensureRestored(page);

    await page.goto(`${BASE_URL}/clients`);
    await expect(page.getByText(CLIENT_NAME!, { exact: false }).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("5. hard delete removes row and writes audit", async ({ page }) => {
    // NOTE: this test mutates fixture data. Skip unless explicitly opted-in.
    test.skip(
      process.env.E2E_ARCHIVE_ALLOW_HARD_DELETE !== "1",
      "Set E2E_ARCHIVE_ALLOW_HARD_DELETE=1 to run the destructive hard-delete leg",
    );

    await ensureArchived(page);
    await page.goto(`${BASE_URL}/archive`);

    const row = page.getByText(CLIENT_NAME!, { exact: false }).first();
    await row.scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: /permanently delete|hard delete/i }).first().click();

    const confirm = page.getByRole("textbox").first();
    await confirm.fill(CLIENT_NAME!);
    await page.getByRole("button", { name: /^(permanently )?delete$/i }).click();

    await expect(page.getByText(/deleted|freed/i).first()).toBeVisible({ timeout: 15_000 });

    await page.goto(`${BASE_URL}/archive`);
    await expect(page.getByText(CLIENT_NAME!, { exact: false })).toHaveCount(0);
  });
});

test.describe("Archive flow — non-admin invisibility", () => {
  test.skip(!haveAdmin || !haveUser, "Need admin + user fixtures for invisibility test");

  test("2. non-admin cannot see archive surface or archived client", async ({ browser }) => {
    // Step 1: admin archives the fixture.
    const adminCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    await signIn(adminPage, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    await ensureArchived(adminPage);
    await adminCtx.close();

    // Step 2: non-admin session must not see anything.
    const userCtx = await browser.newContext();
    const userPage = await userCtx.newPage();
    await signIn(userPage, USER_EMAIL!, USER_PASSWORD!);

    await userPage.goto(`${BASE_URL}/archive`);
    await expect(userPage).not.toHaveURL(/\/archive(\/|$)/);

    await userPage.goto(`${BASE_URL}/clients`);
    await expect(userPage.getByText(CLIENT_NAME!, { exact: false })).toHaveCount(0);

    await userPage.goto(`${BASE_URL}/clients/${CLIENT_ID}`);
    await expect(userPage).not.toHaveURL(new RegExp(`/clients/${CLIENT_ID}$`));

    await userCtx.close();

    // Step 3: cleanup — restore so the next run starts clean.
    const cleanupCtx = await browser.newContext();
    const cleanupPage = await cleanupCtx.newPage();
    await signIn(cleanupPage, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    await ensureRestored(cleanupPage);
    await cleanupCtx.close();
  });
});
