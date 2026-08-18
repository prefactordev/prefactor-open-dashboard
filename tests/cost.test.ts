import { describe, expect, it } from "vitest";
import { extractLlmCalls, PRICES, summarizeCost } from "../src/lib/cost";
import type { Span } from "../src/types";

const baseSpan = (over: Partial<Span>): Span => ({
  id: "sp_1",
  status: "complete",
  schema_name: "ai-sdk:llm",
  started_at: "2026-08-01T10:00:00Z",
  finished_at: "2026-08-01T10:00:02Z",
  parent_span_id: null,
  agent_instance_id: "inst_1",
  agent_id: "agent_a",
  payload: {},
  ...over,
});

const llmSpan = ({ payload, ...over }: Partial<Span> & { payload?: Record<string, unknown> }): Span =>
  baseSpan({
    payload: {
      token_usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
      inputs: { ai: { model: { id: "claude-sonnet-5" } } },
      ...payload,
    },
    ...over,
  });

describe("extractLlmCalls", () => {
  it("ignores spans without token usage", () => {
    expect(extractLlmCalls([baseSpan({ payload: {} }), baseSpan({ payload: null })])).toHaveLength(0);
  });

  it("prices known models from the rate table", () => {
    const [call] = extractLlmCalls([llmSpan({})]);
    const price = PRICES["claude-sonnet-5"];
    expect(call.priced).toBe(true);
    expect(call.cost).toBeCloseTo((1000 / 1e6) * price.inputPer1M + (500 / 1e6) * price.outputPer1M, 12);
    expect(call.durationMs).toBe(2000);
  });

  it("accepts numeric strings for token counts (regression: '874' was read as 0)", () => {
    const [call] = extractLlmCalls([llmSpan({ payload: { token_usage: { prompt_tokens: "874", completion_tokens: "126", total_tokens: "1000" } } })]);
    expect(call.promptTokens).toBe(874);
    expect(call.completionTokens).toBe(126);
    expect(call.totalTokens).toBe(1000);
    expect(call.cost).toBeGreaterThan(0);
  });

  it("derives total tokens when the emitter omits it", () => {
    const [call] = extractLlmCalls([llmSpan({ payload: { token_usage: { prompt_tokens: 300, completion_tokens: 200 } } })]);
    expect(call.totalTokens).toBe(500);
  });

  it("reads the model id from both SDK shapes", () => {
    const nested = extractLlmCalls([llmSpan({})])[0];
    const flat = extractLlmCalls([llmSpan({ payload: { inputs: { model: "gpt-4o-mini" } } })])[0];
    expect(nested.model).toBe("claude-sonnet-5");
    expect(flat.model).toBe("gpt-4o-mini");
  });

  it("marks unknown models unpriced with zero cost, never NaN", () => {
    const [call] = extractLlmCalls([llmSpan({ payload: { inputs: { ai: { model: { id: "in-house-7b" } } } } })]);
    expect(call.priced).toBe(false);
    expect(call.cost).toBe(0);
  });

  it("normalises finish reasons: plain string, {unified}, and error spans", () => {
    const plain = extractLlmCalls([llmSpan({ payload: { outputs: { ai: { finishReason: "stop" } } } })])[0];
    const unified = extractLlmCalls([llmSpan({ payload: { outputs: { ai: { finishReason: { unified: "tool-calls", raw: "end_turn" } } } } })])[0];
    const errored = extractLlmCalls([llmSpan({ payload: { error: { error_type: "RateLimitError" } } })])[0];
    expect(plain.finishReason).toBe("stop");
    expect(unified.finishReason).toBe("tool-calls");
    expect(errored.finishReason).toBe("error: RateLimitError");
  });
});

describe("summarizeCost", () => {
  const window = ["2026-08-01T00:00:00Z", "2026-08-03T23:59:59Z"] as const;

  it("totals cost and tokens and separates unpriced usage", () => {
    const calls = extractLlmCalls([llmSpan({ id: "sp_1" }), llmSpan({ id: "sp_2", payload: { inputs: { ai: { model: { id: "in-house-7b" } } } } })]);
    const s = summarizeCost([...calls], ...window);
    expect(s.llmCalls).toBe(2);
    expect(s.totalTokens).toBe(3000);
    expect(s.unpricedModels).toEqual(["in-house-7b"]);
    expect(s.unpricedTokens).toBe(1500);
    expect(s.unpricedCalls).toBe(1);
    // Priced cost only — the unpriced call contributes zero, visibly.
    expect(s.totalCost).toBeCloseTo(extractLlmCalls([llmSpan({})])[0].cost, 12);
  });

  it("fills every day of the window in byDay, even empty ones", () => {
    const s = summarizeCost(extractLlmCalls([llmSpan({})]), ...window);
    expect(s.byDay.map((r) => r.day)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
    expect(s.byDay[0]["claude-sonnet-5"]).toBeGreaterThan(0);
    expect(s.byDay[1]["claude-sonnet-5"]).toBe(0);
  });

  it("aggregates by agent and instance, sorted by cost", () => {
    const calls = extractLlmCalls([
      llmSpan({ id: "sp_1", agent_id: "agent_a", agent_instance_id: "inst_1" }),
      llmSpan({ id: "sp_2", agent_id: "agent_a", agent_instance_id: "inst_1" }),
      llmSpan({ id: "sp_3", agent_id: "agent_b", agent_instance_id: "inst_2" }),
    ]);
    const s = summarizeCost(calls, ...window);
    expect(s.byAgent[0]).toMatchObject({ agentId: "agent_a", calls: 2 });
    expect(s.byInstance[0]).toMatchObject({ instanceId: "inst_1", calls: 2 });
  });

  it("computes per-model latency percentiles and error counts", () => {
    const calls = extractLlmCalls([
      llmSpan({ id: "sp_1", finished_at: "2026-08-01T10:00:01Z" }),
      llmSpan({ id: "sp_2", finished_at: "2026-08-01T10:00:03Z" }),
      llmSpan({ id: "sp_3", payload: { error: { error_type: "Timeout" } } }),
    ]);
    const s = summarizeCost(calls, ...window);
    const model = s.models.find((m) => m.model === "claude-sonnet-5");
    expect(model?.errors).toBe(1);
    // Durations 1000/2000/3000ms; nearest-rank p50 over three values is the middle one.
    expect(model?.p50Ms).toBe(2000);
    expect(model?.p95Ms).toBe(3000);
  });

  it("counts finish reasons with unknown as its own bucket", () => {
    const calls = extractLlmCalls([
      llmSpan({ id: "sp_1", payload: { outputs: { ai: { finishReason: "stop" } } } }),
      llmSpan({ id: "sp_2", payload: { outputs: { ai: { finishReason: "stop" } } } }),
      llmSpan({ id: "sp_3" }),
    ]);
    const s = summarizeCost(calls, ...window);
    expect(s.finishReasons[0]).toEqual({ reason: "stop", count: 2 });
    expect(s.finishReasons.find((r) => r.reason === "unknown")?.count).toBe(1);
  });
});
