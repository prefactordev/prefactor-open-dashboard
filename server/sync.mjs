// Background sync engine — the fix for slow loads and stale "live" data.
//
// Instead of the browser paging the platform API on every load (~2s per
// 100-span page, capped at 6 parallel requests by the browser), this module
// keeps a local cache the browser reads in ONE instant localhost response:
//
//   - Backfill: page each agent newest-first (ids are k-sortable) until the
//     horizon, at higher concurrency than a browser allows. Runs in the
//     background; partial data is visible immediately and fills in live.
//   - Incremental sync: after backfill, a poll only walks pages until it hits
//     ids it already knows — new spans cost one page fetch, not a re-pull.
//   - Projection: only the fields the dashboard reads are kept (~200 bytes a
//     span instead of ~3.5KB), so a week of high-volume data fits in memory
//     and on disk. Raw payload contents are NOT cached.
//   - Listeners (SSE) are pinged after every round that changed anything.
//
// Zero dependencies. Persisted to data/cache-v1.json so restarts are instant.

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PAGE_SIZE = 100;
const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS ?? 15_000);
const AGENT_CONCURRENCY = 3; // agents synced at once
const PAGE_CONCURRENCY = 6; // pages per backfill burst
// The platform API queues aggressive parallelism into timeout territory —
// ~6 in-flight requests is the sweet spot observed live, so a global
// semaphore holds ALL upstream traffic to that regardless of the loops above.
const GLOBAL_REQUEST_LIMIT = 6;
// Guarded: Number("") is 0 and Number("abc") is NaN, either of which would put
// the horizon at "now" — evicting the entire cache every round.
const BACKFILL_HORIZON_DAYS = (() => {
  const n = Number(process.env.BACKFILL_HORIZON_DAYS ?? 90);
  return Number.isFinite(n) && n >= 1 ? n : 90;
})();
const MAX_SPANS_PER_AGENT = Number(process.env.MAX_CACHE_SPANS_PER_AGENT ?? 60_000);
const BACKFILL_PAGES_PER_ROUND = 20; // per agent per round — keeps rounds short
const IDLE_BACKOFF_AFTER = 4; // rounds with nothing new before an agent slows down
const IDLE_POLL_EVERY = 8; // idle agents poll every Nth round (~2 min at 15s)
const DETAILS_PER_ROUND = 30; // instance-detail (quality) fetches per round
const DETAIL_RECHECK_MS = 10 * 60_000; // re-read quality on recent runs
const DETAIL_RECENT_MS = 24 * 3600_000; // ...if the run finished in the last 24h
const AGENTS_REFRESH_MS = 5 * 60_000;
const EXTRAS_REFRESH_MS = 5 * 60_000; // risk profiles + alerts

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const unwrap = (v) => (v && typeof v === "object" && "$sensitive" in v ? v.value : v);

function collectSensitiveLabels(obj, out, depth = 0) {
  if (depth > 6 || obj == null || typeof obj !== "object") return;
  if ("$sensitive" in obj) {
    if (Array.isArray(obj.labels))
      for (const l of obj.labels)
        if (typeof l === "string") out.add(l);
        else out.add("unlabelled");
    return;
  }
  for (const v of Object.values(obj)) collectSensitiveLabels(v, out, depth + 1);
}

/**
 * Normalise a timestamp to canonical `…Z` ISO. Every ordering decision in this
 * file (horizon checks, oldest-fetched, window filtering) is a lexicographic
 * string compare, which is only valid within one format. An offset-style value
 * like `2026-08-07T01:00:00+00:00` sorts BELOW any `…Z` string, so a single
 * such row would make the horizon check fire immediately and truncate history
 * to one page. Sub-millisecond precision is dropped, which no chart cares about.
 */
function isoZ(v) {
  if (typeof v !== "string" || v === "") return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v)) return v;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Keep only what the dashboard reads; synthesize the exact payload paths the client libs use. */
