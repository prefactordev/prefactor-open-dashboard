// Sync-engine regression tests: createSync() run in-process against the
// synthetic upstream (scripts/mock-upstream.mjs). These pin down the projection
// contract — what the cache keeps, what it drops, and what /api/data's
// snapshot() reports — so a refactor can't silently change what the dashboard
// sees.

import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockUpstream } from "../scripts/mock-upstream.mjs";
import { createSync } from "../server/sync.mjs";

let mock;
let mockUrl;
let dataDir;
let sync;

const WINDOW = () => ({
  start: new Date(Date.now() - 30 * 86400e3).toISOString(),
  end: new Date().toISOString(),
  agentId: "all",
});

/** Run sync rounds until the snapshot reports complete history (or bail). */
async function syncUntilComplete(maxRounds = 10) {
  for (let round = 0; round < maxRounds; round++) {
    const before = sync.snapshot(WINDOW()).meta.lastSyncAt;
    sync.onConfigChanged(); // one round, no timers
    // Wait for the round to finish (lastSyncAt moves when it does).
    for (let waited = 0; waited < 15_000; waited += 50) {
      await new Promise((r) => setTimeout(r, 50));
      if (sync.snapshot(WINDOW()).meta.lastSyncAt !== before) break;
    }
    if (sync.snapshot(WINDOW()).meta.historyComplete) return;
  }
}

beforeAll(async () => {
  mock = createMockUpstream({ seed: 7, days: 10 });
  ({ url: mockUrl } = await mock.ready);
  dataDir = await mkdtemp(join(tmpdir(), "pfdash-sync-"));
  sync = createSync({ getToken: () => mock.token, getHost: () => mockUrl, dataDir });
  await syncUntilComplete();
});

afterAll(async () => {
  await mock.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("backfill", () => {
  it("fetches every span and instance the upstream has", () => {
    const snap = sync.snapshot(WINDOW());
    const totalSpans = [...mock.data.spansByAgent.values()].reduce((a, v) => a + v.length, 0);
    const totalInstances = [...mock.data.instancesByAgent.values()].reduce((a, v) => a + v.length, 0);
    expect(snap.meta.historyComplete).toBe(true);
    expect(snap.spans).toHaveLength(totalSpans);
    // Instances still marked "active" upstream are included too.
    expect(snap.instances).toHaveLength(totalInstances);
    expect(snap.accountId).toBe(mock.data.accountId);
    expect(snap.agents.map((a) => a.id).sort()).toEqual([...mock.data.spansByAgent.keys()].sort());
  });

  it("reports account extras: alerts count and risk profiles", () => {
    const snap = sync.snapshot(WINDOW());
    expect(snap.alerts).toBe(3);
    expect(snap.riskProfiles).toEqual([{ id: "rp_standard", name: "Standard guardrails" }]);
  });

  it("sends the Bearer token on every upstream request", () => {
    expect(mock.requests.length).toBeGreaterThan(0);
    expect(mock.requests.every((r) => r.authorized)).toBe(true);
  });
});

describe("projection", () => {
  it("keeps token usage and normalises every finish-reason shape to {unified}", () => {
    const snap = sync.snapshot(WINDOW());
    const llm = snap.spans.filter((s) => s.schema_name === "ai-sdk:llm");
    expect(llm.length).toBeGreaterThan(0);
    for (const s of llm) {
      expect(s.payload.token_usage).toMatchObject({ prompt_tokens: expect.any(Number), completion_tokens: expect.any(Number) });
      expect(typeof s.payload.inputs?.ai?.model?.id).toBe("string");
      // Upstream emits BOTH the plain-string and {unified} shapes; the cache
      // must present exactly one shape to the client.
      const finish = s.payload.outputs?.ai?.finishReason;
      if (finish != null) expect(typeof finish.unified).toBe("string");
    }
    // Error spans carry error_type instead.
    expect(llm.some((s) => typeof s.payload.error?.error_type === "string")).toBe(true);
  });

  it("extracts sensitive labels but NEVER caches the sensitive value itself", () => {
    const snap = sync.snapshot(WINDOW());
    const tool = snap.spans.filter((s) => s.schema_name === "ai-sdk:tool:lookup_customer");
    expect(tool.length).toBeGreaterThan(0);
    for (const s of tool) {
      expect(s.sensitive_encoding).toBe(true);
      expect(s.sensitive_labels.length).toBeGreaterThan(0);
    }
    // The raw value existed upstream; the projection must have dropped it.
    expect(JSON.stringify(snap)).not.toContain("redacted@example.com");
  });

  it("keeps human ratings from both payload paths", () => {
    const snap = sync.snapshot(WINDOW());
    const rated = snap.spans.filter((s) => typeof s.payload.inputs?.feedback?.rating === "string");
    expect(rated.length).toBeGreaterThan(0);
    const ratings = new Set(rated.map((s) => s.payload.inputs.feedback.rating));
    expect(ratings.has("up") || ratings.has("down")).toBe(true);
    // Scale ratings (user:feedback inputs.rating) are preserved, not dropped.
    expect([...ratings].some((r) => /^\d/.test(r))).toBe(true);
  });

  it("carries termination reasons through to instances", () => {
    const snap = sync.snapshot(WINDOW());
    const killed = snap.instances.filter((i) => i.termination_reason);
    const upstreamKilled = [...mock.data.instancesByAgent.values()].flat().filter((i) => i.termination_reason);
    expect(killed).toHaveLength(upstreamKilled.length);
  });
});

describe("snapshot filtering", () => {
  it("filters by agent", () => {
    const snap = sync.snapshot({ ...WINDOW(), agentId: "agent_support" });
    expect(snap.spans.length).toBeGreaterThan(0);
    expect(snap.spans.every((s) => s.agent_id === "agent_support")).toBe(true);
    expect(snap.instances.every((i) => i.agent_id === "agent_support")).toBe(true);
  });

  it("filters by window and reports clipping honestly", () => {
    const narrow = sync.snapshot({
      start: new Date(Date.now() - 86400e3).toISOString(),
      end: new Date().toISOString(),
      agentId: "all",
    });
    const wide = sync.snapshot(WINDOW());
    expect(narrow.spans.length).toBeLessThan(wide.spans.length);
    expect(narrow.spans.every((s) => s.started_at >= narrow.meta.effectiveStart)).toBe(true);
    // Fully backfilled: nothing should be clipped.
    expect(wide.meta.clipped).toBe(false);
  });

  it("sorts instances newest first", () => {
    const snap = sync.snapshot(WINDOW());
    const times = snap.instances.map((i) => i.started_at);
    expect([...times].sort().reverse()).toEqual(times);
  });
});

describe("quality detail pass", () => {
  it("fills quality payloads for finished instances, bounded per round", () => {
    const snap = sync.snapshot(WINDOW());
    expect(snap.meta.detailChecked).toBeGreaterThan(0);
    const withQuality = snap.instances.filter((i) => i.quality_payload);
    expect(withQuality.length).toBeGreaterThan(0);
    expect(withQuality[0].quality_payload.scores).toBeDefined();
  });
});

describe("persistence", () => {
  it("writes an atomic versioned cache file", () => {
    const cachePath = join(dataDir, "cache-v1.json");
    expect(existsSync(cachePath)).toBe(true);
    const raw = JSON.parse(readFileSync(cachePath, "utf8"));
    expect(raw.projectionVersion).toBe(3);
    expect(raw.accountId).toBe(mock.data.accountId);
    expect(Array.isArray(raw.spans)).toBe(true);
    // No temp file left behind.
    expect(existsSync(`${cachePath}.tmp`)).toBe(false);
  });
});
