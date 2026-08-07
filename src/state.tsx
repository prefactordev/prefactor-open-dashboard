// One data context for the whole dashboard. The heavy lifting (paging the
// platform API) happens in the server's background sync; this provider just
// pulls the cached snapshot — instant — and re-pulls when the server's SSE
// stream says new data landed, so charts update live without a manual
// refresh. The filter row (time range + agent) scopes every tab.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fetchData, NoTokenError, onSyncUpdate } from "./api";
import type { Agent, DataSnapshot, InstanceDetail, InstanceSummary, RiskProfile, Span, TimeRangeKey } from "./types";

const RANGE_MS: Record<TimeRangeKey, number> = {
  "24h": 24 * 3600e3,
  "7d": 7 * 86400e3,
  "30d": 30 * 86400e3,
  "90d": 90 * 86400e3,
};

export interface DashboardData {
  agents: Agent[];
  agentName: (id: string | null | undefined) => string;
  spans: Span[];
  /** True when backfill hasn't reached the requested window start yet. */
  spansTruncated: boolean;
  instances: InstanceSummary[];
  details: InstanceDetail[]; // instances whose quality fields have been read
  detailCapped: boolean;
  riskProfiles: RiskProfile[];
  alerts: number | null;
  windowStart: string; // effective (possibly clipped) start
  windowEnd: string;
  range: TimeRangeKey;
  setRange: (r: TimeRangeKey) => void;
  agentId: string | "all";
  setAgentId: (id: string | "all") => void;
  loading: boolean;
  refetching: boolean; // filter changed — dim the previous render
  backfilling: boolean; // server still walking history for this scope
  /** The start of the range the user asked for (may predate what's cached). */
  requestedStart: string;
  /** Spans held locally — the reason repeat loads are instant. */
  cachedSpans: number;
  /** Range is short because of the fetch horizon, not because it's still loading. */
  horizonLimited: boolean;
  horizonDays: number;
  lastSyncAt: string | null;
  /** False when the live event stream is down — the UI must stop claiming "live". */
  live: boolean;
  error: string | null;
  /** No API token configured yet — first-run state, not an error. */
  needsToken: boolean;
  reload: () => void;
}

const Ctx = createContext<DashboardData | null>(null);

export function useDashboard(): DashboardData {
  const v = useContext(Ctx);
  if (!v) throw new Error("useDashboard outside provider");
  return v;
}

export function DataProvider({ children }: { children: ReactNode }) {
  const [range, setRange] = useState<TimeRangeKey>("7d");
  const [agentId, setAgentId] = useState<string | "all">("all");
  const [snap, setSnap] = useState<DataSnapshot | null>(null);
  const [requestedStart, setRequestedStart] = useState<string>("");
  const [windowEnd, setWindowEnd] = useState<string>(() => new Date().toISOString());
  const [refetching, setRefetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsToken, setNeedsToken] = useState(false);
  const [live, setLive] = useState(true);
  const [nonce, setNonce] = useState(0);
  const generation = useRef(0);
  const scope = useRef({ range, agentId });
  scope.current = { range, agentId };

  const inFlight = useRef<AbortController | null>(null);

  const load = useCallback(async (dim: boolean) => {
    const gen = ++generation.current;
    // Abort the previous request: rapid range switching otherwise pulls
    // several multi-MB snapshots at once, and the one the user actually wants
    // finishes last.
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    const end = new Date().toISOString();
    const start = new Date(Date.parse(end) - RANGE_MS[scope.current.range]).toISOString();
    if (dim) setRefetching(true);
    try {
      const data = await fetchData({ start, end, agentId: scope.current.agentId, signal: controller.signal });
      if (gen !== generation.current) return;
      setSnap(data);
      setRequestedStart(start);
      setWindowEnd(end);
      setError(null);
      setNeedsToken(false);
    } catch (err) {
      if (gen !== generation.current) return;
      if (err instanceof DOMException && err.name === "AbortError") return; // superseded, not a failure
      // First run with no token isn't an error — the Admin panel is already
      // open asking for one. Say nothing rather than showing a raw 401.
      setNeedsToken(err instanceof NoTokenError);
      setError(err instanceof NoTokenError ? null : err instanceof Error ? err.message : String(err));
    } finally {
      // Whichever load is CURRENT clears the dimmed state. Gating this on
      // `dim` deadlocked the UI: a background sync superseding a filter change
      // left the dim flag set by the filter change with nothing able to clear
      // it, so the whole page stayed at 55% opacity showing "loading…" until
      // the user touched a filter again. Superseded loads are aborted, so the
      // current one always reflects the current scope.
      if (gen === generation.current) setRefetching(false);
    }
  }, []);

  // Filter changes: full reload with the previous render dimmed.
  useEffect(() => {
    void load(true);
  }, [range, agentId, nonce, load]);

  // Live updates: the server pings when a sync round changed data. Debounced —
  // background refreshes never dim the page.
  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = onSyncUpdate(
      () => {
        if (pending) return;
        pending = setTimeout(() => {
          pending = null;
          void load(false);
        }, 1500);
      },
      (isLive) => setLive(isLive),
    );
    return () => {
      if (pending) clearTimeout(pending);
      unsubscribe();
    };
  }, [load]);

  const agentName = useCallback(
    (id: string | null | undefined) => snap?.agents.find((a) => a.id === id)?.name ?? (id ? `${id.slice(0, 8)}…` : "—"),
    [snap],
  );

  // Memoised on `snap` alone: computing this inside the context value gave it a
  // fresh identity whenever `refetching` toggled, which re-ran both Quality
  // tabs' full aggregations twice per filter change.
  const details = useMemo(() => (snap?.instances ?? []).filter((i) => i.detail_checked), [snap]);

  const value = useMemo<DashboardData>(() => {
    return {
      agents: snap?.agents ?? [],
      agentName,
      spans: snap?.spans ?? [],
      spansTruncated: snap?.meta.clipped ?? false,
      instances: snap?.instances ?? [],
      details,
      detailCapped: (snap?.instances.length ?? 0) > details.length,
      riskProfiles: snap?.riskProfiles ?? [],
      alerts: snap?.alerts ?? null,
      windowStart: snap?.meta.effectiveStart ?? requestedStart ?? windowEnd,
      windowEnd,
      range,
      setRange,
      agentId,
      setAgentId,
      loading: snap === null && error === null && !needsToken,
      refetching,
      backfilling: (snap?.meta.backfillingAgents ?? 0) > 0,
      requestedStart,
      cachedSpans: snap?.meta.cachedSpans ?? 0,
      horizonLimited: snap?.meta.horizonLimited ?? false,
      horizonDays: snap?.meta.horizonDays ?? 90,
      lastSyncAt: snap?.meta.lastSyncAt ?? null,
      live,
      error: error ?? snap?.meta.syncError ?? null,
      needsToken,
      reload: () => setNonce((n) => n + 1),
    };
  }, [snap, details, agentName, requestedStart, windowEnd, range, agentId, refetching, error, needsToken, live]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