function projectSpan(s) {
  const p = s.payload ?? {};
  const labels = new Set();
  collectSensitiveLabels(p, labels);

  const tu = p.token_usage;
  // Model path differs by SDK family (ai-sdk vs Anthropic wrappers).
  const model = p?.inputs?.ai?.model?.id ?? p?.inputs?.model;
  // finishReason comes in two shapes in the wild: a plain string ("stop",
  // "tool-calls") and an object ({unified, raw}). Reading only `.unified`
  // silently captured NOTHING on accounts using the string form, so the Cost
  // tab's finish-reason chart read as 100% "unknown" for every LLM call.
  const finishRaw = p?.outputs?.ai?.finishReason ?? s?.result_payload?.ai?.finishReason ?? p?.outputs?.stop_reason;
  const finish = typeof finishRaw === "string" ? finishRaw : (finishRaw?.unified ?? finishRaw?.raw);
  const errType = p?.error?.error_type;
  // Human rating lives at two paths in the wild: inputs.feedback.rating
  // (prefactor:quality thumbs) and inputs.rating (user:feedback spans).
  const rating = unwrap(p?.inputs?.feedback?.rating) ?? unwrap(p?.inputs?.rating);

  const payload = {};
  if (tu && typeof tu === "object") {
    payload.token_usage = {
      prompt_tokens: tu.prompt_tokens ?? 0,
      completion_tokens: tu.completion_tokens ?? 0,
      total_tokens: tu.total_tokens ?? 0,
    };
  }
  if (typeof model === "string") payload.inputs = { ai: { model: { id: model } } };
  // Keep ANY rating, not just up/down: a team using a 1-5 scale would
  // otherwise have every rating dropped here and counted nowhere.
  if (typeof rating === "string" && rating !== "") payload.inputs = { ...(payload.inputs ?? {}), feedback: { rating } };
  if (typeof finish === "string") payload.outputs = { ai: { finishReason: { unified: finish } } };
  if (typeof errType === "string") payload.error = { error_type: errType };

  return {
    id: s.id,
    status: s.status,
    schema_name: s.schema_name,
    schema_title: s.schema_title ?? null,
    started_at: isoZ(s.started_at),
    finished_at: isoZ(s.finished_at),
    parent_span_id: s.parent_span_id ?? null,
    agent_instance_id: s.agent_instance_id ?? null,
    agent_id: s.agent_id ?? null,
    purpose: s.purpose ?? null,
    risk_level: s.risk_level ?? null,
    risk_score: typeof s.risk_score === "number" ? s.risk_score : null,
    sensitive_encoding: Boolean(s.sensitive_encoding) || labels.size > 0,
    sensitive_labels: [...labels],
    payload,
  };
}

function projectInstance(i) {
  return {
    id: i.id,
    status: i.status,
    purpose: i.purpose ?? null,
    started_at: isoZ(i.started_at),
    finished_at: isoZ(i.finished_at),
    agent_id: i.agent_id,
    termination_reason: i.termination_reason ?? null,
    // filled by the detail pass:
    detail_checked: false,
    quality_payload: null,
    quality_summary: null,
  };
}

