// Runs before `npm start`. Builds the frontend only when it's missing or
// stale, so a fresh clone can go straight to `npm start` without anyone
// remembering to build first. A normal restart skips this in milliseconds.
//
// The build steps are invoked as `node <local-bin>` rather than `npm run
// build`: spawning npm.cmd on Windows needs a shell (Node blocks .cmd without
// one since CVE-2024-27980), and passing args through a shell is deprecated.
// Calling the JS entrypoints directly sidesteps both.

import { existsSync, statSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const INDEX = join(ROOT, "dist", "index.html");
const TSC = join(ROOT, "node_modules", "typescript", "bin", "tsc");
const VITE = join(ROOT, "node_modules", "vite", "bin", "vite.js");

/** Newest mtime under a directory, skipping node_modules/dist/dotfiles. */
function newestMtime(dir, newest = 0) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    newest = entry.isDirectory() ? newestMtime(path, newest) : Math.max(newest, statSync(path).mtimeMs);
  }
  return newest;
}

function needsBuild() {
  if (!existsSync(INDEX)) return "no build found";
  try {
    const built = statSync(INDEX).mtimeMs;
    const newestSource = Math.max(newestMtime(join(ROOT, "src")), statSync(join(ROOT, "index.html")).mtimeMs);
    if (newestSource > built) return "sources changed since last build";
  } catch {
    return "could not compare build timestamps";
  }
  return null;
}

const reason = needsBuild();
if (!reason) process.exit(0);

if (!existsSync(VITE) || !existsSync(TSC)) {
  console.error("Dependencies are missing. Run `npm install` first, then `npm start`.");
  process.exit(1);
}

console.log(`Building the dashboard (${reason})... this takes a few seconds and only happens once.`);

const run = (label, args) => {
  const res = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  if (res.status !== 0) {
    console.error(`\n${label} failed. Fix the error above, then run \`npm start\` again.`);
    process.exit(res.status ?? 1);
  }
};

run("Typecheck", [TSC, "--noEmit"]);
run("Build", [VITE, "build"]);
