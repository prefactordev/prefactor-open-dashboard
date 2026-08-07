// Prefactor Open Dashboard — local server.
//
// Two jobs, zero dependencies (Node 18.17+):
//   1. Run the background sync (server/sync.mjs) and serve its cached snapshot
//      at /api/data, plus a live event stream at /api/events. The admin API
//      token is used only here, server-side, and no endpoint ever returns it.
//   2. Serve the built frontend from ./dist (built automatically by `npm start`).
//
// Config comes from environment variables or a local .env file:
//   PREFACTOR_API_TOKEN  (required) admin/session API token — NOT the SDK ingestion key
//   PREFACTOR_API_HOST   (optional) defaults to https://app.prefactorai.com
//   PORT                 (optional) defaults to 8788

// MUST be first: it populates process.env from .env, and sync.mjs reads its
// tunables at module scope — which happens before this file's body runs.
import { fileEnv } from "./server/env.mjs";

import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { gzipSync } from "node:zlib";
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { join, extname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSync } from "./server/sync.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));

// Node 18.17+ — earlier versions lack a stable global fetch, which every
// upstream call depends on. Fail with a readable message, not a stack trace.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 18 || (major === 18 && minor < 17)) {
  console.error(
    `Node ${process.versions.node} is too old — this dashboard needs Node 18.17 or newer.\n` +
      `Install a current LTS from https://nodejs.org and try again.`,
  );
  process.exit(1);
}

// --- config ----------------------------------------------------------------
// .env is loaded and published into process.env by ./server/env.mjs above.
// Values are never logged.
const env = (k) => process.env[k] ?? fileEnv[k];

// Everything the server persists — cache AND the saved token — lives here.
// Point DATA_DIR at a mounted volume when hosting, so both survive redeploys.
const DATA_DIR = env("DATA_DIR") ? resolve(env("DATA_DIR")) : join(ROOT, "data");
const CONFIG_PATH = join(DATA_DIR, "config.json");

/**
 * A token saved from the Admin panel. Kept in DATA_DIR (not just .env) because
 * that is the directory a hosted deployment is expected to mount persistently,
 * and because .env is often read-only in a container image.
 */
function loadStoredConfig() {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}
const stored = loadStoredConfig();

// Precedence: real environment > stored (Admin panel) > .env file.
// An explicitly-set env var always wins, so hosted config can't be overridden
// from the UI by accident.
const setting = (k) => process.env[k] ?? stored[k] ?? fileEnv[k];

let TOKEN = setting("PREFACTOR_API_TOKEN") || null;
let HOST = (setting("PREFACTOR_API_HOST") ?? "https://app.prefactorai.com").replace(/\/+$/, "");
const PORT = Number(env("PORT") ?? 8788);
const BIND_HOST = env("BIND_HOST") ?? "127.0.0.1";
const PASSWORD = env("DASHBOARD_PASSWORD") || null;
const TOKEN_FROM_ENV = Boolean(process.env.PREFACTOR_API_TOKEN);

// Binding beyond loopback publishes an API token and all of your agent
// telemetry to anyone who can reach the port. Require a password for that.
const LOOPBACK = ["127.0.0.1", "localhost", "::1"];
if (!LOOPBACK.includes(BIND_HOST) && !PASSWORD) {
  console.error(
    `Refusing to start: BIND_HOST=${BIND_HOST} exposes this dashboard beyond localhost,\n` +
      `which would publish your agent data (and let anyone use your API token).\n` +
      `Set DASHBOARD_PASSWORD to require a login, or leave BIND_HOST unset for local use.`,
  );
  process.exit(1);
}

if (!TOKEN) {
  console.log('No API token configured yet - set one in the dashboard\'s "Admin" panel (or put it in .env).');
}

// Background sync: keeps a local cache of (projected) spans/instances so the
// browser loads instantly and sees new activity within one poll interval.
const sync = createSync({ getToken: () => TOKEN, getHost: () => HOST, dataDir: DATA_DIR });

/**
 * Persist the token/host so they survive a restart. Writes DATA_DIR/config.json
 * (the durable location) and mirrors into .env when that file is writable, so
 * a local user can still see/edit it there. Returns false when nothing could be
 * written — the caller tells the user rather than silently forgetting.
 * The token is write-only: it is saved here, but no endpoint returns it.
 */
