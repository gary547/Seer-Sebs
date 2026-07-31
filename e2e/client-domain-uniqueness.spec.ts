/**
 * Phase 2A/2B — Client domain uniqueness end-to-end.
 *
 * Covers the four canonical cases from the Phase 2B plan:
 *   1. Duplicate live domain (scheme + trailing slash) blocked with inline error.
 *   2. All normalisation variants collapse to the same canonical value.
 *   3. Archive frees the domain; restoring the archived client is rejected
 *      with the friendly "domain already used" toast.
 *   4. Editing a live client and saving without changing the domain does not
 *      false-positive.
 *
 * Skips cleanly when the admin fixture env vars are missing so this is safe
 * to land without CI wiring.
 *
 * Required env vars:
 *   E2E_BASE_URL                 — defaults to http://localhost:8080
 *   E2E_ADMIN_EMAIL              — admin or super_admin
 *   E2E_ADMIN_PASSWORD
 *   E2E_DOMAIN_FIXTURE_CLIENT    — UUID of a throwaway client we can archive/edit
 *   E2E_DOMAIN_FIXTURE_NAME      — its display name
 *   E2E_DOMAIN_FIXTURE_DOMAIN    — its canonical domain (e.g. pilltime.co.uk)
 */

import { test, expect, type Page } from "../playwright-fixture";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:8080";
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const FIXTURE_CLIENT = process.env.E2E_DOMAIN_FIXTURE_CLIENT;
const FIXTURE_NAME = process.env.E2E_DOMAIN_FIXTURE_NAME;
const FIXTURE_DOMAIN = process.env.E2E_DOMAIN_FIXTURE_DOMAIN;

const ready = Boolean(ADMIN_EMAIL && ADMIN_PASSWORD && FIXTURE_CLIENT && FIXTURE_NAME && FIXTURE_DOMAIN);

async function signIn(page: Page, email: string, password: string) {
  await page.goto(`${BASE_URL}/auth`);
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/auth"), { timeout: 15_000 });
}

async function openCreateClient(page: Page) {
  await page.goto(`${BASE_URL}/clients/new`);
  await page.waitForLoadState("domcontentloaded");
}

test.describe("Client domain uniqueness", () => {
  test.skip(!ready, "Domain uniqueness fixture env vars not set");

  test("case 1 — duplicate with scheme + trailing slash is blocked", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    await openCreateClient(page);

    await page.getByLabel(/company name/i).fill(`Dup Test ${Date.now()}`);
    await page.getByLabel(/domain|website/i).fill(`https://${FIXTURE_DOMAIN}/`);
    await page.getByLabel(/domain|website/i).blur();

    // Pre-flight should surface the inline conflict with an "Open workspace" link.
    await expect(page.getByText(/already exists/i)).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("link", { name: /open workspace/i })).toBeVisible();
  });

  test("case 2 — normalisation variants collapse to the same canonical value", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);

    const variants = [
      `www.${FIXTURE_DOMAIN.toUpperCase()}`,
      `${FIXTURE_DOMAIN}/`,
      `http://${FIXTURE_DOMAIN}`,
      FIXTURE_DOMAIN.toUpperCase(),
    ];

    for (const variant of variants) {
      await openCreateClient(page);
      await page.getByLabel(/company name/i).fill(`Variant ${Date.now()}`);
      await page.getByLabel(/domain|website/i).fill(variant);
      await page.getByLabel(/domain|website/i).blur();
      await expect(page.getByText(/already exists/i)).toBeVisible({ timeout: 5_000 });
    }
  });

  test("case 3 — archive frees domain; restore is rejected with friendly toast", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);

    // Archive the fixture client via the admin archive surface.
    await page.goto(`${BASE_URL}/clients/${FIXTURE_CLIENT}`);
    await page.getByRole("button", { name: /archive/i }).first().click();
    await page.getByRole("button", { name: /^archive$/i }).click();
    await expect(page.getByText(/moved to \/archive/i)).toBeVisible();

    // Create a new client re-using the freed domain.
    const replacementName = `Replacement ${Date.now()}`;
    await openCreateClient(page);
    await page.getByLabel(/company name/i).fill(replacementName);
    await page.getByLabel(/domain|website/i).fill(FIXTURE_DOMAIN!);
    await page.getByRole("button", { name: /create|save/i }).click();
    await expect(page).toHaveURL(/\/clients\/[a-f0-9-]+/i);

    // Attempt to restore the original — should be rejected with the friendly guard message.
    await page.goto(`${BASE_URL}/archive`);
    await page.getByText(FIXTURE_NAME!, { exact: false }).first().click();
    await page.getByRole("button", { name: /restore/i }).click();
    await expect(
      page.getByText(/already used by another live client/i),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("case 4 — editing without changing the domain does not false-positive", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    await page.goto(`${BASE_URL}/clients/${FIXTURE_CLIENT}/edit`);
    await page.waitForLoadState("domcontentloaded");

    // Touch a non-domain field and save.
    const industry = page.getByLabel(/industry/i);
    if (await industry.count()) {
      await industry.fill(`Industry ${Date.now()}`);
    }
    await page.getByRole("button", { name: /save|update/i }).click();

    // No conflict banner should surface — pre-flight must exclude the current client id.
    await expect(page.getByText(/already exists/i)).toHaveCount(0);
    await expect(page.getByText(/saved|updated/i)).toBeVisible({ timeout: 5_000 });
  });
});
