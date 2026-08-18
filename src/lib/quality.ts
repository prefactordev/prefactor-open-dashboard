// Two quality lenses, split by WHO produced the signal:
//
//   Prefactor-created — signals the platform itself computes or renders:
//     run outcomes and durations (from ordinary lifecycle data, the same math
//     as the app's Quality tab), thumbs feedback captured by the platform's
//     prefactor:quality spans, and quality_summary (server-rendered from the
//     quality_schema template declared at register).
//
//   Externally-created — quality_payload contents. That JSON is always written
//     by YOUR code (agent instrumentation or an eval tool PUTting scores);
//     Prefactor stores it but never invents it. The tab discovers its fields
//     generically, so any eval tool's scores show up without configuration.

import type { InstanceDetail, InstanceSummary, Span } from "../types";
import { ratingOf } from "./actions";
import { dayKey, dayRange, durationMs, percentile, unwrapSensitive } from "./util";

// --- Prefactor-created ------------------------------------------------------

// Terminal statuses seen from the platform. `terminated` is the killswitch
// outcome — leaving it out (as an earlier version did) reported runs that were
// deliberately killed as if they had never happened, and could show 100%
// success for a window where half the runs were stopped.
const TERMINAL = ["complete", "failed", "terminated", "cancelled"] as const;
type TerminalStatus = (typeof TERMINAL)[number];
const isTerminal = (s: string): s is TerminalStatus => (TERMINAL as readonly string[]).includes(s);

export interface NativeQualitySummary {
  runs: number;
  outcomes: { complete: number; failed: number; terminated: number; cancelled: number; active: number; other: number };
  /** complete / (complete + failed + terminated) — a killed run is not a success. */
  successRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  byDay: Array<{ day: string; complete: number; failed: number; terminated: number; cancelled: number }>;
  /** `other` counts ratings that aren't up/down (e.g. a 1-5 scale), so this
   *  reconciles with the Actions tile, which counts any rating. */
  feedback: { up: number; down: number; other: number; rate: number | null };
  feedbackByDay: Array<{ day: string; up: number; down: number }>;
  purposes: Array<{ purpose: string; count: number }>;
  bySpanType: Array<{ schema: string; count: number; p50Ms: number | null; p95Ms: number | null; failed: number }>;
  summaries: Array<{ instanceId: string; agentId: string; startedAt: string | null; summary: string }>;
}

export function summarizeNativeQuality(
  instances: InstanceSummary[],
  spans: Span[],
  details: InstanceDetail[],
  windowStart: string,
  windowEnd: string,
): NativeQualitySummary {
  const outcomes = { complete: 0, failed: 0, terminated: 0, cancelled: 0, active: 0, other: 0 };
  const days = new Map<string, { complete: number; failed: number; terminated: number; cancelled: number }>();
  const durations: number[] = [];

  for (const i of instances) {
    // Own-property check, and an explicit bucket for statuses we don't know:
    // every run is counted somewhere, so the tiles always reconcile.
    if (isTerminal(i.status)) outcomes[i.status]++;
    else if (i.status === "active") outcomes.active++;
    else outcomes.other++;

    if (i.started_at && isTerminal(i.status)) {
      const day = dayKey(i.started_at);
      const d = days.get(day) ?? { complete: 0, failed: 0, terminated: 0, cancelled: 0 };
      d[i.status]++;
      days.set(day, d);
      const ms = durationMs(i.started_at, i.finished_at);
      if (ms != null) durations.push(ms);
    }
  }
  durations.sort((a, b) => a - b);

  // Thumbs feedback lives on the platform's own quality spans.
  let up = 0,
    down = 0,
    otherRatings = 0;
  const fbDays = new Map<string, { up: number; down: number }>();
  for (const s of spans) {
    // Detect by the presence of a rating, not by schema name: thumbs arrive as
    // prefactor:quality with inputs.feedback.rating, and as user:feedback (or
    // a team's own name) with inputs.rating. A prefactor:quality span with no
    // rating is a quality/eval record, not human feedback.
    const rating = ratingOf(s);
    if (rating == null) continue;
    if (rating !== "up" && rating !== "down") {
      // Counted, so this total matches the Actions tile even when a team uses
      // a scale instead of thumbs.
      otherRatings++;
      continue;
    }
    if (rating === "up") up++;
    else down++;
    if (s.started_at) {
      const day = dayKey(s.started_at);
      const d = fbDays.get(day) ?? { up: 0, down: 0 };
      d[rating]++;
      fbDays.set(day, d);
    }
  }

  const purposeCounts = new Map<string, number>();
  for (const i of instances) {
    const p = i.purpose ?? "live";
    purposeCounts.set(p, (purposeCounts.get(p) ?? 0) + 1);
  }

  // Per-span-type timings, the same cut the app's Quality tab shows.
  const types = new Map<string, { durations: number[]; count: number; failed: number }>();
  for (const s of spans) {
    const t = types.get(s.schema_name) ?? { durations: [], count: 0, failed: 0 };
    t.count++;
    if (s.status === "failed") t.failed++;
    const ms = durationMs(s.started_at, s.finished_at);
    if (ms != null && (s.status === "complete" || s.status === "failed")) t.durations.push(ms);
    types.set(s.schema_name, t);
  }

  const denom = outcomes.complete + outcomes.failed + outcomes.terminated;
  return {
    runs: instances.length,
    outcomes,
    successRate: denom ? outcomes.complete / denom : null,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    byDay: dayRange(windowStart, windowEnd).map((day) => ({
      day,
      ...(days.get(day) ?? { complete: 0, failed: 0, terminated: 0, cancelled: 0 }),
    })),
    feedback: { up, down, other: otherRatings, rate: up + down ? up / (up + down) : null },
    feedbackByDay: dayRange(windowStart, windowEnd).map((day) => ({ day, ...(fbDays.get(day) ?? { up: 0, down: 0 }) })),
    purposes: [...purposeCounts.entries()].map(([purpose, count]) => ({ purpose, count })).sort((a, b) => b.count - a.count),
    bySpanType: [...types.entries()]
      .map(([schema, t]) => {
        t.durations.sort((a, b) => a - b);
        return { schema, count: t.count, p50Ms: percentile(t.durations, 50), p95Ms: percentile(t.durations, 95), failed: t.failed };
      })
      .sort((a, b) => b.count - a.count),
    summaries: details
      .filter((d) => typeof d.quality_summary === "string" && d.quality_summary.trim() !== "")
      .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))
      .slice(0, 8)
      .map((d) => ({ instanceId: d.id, agentId: d.agent_id, startedAt: d.started_at, summary: String(d.quality_summary) })),
  };
}

