// Cost is DERIVED, not stored: the API reports token usage on llm spans and we
// price it with a per-model rate table. A model missing from the table
// contributes ZERO cost — the Cost tab surfaces those models loudly instead of
// hiding the gap.
//
// Verified payload paths (live spans, July 2026):
//   tokens: payload.token_usage.{prompt_tokens, completion_tokens, total_tokens}
//   model:  payload.inputs.ai.model.id   (e.g. "claude-haiku-4-5")

import type { Span } from "../types";
import { dayKey, dayRange, durationMs, getPath, percentile } from "./util";

export interface ModelPrice {
  inputPer1M: number; // USD per 1M prompt tokens
  outputPer1M: number; // USD per 1M completion tokens
}

/** Edit this table for the models YOUR agents use. Rates: published list prices. */
export const PRICES: Record<string, ModelPrice> = {
  // Anthropic
  "claude-haiku-4-5": { inputPer1M: 1.0, outputPer1M: 5.0 },
  "claude-sonnet-4-6": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-sonnet-5": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-opus-4-8": { inputPer1M: 5.0, outputPer1M: 25.0 },
  "claude-opus-5": { inputPer1M: 5.0, outputPer1M: 25.0 },
  // OpenAI (common ids; extend as needed)
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10.0 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
};

export interface LlmCall {
  spanId: string;
  agentId: string | null;
  instanceId: string | null;
  startedAt: string | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number; // 0 when the model is unpriced
  priced: boolean;
  durationMs: number | null;
  finishReason: string | null; // payload.outputs.ai.finishReason.unified
}

// Accept numeric strings too: some emitters send token counts as strings, and
// treating "874" as 0 silently zeroed both tokens and cost while still
// counting the call.
const num = (v: unknown): number => {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
};

/** True when a span carries token usage — the definition of an "LLM call" here. */
export function extractLlmCalls(spans: Span[]): LlmCall[] {
  const calls: LlmCall[] = [];
  for (const s of spans) {
    const usage = getPath(s, "payload.token_usage");
    if (usage == null || typeof usage !== "object") continue;
    const promptTokens = num(getPath(s, "payload.token_usage.prompt_tokens"));
    const completionTokens = num(getPath(s, "payload.token_usage.completion_tokens"));
    const totalTokens = num(getPath(s, "payload.token_usage.total_tokens")) || promptTokens + completionTokens;
    // Model path differs by SDK family: ai-sdk nests it under inputs.ai,
    // the Anthropic SDKs write inputs.model directly. Narrowed to string, not
    // String()-coerced: an object at either path would otherwise become the
    // model name "[object Object]".
    const modelRaw = getPath(s, "payload.inputs.ai.model.id") ?? getPath(s, "payload.inputs.model");
    const model = typeof modelRaw === "string" && modelRaw !== "" ? modelRaw : "unknown";
    const price = PRICES[model];
    // Finish reason takes several shapes: ai-sdk writes either a string or
    // {unified, raw}, Anthropic writes stop_reason. Failed calls carry
    // payload.error.error_type instead.
    // The server's projection normalises every upstream shape into
    // payload.outputs.ai.finishReason; stop_reason is kept as a fallback for
    // spans read outside the cache.
    const finishRaw = getPath(s, "payload.outputs.ai.finishReason") ?? getPath(s, "payload.outputs.stop_reason");
    const finish =
      typeof finishRaw === "string"
        ? finishRaw
        : ((finishRaw as { unified?: unknown; raw?: unknown } | null)?.unified ?? (finishRaw as { unified?: unknown; raw?: unknown } | null)?.raw);
    const errType = getPath(s, "payload.error.error_type");
    calls.push({
      spanId: s.id,
      agentId: s.agent_id,
      instanceId: s.agent_instance_id,
      startedAt: s.started_at,
      model,
      promptTokens,
      completionTokens,
      totalTokens,
      cost: price ? (promptTokens / 1e6) * price.inputPer1M + (completionTokens / 1e6) * price.outputPer1M : 0,
      priced: Boolean(price),
      durationMs: durationMs(s.started_at, s.finished_at),
      finishReason: typeof errType === "string" ? `error: ${errType}` : typeof finish === "string" ? finish : null,
    });
  }
  return calls;
}

export interface CostSummary {
  totalCost: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  llmCalls: number;
  models: Array<{
    model: string;
    cost: number;
    tokens: number;
    calls: number;
    priced: boolean;
    promptTokens: number;
    completionTokens: number;
    avgCostPerCall: number;
    p50Ms: number | null;
    p95Ms: number | null;
    errors: number;
  }>;
  unpricedModels: string[];
  /** Tokens/calls contributing $0 because their model has no rate (or no id). */
  unpricedTokens: number;
  unpricedCalls: number;
  byAgent: Array<{ agentId: string; cost: number; tokens: number; calls: number }>;
  /** One row per UTC day; per-model cost keyed by model id. */
  byDay: Array<{ day: string } & Record<string, number | string>>;
  byInstance: Array<{ instanceId: string; agentId: string | null; cost: number; tokens: number; calls: number; startedAt: string | null }>;
  tokensByDay: Array<{ day: string; prompt: number; completion: number }>;
  latencyByDay: Array<{ day: string; p50: number | null; p95: number | null }>;
  finishReasons: Array<{ reason: string; count: number }>;
}