function persistConfig(updates) {
  let ok = false;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify({ ...stored, ...updates }, null, 2), { mode: 0o600 });
    Object.assign(stored, updates);
    ok = true;
  } catch (err) {
    console.warn(`[config] could not save to ${CONFIG_PATH}: ${err?.message ?? err}`);
  }
  try {
    const path = join(ROOT, ".env");
    const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
    for (const [key, value] of Object.entries(updates)) {
      const idx = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
      const line = `${key}=${value}`;
      if (idx >= 0) lines[idx] = line;
      else lines.push(line);
    }
    // 0600: this file holds an API token; default 0644 would expose it to
    // every local user on a shared machine. `mode` only applies when
    // writeFileSync CREATES the file, and the documented setup step is
    // `cp .env.example .env` — so an existing 0644 file needs an explicit
    // chmod or the token lands world-readable on macOS/Linux.
    writeFileSync(path, lines.filter((l, i) => l !== "" || i < lines.length - 1).join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(path, 0o600); // no-op on Windows, which has no equivalent
    } catch {
      /* best effort */
    }
    ok = true;
  } catch {
    /* read-only filesystem (common in containers) — config.json above is the durable copy */
  }
  return ok;
}

// --- data + live events -----------------------------------------------------
// GET /api/data?start=<iso>&end=<iso>&agent=<id|all> → cached snapshot, gzipped.
// GET /api/events → SSE; a "sync" event fires whenever a round changed data.

function sendJson(req, res, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  if (/\bgzip\b/.test(req.headers["accept-encoding"] ?? "")) {
    const zipped = gzipSync(body);
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "content-length": zipped.length });
    res.end(zipped);
  } else {
    res.writeHead(200, { "content-type": "application/json", "content-length": body.length });
    res.end(body);
  }
}

function handleData(req, res, url) {
  if (!TOKEN) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "No API token configured", code: "no_token" }));
    return;
  }
  // Validate before arithmetic: an unparseable date would otherwise reach
  // toISOString() and throw RangeError, taking the whole server down.
  const iso = (value, fallback) => {
    const ms = value == null ? NaN : Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback;
  };
  const end = iso(url.searchParams.get("end"), new Date().toISOString());
  const start = iso(url.searchParams.get("start"), new Date(Date.parse(end) - 7 * 86400e3).toISOString());
  const agentId = url.searchParams.get("agent") ?? "all";
  try {
    sendJson(req, res, sync.snapshot({ start: start <= end ? start : end, end, agentId }));
  } catch (err) {
    // Serialising an enormous window can exceed V8's max string length.
    // Answer with guidance rather than dying.
    console.error(`[server] snapshot failed: ${err?.message ?? err}`);
    res.writeHead(507, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error:
          "This range is too large to serialise. Pick a shorter range or a single agent, " +
          "or lower BACKFILL_HORIZON_DAYS / MAX_CACHE_SPANS_PER_AGENT.",
      }),
    );
  }
}

const sseClients = new Set();
function handleEvents(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write("retry: 3000\n\n");
  sseClients.add(res);
  const drop = () => {
    clearInterval(keepalive);
    sseClients.delete(res);
  };
  const keepalive = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      drop();
    }
  }, 25_000);
  // Without this listener a socket error on a closed tab is an unhandled
  // 'error' event, which would take the process down.
  res.on("error", drop);
  req.on("error", drop);
  req.on("close", drop);
}
sync.events.on("update", (info) => {
  // A dead client must not abort the sync round that emitted this.
  for (const res of sseClients) {
    try {
      res.write(`event: sync\ndata: ${JSON.stringify(info)}\n\n`);
    } catch {
      sseClients.delete(res);
    }
  }
});

// --- admin config ----------------------------------------------------------
// GET  /api/config → { tokenSet, host } — NEVER the token itself.
// POST /api/config → { token?, host? } — validates the token against the
//   upstream account endpoint before accepting, then persists to .env.
// JSON-only bodies force a CORS preflight, and this server sends no CORS
// headers, so a foreign origin can't POST here from a browser.

function readBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) reject(new Error("body too large"));
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleConfig(req, res) {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        tokenSet: Boolean(TOKEN),
        host: HOST,
        // True when the token comes from the environment: the Admin panel can't
        // override it, and it survives restarts by definition.
        fromEnv: TOKEN_FROM_ENV,
      }),
    );
    return;
  }
  if (req.method !== "POST" || !/^application\/json/.test(req.headers["content-type"] ?? "")) {
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "POST application/json only" }));
    return;
  }
  try {
    const body = JSON.parse(await readBody(req));
    const suppliedToken = typeof body.token === "string" && body.token.trim() !== "" ? body.token.trim() : null;
    const newHost = typeof body.host === "string" && body.host.trim() !== "" ? body.host.trim().replace(/\/+$/, "") : HOST;
    const newToken = suppliedToken ?? TOKEN;
    if (!newToken) throw new Error("token is required");
    if (!/^https:\/\//.test(newHost)) throw new Error("host must be https://…");
    // Never send the stored token to a host the caller merely names: that
    // would let a request carrying no credential of its own exfiltrate the
    // admin token to an arbitrary server. Changing host requires re-supplying
    // the token, so the caller must already possess it.
    if (newHost !== HOST && !suppliedToken) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Changing the API host requires re-entering the API token." }));
      return;
    }

    // Prove the token works (and matches the host) before saving anything.
    const check = await fetch(`${newHost}/api/v1/account`, {
      headers: { Authorization: `Bearer ${newToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000), // an unreachable host must fail, not hang the panel
    });
    if (!check.ok) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `Token rejected by ${newHost} (HTTP ${check.status}). Paste the admin API token (a JWT), not the pf_… ingestion key.` }));
      return;
    }

    TOKEN = newToken;
    HOST = newHost;
    // Connected either way; `persisted` tells the user whether it will still be
    // set after a restart, instead of silently forgetting it.
    const persisted = persistConfig({ PREFACTOR_API_TOKEN: TOKEN, PREFACTOR_API_HOST: HOST });
    sync.onConfigChanged(); // resync now; wipes the cache if the account changed
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, tokenSet: true, host: HOST, persisted }));
  } catch (err) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: err?.message ?? String(err) }));
  }
}

// --- static files ----------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

function serveStatic(res, urlPath) {
  const dist = join(ROOT, "dist");
  if (!existsSync(join(dist, "index.html"))) {
    // Reachable only when someone runs `node server.mjs` directly; `npm start`
    // builds first. Answer in the browser rather than in a terminal they may
    // not be looking at.
    res.writeHead(503, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>Prefactor Open Dashboard — build needed</title>` +
        `<style>body{font:15px/1.6 system-ui,sans-serif;background:#05100d;color:#f2f7f5;display:grid;place-items:center;height:100vh;margin:0}` +
        `div{max-width:32rem;padding:2rem}code{background:#0a1613;border:1px solid rgba(255,255,255,.1);border-radius:6px;padding:2px 7px}` +
        `h1{font-size:18px;margin:0 0 .75rem}p{color:#9fb2ac}</style>` +
        `<div><h1>The dashboard hasn't been built yet</h1>` +
        `<p>Stop this server and run <code>npm start</code> — it builds automatically, then serves the dashboard.</p>` +
        `<p>For live-reloading development, use <code>npm run dev</code> instead.</p></div>`,
    );
    return;
  }
  // A malformed escape (e.g. /%ZZ) makes decodeURIComponent throw; a crawler
  // hitting one must not kill the server.
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    decoded = urlPath;
  }
  let rel = normalize(decoded).replace(/^([/\\])+/, "");
  if (rel.includes("..")) rel = "";
  let file = join(dist, rel);
  if (!existsSync(file) || extname(file) === "") file = join(dist, "index.html"); // SPA fallback
  // Read BEFORE committing the status line, or an unreadable file appends a
  // JSON error to a 200 response that already claims to be JS or CSS.
  let body;
  try {
    body = readFileSync(file);
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`Could not read ${rel}: ${err?.message ?? err}\n`);
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(body);
}

