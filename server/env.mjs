// Loads .env into process.env.
//
// This lives in its own module and is imported FIRST by server.mjs, because ES
// module imports are evaluated before the importing module's body. server/
// sync.mjs reads its tunables (SYNC_INTERVAL_MS, BACKFILL_HORIZON_DAYS,
// MAX_CACHE_SPANS_PER_AGENT) at module scope, so populating process.env in
// server.mjs's body would have happened too late — the values in .env were
// silently ignored while the UI told users to change exactly those.
//
// A real environment variable always wins over the file.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Parsed .env contents, exported so callers can tell file from environment. */
export const fileEnv = (() => {
  const path = join(ROOT, ".env");
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
})();

for (const [k, v] of Object.entries(fileEnv)) {
  if (process.env[k] === undefined) process.env[k] = v;
}
