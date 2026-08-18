import { describe, expect, it } from "vitest";
import { summarizeRisk } from "../src/lib/risk";
import type { Span } from "../src/types";

const span = (over: Partial<Span>): Span => ({
  id: "sp_1",
  status: "complete",
  schema_name: "ai-sdk:llm",
  started_at: "2026-08-01T10:00:00Z",
  finished_at: "2026-08-01T10:00:01Z",
  parent_span_id: null,
  agent_instance_id: "inst_1",
  agent_id: "agent_a",
  payload: {},
  ...over,
});

const WINDOW = ["2026-08-01T00:00:00Z", "2026-08-02T23:59:59Z"] as const;

describe("summarizeRisk", () => {
  it("counts levels and reports coverage over ALL spans", () => {
    const s = summarizeRisk(
      [
        span({ id: "a", risk_level: "low", risk_score: 5 }),
        span({ id: "b", risk_level: "high", risk_score: 70 }),
        span({ id: "c", risk_level: "critical", risk_score: 95 }),
        span({ id: "d" }), // unscored
      ],
      ...WINDOW,
    );
    expect(s.totalSpans).toBe(4);
    expect(s.scoredSpans).toBe(3);
    expect(s.coverage).toBeCloseTo(0.75);
    expect(s.byLevel).toEqual({ low: 1, medium: 0, high: 1, critical: 1 });
    expect(s.highPlus).toBe(2);
    expect(s.maxScore).toBe(95);
  });

  it("ignores unknown risk levels rather than counting them", () => {
    const s = summarizeRisk([span({ risk_level: "extreme", risk_score: 99 })], ...WINDOW);
    expect(s.scoredSpans).toBe(0);
    expect(s.maxScore).toBeNull();
  });

  it("keeps NaN scores out of the histogram (regression: histogram total drifted below the tile)", () => {
    const s = summarizeRisk([span({ risk_level: "low", risk_score: NaN })], ...WINDOW);
    expect(s.scoredSpans).toBe(1);
    const histogramTotal = s.scoreHistogram.reduce((a, b) => a + b.count, 0);
    expect(histogramTotal).toBe(0);
  });

  it("buckets scores into ten-point bins with 90+ capped", () => {
    const s = summarizeRisk(
      [
        span({ id: "a", risk_level: "low", risk_score: 0 }),
        span({ id: "b", risk_level: "high", risk_score: 89 }),
        span({ id: "c", risk_level: "critical", risk_score: 100 }),
      ],
      ...WINDOW,
    );
    expect(s.scoreHistogram[0]).toMatchObject({ count: 1 });
    expect(s.scoreHistogram[8]).toMatchObject({ bucket: "80–89", count: 1 });
    expect(s.scoreHistogram[9]).toMatchObject({ bucket: "90+", count: 1 });
  });

  it("lists agents that produced spans but no scores", () => {
    const s = summarizeRisk(
      [span({ agent_id: "agent_scored", risk_level: "low", risk_score: 1 }), span({ id: "b", agent_id: "agent_unscored" })],
      ...WINDOW,
    );
    expect(s.unscoredAgents).toEqual(["agent_unscored"]);
  });

  it("ranks top spans by score and caps the list at 12", () => {
    const spans = Array.from({ length: 20 }, (_, i) => span({ id: `sp_${i}`, risk_level: "high", risk_score: i }));
    const s = summarizeRisk(spans, ...WINDOW);
    expect(s.top).toHaveLength(12);
    expect(s.top[0].score).toBe(19);
  });

  it("fills every window day in byDay", () => {
    const s = summarizeRisk([span({ risk_level: "medium", risk_score: 40 })], ...WINDOW);
    expect(s.byDay.map((d) => d.day)).toEqual(["2026-08-01", "2026-08-02"]);
    expect(s.byDay[0].medium).toBe(1);
    expect(s.byDay[1].medium).toBe(0);
  });

  it("reads precomputed sensitive labels and falls back to scanning payloads", () => {
    const s = summarizeRisk(
      [
        span({ id: "a", sensitive_labels: ["email", "pii"] }),
        span({ id: "b", payload: { inputs: { ssn: { $sensitive: "string", labels: ["ssn"], value: "x" } } } }),
        span({ id: "c", sensitive_encoding: true }), // encoded away: counted, unlabelled
        span({ id: "d" }),
      ],
      ...WINDOW,
    );
    expect(s.sensitive.spansMarked).toBe(3);
    expect(s.sensitive.spansEncoded).toBe(1);
    expect(s.sensitive.byLabel.map((l) => l.label).sort()).toEqual(["email", "pii", "ssn"]);
  });

  it("aggregates risk per span type, sorted by critical then high", () => {
    const s = summarizeRisk(
      [
        span({ id: "a", schema_name: "tool:payments", risk_level: "critical", risk_score: 90 }),
        span({ id: "b", schema_name: "ai-sdk:llm", risk_level: "high", risk_score: 60 }),
        span({ id: "c", schema_name: "ai-sdk:llm", risk_level: "low", risk_score: 5 }),
      ],
      ...WINDOW,
    );
    expect(s.bySchema[0]).toMatchObject({ schema: "tool:payments", critical: 1 });
    expect(s.bySchema[1]).toMatchObject({ schema: "ai-sdk:llm", total: 2 });
  });
});
