// API regression tests: server.mjs booted as a real child process against the
// synthetic upstream, exercised over real HTTP. This is the contract the
// frontend (src/api.ts) and any external consumer depends on — if any of
// these fail, a change broke the API.
//
// Raw node:http is used (not fetch) where header control matters: gzip
// negotiation, Host-header spoofing, SSE streaming.

import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockUpstream } from "../scripts/mock-upstream.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });

/** GET with full header control; buffers the body. */
function rawGet(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Boot server.mjs with the given env; resolves once /api/config answers. */
async function startDashboard(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [join(ROOT, "server.mjs")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), PREFACTOR_API_TOKEN: "", DASHBOARD_PASSWORD: "", BIND_HOST: "", DATA_DIR: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));

  for (let waited = 0; waited < 20_000; waited += 100) {
    try {
      const res = await rawGet(port, "/api/config");
      if (res.status === 200 || res.status === 401) return { child, port, getOutput: () => output, exited };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`server.mjs never became ready. Output:\n${output}`);
}

let mock;
let mockUrl;
let dash; // main configured instance
let dataDir;

beforeAll(async () => {
  mock = createMockUpstream({ seed: 11, days: 7 });
  ({ url: mockUrl } = await mock.ready);
  dataDir = await mkdtemp(join(tmpdir(), "pfdash-api-"));
  dash = await startDashboard({
    PREFACTOR_API_TOKEN: mock.token,
    PREFACTOR_API_HOST: mockUrl,
    DATA_DIR: dataDir,
    SYNC_INTERVAL_MS: "300",
  });
});

afterAll(async () => {
  dash?.child.kill();
  await mock.close();
  // Windows: the child may hold file handles for a beat after kill.
  await new Promise((r) => setTimeout(r, 300));
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

const getJson = async (path, headers = {}) => {
  const res = await rawGet(dash.port, path, headers);
  const body = res.headers["content-encoding"] === "gzip" ? gunzipSync(res.body) : res.body;
  return { ...res, json: JSON.parse(body.toString("utf8")) };
};

/**
 * Poll /api/data until the sync reaches its documented steady state: full
 * history, no clipping, no error. Transient mid-backfill snapshots (clipped
 * windows, a round that hasn't finished) are legal, so tests assert on the
 * state the server must CONVERGE to, not on a lucky early poll.
 */
async function waitForData() {
  let last = null;
  for (let waited = 0; waited < 20_000; waited += 200) {
    const { json } = await getJson("/api/data");
    last = json;
    // lastSyncAt is stamped only when a full round (including the quality
    // detail pass) completes — history can be complete before that.
    if (json.spans?.length > 0 && json.meta?.historyComplete && !json.meta.clipped && json.meta.syncError == null && json.meta.lastSyncAt != null)
      return json;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`sync never reached steady state. Last meta: ${JSON.stringify(last?.meta)}`);
}

describe("GET /api/config", () => {
  it("reports token state and host — never the token itself", async () => {
    const { status, json, body } = await getJson("/api/config");
    expect(status).toBe(200);
    expect(json).toEqual({ tokenSet: true, host: mockUrl, fromEnv: true });
    expect(body.toString()).not.toContain(mock.token);
  });
});

describe("POST /api/config", () => {
  const post = (payload, headers = {}) =>
    new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const req = http.request(
        { host: "127.0.0.1", port: dash.port, path: "/api/config", method: "POST", headers: { "content-type": "application/json", ...headers } },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) }));
        },
      );
      req.on("error", reject);
      req.end(body);
    });

  it("rejects non-JSON bodies with 405 (CORS-preflight enforcement)", async () => {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: dash.port, path: "/api/config", method: "POST", headers: { "content-type": "text/plain" } },
        (r) => {
          r.resume();
          r.on("end", () => resolve({ status: r.statusCode }));
        },
      );
      req.on("error", reject);
      req.end("token=x");
    });
    expect(res.status).toBe(405);
  });

  it("rejects a host change that does not re-supply the token (anti-exfiltration)", async () => {
    const res = await post({ host: "https://evil.example.com" });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/re-entering/i);
  });

  it("rejects non-https hosts", async () => {
    const res = await post({ token: "anything", host: "http://plain.example.com" });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/https/);
  });

  it("applies the https requirement even to a host inherited from the environment", async () => {
    // This instance's host is the http:// mock (allowed via env for tests and
    // demos); the admin endpoint must still refuse to SAVE a non-https host,
    // so a UI round-trip can never downgrade a real deployment.
    const res = await post({ token: "wrong-token" });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/https/);
  });
});

