// Demo mode: the full dashboard running against the synthetic Prefactor API —
// every tab lit up with realistic data, no account or token required.
//
//   npm run demo      then open http://localhost:8788
//
// Boots scripts/mock-upstream.mjs on a local port, then starts server.mjs
// pointed at it with a demo token and an isolated data directory (data/demo),
// so demo cache never mixes with a real account's cache. Ctrl+C stops both.

import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMockUpstream } from "./mock-upstream.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEMO_DATA_DIR = join(ROOT, "data", "demo");

// Fresh cache each run: the synthetic dataset is regenerated relative to "now",
// so yesterday's cache would layer a second dataset on top of today's.
rmSync(DEMO_DATA_DIR, { recursive: true, force: true });

const mock = createMockUpstream({ days: 14 });
const { url } = await mock.ready;
console.log(`\n  Synthetic Prefactor API  ->  ${url}`);

// `npm start` semantics (build if needed, then serve), but with the
// environment pinned to the mock. Real env vars for the same keys are
// overridden on purpose — demo mode must never touch a real account.
const child = spawn(process.execPath, [join(ROOT, "scripts", "ensure-build.mjs")], { cwd: ROOT, stdio: "inherit" });
child.on("exit", (code) => {
  if (code !== 0) process.exit(code ?? 1);
  const server = spawn(process.execPath, [join(ROOT, "server.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      PREFACTOR_API_TOKEN: mock.token,
      PREFACTOR_API_HOST: url,
      DATA_DIR: DEMO_DATA_DIR,
      SYNC_INTERVAL_MS: "3000",
      PORT: process.env.PORT ?? "8788",
    },
  });
  const stop = () => {
    server.kill();
    mock.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  server.on("exit", (c) => {
    mock.close().then(() => process.exit(c ?? 0));
  });
});
