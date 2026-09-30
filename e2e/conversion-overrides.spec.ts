import { expect, test } from "@playwright/test";

const projectId = "00000000-0000-4000-8000-000000000003";
const overrideId = "00000000-0000-4000-8000-000000000004";

test("selects filtered categories together and saves separate forecast assumptions", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
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

  let saved: Array<Record<string, unknown>> = [];
  let categories = [
    { category: "Ovens", keywordCount: 4 },
    { category: "Refrigeration", keywordCount: 5 },
    { category: "Microwave Ovens", keywordCount: 3 },
    { category: "Microwave Parts", keywordCount: 2 },
  ];
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
    if (path === "/v1/clients") return json({
      clients: [{
        archived_at: null,
        id: "00000000-0000-4000-8000-000000000002",
        name: "No Brainer",
      }],
    });
    if (path === "/v1/projects") return json({
      projects: [{
        archived_at: null,
        client_id: "00000000-0000-4000-8000-000000000002",
        id: projectId,
        project_name: "AO",
      }],
    });
    if (path === `/v1/projects/${projectId}/summary`) return json({
      client_id: "00000000-0000-4000-8000-000000000002",
      client_name: "No Brainer",
      id: projectId,
      project_name: "AO",
    });
    if (path === `/v1/projects/${projectId}/conversion-overrides`) return json({
      categories,
      overrides: saved,
    });
    if (path === "/v1/conversion-overrides/categories" && route.request().method() === "POST") {
      const payload = route.request().postDataJSON();
      saved = payload.scope_values.map((scopeValue: string, index: number) => ({
        ...payload,
        id: `${overrideId.slice(0, -1)}${index + 4}`,
        scope_type: "category",
        scope_value: scopeValue,
        updated_at: "2026-09-24T00:00:00.000Z",
      }));
      return json({ created: saved.length, updated: 0 });
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
  await expect(dialog.getByText("4 individual categories · 14 kept keywords")).toBeVisible();
  await expect(dialog.getByRole("option").first()).toContainText("Refrigeration");
  await dialog.getByRole("button", { name: "A–Z" }).click();
  await expect(dialog.getByRole("option").first()).toContainText("Microwave Ovens");
  await dialog.getByRole("button", { name: "Most keywords" }).click();
  await dialog.getByRole("combobox", { name: "Search project categories" }).fill("microwave");
  await expect(dialog.getByRole("option")).toHaveCount(2);
  await dialog.getByRole("button", { name: "Select all in view" }).click();
  await expect(dialog.getByText("2 selected · 5 keywords")).toBeVisible();
  await dialog.getByRole("combobox", { name: "Search project categories" }).fill("refrig");
  await dialog.getByRole("button", { name: "Select all in view" }).click();
  await expect(dialog.getByText("3 selected · 10 keywords")).toBeVisible();
  await dialog.getByRole("button", { name: "Clear in view" }).click();
  await expect(dialog.getByText("2 selected · 5 keywords")).toBeVisible();
  await dialog.getByRole("spinbutton", { name: "Conversion rate (%)" }).fill("2.5");
  await dialog.getByRole("spinbutton", { name: "Average order value" }).fill("400");
  await dialog.getByRole("textbox", { name: /Note/ }).fill("Client supplied category assumptions");
  await page.screenshot({ path: "test-results/conversion-overrides-category-dialog.png" });
  await dialog.getByRole("button", { name: "Save category overrides" }).click();

  await expect(dialog).not.toBeVisible();
  expect(saved).toHaveLength(2);
  expect(saved.map((row) => row.scope_value)).toEqual(["Microwave Ovens", "Microwave Parts"]);
  expect(saved[0]).toMatchObject({
    project_id: projectId,
    conversion_rate: 0.025,
    average_order_value: 400,
    note: "Client supplied category assumptions",
  });
  await expect(page.getByRole("row", { name: /Microwave Ovens/ })).toContainText("3");
  await expect(page.getByRole("row", { name: /Microwave Parts/ })).toContainText("2");
  await page.screenshot({ path: "test-results/conversion-overrides-saved.png" });

  categories = [{ category: "AV", keywordCount: 18_210 }];
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "New override" }).click();
  await page.getByRole("dialog").getByRole("combobox", { name: "Scope" }).click();
  await page.getByRole("option", { name: "category" }).click();
  await expect(page.getByText("AO categories")).toBeVisible();
  await expect(page.getByText(/All 18,210 kept keywords currently share “AV”/)).toBeVisible();
  await expect(page.getByText(/This is the only category available in this project/)).toBeVisible();
  await page.screenshot({ path: "test-results/conversion-overrides-single-category.png" });
});
