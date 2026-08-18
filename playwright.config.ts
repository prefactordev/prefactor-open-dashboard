import { defineConfig } from "@playwright/test";

// Browser smoke tests run against DEMO MODE (scripts/demo.mjs): the real
// server + the synthetic upstream, so every tab has data and no account or
// token is involved. Playwright boots it via webServer below — `npm run
// test:e2e` is self-contained.
export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: "http://localhost:8788",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node scripts/demo.mjs",
    url: "http://localhost:8788/api/config",
    // First run builds the frontend, which dominates this budget.
    timeout: 240_000,
    reuseExistingServer: !process.env.CI,
  },
});
