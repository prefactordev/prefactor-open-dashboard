import { describe, expect, it } from "vitest";
import { hourOfWeekHeatmap, spansBySchemaByDay } from "../src/lib/activity";
import type { Span } from "../src/types";

const span = (over: Partial<Span>): Span => ({
  id: "sp_1",
  status: "complete",
  schema_name: "ai-sdk:llm",
  started_at: "2026-08-03T10:00:00Z", // a Monday
  finished_at: "2026-08-03T10:00:01Z",
  parent_span_id: null,
  agent_instance_id: "inst_1",
  agent_id: "agent_a",
  payload: {},
  ...over,
});

describe("spansBySchemaByDay", () => {
  it("orders schemas by total volume and zero-fills missing days", () => {
    const s = spansBySchemaByDay(
      [
        span({ id: "a", schema_name: "tool:x" }),
        span({ id: "b", schema_name: "ai-sdk:llm" }),
        span({ id: "c", schema_name: "ai-sdk:llm", started_at: "2026-08-04T10:00:00Z" }),
      ],
      "2026-08-03T00:00:00Z",
      "2026-08-05T23:00:00Z",
    );
    expect(s.schemas).toEqual(["ai-sdk:llm", "tool:x"]);
    expect(s.rows.map((r) => r.day)).toEqual(["2026-08-03", "2026-08-04", "2026-08-05"]);
    expect(s.rows[0]["ai-sdk:llm"]).toBe(1);
    expect(s.rows[2]["ai-sdk:llm"]).toBe(0);
    expect(s.rows[2]["tool:x"]).toBe(0);
  });

  it("still counts totals for spans without a start time", () => {
    const s = spansBySchemaByDay([span({ started_at: null })], "2026-08-03T00:00:00Z", "2026-08-03T23:00:00Z");
    expect(s.schemas).toEqual(["ai-sdk:llm"]);
    expect(s.rows[0]["ai-sdk:llm"]).toBe(0);
  });
});

describe("hourOfWeekHeatmap", () => {
  it("is a Monday-first 7×24 grid keyed by UTC", () => {
    // 2026-08-03 is a Monday; 10:00 UTC.
    const { cells, max } = hourOfWeekHeatmap([span({}), span({ id: "b" })]);
    expect(cells).toHaveLength(7);
    expect(cells[0]).toHaveLength(24);
    expect(cells[0][10]).toBe(2); // Monday row 0
    expect(max).toBe(2);
  });

  it("maps Sunday to the last row", () => {
    const { cells } = hourOfWeekHeatmap([span({ started_at: "2026-08-09T23:00:00Z" })]); // a Sunday
    expect(cells[6][23]).toBe(1);
  });

  it("skips spans with missing or invalid timestamps", () => {
    const { cells, max } = hourOfWeekHeatmap([span({ started_at: null }), span({ started_at: "garbage" })]);
    expect(max).toBe(0);
    expect(cells.flat().reduce((a, b) => a + b, 0)).toBe(0);
  });
});
