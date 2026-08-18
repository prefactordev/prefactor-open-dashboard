// Cost — derived from llm-span token usage × the price table in lib/cost.ts.
// Anatomy mirrors the classic usage dashboard: stat row, cost-by-model-over-
// time stacked daily bars, model mix donut, cost by agent, top runs by cost.

import { useMemo } from "react";
import { Bar, BarChart, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from "recharts";
import { useDashboard } from "../state";
import { extractLlmCalls, summarizeCost } from "../lib/cost";
import { AXIS_LINE, AXIS_TICK, BarList, ChartCard, EmptyState, GRID_STROKE, StatCard, VizLegend, VizTooltip } from "../components/viz";
import { assignSlots, seriesColor, OTHER_LIGHT, OTHER_DARK } from "../palette";
import { useIsDark } from "../useTheme";
import { compact, fmtMs, fmtWhen, pct, shortDay, shortId, usd } from "../lib/util";

export default function CostTab() {
  const { spans, windowStart, windowEnd, agentName } = useDashboard();
  const dark = useIsDark();

  const summary = useMemo(() => summarizeCost(extractLlmCalls(spans), windowStart, windowEnd), [spans, windowStart, windowEnd]);

  if (summary.llmCalls === 0) {
    return (
      <EmptyState title="No token usage in this window">
        <p>
          Cost is computed from spans that carry <code>payload.token_usage</code> — the SDK records these on LLM calls automatically. Widen the time
          range, or check that your agents are emitting llm spans.
        </p>
      </EmptyState>
    );
  }

  // Fixed slot order = models by total cost across the WHOLE window; a filter
  // change re-derives the dataset, never re-ranks colors within it.
  const { named: namedModels, other: otherModels } = assignSlots(summary.models.map((m) => m.model));
  const modelColor = (model: string): string => {
    const idx = namedModels.indexOf(model);
    return idx >= 0 ? seriesColor(idx, dark) : dark ? OTHER_DARK : OTHER_LIGHT;
  };

  const byDay = summary.byDay.map((row) => {
    const out: Record<string, number | string> = { day: row.day };
    for (const m of namedModels) out[m] = Number(row[m] ?? 0);
    if (otherModels.length) out.Other = otherModels.reduce((acc, m) => acc + Number(row[m] ?? 0), 0);
    return out;
  });
  const stackKeys = [...namedModels, ...(otherModels.length ? ["Other"] : [])];

  const donutData = [
    ...namedModels.map((m) => ({ name: m, value: summary.models.find((x) => x.model === m)?.cost ?? 0 })),
    ...(otherModels.length
      ? [{ name: "Other", value: otherModels.reduce((a, m) => a + (summary.models.find((x) => x.model === m)?.cost ?? 0), 0) }]
      : []),
  ].filter((d) => d.value > 0);

  const legendItems = stackKeys.map((m) => ({ label: m, color: m === "Other" ? (dark ? OTHER_DARK : OTHER_LIGHT) : modelColor(m) }));

  return (
    <div>
      {summary.unpricedModels.length > 0 && (
        <div className="notice warn">
          <strong>Cost is understated:</strong>
          <span>
            {compact(summary.unpricedTokens)} tokens ({pct(summary.totalTokens ? summary.unpricedTokens / summary.totalTokens : null)} of all tokens,{" "}
            {compact(summary.unpricedCalls)} calls) are priced at $0 —{" "}
            {summary.unpricedModels.includes("unknown") && (
              <>
                some spans carry token usage but no model id, so their model can't be identified
                {summary.unpricedModels.length > 1 ? "; " : ". "}
              </>
            )}
            {summary.unpricedModels.filter((m) => m !== "unknown").length > 0 && (
              <>
                no rate is configured for {summary.unpricedModels.filter((m) => m !== "unknown").join(", ")} — add them to <code>PRICES</code> in{" "}
                <code>src/lib/cost.ts</code>.
              </>
            )}
          </span>
        </div>
      )}

      <div className="tiles">
        <StatCard
          label="Estimated cost"
          value={usd(summary.totalCost)}
          detail={`${summary.models.length} model${summary.models.length === 1 ? "" : "s"}`}
        />
        <StatCard
          label="Tokens"
          value={compact(summary.totalTokens)}
          detail={`${compact(summary.promptTokens)} in / ${compact(summary.completionTokens)} out`}
        />
        <StatCard label="LLM calls" value={compact(summary.llmCalls)} detail={`avg ${usd(summary.totalCost / summary.llmCalls)} per call`} />
        <StatCard label="Agents with spend" value={String(summary.byAgent.length)} />
      </div>

      <ChartCard
        title="Cost by model over time"
        sub="estimated cost per day, stacked by model"
        table={{
          columns: ["Day", ...stackKeys],
          rows: byDay.map((r) => [shortDay(String(r.day)), ...stackKeys.map((k) => usd(Number(r[k] ?? 0)))]),
          numeric: stackKeys.map((_, i) => i + 1),
        }}
        legend={<VizLegend items={legendItems} />}
      >
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={byDay} margin={{ top: 4, right: 8, left: 4, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={GRID_STROKE} />
            <XAxis dataKey="day" tickFormatter={shortDay} tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={false} />
            <YAxis tickFormatter={(v: number) => usd(v)} tick={AXIS_TICK} axisLine={false} tickLine={false} width={58} />
            <Tooltip cursor={{ fill: "var(--gridline)", opacity: 0.35 }} content={<VizTooltip format={usd} labelFormat={shortDay} />} />
            {stackKeys.map((m, i) => (
              <Bar
                key={m}
                dataKey={m}
                stackId="cost"
                fill={m === "Other" ? (dark ? OTHER_DARK : OTHER_LIGHT) : modelColor(m)}
                stroke="var(--surface-1)"
                strokeWidth={2}
                maxBarSize={24}
                radius={i === stackKeys.length - 1 ? [4, 4, 0, 0] : undefined}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid-2">
        <ChartCard
          title="Tokens over time"
          sub="prompt vs completion per day"
          table={{
            columns: ["Day", "Prompt", "Completion"],
            rows: summary.tokensByDay.map((r) => [shortDay(r.day), r.prompt, r.completion]),
            numeric: [1, 2],
          }}
          legend={
            <VizLegend
              items={[
                { label: "prompt", color: seriesColor(0, dark) },
                { label: "completion", color: seriesColor(1, dark) },
              ]}
            />
          }
        >
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={summary.tokensByDay} margin={{ top: 4, right: 8, left: 4, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke={GRID_STROKE} />
              <XAxis dataKey="day" tickFormatter={shortDay} tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={false} />
              <YAxis tickFormatter={(v: number) => compact(v)} tick={AXIS_TICK} axisLine={false} tickLine={false} width={48} />
              <Tooltip cursor={{ fill: "var(--gridline)", opacity: 0.35 }} content={<VizTooltip format={compact} labelFormat={shortDay} />} />
              <Bar
                dataKey="prompt"
                name="prompt"
                stackId="tok"
                fill={seriesColor(0, dark)}
                stroke="var(--surface-1)"
                strokeWidth={2}
                maxBarSize={24}
                isAnimationActive={false}
              />
              <Bar
                dataKey="completion"
                name="completion"
                stackId="tok"
                fill={seriesColor(1, dark)}
                stroke="var(--surface-1)"
                strokeWidth={2}
                maxBarSize={24}
                radius={[4, 4, 0, 0]}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="LLM latency"
          sub="call duration percentiles per day"
          table={{
            columns: ["Day", "p50", "p95"],
            rows: summary.latencyByDay.map((r) => [shortDay(r.day), fmtMs(r.p50), fmtMs(r.p95)]),
            numeric: [1, 2],
          }}
          legend={
            <VizLegend
              items={[
                { label: "p50", color: seriesColor(0, dark), mark: "line" },
                { label: "p95", color: seriesColor(1, dark), mark: "line" },
              ]}
            />
          }
        >
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={summary.latencyByDay} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke={GRID_STROKE} />
              <XAxis dataKey="day" tickFormatter={shortDay} tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={false} />
              <YAxis tickFormatter={(v: number) => fmtMs(v)} tick={AXIS_TICK} axisLine={false} tickLine={false} width={50} />
              <Tooltip cursor={{ stroke: "var(--baseline)" }} content={<VizTooltip format={(v) => fmtMs(v)} labelFormat={shortDay} />} />
              <Line
                type="monotone"
                dataKey="p50"
                name="p50"
                stroke={seriesColor(0, dark)}
                strokeWidth={2}
                connectNulls
                dot={false}
                activeDot={{ r: 5 }}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="p95"
                name="p95"
                stroke={seriesColor(1, dark)}
                strokeWidth={2}
                connectNulls
                dot={false}
                activeDot={{ r: 5 }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <div className="grid-21">
        <ChartCard
          title="Cost by agent"
          table={{
            columns: ["Agent", "Cost", "Tokens", "Calls"],
            rows: summary.byAgent.map((a) => [agentName(a.agentId), usd(a.cost), compact(a.tokens), a.calls]),
            numeric: [1, 2, 3],
          }}
        >
          <BarList
            rows={summary.byAgent.slice(0, 8).map((a) => ({ name: agentName(a.agentId), value: a.cost, display: usd(a.cost) }))}
            color={seriesColor(0, dark)}
          />
        </ChartCard>

        <ChartCard
          title="Model mix"
          sub="share of estimated cost"
          table={{
            columns: ["Model", "Cost", "Tokens", "Calls"],
            rows: summary.models.map((m) => [m.model, usd(m.cost), compact(m.tokens), m.calls]),
            numeric: [1, 2, 3],
          }}
          legend={<VizLegend items={legendItems.filter((l) => donutData.some((d) => d.name === l.label))} />}
        >
          {donutData.length < 2 ? (
            // One model: a one-slice donut says nothing — the numbers are the chart.
            <div className="table-scroll">
              <table className="viz">
                <tbody>
                  {summary.models.map((m) => (
                    <tr key={m.model}>
                      <td className="strong">{m.model}</td>
                      <td className="num">{compact(m.tokens)} tokens</td>
                      <td className="num strong">{usd(m.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ position: "relative" }}>
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie
                    data={donutData}
                    dataKey="value"
                    nameKey="name"
                    innerRadius="62%"
                    outerRadius="92%"
                    paddingAngle={2}
                    stroke="var(--surface-1)"
                    strokeWidth={2}
                    isAnimationActive={false}
                  >
                    {donutData.map((d) => (
                      <Cell key={d.name} fill={d.name === "Other" ? (dark ? OTHER_DARK : OTHER_LIGHT) : modelColor(d.name)} />
                    ))}
                  </Pie>
                  <Tooltip content={<VizTooltip format={usd} />} />
                </PieChart>
              </ResponsiveContainer>
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "grid",
                  placeItems: "center",
                  pointerEvents: "none",
                  fontWeight: 650,
                  fontSize: 18,
                }}
              >
                {usd(summary.totalCost)}
              </div>
            </div>
          )}
        </ChartCard>
      </div>

      <ChartCard title="Model economics" sub="per-model unit costs, tokens, latency, and errors">
        <div className="table-scroll">
          <table className="viz">
            <thead>
              <tr>
                <th>Model</th>
                <th className="num">Calls</th>
                <th className="num">Tokens in</th>
                <th className="num">Tokens out</th>
                <th className="num">Cost</th>
                <th className="num">$ / call</th>
                <th className="num">$ / 1M tokens</th>
                <th className="num">p50</th>
                <th className="num">p95</th>
                <th className="num">Errors</th>
              </tr>
            </thead>
            <tbody>
              {summary.models.map((m) => (
                <tr key={m.model}>
                  <td className="strong">
                    {m.model}
                    {m.priced ? "" : " ⚠ unpriced"}
                  </td>
                  <td className="num">{compact(m.calls)}</td>
                  <td className="num">{compact(m.promptTokens)}</td>
                  <td className="num">{compact(m.completionTokens)}</td>
                  <td className="num strong">{usd(m.cost)}</td>
                  <td className="num">{usd(m.avgCostPerCall)}</td>
                  <td className="num">{m.tokens ? usd(m.cost / (m.tokens / 1e6)) : "—"}</td>
                  <td className="num">{fmtMs(m.p50Ms)}</td>
                  <td className="num">{fmtMs(m.p95Ms)}</td>
                  <td className="num">{m.errors || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ChartCard>

      <div className="grid-21">
        <ChartCard title="Top runs by cost" sub="agent instances ranked by estimated cost">
          <div className="table-scroll">
            <table className="viz">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Agent</th>
                  <th>Started</th>
                  <th className="num">LLM calls</th>
                  <th className="num">Tokens</th>
                  <th className="num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {summary.byInstance.map((r) => (
                  <tr key={r.instanceId}>
                    <td>{shortId(r.instanceId)}</td>
                    <td>{agentName(r.agentId)}</td>
                    <td>{fmtWhen(r.startedAt)}</td>
                    <td className="num">{r.calls}</td>
                    <td className="num">{compact(r.tokens)}</td>
                    <td className="num strong">{usd(r.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ChartCard>

        <ChartCard
          title="Finish reasons"
          sub="why LLM calls ended"
          table={{
            columns: ["Reason", "Calls"],
            rows: summary.finishReasons.map((r) => [r.reason, r.count]),
            numeric: [1],
          }}
        >
          <BarList
            rows={summary.finishReasons.slice(0, 6).map((r) => ({ name: r.reason, value: r.count, display: compact(r.count) }))}
            color={seriesColor(0, dark)}
          />
          {summary.finishReasons.some((r) => r.reason === "length") && (
            <div className="notice warn" style={{ marginTop: 10, marginBottom: 0 }}>
              <span>
                <strong>length</strong> finishes are truncated responses — consider raising max output tokens.
              </span>
            </div>
          )}
        </ChartCard>
      </div>
    </div>
  );
}