export function createSync({ getToken, getHost, dataDir }) {
  const events = new EventEmitter();
  events.setMaxListeners(50);

  const state = {
    accountId: null,
    agents: new Map(), // id → {id,name,status,type}
    spans: new Map(), // id → projected span
    instances: new Map(), // id → projected instance (+quality detail)
    riskProfiles: [],
    alerts: null,
    // per-agent sync bookkeeping
    agentSync: new Map(), // id → {backfillDone, oldestFetched, backfillOffset, spanCount, instBackfillDone, instOldest}
    lastSyncAt: null,
    syncing: false,
    error: null,
    dirty: false,
  };
  const detailCheckedAt = new Map(); // instanceId → epoch ms of last detail fetch
  const detailFails = new Map(); // instanceId → consecutive detail-fetch failures

  const cachePath = join(dataDir, "cache-v1.json");
  // Bump whenever projectSpan/projectInstance changes shape. A cache written
  // by an older projection is discarded and refetched rather than read as if
  // it had the new fields — silently-stale rows are worse than a re-backfill.
  const PROJECTION_VERSION = 3;

  // --- upstream ------------------------------------------------------------

  // Global upstream semaphore.
  let inFlight = 0;
  const waiters = [];
  const acquire = () => (inFlight < GLOBAL_REQUEST_LIMIT ? (inFlight++, Promise.resolve()) : new Promise((r) => waiters.push(r)));
  const release = () => {
    const next = waiters.shift();
    if (next) next();
    else inFlight--;
  };

  async function api(path, params = {}) {
    const token = getToken();
    if (!token) throw new Error("no token");
    const url = new URL(`${getHost()}/api/v1/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    await acquire();
    try {
      // Hard timeout per request — a single hung fetch must never wedge a round.
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      return await res.json();
    } finally {
      release();
    }
  }

  const listPage = (path, params, offset) =>
    api(path, {
      ...params,
      "pagination[page_size]": PAGE_SIZE,
      "pagination[offset]": offset,
      "sorting[field]": "id",
      "sorting[direction]": "desc",
    });

  // --- persistence ---------------------------------------------------------

  function load() {
    try {
      if (!existsSync(cachePath)) return;
      const raw = JSON.parse(readFileSync(cachePath, "utf8"));
      if ((raw.projectionVersion ?? 0) !== PROJECTION_VERSION) {
        console.log(`[sync] cache was written by an older projection (v${raw.projectionVersion ?? 0}) - refetching`);
        return;
      }
      state.accountId = raw.accountId ?? null;
      for (const s of raw.spans ?? []) state.spans.set(s.id, s);
      for (const i of raw.instances ?? []) state.instances.set(i.id, i);
      for (const [id, v] of raw.agentSync ?? []) {
        state.agentSync.set(id, { ...v, backfillOffset: v.backfillOffset ?? 0, instOffset: v.instOffset ?? 0 });
      }
      for (const [id, at] of raw.detailCheckedAt ?? []) detailCheckedAt.set(id, at);
      for (const a of raw.agents ?? []) state.agents.set(a.id, a);
      console.log(`[sync] loaded cache: ${state.spans.size} spans, ${state.instances.size} instances`);
    } catch (err) {
      console.warn(`[sync] cache load failed (starting fresh): ${err?.message ?? err}`);
    }
  }

  /**
   * Write the cache atomically: a crash or a kill mid-write would otherwise
   * leave a truncated JSON file, which fails to load and forces a full
   * re-backfill — the exact slow path this cache exists to avoid. Writing to a
   * temp file and renaming means the old cache stays valid until the new one
   * is complete.
   */
  function persist() {
    if (!state.dirty) return;
    try {
      mkdirSync(dataDir, { recursive: true });
      const tmp = `${cachePath}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({
          projectionVersion: PROJECTION_VERSION,
          accountId: state.accountId,
          agents: [...state.agents.values()],
          agentSync: [...state.agentSync.entries()],
          spans: [...state.spans.values()],
          instances: [...state.instances.values()],
          // Persisted so a restart doesn't re-fetch quality detail for every
          // instance already checked — on a large cache that was hours of
          // pointless upstream traffic after each start.
          detailCheckedAt: [...detailCheckedAt.entries()],
        }),
        // Cached quality payloads can contain whatever your eval code wrote;
        // don't leave them world-readable.
        { mode: 0o600 },
      );
      renameSync(tmp, cachePath); // atomic on the same filesystem
      state.dirty = false;
    } catch (err) {
      console.warn(`[sync] persist failed: ${err?.message ?? err}`);
    }
  }

  /**
   * Throttled persist, called as each agent's data lands rather than only at
   * the end of a round — a first sync can take tens of seconds, and none of
   * that work should be at risk of a hard kill. Small caches are written
   * eagerly (a 2MB write costs ~10ms); large ones back off, since serialising
   * tens of megabytes is not free.
   */
  let lastPersistAt = 0;
  function maybePersist(force = false) {
    if (!state.dirty) return;
    const minGap = state.spans.size > 50_000 ? 30_000 : 5_000;
    if (!force && Date.now() - lastPersistAt < minGap) return;
    persist();
    lastPersistAt = Date.now();
  }

  /**
   * Drop rows that have aged out of the fetch horizon. Without this the cache
   * only ever grew: a dashboard left running for weeks on a live account
   * climbed until the process ran out of memory, and the horizon only bounded
   * how far BACK we fetched, never how much we kept.
   */
  function evictBeyondHorizon(horizonIso) {
    let dropped = 0;
    for (const [id, s] of state.spans) {
      if (s.started_at && s.started_at < horizonIso) {
        state.spans.delete(id);
        dropped++;
      }
    }
    for (const [id, i] of state.instances) {
      if (i.started_at && i.started_at < horizonIso) {
        state.instances.delete(id);
        detailCheckedAt.delete(id);
        dropped++;
      }
    }
    if (dropped > 0) {
      // Per-agent counters must follow, or the per-agent cap would stay
      // tripped forever after an eviction.
      for (const as of state.agentSync.values()) as.spanCount = 0;
      for (const s of state.spans.values()) {
        const as = s.agent_id ? state.agentSync.get(s.agent_id) : null;
        if (as) as.spanCount = (as.spanCount ?? 0) + 1;
      }
      state.dirty = true;
      console.log(`[sync] evicted ${dropped} rows older than the ${BACKFILL_HORIZON_DAYS}d horizon`);
    }
  }

  function wipe() {
    state.accountId = null;
    state.agents.clear();
    state.spans.clear();
    state.instances.clear();
    state.agentSync.clear();
    detailCheckedAt.clear();
    // Account-scoped extras must go too, or the new account briefly shows the
    // previous account's risk profiles and alert count.
    state.riskProfiles = [];
    state.alerts = null;
    lastExtrasRefresh = 0;
    state.dirty = true;
    persist();
  }

  // --- sync passes ---------------------------------------------------------

  let lastAgentsRefresh = 0;
  let lastExtrasRefresh = 0;

  async function refreshAccountAndAgents() {
    const acct = await api("account");
    const accountId = acct.details?.id ?? acct.summaries?.[0]?.id ?? null;
    if (accountId && state.accountId && accountId !== state.accountId) {
      console.log("[sync] account changed - clearing cache");
      wipe();
    }
    state.accountId = accountId;

    let offset = 0;
    const seen = new Set();
    // Page cap: a misbehaving next_page_offset would otherwise spin forever
    // while holding the sync lock.
    for (let page = 0; page < 50; page++) {
      const data = await listPage("agent", {}, offset);
      for (const a of data.summaries ?? []) {
        seen.add(a.id);
        state.agents.set(a.id, { id: a.id, name: a.name ?? a.id, status: a.status ?? "", type: a.type ?? "", updated_at: a.updated_at ?? null });
      }
      const next = data.pagination?.next_page_offset;
      if (next == null) break;
      offset = next;
    }

    // Drop agents that no longer exist upstream. Keeping them meant a deleted
    // agent stayed "still backfilling" forever, which pinned historyComplete
    // to false and clipped the time window for the WHOLE dashboard, while
    // burning failing requests every round.
    if (seen.size > 0) {
      for (const id of [...state.agents.keys()]) {
        if (seen.has(id)) continue;
        state.agents.delete(id);
        state.agentSync.delete(id);
        state.dirty = true;
      }
    }
    lastAgentsRefresh = Date.now();
  }

  async function refreshExtras() {
    try {
      const count = await api("alerts/count");
      state.alerts = typeof count.count === "number" ? count.count : null;
    } catch {
      state.alerts = null;
    }
    try {
      if (state.accountId) {
        const rp = await api("risk_profile", { account_id: state.accountId, "pagination[page_size]": PAGE_SIZE });
        state.riskProfiles = (rp.summaries ?? []).map((p) => ({ id: p.id, name: p.name }));
      }
    } catch {
      /* optional */
    }
    lastExtrasRefresh = Date.now();
  }

  function agentState(id) {
    let s = state.agentSync.get(id);
    if (!s) {
      s = { backfillDone: false, oldestFetched: null, backfillOffset: 0, instBackfillDone: false, instOldest: null, instOffset: 0 };
      state.agentSync.set(id, s);
    }
    return s;
  }

  /**
   * One agent's span sync. Newest-first paging:
   *  - incremental phase: from offset 0, stop at the first page with no new ids
   *  - backfill phase: continue from the remembered offset toward the horizon,
   *    a bounded number of pages per round so rounds stay short
   */
  async function syncAgentSpans(agentId, horizonIso) {
    const as = agentState(agentId);
    let added = 0;

    // Incremental: catch anything new at the top.
    let offset = 0;
    for (;;) {
      const data = await listPage("agent_spans", { agent_id: agentId, include_risk_level: "true" }, offset);
      const rows = data.summaries ?? [];
      let newHere = 0;
      for (const raw of rows) {
        const st = isoZ(raw.started_at);
        // Past the horizon: never store it. Eviction would delete it at the end
        // of the round and the next round would see it as "new" again — an
        // endless fetch/evict cycle on any agent whose history predates it.
        if (st && st < horizonIso) {
          newHere++; // still "seen", so the incremental walk can stop
        } else if (!state.spans.has(raw.id)) {
          state.spans.set(raw.id, projectSpan(raw));
          as.spanCount = (as.spanCount ?? 0) + 1;
          newHere++;
          added++;
        }
        if (st && (!as.oldestFetched || st < as.oldestFetched)) as.oldestFetched = st;
      }
      const next = data.pagination?.next_page_offset;
      if (rows.length === 0 || next == null) {
        as.backfillDone = true; // walked the whole history
        break;
      }
      if (as.backfillDone && newHere < rows.length) break; // reached known territory
      if (!as.backfillDone) {
        // Backfill continues from its own remembered offset — the top page here
        // only catches new arrivals. Seed the offset on the very first pass.
        if (as.backfillOffset === 0) as.backfillOffset = next;
        break;
      }
      offset = next;
    }

    // Backfill: bounded burst of older pages, parallel where the offsets are
    // known. The cap is PER AGENT (as the env var name says): a global budget
    // would let one busy agent stop every other agent's backfill.
    // Hitting the cap ENDS backfill for this agent. Skipping the block without
    // setting backfillDone left the agent "still backfilling" forever, which
    // pinned the whole dashboard's window open and showed "Fetching older
    // history…" indefinitely for history that was never coming.
    if (!as.backfillDone && (as.spanCount ?? 0) >= MAX_SPANS_PER_AGENT) {
      as.backfillDone = true;
      as.capLimited = true;
      as.horizonLimited = true; // the window genuinely can't reach further back
    }
    if (!as.backfillDone) {
      const offsets = [];
      for (let i = 0; i < BACKFILL_PAGES_PER_ROUND; i++) offsets.push(as.backfillOffset + i * PAGE_SIZE);
      const pages = await mapLimit(offsets, PAGE_CONCURRENCY, (off) =>
        listPage("agent_spans", { agent_id: agentId, include_risk_level: "true" }, off).catch(() => null),
      );
      let exhausted = false;
      let reachedHorizon = false;
      // Only advance past the pages that actually came back. A timeout or 429
      // on one page used to move the cursor past it anyway, leaving a
      // permanent, invisible hole in history that nothing ever revisits.
      let contiguousOk = 0;
      for (const data of pages) {
        if (!data) break;
        contiguousOk++;
        const rows = data.summaries ?? [];
        if (rows.length === 0 || data.pagination?.next_page_offset == null) exhausted = true;
        for (const raw of rows) {
          const st = isoZ(raw.started_at);
          if (st && (!as.oldestFetched || st < as.oldestFetched)) as.oldestFetched = st;
          if (st && st < horizonIso) reachedHorizon = true;
          // Same rule as the incremental phase: don't store what eviction will
          // immediately remove.
          else if (!state.spans.has(raw.id)) {
            state.spans.set(raw.id, projectSpan(raw));
            as.spanCount = (as.spanCount ?? 0) + 1;
            added++;
          }
        }
      }
      as.backfillOffset += contiguousOk * PAGE_SIZE;
      if (contiguousOk === 0) {
        as.failedRounds = (as.failedRounds ?? 0) + 1;
        // A page that fails every time (a 429 window, a row the API 500s on,
        // a request that always times out) would otherwise freeze this agent's
        // backfill forever — and a permanently-incomplete agent clips the time
        // window for the WHOLE dashboard. After several attempts, step over it
        // and say so, rather than retrying the same offset until the heat death
        // of the universe.
        if (as.failedRounds >= 5) {
          console.warn(`[sync] agent ${agentId}: skipping page at offset ${as.backfillOffset} after 5 failed attempts`);
          as.backfillOffset += PAGE_SIZE;
          as.skippedPages = (as.skippedPages ?? 0) + 1;
          as.failedRounds = 0;
        }
      } else {
        as.failedRounds = 0;
      }
      if (exhausted || reachedHorizon) as.backfillDone = true;
      // Stopping at the horizon is different from running out of history: the
      // cache genuinely cannot answer for anything older, so the window must
      // keep clipping (and saying so) rather than silently showing less.
      if (reachedHorizon && !exhausted) as.horizonLimited = true;
    }

    return added;
  }

  /** Instance sync, same newest-first two-phase pattern (endpoint requires agent_id). */
  async function syncAgentInstances(agentId, horizonIso) {
    const as = agentState(agentId);
    let added = 0;

    const absorbPage = (rows) => {
      let newHere = 0;
      for (const raw of rows) {
        const existing = state.instances.get(raw.id);
        if (!existing) {
          state.instances.set(raw.id, projectInstance(raw));
          newHere++;
          added++;
        } else if (existing.status !== raw.status || existing.termination_reason !== (raw.termination_reason ?? null)) {
          // status transitions (active → complete/failed, termination) must land
          Object.assign(existing, {
            status: raw.status,
            finished_at: raw.finished_at ?? existing.finished_at,
            termination_reason: raw.termination_reason ?? null,
          });
          added++;
        }
        const st = isoZ(raw.started_at);
        if (st && (!as.instOldest || st < as.instOldest)) as.instOldest = st;
      }
      return newHere;
    };

    // Incremental: from the top until a page brings nothing new.
    let offset = 0;
    for (let page = 0; page < 5; page++) {
      const data = await listPage("agent_instance", { agent_id: agentId }, offset);
      const rows = data.summaries ?? [];
      const newHere = absorbPage(rows);
      const next = data.pagination?.next_page_offset;
      if (next == null || rows.length === 0) {
        as.instBackfillDone = true;
        return added;
      }
      if (!as.instBackfillDone) {
        if (as.instOffset === 0) as.instOffset = next;
        break;
      }
      if (newHere < rows.length) break;
      offset = next;
    }

    // Backfill continuation from the remembered offset.
    if (!as.instBackfillDone) {
      for (let page = 0; page < 8; page++) {
        const data = await listPage("agent_instance", { agent_id: agentId }, as.instOffset);
        const rows = data.summaries ?? [];
        absorbPage(rows);
        const next = data.pagination?.next_page_offset;
        const oldestOnPage = isoZ(rows[rows.length - 1]?.started_at);
        if (next == null || rows.length === 0 || (oldestOnPage && oldestOnPage < horizonIso)) {
          as.instBackfillDone = true;
          if (next != null && rows.length > 0) as.horizonLimited = true; // stopped at the horizon, not the end
          break;
        }
        as.instOffset = next;
      }
    }
    return added;
  }

  /** Quality-detail pass: newest finished instances first, bounded per round. */
  async function syncDetails() {
    const now = Date.now();
    // Filter BEFORE sorting, and compare ISO strings directly: sorting every
    // cached instance with localeCompare each round costs seconds once the
    // cache is large.
    const candidates = [...state.instances.values()]
      .filter((i) => {
        if (i.status === "active") return false;
        const at = detailCheckedAt.get(i.id);
        if (at == null) return true;
        const finished = i.finished_at ? Date.parse(i.finished_at) : 0;
        return now - at > DETAIL_RECHECK_MS && now - finished < DETAIL_RECENT_MS;
      })
      .sort((a, b) => (a.started_at === b.started_at ? 0 : String(b.started_at) > String(a.started_at) ? 1 : -1))
      .slice(0, DETAILS_PER_ROUND);

    let changed = 0;
    await mapLimit(candidates, 6, async (i) => {
      try {
        const data = await api(`agent_instance/${i.id}`);
        const d = data.details ?? {};
        const inst = state.instances.get(i.id);
        if (!inst) return;
        const qp = d.quality_payload ?? null;
        const qs = d.quality_summary ?? null;
        if (!inst.detail_checked || JSON.stringify(inst.quality_payload) !== JSON.stringify(qp) || inst.quality_summary !== qs) changed++;
        inst.detail_checked = true;
        inst.quality_payload = qp;
        inst.quality_summary = qs;
        detailCheckedAt.set(i.id, now);
        detailFails.delete(i.id);
      } catch {
        // Back off, don't abandon. Marking a failure as "checked" outright
        // meant one transient error permanently dropped that run's quality
        // data (a run finished over 24h ago never re-qualifies). Retry a few
        // times, then stop so a permanently-404ing instance can't consume the
        // whole per-round budget forever.
        const fails = (detailFails.get(i.id) ?? 0) + 1;
        detailFails.set(i.id, fails);
        if (fails >= 3) detailCheckedAt.set(i.id, now);
      }
    });
    return changed;
  }

  let roundStartedAt = 0;
  let roundGeneration = 0;

  async function syncOnce() {
    // Watchdog: a round that outlives 5 minutes forfeits its lock. Bumping the
    // generation is what makes this safe — the stalled round's `finally` will
    // see it no longer owns the lock and won't clear the NEW round's lock.
    // (A large account legitimately exceeds 5 minutes, so this fires in normal
    // use, not just in emergencies.)
    if (state.syncing && Date.now() - roundStartedAt > 5 * 60_000) {
      console.warn("[sync] previous round exceeded 5m - starting a fresh one");
      roundGeneration++;
      state.syncing = false;
    }
    if (state.syncing || !getToken()) return;
    const myGeneration = ++roundGeneration;
    state.syncing = true;
    roundStartedAt = Date.now();
    try {
      if (Date.now() - lastAgentsRefresh > AGENTS_REFRESH_MS || state.agents.size === 0) await refreshAccountAndAgents();
      if (Date.now() - lastExtrasRefresh > EXTRAS_REFRESH_MS) await refreshExtras();

      const horizonIso = new Date(Date.now() - BACKFILL_HORIZON_DAYS * 86400e3).toISOString();
      const ids = [...state.agents.keys()];
      const changes = await mapLimit(ids, AGENT_CONCURRENCY, async (id) => {
        // Cooperative cancellation: once the watchdog has started a
        // replacement round, this one must stop touching shared cursors.
        if (myGeneration !== roundGeneration) return 0;
        const as = agentState(id);
        // Idle backoff: agents that keep coming back empty poll less often, so
        // steady-state load on the upstream stays light.
        as.sinceSynced = (as.sinceSynced ?? 0) + 1;
        const busy = !as.backfillDone || !as.instBackfillDone;
        const interval = busy || (as.idleRounds ?? 0) < IDLE_BACKOFF_AFTER ? 1 : IDLE_POLL_EVERY;
        if (as.sinceSynced < interval) return 0;
        as.sinceSynced = 0;
        try {
          // Instances before the deep span backfill so runs/quality populate early.
          const a = await syncAgentInstances(id, horizonIso);
          const b = await syncAgentSpans(id, horizonIso);
          const added = a + b;
          as.idleRounds = added === 0 ? (as.idleRounds ?? 0) + 1 : 0;
          if (added > 0) {
            // Publish and save as soon as THIS agent has data, so the first
            // charts appear (and are durable) seconds in, not after every
            // agent in the account has been walked.
            state.dirty = true;
            events.emit("update", { changed: added });
            maybePersist();
          }
          return added;
        } catch (err) {
          console.warn(`[sync] agent ${id}: ${err?.message ?? err}`);
          return 0;
        }
      });
      const detailChanges = myGeneration === roundGeneration ? await syncDetails() : 0;

      const total = changes.reduce((a, b) => a + b, 0) + detailChanges;
      state.lastSyncAt = new Date().toISOString();
      state.error = null;
      if (total > 0) {
        state.dirty = true;
        events.emit("update", { changed: total });
      }
      evictBeyondHorizon(horizonIso);
      // Save soon after work lands, not only on the slow timer: a hard kill
      // (container restart, power loss) must not throw away a backfill that
      // took minutes to fetch.
      maybePersist();
    } catch (err) {
      state.error = err?.message ?? String(err);
      console.warn(`[sync] round failed: ${state.error}`);
    } finally {
      // Only release the lock if it's still ours; a watchdog-superseded round
      // must not free the lock belonging to the round that replaced it.
      if (myGeneration === roundGeneration) state.syncing = false;
    }
  }

  // --- public API ----------------------------------------------------------

  let timer = null;

  return {
    events,
    start() {
      load();
      if (timer) return;
      syncOnce();
      timer = setInterval(syncOnce, SYNC_INTERVAL_MS);
      setInterval(() => maybePersist(true), 60_000);
      const flush = () => {
        persist();
        process.exit(0);
      };
      process.on("SIGINT", flush);
      process.on("SIGTERM", flush);
    },
    /** Token/host changed via the admin panel: resync now (wipes if the account differs). */
    onConfigChanged() {
      lastAgentsRefresh = 0;
      lastExtrasRefresh = 0;
      syncOnce();
    },
    /** Snapshot for /api/data: everything the client needs, filtered to scope. */
    snapshot({ start, end, agentId }) {
      const inScope = (aid) => (agentId === "all" || !agentId ? true : aid === agentId);

      // Coverage: an agent that hasn't finished backfilling only vouches for
      // data back to the oldest row it has fetched — clip the window there.
      let effectiveStart = start;
      let horizonLimited = false;
      for (const [id, as] of state.agentSync) {
        if (!inScope(id)) continue;
        // Clip while still fetching, and permanently for agents whose history
        // was cut short by the horizon.
        const spansIncomplete = !as.backfillDone || as.horizonLimited;
        const instIncomplete = !as.instBackfillDone || as.horizonLimited;
        if (spansIncomplete && as.oldestFetched && as.oldestFetched > effectiveStart) effectiveStart = as.oldestFetched;
        if (instIncomplete && as.instOldest && as.instOldest > effectiveStart) effectiveStart = as.instOldest;
        if (as.horizonLimited) horizonLimited = true;
      }

      const spans = [];
      for (const s of state.spans.values()) {
        if (!inScope(s.agent_id)) continue;
        if (!s.started_at || s.started_at < effectiveStart || s.started_at > end) continue;
        spans.push(s);
      }
      const instances = [];
      for (const i of state.instances.values()) {
        if (!inScope(i.agent_id)) continue;
        if (!i.started_at || i.started_at < effectiveStart || i.started_at > end) continue;
        instances.push(i);
      }
      instances.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));

      const backfilling = [...state.agentSync.entries()].filter(([id, s]) => inScope(id) && (!s.backfillDone || !s.instBackfillDone)).length;
      return {
        accountId: state.accountId,
        agents: [...state.agents.values()],
        spans,
        instances,
        riskProfiles: state.riskProfiles,
        alerts: state.alerts,
        meta: {
          effectiveStart,
          clipped: effectiveStart !== start,
          backfillingAgents: backfilling,
          /** True once every in-scope agent has walked its full history. */
          historyComplete: backfilling === 0,
          /** Clipped because BACKFILL_HORIZON_DAYS cut history, not because it's still loading. */
          horizonLimited: horizonLimited && effectiveStart !== start,
          /** How far back history is fetched at all (BACKFILL_HORIZON_DAYS). */
          horizonDays: BACKFILL_HORIZON_DAYS,
          cachedSpans: state.spans.size,
          lastSyncAt: state.lastSyncAt,
          syncError: state.error,
          detailChecked: instances.filter((i) => i.detail_checked).length,
        },
      };
    },
  };
}
