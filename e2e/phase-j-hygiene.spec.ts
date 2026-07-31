/**
 * Phase J hygiene — console-warning sweep (J3) and 375px tap-target sweep (J4).
 * Authenticated tests skip when E2E_AUTH_STATUS !== "injected" so
 * the suite stays green without a managed Supabase session.
 *
 * Evidence (console snapshots + element screenshots) is written under
 * docs/qa/phase-j-console/ and docs/qa/phase-j-mobile/ so the handover has a
 * reproducible trail. The asserts themselves are non-flaky and CI-safe.
 */
import { test, expect, type ConsoleMessage } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const APP = process.env.E2E_BASE_URL ?? "http://localhost:8080";
const AUTHED = process.env.E2E_AUTH_STATUS === "injected";

const CONSOLE_OUT = "docs/qa/phase-j-console";
const MOBILE_OUT = "docs/qa/phase-j-mobile";
mkdirSync(CONSOLE_OUT, { recursive: true });
mkdirSync(MOBILE_OUT, { recursive: true });

// React noise we care about for J3. Anything matching = test fail.
const REACT_WARN_RE =
  /(validateDOMNesting|Each child in a list should have a unique "key"|controlled.*uncontrolled|uncontrolled.*controlled|findDOMNode is deprecated|Encountered two children with the same key|Warning:.*React)/i;

async function collectConsole(
  page: import("@playwright/test").Page,
  url: string,
  slug: string,
): Promise<string[]> {
  const lines: string[] = [];
  const handler = (m: ConsoleMessage) => {
    if (m.type() === "warning" || m.type() === "error") {
      lines.push(`[${m.type()}] ${m.text()}`);
    }
  };
  page.on("console", handler);
  await page.goto(`${APP}${url}`, { waitUntil: "networkidle" });
  // Give late effects (suspense fallbacks, query refetch) a moment to settle.
  await page.waitForTimeout(750);
  page.off("console", handler);

  writeFileSync(join(CONSOLE_OUT, `${slug}.txt`), lines.join("\n"));
  return lines;
}

test.describe("Phase J3 — console hygiene", () => {
  test.skip(!AUTHED, "Requires E2E_AUTH_STATUS=injected");

  test("/dashboard has no React warnings", async ({ page }) => {
    const lines = await collectConsole(page, "/dashboard", "dashboard");
    const offenders = lines.filter((l) => REACT_WARN_RE.test(l));
    expect(offenders, offenders.join("\n")).toHaveLength(0);
  });

  test("/clients has no React warnings", async ({ page }) => {
    const lines = await collectConsole(page, "/clients", "clients");
    const offenders = lines.filter((l) => REACT_WARN_RE.test(l));
    expect(offenders, offenders.join("\n")).toHaveLength(0);
  });

  test("/clients/:id has no React warnings", async ({ page }) => {
    await page.goto(`${APP}/clients`, { waitUntil: "networkidle" });
    const clientLink = page.locator('a[href^="/clients/"]').first();
    if (!(await clientLink.isVisible().catch(() => false))) {
      test.skip(true, "No client available");
    }
    const href = await clientLink.getAttribute("href");
    if (!href) test.skip(true, "Client link missing href");
    const lines = await collectConsole(page, href!, "client-detail");
    const offenders = lines.filter((l) => REACT_WARN_RE.test(l));
    expect(offenders, offenders.join("\n")).toHaveLength(0);
  });

  test("/clients/:id/projects/:id has no React warnings", async ({ page }) => {
    await page.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
    const projectLink = page.locator('a[href*="/projects/"]').first();
    if (!(await projectLink.isVisible().catch(() => false))) {
      test.skip(true, "No project available");
    }
    const href = await projectLink.getAttribute("href");
    if (!href) test.skip(true, "Project link missing href");
    const lines = await collectConsole(page, href!, "project-detail");
    const offenders = lines.filter((l) => REACT_WARN_RE.test(l));
    expect(offenders, offenders.join("\n")).toHaveLength(0);
  });
});

test.describe("Phase J4 — mobile tap-target sweep (375px)", () => {
  test.skip(!AUTHED, "Requires E2E_AUTH_STATUS=injected");
  test.use({ viewport: { width: 375, height: 812 } });

  const MIN = 44;

  async function assertTapTarget(
    locator: import("@playwright/test").Locator,
    label: string,
  ) {
    if (!(await locator.isVisible().catch(() => false))) return;
    const box = await locator.boundingBox();
    expect(box, `${label} has no bounding box`).not.toBeNull();
    expect(box!.width, `${label} width ${box!.width}px < ${MIN}px`).toBeGreaterThanOrEqual(MIN);
    expect(box!.height, `${label} height ${box!.height}px < ${MIN}px`).toBeGreaterThanOrEqual(MIN);
    await locator.screenshot({
      path: join(MOBILE_OUT, `${label.replace(/\s+/g, "-").toLowerCase()}.png`),
    });
  }

  test("project sub-nav tabs clear 44px", async ({ page }) => {
    await page.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
    const projectLink = page.locator('a[href*="/projects/"]').first();
    if (!(await projectLink.isVisible().catch(() => false))) {
      test.skip(true, "No project available");
    }
    await projectLink.click();
    await page.waitForLoadState("networkidle");

    const tabs = page.locator('[role="tab"], nav button, nav a').filter({
      hasText: /setup|forecast|roadmap|architecture|monitor|keywords|overview/i,
    });
    const count = await tabs.count();
    for (let i = 0; i < Math.min(count, 7); i++) {
      await assertTapTarget(tabs.nth(i), `sub-nav-tab-${i}`);
    }
  });

  test("header switcher trigger clears 44px", async ({ page }) => {
    await page.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
    const switcher = page
      .getByRole("button", { name: /client|project|switch/i })
      .first();
    await assertTapTarget(switcher, "header-switcher");
  });

  test("sidebar trigger clears 44px", async ({ page }) => {
    await page.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
    const trigger = page
      .getByRole("button", { name: /toggle sidebar|open sidebar|menu/i })
      .first();
    await assertTapTarget(trigger, "sidebar-trigger");
  });

  test("scope chip clear button clears 44px on Capture Window", async ({ page }) => {
    await page.goto(`${APP}/tools/capture-window`, { waitUntil: "networkidle" });
    // Apply a client filter so the chip renders; pick the first available.
    await page.goto(`${APP}/clients`, { waitUntil: "networkidle" });
    const clientLink = page.locator('a[href^="/clients/"]').first();
    if (!(await clientLink.isVisible().catch(() => false))) {
      test.skip(true, "No client available");
    }
    const href = await clientLink.getAttribute("href");
    const clientId = href?.match(/\/clients\/([^/?#]+)/)?.[1];
    if (!clientId) test.skip(true, "Could not parse client id");

    await page.goto(`${APP}/tools/capture-window?clientId=${clientId}`, {
      waitUntil: "networkidle",
    });
    const clear = page.getByRole("button", { name: /clear client filter/i }).first();
    await assertTapTarget(clear, "scope-chip-clear");
  });
});
