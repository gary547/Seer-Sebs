import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:8080";
const browserExecutable = process.env.E2E_BROWSER_EXECUTABLE;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["list"]],
  use: {
    baseURL,
    launchOptions: browserExecutable ? { executablePath: browserExecutable } : undefined,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: process.env.E2E_VIDEO === "off" ? "off" : "retain-on-failure",
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run dev -- --host 127.0.0.1 --port 8080",
        reuseExistingServer: !process.env.CI,
        url: baseURL,
      },
  projects: [
    {
      name: "chromium",
      use: devices["Desktop Chrome"],
    },
  ],
});
