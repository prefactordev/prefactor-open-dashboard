// Regenerates the per-tab screenshots in docs/ from demo mode, so the README
// always shows what the current code actually renders.
//
//   npm run shots
//
// Boots the demo (synthetic data), waits for the sync to finish AND for the
// quality-detail pass to cover enough runs that the evals tab looks real,
// then captures each tab at a fixed size. Deterministic data in, stable
// screenshots out.

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASE = "http://localhost:8788";

const TABS = [
  { button: "Risk", file: "tab-risk.png" },
  { button: "Quality · Prefactor", file: "tab-quality-prefactor.png" },
  { button: "Quality · Your evals", file: "tab-quality-evals.png" },
  { button: "Cost", file: "tab-cost.png" },
];

const demo = spawn(process.execPath, [join(ROOT, "scripts", "demo.mjs")], { cwd: ROOT, stdio: "inherit" });
const stop = (code) => {
  demo.kill();
  process.exit(code);
};

try {
  // Wait for the server, then for steady, detail-rich data.
  const deadline = Date.now() + 240_000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    try {
      const res = await fetch(`${BASE}/api/data`);
      if (res.ok) {
        const json = await res.json();
        ready = json.spans?.length > 0 && json.meta?.historyComplete && (json.meta?.detailChecked ?? 0) > 50;
      }
    } catch {
      /* not up yet */
    }
    if (!ready) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!ready) throw new Error("demo never reached steady state");

  mkdirSync(join(ROOT, "docs"), { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 }, deviceScaleFactor: 2 });
  await page.goto(BASE);
  for (const { button, file } of TABS) {
    await page.getByRole("tab", { name: button }).click();
    // Let charts finish their mount animation before capturing.
    await page.waitForTimeout(1800);
    await page.screenshot({ path: join(ROOT, "docs", file) });
    console.log(`captured docs/${file}`);
  }
  await browser.close();
  stop(0);
} catch (err) {
  console.error(err);
  stop(1);
}
