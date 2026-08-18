import { describe, expect, it } from "vitest";
import { ratingOf, summarizeActions } from "../src/lib/actions";
import type { InstanceSummary, Span } from "../src/types";

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

const instance = (over: Partial<InstanceSummary>): InstanceSummary => ({
  id: "inst_1",
  status: "complete",
  started_at: "2026-08-01T09:00:00Z",
  finished_at: "2026-08-01T09:05:00Z",
  agent_id: "agent_a",
  termination_reason: null,
  ...over,
});

const WINDOW = ["2026-08-01T00:00:00Z", "2026-08-02T23:59:59Z"] as const;

describe("ratingOf", () => {
  it("reads both rating paths and unwraps $sensitive", () => {
    expect(ratingOf(span({ payload: { inputs: { feedback: { rating: "up" } } } }))).toBe("up");
    expect(ratingOf(span({ payload: { inputs: { rating: "4" } } }))).toBe("4");
    expect(ratingOf(span({ payload: { inputs: { rating: { $sensitive: "string", labels: [], value: "down" } } } }))).toBe("down");
  });
  it("is null for missing or empty ratings", () => {
    expect(ratingOf(span({}))).toBeNull();
    expect(ratingOf(span({ payload: { inputs: { rating: "" } } }))).toBeNull();
  });
});

describe("summarizeActions", () => {
  it("counts HITL by whole schema segments, never substrings (regression: tool calls counted as approvals)", () => {
    const s = summarizeActions(
      [
        span({ id: "a", schema_name: "hitl:human-approval" }),
        span({ id: "b", schema_name: "flow:approvals" }),
        // The agent ACTING is not a human intervening:
        span({ id: "c", schema_name: "ai-sdk:tool:approve_refund" }),
        span({ id: "d", schema_name: "ai-sdk:tool:escalate_to_human" }),
        span({ id: "e", schema_name: "my-hitl-like:llm" }),
      ],
      [],
      ...WINDOW,
    );
    expect(s.byKind.hitl).toBe(2);
  });

  it("counts killswitches from termination_reason and lists recent kills newest first", () => {
    const s = summarizeActions(
      [],
      [
        instance({ id: "i1", status: "terminated", termination_reason: "policy breach", finished_at: "2026-08-01T10:00:00Z" }),
        instance({ id: "i2", status: "terminated", termination_reason: "runaway loop", finished_at: "2026-08-02T10:00:00Z" }),
        instance({ id: "i3" }),
      ],
      ...WINDOW,
    );
    expect(s.byKind.killswitch).toBe(2);
    expect(s.recentKills[0]).toMatchObject({ instanceId: "i2", reason: "runaway loop" });
  });

  it("counts feedback by rating presence, not schema name", () => {
    const s = summarizeActions(
      [
        span({ id: "a", schema_name: "prefactor:quality", payload: { inputs: { feedback: { rating: "up" } } } }),
        span({ id: "b", schema_name: "user:feedback", payload: { inputs: { rating: "3" } } }),
        // A quality/eval record without a rating is bookkeeping, not an action:
        span({ id: "c", schema_name: "prefactor:quality", payload: { inputs: { report: "eval" } } }),
      ],
      [],
      ...WINDOW,
    );
    expect(s.byKind.feedback).toBe(2);
  });

  it("computes the oversight rate as actions / total spans", () => {
    const s = summarizeActions(
      [span({ id: "a", schema_name: "hitl:human-approval" }), span({ id: "b" }), span({ id: "c" }), span({ id: "d" })],
      [instance({ id: "i1", termination_reason: "stop" })],
      ...WINDOW,
    );
    expect(s.totalActions).toBe(2);
    expect(s.totalSpans).toBe(4);
    expect(s.rate).toBeCloseTo(0.5);
  });

  it("returns a null rate when there are no spans", () => {
    expect(summarizeActions([], [], ...WINDOW).rate).toBeNull();
  });

  it("fills every window day in byDay", () => {
    const s = summarizeActions([span({ schema_name: "hitl:human-approval" })], [], ...WINDOW);
    expect(s.byDay).toHaveLength(2);
    expect(s.byDay[0]).toMatchObject({ day: "2026-08-01", hitl: 1 });
    expect(s.byDay[1]).toMatchObject({ day: "2026-08-02", hitl: 0 });
  });
});