// --- Externally-created (quality_payload) -----------------------------------

export interface PayloadField {
  path: string;
  kind: "number" | "boolean" | "string";
  count: number; // instances carrying this field
  avg: number | null; // numbers only
  min: number | null;
  max: number | null;
  passRate: number | null; // booleans only
  /** Daily series: avg for numbers, true-share for booleans. */
  byDay: Array<{ day: string; value: number | null; n: number }>;
}

export interface ExternalQualitySummary {
  finished: number; // finished instances we fetched details for
  withPayload: number;
  coverage: number | null;
  fields: PayloadField[];
  recent: Array<{ instanceId: string; agentId: string; startedAt: string | null; values: Record<string, string> }>;
}

function flatten(obj: unknown, prefix: string, out: Map<string, unknown>, depth = 0): void {
  if (depth > 4 || obj == null) return;
  const v = unwrapSensitive(obj);
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      flatten(child, prefix ? `${prefix}.${k}` : k, out, depth + 1);
    }
  } else if (prefix) {
    out.set(prefix, v);
  }
}

export function summarizeExternalQuality(details: InstanceDetail[], windowStart: string, windowEnd: string): ExternalQualitySummary {
  const finished = details.filter((d) => d.status !== "active");
  const carrying = finished.filter((d) => d.quality_payload && typeof d.quality_payload === "object" && Object.keys(d.quality_payload).length > 0);

  interface Acc {
    kind: "number" | "boolean" | "string";
    values: Array<{ day: string | null; num: number | null; bool: boolean | null }>;
  }
  const fields = new Map<string, Acc>();

  for (const d of carrying) {
    const flat = new Map<string, unknown>();
    flatten(d.quality_payload, "", flat);
    const day = d.started_at ? dayKey(d.started_at) : null;
    for (const [path, raw] of flat) {
      const kind = typeof raw === "number" ? "number" : typeof raw === "boolean" ? "boolean" : "string";
      const acc = fields.get(path) ?? { kind, values: [] };
      // Mixed types: keep the numeric (or boolean) reading rather than
      // degrading the whole field to string. One "n/a" among a hundred scores
      // used to erase the field's average and delete its trend line entirely.
      if (acc.kind !== kind && kind !== "string") acc.kind = kind;
      acc.values.push({
        day,
        num: typeof raw === "number" && Number.isFinite(raw) ? raw : null,
        bool: typeof raw === "boolean" ? raw : null,
      });
      fields.set(path, acc);
    }
  }

  const allDays = dayRange(windowStart, windowEnd);
  const fieldRows: PayloadField[] = [...fields.entries()]
    .map(([path, acc]) => {
      const nums = acc.values.map((v) => v.num).filter((n): n is number => n != null);
      const bools = acc.values.map((v) => v.bool).filter((b): b is boolean => b != null);
      const byDay = allDays.map((day) => {
        const todays = acc.values.filter((v) => v.day === day);
        if (acc.kind === "number") {
          const ns = todays.map((v) => v.num).filter((n): n is number => n != null);
          return { day, value: ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : null, n: ns.length };
        }
        if (acc.kind === "boolean") {
          const bs = todays.map((v) => v.bool).filter((b): b is boolean => b != null);
          return { day, value: bs.length ? bs.filter(Boolean).length / bs.length : null, n: bs.length };
        }
        return { day, value: null, n: todays.length };
      });
      return {
        path,
        kind: acc.kind,
        count: acc.values.length,
        avg: nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null,
        min: nums.length ? Math.min(...nums) : null,
        max: nums.length ? Math.max(...nums) : null,
        passRate: bools.length ? bools.filter(Boolean).length / bools.length : null,
        byDay,
      };
    })
    .sort((a, b) => b.count - a.count);

  return {
    finished: finished.length,
    withPayload: carrying.length,
    coverage: finished.length ? carrying.length / finished.length : null,
    fields: fieldRows,
    recent: carrying
      .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))
      .slice(0, 10)
      .map((d) => {
        const flat = new Map<string, unknown>();
        flatten(d.quality_payload, "", flat);
        const values: Record<string, string> = {};
        for (const [k, v] of flat) values[k] = typeof v === "string" ? (v.length > 60 ? `${v.slice(0, 60)}…` : v) : JSON.stringify(v);
        return { instanceId: d.id, agentId: d.agent_id, startedAt: d.started_at, values };
      }),
  };
}
