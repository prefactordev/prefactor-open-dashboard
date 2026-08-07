// Risk aggregation. Prefactor computes risk ON READ: spans carry
// risk_level/risk_score only when the request passed include_risk_level=true
// (the API client always does) AND the span's agent has a risk_profile_id
// assigned. Spans from agents without a profile stay null — the tab reports
// coverage honestly instead of pretending zero risk.

import type { Span } from "../types";
import { dayKey, dayRange } from "./util";

export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export interface RiskSummary {
  totalSpans: number;
  scoredSpans: number;
  coverage: number | null; // scored / total
  byLevel: Record<RiskLevel, number>;
  highPlus: number; // high + critical
  maxScore: number | null;
  /** One row per UTC day with a count per level. */
  byDay: Array<{ day: string } & Record<RiskLevel, number> & { day: string }>;
  /** Riskiest spans, score desc. */
  top: Array<{ spanId: string; agentId: string | null; instanceId: string | null; name: string; level: string; score: number; startedAt: string | null }>;
  /** Agents that produced spans but no risk scores (likely missing a risk profile). */
  unscoredAgents: string[];
  /** Per span type, count at each level — which activities carry the risk. */
  bySchema: Array<{ schema: string } & Record<RiskLevel, number> & { schema: string; total: number }>;
  /** Risk score histogram, ten-point buckets 0-9 … 90+. */
  scoreHistogram: Array<{ bucket: string; count: number }>;
  /**
   * Sensitive-data exposure. `spansMarked` counts spans carrying sensitive
   * values by any signal; `spansEncoded` counts those the API returned with
   * the content encoded away, for which labels are simply not available. The
   * two are reported separately so a non-zero tile can never sit above an
   * "unknown" card with no explanation.
   */
  sensitive: { spansMarked: number; spansEncoded: number; byLabel: Array<{ label: string; count: number }> };
}

/** Count $sensitive wrappers (and their labels) anywhere in a span's payload. */
function scanSensitive(obj: unknown, labels: Map<string, number>, depth = 0): boolean {
  if (depth > 6 || obj == null || typeof obj !== "object") return false;
  let found = false;
  if ("$sensitive" in (obj as Record<string, unknown>)) {
    const ls = (obj as { labels?: unknown }).labels;
    if (Array.isArray(ls)) for (const l of ls) if (typeof l === "string") labels.set(l, (labels.get(l) ?? 0) + 1);
    return true;
  }
  for (const v of Object.values(obj as Record<string, unknown>)) {
    if (scanSensitive(v, labels, depth + 1)) found = true;
  }
  return found;
}

export function summarizeRisk(spans: Span[], windowStart: string, windowEnd: string): RiskSummary {
  const byLevel: Record<RiskLevel, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  const days = new Map<string, Record<RiskLevel, number>>();
  const agentScored = new Map<string, boolean>();
  const schemaLevels = new Map<string, Record<RiskLevel, number>>();
  const histogram = new Array<number>(10).fill(0);
  const sensitiveLabels = new Map<string, number>();
  let spansMarked = 0;
  let spansEncoded = 0;
  const top: RiskSummary["top"] = [];
  let scored = 0;
  let maxScore: number | null = null;

  for (const s of spans) {
    if (s.agent_id) agentScored.set(s.agent_id, agentScored.get(s.agent_id) || s.risk_level != null);
    // Sensitive markers are independent of risk scoring. The server's
    // projection precomputes labels; fall back to scanning raw payloads for
    // spans that arrived without it.
    let marked = false;
    if (Array.isArray(s.sensitive_labels) && s.sensitive_labels.length > 0) {
      marked = true;
      for (const l of s.sensitive_labels) sensitiveLabels.set(l, (sensitiveLabels.get(l) ?? 0) + 1);
    } else {
      marked = scanSensitive(s.payload, sensitiveLabels);
    }
    if (marked || s.sensitive_encoding) spansMarked++;
    // Encoded-but-unlabelled: counted in the tile, but no label can be shown.
    if (s.sensitive_encoding && !marked) spansEncoded++;
    const level = (s.risk_level ?? "") as RiskLevel;
    if (!RISK_LEVELS.includes(level)) continue;
    scored++;
    byLevel[level]++;
    const sl = schemaLevels.get(s.schema_name) ?? { low: 0, medium: 0, high: 0, critical: 0 };
    sl[level]++;
    schemaLevels.set(s.schema_name, sl);
    // Finite check: a NaN score would write a non-index property, silently
    // making the histogram total less than the "spans risk-scored" tile.
    if (typeof s.risk_score === "number" && Number.isFinite(s.risk_score)) {
      histogram[Math.min(9, Math.max(0, Math.floor(s.risk_score / 10)))]++;
    }
    const score = typeof s.risk_score === "number" ? s.risk_score : 0;
    if (maxScore == null || score > maxScore) maxScore = score;
    if (s.started_at) {
      const day = dayKey(s.started_at);
      const d = days.get(day) ?? { low: 0, medium: 0, high: 0, critical: 0 };
      d[level]++;
      days.set(day, d);
    }
    top.push({
      spanId: s.id,
      agentId: s.agent_id,
      instanceId: s.agent_instance_id,
      name: s.schema_title || s.schema_name,
      level,
      score,
      startedAt: s.started_at,
    });
  }

  top.sort((a, b) => b.score - a.score);

  return {
    totalSpans: spans.length,
    scoredSpans: scored,
    coverage: spans.length ? scored / spans.length : null,
    byLevel,
    highPlus: byLevel.high + byLevel.critical,
    maxScore,
    byDay: dayRange(windowStart, windowEnd).map((day) => ({ day, ...(days.get(day) ?? { low: 0, medium: 0, high: 0, critical: 0 }) })),
    top: top.slice(0, 12),
    unscoredAgents: [...agentScored.entries()].filter(([, ok]) => !ok).map(([id]) => id),
    bySchema: [...schemaLevels.entries()]
      .map(([schema, levels]) => ({ schema, ...levels, total: levels.low + levels.medium + levels.high + levels.critical }))
      .sort((a, b) => b.critical - a.critical || b.high - a.high || b.total - a.total)
      .slice(0, 8),
    scoreHistogram: histogram.map((count, i) => ({ bucket: i === 9 ? "90+" : `${i * 10}–${i * 10 + 9}`, count })),
    sensitive: {
      spansMarked,
      spansEncoded,
      byLabel: [...sensitiveLabels.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
    },
  };
}
