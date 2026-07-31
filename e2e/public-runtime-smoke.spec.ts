import { expect, test } from "@playwright/test";

test("production build renders the public auth route without runtime errors", async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));

  await page.goto("/auth");

  await expect(page).toHaveURL(/\/auth$/);
  await expect(page.getByRole("heading", { name: "Open Seer®" })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});
