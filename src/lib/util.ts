// Small pure helpers shared by every tab: payload paths, time buckets,
// percentiles, and number formatting.

/** Read a dotted path out of a nested object; undefined when absent. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * Values the SDK marked sensitive arrive wrapped:
 * { $sensitive: "string", labels: [...], value: ... }. Unwrap for display-safe
 * scalar reads (we only ever surface numbers/booleans/short strings).
 */
export function unwrapSensitive(v: unknown): unknown {
  if (v && typeof v === "object" && "$sensitive" in (v as Record<string, unknown>)) {
    return (v as Record<string, unknown>).value;
  }
  return v;
}

export function durationMs(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** UTC day bucket key, e.g. "2026-08-03". */
export function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

/** Every UTC day key from start to end inclusive, so charts show empty days. */
export function dayRange(startIso: string, endIso: string): string[] {
  const out: string[] = [];
  const d = new Date(`${dayKey(startIso)}T00:00:00Z`);
  const end = Date.parse(`${dayKey(endIso)}T00:00:00Z`);
  while (d.getTime() <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** "2026-08-03" → "Aug 3" for axis ticks. */
export function shortDay(key: string): string {
  const d = new Date(`${key}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// --- formatting ------------------------------------------------------------

// Formatters fail closed to an em dash: a NaN or Infinity slipping through
// should read as "no value", never as "$NaN" on a dashboard.
export function usd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (n >= 0.1) return `$${n.toFixed(2)}`;
  if (n === 0) return "$0";
  return `$${n.toFixed(4)}`;
}

export function compact(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString("en-US");
}

export function pct(x: number | null): string {
  if (x == null || !Number.isFinite(x)) return "—";
  return `${(x * 100).toFixed(x >= 0.995 || x === 0 ? 0 : 1)}%`;
}

export function fmtMs(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

/**
 * Timestamps render in UTC to match every chart bucket and the heatmap. Using
 * the browser's local zone here put table rows on a different calendar day
 * than the bar they belong to for anyone not on UTC.
 */
export function fmtWhen(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

export const shortId = (id: string): string => (id.length > 10 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id);