export function summarizeCost(calls: LlmCall[], windowStart: string, windowEnd: string): CostSummary {
  const models = new Map<
    string,
    {
      cost: number;
      tokens: number;
      calls: number;
      priced: boolean;
      promptTokens: number;
      completionTokens: number;
      durations: number[];
      errors: number;
    }
  >();
  const agents = new Map<string, { cost: number; tokens: number; calls: number }>();
  const instances = new Map<string, { agentId: string | null; cost: number; tokens: number; calls: number; startedAt: string | null }>();
  const days = new Map<string, Map<string, number>>();
  let totalCost = 0,
    totalTokens = 0,
    promptTokens = 0,
    completionTokens = 0;

  for (const c of calls) {
    totalCost += c.cost;
    totalTokens += c.totalTokens;
    promptTokens += c.promptTokens;
    completionTokens += c.completionTokens;

    const m = models.get(c.model) ?? {
      cost: 0,
      tokens: 0,
      calls: 0,
      priced: c.priced,
      promptTokens: 0,
      completionTokens: 0,
      durations: [],
      errors: 0,
    };
    m.cost += c.cost;
    m.tokens += c.totalTokens;
    m.calls++;
    m.promptTokens += c.promptTokens;
    m.completionTokens += c.completionTokens;
    if (c.durationMs != null) m.durations.push(c.durationMs);
    if (c.finishReason?.startsWith("error")) m.errors++;
    models.set(c.model, m);

    if (c.agentId) {
      const a = agents.get(c.agentId) ?? { cost: 0, tokens: 0, calls: 0 };
      a.cost += c.cost;
      a.tokens += c.totalTokens;
      a.calls++;
      agents.set(c.agentId, a);
    }
    if (c.instanceId) {
      const i = instances.get(c.instanceId) ?? { agentId: c.agentId, cost: 0, tokens: 0, calls: 0, startedAt: c.startedAt };
      i.cost += c.cost;
      i.tokens += c.totalTokens;
      i.calls++;
      if (c.startedAt && (!i.startedAt || c.startedAt < i.startedAt)) i.startedAt = c.startedAt;
      instances.set(c.instanceId, i);
    }
    if (c.startedAt) {
      const day = dayKey(c.startedAt);
      const d = days.get(day) ?? new Map<string, number>();
      d.set(c.model, (d.get(c.model) ?? 0) + c.cost);
      days.set(day, d);
    }
  }

  const modelRows = [...models.entries()]
    .map(([model, v]) => {
      v.durations.sort((a, b) => a - b);
      const { durations, ...rest } = v;
      return {
        model,
        ...rest,
        avgCostPerCall: v.calls ? v.cost / v.calls : 0,
        p50Ms: percentile(durations, 50),
        p95Ms: percentile(durations, 95),
      };
    })
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);

  const byDay = dayRange(windowStart, windowEnd).map((day) => {
    const row: { day: string } & Record<string, number | string> = { day };
    const d = days.get(day);
    for (const { model } of modelRows) row[model] = d?.get(model) ?? 0;
    return row;
  });

  // Daily token split and latency percentiles, from the same calls.
  const callsByDay = new Map<string, LlmCall[]>();
  for (const c of calls) {
    if (!c.startedAt) continue;
    const day = dayKey(c.startedAt);
    (callsByDay.get(day) ?? callsByDay.set(day, []).get(day)!).push(c);
  }
  const allDays = dayRange(windowStart, windowEnd);
  const tokensByDay = allDays.map((day) => {
    const list = callsByDay.get(day) ?? [];
    return {
      day,
      prompt: list.reduce((a, c) => a + c.promptTokens, 0),
      completion: list.reduce((a, c) => a + c.completionTokens, 0),
    };
  });
  const latencyByDay = allDays.map((day) => {
    const durs = (callsByDay.get(day) ?? [])
      .map((c) => c.durationMs)
      .filter((d): d is number => d != null)
      .sort((a, b) => a - b);
    return { day, p50: percentile(durs, 50), p95: percentile(durs, 95) };
  });

  const reasonCounts = new Map<string, number>();
  for (const c of calls) {
    const r = c.finishReason ?? "unknown";
    reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
  }
  const finishReasons = [...reasonCounts.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);

  return {
    totalCost,
    totalTokens,
    promptTokens,
    completionTokens,
    llmCalls: calls.length,
    models: modelRows,
    // "unknown" must NOT be excluded: spans that carry token usage but no
    // model id (e.g. langchain:llm) are the largest unpriced bucket in
    // practice, and hiding them made the headline read as if everything was
    // priced. Unpriced tokens are reported separately so the gap is visible.
    unpricedModels: modelRows.filter((m) => !m.priced).map((m) => m.model),
    unpricedTokens: modelRows.filter((m) => !m.priced).reduce((a, m) => a + m.tokens, 0),
    unpricedCalls: modelRows.filter((m) => !m.priced).reduce((a, m) => a + m.calls, 0),
    byAgent: [...agents.entries()].map(([agentId, v]) => ({ agentId, ...v })).sort((a, b) => b.cost - a.cost),
    byDay,
    byInstance: [...instances.entries()]
      .map(([instanceId, v]) => ({ instanceId, ...v }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 12),
    tokensByDay,
    latencyByDay,
    finishReasons,
  };
}