// --- server ----------------------------------------------------------------
/**
 * Optional shared-password gate (HTTP Basic), required whenever the server is
 * bound beyond loopback. Any username is accepted; only the password matters.
 * Compared in constant time so the check can't be timed character by character.
 */
function authorized(req) {
  if (!PASSWORD) return true;
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const supplied = Buffer.from(decoded.slice(decoded.indexOf(":") + 1));
  const expected = Buffer.from(PASSWORD);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

// A local tool should never die from one bad request or a late socket error;
// log and keep serving instead.
process.on("uncaughtException", (err) => console.error(`[server] uncaught: ${err?.stack ?? err}`));
process.on("unhandledRejection", (err) => console.error(`[server] unhandled rejection: ${err?.stack ?? err}`));

/**
 * DNS-rebinding guard. Without this, a page on attacker.com whose DNS briefly
 * re-resolves to 127.0.0.1 becomes same-origin with this server and can read
 * every response — all of your agent telemetry, from a machine the attacker
 * never touched. Checking the Host header costs nothing and closes it, because
 * the browser sends the attacker's hostname, not ours.
 */
const ALLOWED_HOSTS = (env("ALLOWED_HOSTS") ?? "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

function hostAllowed(req) {
  const host = (req.headers.host ?? "").toLowerCase();
  // Localhost is ALWAYS allowed — otherwise setting ALLOWED_HOSTS for a hosted
  // domain would lock you out of your own machine with a 403 whose body tells
  // you to use localhost.
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (name === "localhost" || name === "127.0.0.1" || name === "::1" || name === "") return true;
  // Entries may be given with or without a port.
  if (ALLOWED_HOSTS.length > 0) return ALLOWED_HOSTS.includes(host) || ALLOWED_HOSTS.includes(name);
  // Hosted behind a real domain (non-loopback bind): the password gate is the
  // control, and the operator can pin hostnames with ALLOWED_HOSTS.
  return !LOOPBACK.includes(BIND_HOST);
}

function handleRequest(req, res) {
  if (!hostAllowed(req)) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("Forbidden: unexpected Host header. Reach this dashboard at http://localhost:" + PORT + "/\n");
    return;
  }
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (!authorized(req)) {
    res.writeHead(401, { "www-authenticate": 'Basic realm="Prefactor Open Dashboard", charset="UTF-8"' });
    res.end("Authentication required.");
    return;
  }
  if (url.pathname === "/api/config") return void handleConfig(req, res);
  if (url.pathname === "/api/data") return void handleData(req, res, url);
  if (url.pathname === "/api/events") return void handleEvents(req, res);
  serveStatic(res, url.pathname);
}

http
  .createServer((req, res) => {
    // One bad request must never take the dashboard down.
    try {
      handleRequest(req, res);
    } catch (err) {
      console.error(`[server] request failed: ${err?.stack ?? err}`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      if (!res.writableEnded) res.end(JSON.stringify({ error: "Internal error" }));
    }
  })
  // Bound to loopback by default: this is a local tool holding a credential.
  .listen(PORT, BIND_HOST, () => {
    // ASCII only: Windows terminals default to a codepage that mangles
    // arrows, em dashes, and emoji.
    const shown = LOOPBACK.includes(BIND_HOST) ? "localhost" : BIND_HOST;
    console.log(`\n  Prefactor Open Dashboard  ->  http://${shown}:${PORT}\n`);
    console.log(`  upstream:  ${HOST}`);
    console.log(`  data dir:  ${DATA_DIR}`);
    console.log(TOKEN ? "  API token: configured" : '  API token: not set - add it in the "Admin" panel when the page opens');
    if (PASSWORD) console.log("  login:     password required (DASHBOARD_PASSWORD)");
    console.log("  press Ctrl+C to stop\n");
    sync.start();
  })
  .on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `Port ${PORT} is already in use — the dashboard may already be running at http://localhost:${PORT}.\n` +
          `Close the other copy, or start this one on a different port:  PORT=8790 npm start`,
      );
      process.exit(1);
    }
    // Don't rethrow: the uncaughtException handler would swallow it and the
    // server would sit there having never started syncing.
    console.error(`Could not listen on ${BIND_HOST}:${PORT} — ${err?.message ?? err}`);
    process.exit(1);
  });
