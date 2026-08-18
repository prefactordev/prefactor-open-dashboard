import { describe, expect, it } from "vitest";
import { summarizeExternalQuality, summarizeNativeQuality } from "../src/lib/quality";
import type { InstanceDetail, InstanceSummary, Span } from "../src/types";

const instance = (over: Partial<InstanceSummary>): InstanceSummary => ({
  id: "inst_1",
  status: "complete",
  started_at: "2026-08-01T09:00:00Z",
  finished_at: "2026-08-01T09:05:00Z",
  agent_id: "agent_a",
  ...over,
});

const detail = (over: Partial<InstanceDetail>): InstanceDetail => ({
  ...instance({}),
  detail_checked: true,
  quality_payload: null,
  quality_summary: null,
  ...over,
});

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

describe("summarizeNativeQuality", () => {
  it("counts every terminal status, including terminated and cancelled (regression: killed runs vanished)", () => {
    const s = summarizeNativeQuality(
      [
        instance({ id: "i1", status: "complete" }),
        instance({ id: "i2", status: "failed" }),
        instance({ id: "i3", status: "terminated" }),
        instance({ id: "i4", status: "cancelled" }),
        instance({ id: "i5", status: "active", finished_at: null }),
        instance({ id: "i6", status: "someday-new-status" }),
      ],
      [],
      [],
      ...WINDOW,
    );
    expect(s.outcomes).toEqual({ complete: 1, failed: 1, terminated: 1, cancelled: 1, active: 1, other: 1 });
    // A killed run is not a success; a cancelled one is excluded from the denominator.
    expect(s.successRate).toBeCloseTo(1 / 3);
    expect(s.runs).toBe(6);
  });

  it("computes duration percentiles over terminal runs only", () => {
    const s = summarizeNativeQuality(
      [
        instance({ id: "i1", finished_at: "2026-08-01T09:01:00Z" }), // 60s
        instance({ id: "i2", finished_at: "2026-08-01T09:03:00Z" }), // 180s
        instance({ id: "i3", status: "active", finished_at: null }),
      ],
      [],
      [],
      ...WINDOW,
    );
    expect(s.p50Ms).toBe(60_000);
    expect(s.p95Ms).toBe(180_000);
  });

  it("splits feedback into up/down/other so totals reconcile with the Actions tile", () => {
    const s = summarizeNativeQuality(
      [],
      [
        span({ id: "a", schema_name: "prefactor:quality", payload: { inputs: { feedback: { rating: "up" } } } }),
        span({ id: "b", schema_name: "user:feedback", payload: { inputs: { rating: "down" } } }),
        span({ id: "c", schema_name: "user:feedback", payload: { inputs: { rating: "4" } } }),
        span({ id: "d", schema_name: "prefactor:quality", payload: { inputs: { report: "not-feedback" } } }),
      ],
      [],
      ...WINDOW,
    );
    expect(s.feedback).toMatchObject({ up: 1, down: 1, other: 1 });
    expect(s.feedback.rate).toBeCloseTo(0.5);
  });

  it("counts purposes with a 'live' default and per-span-type timings", () => {
    const s = summarizeNativeQuality(
      [instance({ id: "i1" }), instance({ id: "i2", purpose: "eval" })],
      [span({ id: "a" }), span({ id: "b", status: "failed" })],
      [],
      ...WINDOW,
    );
    expect(s.purposes).toEqual([
      { purpose: "live", count: 1 },
      { purpose: "eval", count: 1 },
    ]);
    expect(s.bySpanType[0]).toMatchObject({ schema: "ai-sdk:llm", count: 2, failed: 1 });
  });

  it("surfaces the newest rendered quality summaries, capped at 8", () => {
    const details = Array.from({ length: 12 }, (_, i) =>
      detail({ id: `i${i}`, started_at: `2026-08-01T0${Math.min(i, 9)}:00:00Z`, quality_summary: `summary ${i}` }),
    );
    const s = summarizeNativeQuality([], [], details, ...WINDOW);
    expect(s.summaries).toHaveLength(8);
    expect(s.summaries[0].summary).toBe("summary 9");
  });
});

describe("summarizeExternalQuality", () => {
  it("reports coverage over finished instances only", () => {
    const s = summarizeExternalQuality(
      [detail({ id: "i1", quality_payload: { score: 0.9 } }), detail({ id: "i2" }), detail({ id: "i3", status: "active" })],
      ...WINDOW,
    );
    expect(s.finished).toBe(2);
    expect(s.withPayload).toBe(1);
    expect(s.coverage).toBeCloseTo(0.5);
  });

  it("discovers nested numeric fields with avg/min/max and daily series", () => {
    const s = summarizeExternalQuality(
      [
        detail({ id: "i1", quality_payload: { scores: { accuracy: 0.8 } } }),
        detail({ id: "i2", started_at: "2026-08-02T09:00:00Z", quality_payload: { scores: { accuracy: 0.6 } } }),
      ],
      ...WINDOW,
    );
    const field = s.fields.find((f) => f.path === "scores.accuracy");
    expect(field).toMatchObject({ kind: "number", count: 2, min: 0.6, max: 0.8 });
    expect(field?.avg).toBeCloseTo(0.7);
    expect(field?.byDay.map((d) => d.value)).toEqual([0.8, 0.6]);
  });

  it("computes boolean pass rates", () => {
    const s = summarizeExternalQuality(
      [
        detail({ id: "i1", quality_payload: { passed: true } }),
        detail({ id: "i2", quality_payload: { passed: true } }),
        detail({ id: "i3", quality_payload: { passed: false } }),
      ],
      ...WINDOW,
    );
    expect(s.fields[0].passRate).toBeCloseTo(2 / 3);
  });

  it("keeps a field numeric when a few values are strings (regression: one 'n/a' erased the trend)", () => {
    const s = summarizeExternalQuality(
      [
        detail({ id: "i1", quality_payload: { score: "n/a" } }),
        detail({ id: "i2", quality_payload: { score: 0.5 } }),
        detail({ id: "i3", quality_payload: { score: 0.9 } }),
      ],
      ...WINDOW,
    );
    const field = s.fields.find((f) => f.path === "score");
    expect(field?.kind).toBe("number");
    expect(field?.avg).toBeCloseTo(0.7);
    expect(field?.count).toBe(3);
  });

  it("unwraps $sensitive values and truncates long strings in recent rows", () => {
    const long = "x".repeat(100);
    const s = summarizeExternalQuality(
      [detail({ id: "i1", quality_payload: { note: long, tag: { $sensitive: "string", labels: [], value: "wrapped" } } })],
      ...WINDOW,
    );
    expect(s.recent[0].values.note.length).toBeLessThanOrEqual(61); // 60 + ellipsis
    expect(s.recent[0].values.tag).toBe("wrapped");
  });
});
