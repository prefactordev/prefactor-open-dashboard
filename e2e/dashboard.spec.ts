// Browser smoke suite: does each tab actually RENDER in a real browser?
// The API regression tests pin the server contract; these pin the last mile —
// React mounts, charts draw, no error boundary fires. Run against demo mode
// (synthetic data), so failures here are frontend regressions, never data.

import { expect, test, type Page } from "@playwright/test";

/** Wait until the background sync has fully landed the synthetic dataset. */
async function waitForSteadyData(page: Page) {
  await expect
    .poll(
      async () => {
        const res = await page.request.get("/api/data");
        if (!res.ok()) return "http-error";
        const json = (await res.json()) as { spans?: unknown[]; meta?: { historyComplete?: boolean } };
        return (json.spans?.length ?? 0) > 0 && json.meta?.historyComplete ? "ready" : "syncing";
      },
      { timeout: 60_000 },
    )
    .toBe("ready");
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForSteadyData(page);
});

test("loads the app shell with all four tabs and no admin prompt", async ({ page }) => {
  await expect(page).toHaveTitle(/Prefactor Open Dashboard/);
  for (const tab of ["Risk", "Quality · Prefactor", "Quality · Your evals", "Cost"]) {
    await expect(page.getByRole("tab", { name: tab })).toBeVisible();
  }
  // Demo mode has a token configured, so the Admin panel must NOT auto-open.
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("Risk tab renders scored spans, charts, and sensitive-data exposure", async ({ page }) => {
  await page.getByRole("tab", { name: "Risk" }).click();
  // These headings only render when data made it through; the empty state
  // ("No risk-scored spans in this window") would replace them.
  await expect(page.getByRole("heading", { name: "Risk-scored spans over time" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Risk score distribution" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sensitive data exposure" })).toBeVisible();
  await expect(page.getByText("No risk-scored spans in this window")).toHaveCount(0);
  expect(await page.locator(".recharts-surface").count()).toBeGreaterThan(0);
});

test("Quality · Prefactor tab renders outcomes, feedback, and the heatmap", async ({ page }) => {
  await page.getByRole("tab", { name: "Quality · Prefactor" }).click();
  await expect(page.getByRole("heading", { name: "Run outcomes over time" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "User feedback over time" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Activity heatmap" })).toBeVisible();
  await expect(page.getByText("No agent runs in this window")).toHaveCount(0);
  expect(await page.locator(".recharts-surface").count()).toBeGreaterThan(0);
});

test("Quality · Your evals tab discovers score fields from quality payloads", async ({ page }) => {
  // The evals tab needs the sync's per-instance detail pass; demo mode covers
  // enough instances within a couple of rounds.
  await expect
    .poll(
      async () => {
        const res = await page.request.get("/api/data");
        const json = (await res.json()) as { meta?: { detailChecked?: number } };
        return json.meta?.detailChecked ?? 0;
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThan(10);
  await page.getByRole("tab", { name: "Quality · Your evals" }).click();
  await expect(page.getByText("No quality payloads found")).toHaveCount(0);
  // Field names come from the synthetic quality_payload's shape.
  await expect(page.getByText("scores.accuracy").first()).toBeVisible();
});

test("Cost tab renders spend, model economics, and flags the unpriced model", async ({ page }) => {
  await page.getByRole("tab", { name: "Cost" }).click();
  await expect(page.getByRole("heading", { name: "Cost by model over time" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Model economics" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Finish reasons" })).toBeVisible();
  await expect(page.getByText("No token usage in this window")).toHaveCount(0);
  // The synthetic dataset deliberately includes an unpriced model; the UI must
  // surface the pricing gap rather than hide it.
  await expect(page.getByText("in-house-7b").first()).toBeVisible();
  expect(await page.locator(".recharts-surface").count()).toBeGreaterThan(0);
});

test("no tab trips the error boundary", async ({ page }) => {
  for (const tab of ["Risk", "Quality · Prefactor", "Quality · Your evals", "Cost"]) {
    await page.getByRole("tab", { name: tab }).click();
    await expect(page.getByText(/unexpected error/i)).toHaveCount(0);
  }
});
