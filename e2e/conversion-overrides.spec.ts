import { expect, test } from "@playwright/test";

const projectId = "00000000-0000-4000-8000-000000000003";
const overrideId = "00000000-0000-4000-8000-000000000004";

test("selects a project category and saves its forecast assumptions", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("seer-gcp-local-session", JSON.stringify({
      expiresAt: "2099-01-01T00:00:00.000Z",
      token: "e2e-admin-token",
      user: {
        email: "e2e-admin@example.dev",
        id: "00000000-0000-4000-8000-000000000001",
      },
    }));
  });

  let saved: Record<string, unknown> | null = null;
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({
      body: JSON.stringify(body),
      contentType: "application/json",
      status: 200,
    });

    if (path === "/v1/me") return json({
      approvalStatus: "approved",
      createdAt: "2026-09-24T00:00:00.000Z",
      email: "e2e-admin@example.dev",
      emailVerified: true,
      fullName: "E2E Admin",
      id: "00000000-0000-4000-8000-000000000001",
      notifyUrlMonitor: false,
      rejectionReason: null,
      role: "admin",
      themePreference: "light",
    });
    if (path === `/v1/projects/${projectId}/summary`) return json({
      client_id: "00000000-0000-4000-8000-000000000002",
      client_name: "No Brainer",
      id: projectId,
      project_name: "AO",
    });
    if (path === `/v1/projects/${projectId}/conversion-overrides`) return json({
      categories: [
        { category: "Ovens", keywordCount: 4 },
        { category: "Refrigeration", keywordCount: 5 },
      ],
      overrides: saved ? [{
        ...saved,
        id: overrideId,
        updated_at: "2026-09-24T00:00:00.000Z",
      }] : [],
    });
    if (path === "/v1/conversion-overrides" && route.request().method() === "POST") {
      saved = route.request().postDataJSON();
      return json({ ...saved, id: overrideId });
    }
    return route.fulfill({
      body: JSON.stringify({ error: { code: "not_found", message: path } }),
      contentType: "application/json",
      status: 404,
    });
  });

  await page.goto(`/admin/projects/${projectId}/conversion-overrides`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Conversion overrides" })).toBeVisible();
  await page.getByRole("button", { name: "New override" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Scope" }).click();
  await page.getByRole("option", { name: "category" }).click();
  await dialog.getByRole("combobox", { name: "Category" }).click();
  await page.getByPlaceholder("Search categories…").fill("refrig");
  await page.getByRole("option", { name: /Refrigeration/ }).click();
  await expect(dialog.getByText("5 kept keywords match this category.", { exact: false })).toBeVisible();
  await dialog.getByRole("spinbutton", { name: "Conversion rate (%)" }).fill("2.5");
  await dialog.getByRole("spinbutton", { name: "Average order value" }).fill("400");
  await dialog.getByRole("textbox", { name: /Note/ }).fill("Client supplied category assumptions");
  await page.screenshot({ path: "test-results/conversion-overrides-category-dialog.png" });
  await dialog.getByRole("button", { name: "Create override" }).click();

  await expect(dialog).not.toBeVisible();
  expect(saved).toMatchObject({
    project_id: projectId,
    scope_type: "category",
    scope_value: "Refrigeration",
    conversion_rate: 0.025,
    average_order_value: 400,
    note: "Client supplied category assumptions",
  });
  await expect(page.getByRole("row", { name: /Refrigeration/ })).toContainText("5");
});
