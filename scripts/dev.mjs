// Dev runner: starts the API/sync server and Vite together, so `npm run dev`
// is the only command you need. Vite serves the UI on :5173 with live reload
// and proxies /api to the server on :8788.
//
// Both children are spawned as `node <local-bin>` — no shell, no .cmd, which
// keeps this working identically on Windows and POSIX.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VITE = join(ROOT, "node_modules", "vite", "bin", "vite.js");

if (!existsSync(VITE)) {
  console.error("Dependencies are missing. Run `npm install` first, then `npm run dev`.");
  process.exit(1);
}

const opts = { cwd: ROOT, stdio: "inherit" };
const server = spawn(process.execPath, [join(ROOT, "server.mjs")], opts);
const vite = spawn(process.execPath, [VITE], opts);

let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  server.kill();
  vite.kill();
  process.exit(code);
};

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
server.on("exit", (code) => stop(code ?? 0));
vite.on("exit", (code) => stop(code ?? 0));