describe("GET /api/data", () => {
  it("serves the synced snapshot with the full documented shape", async () => {
    const json = await waitForData();
    expect(json.accountId).toBe("acct_demo_0001");
    expect(json.agents).toHaveLength(3);
    expect(json.spans.length).toBeGreaterThan(100);
    expect(json.instances.length).toBeGreaterThan(10);
    expect(json.alerts).toBe(3);
    expect(json.riskProfiles).toEqual([{ id: "rp_standard", name: "Standard guardrails" }]);
    expect(json.meta).toMatchObject({
      historyComplete: true,
      clipped: false,
      backfillingAgents: 0,
      horizonDays: expect.any(Number),
      cachedSpans: expect.any(Number),
      lastSyncAt: expect.any(String),
      syncError: null,
    });
  });

  it("filters by agent", async () => {
    await waitForData();
    const { json } = await getJson("/api/data?agent=agent_support");
    expect(json.spans.length).toBeGreaterThan(0);
    expect(json.spans.every((s) => s.agent_id === "agent_support")).toBe(true);
  });

  it("filters by time window", async () => {
    const all = await waitForData();
    const start = new Date(Date.now() - 2 * 86400e3).toISOString();
    const { json } = await getJson(`/api/data?start=${encodeURIComponent(start)}`);
    expect(json.spans.length).toBeGreaterThan(0);
    expect(json.spans.length).toBeLessThan(all.spans.length);
    expect(json.spans.every((s) => s.started_at >= start)).toBe(true);
  });

  it("survives unparseable dates by falling back to defaults", async () => {
    const { status, json } = await getJson("/api/data?start=garbage&end=alsogarbage");
    expect(status).toBe(200);
    expect(json.meta).toBeDefined();
  });

  it("swaps start/end when the range is inverted", async () => {
    const end = new Date().toISOString();
    const start = new Date(Date.now() - 86400e3).toISOString();
    const { status, json } = await getJson(`/api/data?start=${encodeURIComponent(end)}&end=${encodeURIComponent(start)}`);
    expect(status).toBe(200);
    expect(json.spans).toBeDefined();
  });

  it("gzips when the client accepts it, and not otherwise", async () => {
    const zipped = await rawGet(dash.port, "/api/data", { "accept-encoding": "gzip" });
    expect(zipped.headers["content-encoding"]).toBe("gzip");
    expect(() => JSON.parse(gunzipSync(zipped.body).toString())).not.toThrow();

    const plain = await rawGet(dash.port, "/api/data", { "accept-encoding": "identity" });
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(() => JSON.parse(plain.body.toString())).not.toThrow();
  });

  it("never leaks the raw sensitive values the upstream held", async () => {
    const json = await waitForData();
    expect(JSON.stringify(json)).not.toContain("redacted@example.com");
  });
});

describe("GET /api/events (SSE)", () => {
  it("streams text/event-stream with a retry hint", async () => {
    const result = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: dash.port, path: "/api/events" }, (res) => {
        let buf = "";
        res.on("data", (c) => {
          buf += c;
          if (buf.includes("retry:")) {
            req.destroy();
            resolve({ status: res.statusCode, type: res.headers["content-type"], buf });
          }
        });
      });
      req.on("error", reject);
      req.end();
      setTimeout(() => reject(new Error("no SSE preamble within 5s")), 5000);
    });
    expect(result.status).toBe(200);
    expect(result.type).toBe("text/event-stream");
    expect(result.buf).toContain("retry: 3000");
  });
});

describe("security guards", () => {
  it("403s requests with an unexpected Host header (DNS-rebinding guard)", async () => {
    const res = await rawGet(dash.port, "/api/data", { host: "attacker.example.com" });
    expect(res.status).toBe(403);
  });

  it("accepts localhost Host headers with and without a port", async () => {
    for (const host of [`localhost:${dash.port}`, "localhost", "127.0.0.1"]) {
      const res = await rawGet(dash.port, "/api/config", { host });
      expect(res.status).toBe(200);
    }
  });

  it("never serves files outside dist/ (path traversal)", async () => {
    for (const path of ["/..%2f..%2fpackage.json", "/../server.mjs", "/%2e%2e/%2e%2e/package.json"]) {
      const res = await rawGet(dash.port, path);
      expect(res.status).toBe(200); // SPA fallback, not the file
      expect(res.body.toString()).not.toContain('"name": "prefactor-open-dashboard"');
      expect(res.body.toString()).not.toContain("createSync");
    }
  });

  it("survives malformed percent-escapes", async () => {
    const res = await rawGet(dash.port, "/%ZZ");
    expect(res.status).toBe(200);
  });
});

describe("unconfigured instance", () => {
  it("401s /api/data with a no_token code until a token is set", async () => {
    const bare = await startDashboard({ DATA_DIR: await mkdtemp(join(tmpdir(), "pfdash-bare-")) });
    try {
      const data = await rawGet(bare.port, "/api/data");
      expect(data.status).toBe(401);
      expect(JSON.parse(data.body.toString()).code).toBe("no_token");
      const cfg = await rawGet(bare.port, "/api/config");
      expect(JSON.parse(cfg.body.toString())).toMatchObject({ tokenSet: false });
    } finally {
      bare.child.kill();
    }
  });
});

describe("password gate", () => {
  it("requires HTTP Basic auth when DASHBOARD_PASSWORD is set", async () => {
    const gated = await startDashboard({
      DASHBOARD_PASSWORD: "hunter2",
      DATA_DIR: await mkdtemp(join(tmpdir(), "pfdash-pw-")),
    });
    try {
      const denied = await rawGet(gated.port, "/api/config");
      expect(denied.status).toBe(401);
      expect(denied.headers["www-authenticate"]).toContain("Basic");

      const ok = await rawGet(gated.port, "/api/config", {
        authorization: `Basic ${Buffer.from("anyuser:hunter2").toString("base64")}`,
      });
      expect(ok.status).toBe(200);

      const wrong = await rawGet(gated.port, "/api/config", {
        authorization: `Basic ${Buffer.from("anyuser:wrong").toString("base64")}`,
      });
      expect(wrong.status).toBe(401);
    } finally {
      gated.child.kill();
    }
  });
});

describe("startup refusals", () => {
  it("refuses to bind beyond loopback without a password", async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [join(ROOT, "server.mjs")], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), BIND_HOST: "0.0.0.0", DASHBOARD_PASSWORD: "", PREFACTOR_API_TOKEN: "x" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    const code = await new Promise((resolve) => child.on("exit", resolve));
    expect(code).toBe(1);
    expect(output).toMatch(/DASHBOARD_PASSWORD/);
  });
});
