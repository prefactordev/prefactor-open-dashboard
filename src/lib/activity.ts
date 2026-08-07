// Activity-shaped aggregations: what kinds of work the agents did, and when.

import type { Span } from "../types";
import { dayKey, dayRange } from "./util";

export interface SchemaByDay {
  schemas: string[]; // by total volume, desc — the fixed color-slot order
  rows: Array<{ day: string } & Record<string, number | string>>;
}

export function spansBySchemaByDay(spans: Span[], windowStart: string, windowEnd: string): SchemaByDay {
  const totals = new Map<string, number>();
  const days = new Map<string, Map<string, number>>();
  for (const s of spans) {
    totals.set(s.schema_name, (totals.get(s.schema_name) ?? 0) + 1);
    if (!s.started_at) continue;
    const day = dayKey(s.started_at);
    const d = days.get(day) ?? new Map<string, number>();
    d.set(s.schema_name, (d.get(s.schema_name) ?? 0) + 1);
    days.set(day, d);
  }
  const schemas = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const rows = dayRange(windowStart, windowEnd).map((day) => {
    const row: { day: string } & Record<string, number | string> = { day };
    const d = days.get(day);
    for (const sch of schemas) row[sch] = d?.get(sch) ?? 0;
    return row;
  });
  return { schemas, rows };
}

/**
 * UTC hour-of-week grid (7 × 24) of span starts — a stable-size heatmap for
 * any window length. cells[dow][hour], dow 0 = Monday.
 */
export function hourOfWeekHeatmap(spans: Span[]): { cells: number[][]; max: number } {
  const cells = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  let max = 0;
  for (const s of spans) {
    if (!s.started_at) continue;
    const t = new Date(s.started_at);
    if (Number.isNaN(t.getTime())) continue;
    const dow = (t.getUTCDay() + 6) % 7; // Monday-first
    const v = ++cells[dow][t.getUTCHours()];
    if (v > max) max = v;
  }
  return { cells, max };
}
