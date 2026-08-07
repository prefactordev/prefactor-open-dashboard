// Client for the local server. All platform-API traffic happens server-side
// in a background sync (see server/sync.mjs); the browser only ever makes
// instant localhost calls:
//   GET /api/data    — the cached snapshot for a window/agent scope
//   GET /api/events  — SSE stream; a "sync" event means new data landed
//   /api/config      — admin panel (token is write-only)

import type { DataSnapshot } from "./types";

/** No API token set yet — expected on first run, not an error worth shouting about. */
export class NoTokenError extends Error {
  constructor() {
    super("No API token configured");
    this.name = "NoTokenError";
  }
}

export async function fetchData(opts: { start: string; end: string; agentId: string; signal?: AbortSignal }): Promise<DataSnapshot> {
  const qs = new URLSearchParams({ start: opts.start, end: opts.end, agent: opts.agentId });
  const res = await fetch(`/api/data?${qs}`, { signal: opts.signal });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401 && body.includes("no_token")) throw new NoTokenError();
    throw new Error(`Couldn't load data from the local server (HTTP ${res.status}). ${body.slice(0, 160)}`);
  }
  return (await res.json()) as DataSnapshot;
}

/**
 * Subscribe to sync pings.
 *
 * EventSource only auto-reconnects after a *network* drop; a non-200 or a
 * wrong content-type closes it permanently. Without noticing that, the
 * dashboard sat there claiming "live" while nothing refreshed again — so this
 * reports connection state and reconnects itself, and the caller refetches on
 * reconnect (events missed while disconnected are gone).
 */
export function onSyncUpdate(handler: () => void, onState?: (live: boolean) => void): () => void {
  let es: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let backoff = 3000;

  const connect = () => {
    if (closed) return;
    es = new EventSource("/api/events");
    es.addEventListener("open", () => {
      backoff = 3000;
      onState?.(true);
      handler(); // catch up on anything missed while disconnected
    });
    es.addEventListener("sync", () => handler());
    es.addEventListener("error", () => {
      onState?.(false);
      // CLOSED means it will never retry on its own; rebuild it ourselves.
      if (es?.readyState === EventSource.CLOSED) {
        es.close();
        es = null;
        if (!closed) {
          retry = setTimeout(connect, backoff);
          backoff = Math.min(backoff * 2, 30_000);
        }
      }
    });
  };
  connect();

  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    es?.close();
  };
}

// --- admin config (token is write-only: it can be set, never read back) ----

export interface ServerConfig {
  tokenSet: boolean;
  host: string;
  /** Token comes from an env var: the panel can't override it. */
  fromEnv?: boolean;
  /** Whether the saved token will survive a restart. */
  persisted?: boolean;
}

export async function getConfig(): Promise<ServerConfig> {
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error(`GET /api/config failed: HTTP ${res.status}`);
  return (await res.json()) as ServerConfig;
}

/** Validates upstream before saving; throws with the server's reason if rejected. */
export async function saveConfig(cfg: { token?: string; host?: string }): Promise<ServerConfig> {
  const res = await fetch("/api/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(cfg),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; tokenSet?: boolean; host?: string; persisted?: boolean };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return { tokenSet: Boolean(body.tokenSet), host: body.host ?? "", persisted: body.persisted !== false };
}
