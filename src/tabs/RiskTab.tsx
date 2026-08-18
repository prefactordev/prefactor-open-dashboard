// Risk — read straight off spans (Prefactor scores risk on read when the
// agent has a risk profile). Risk levels are STATE, so they wear the reserved
// status palette and always ship an icon + label, never color alone.

import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useDashboard } from "../state";
import { RISK_LEVELS, summarizeRisk } from "../lib/risk";
import { AXIS_LINE, AXIS_TICK, BarList, ChartCard, EmptyState, GRID_STROKE, StatCard, VizLegend, VizTooltip } from "../components/viz";
import { RISK_COLOR, RISK_ICON } from "../palette";
import { ActionsChartCard, ActionsTile, useActions } from "../components/ActionsSection";
import { compact, fmtWhen, pct, shortDay } from "../lib/util";

function RiskChip({ level }: { level: string }) {
  return (
    <span className="risk-chip">
      <span className="dot" style={{ background: RISK_COLOR[level] }} />
      {RISK_ICON[level]} {level}
    </span>
  );
}

export default function RiskTab() {
  const { spans, windowStart, windowEnd, agentName, riskProfiles, agents, alerts } = useDashboard();

  const summary = useMemo(() => summarizeRisk(spans, windowStart, windowEnd), [spans, windowStart, windowEnd]);
  const actions = useActions();

  if (summary.scoredSpans === 0) {
    return (
      <EmptyState title="No risk-scored spans in this window">
        <p>
          Prefactor computes risk <em>on read</em>, and only for agents with a risk profile assigned. Spans from agents without one come back
          unscored.
        </p>
        <p>
          Assign a profile with <code>{'PUT /api/v1/agent/{id} {"details":{"risk_profile_id":"…"}}'}</code>
          {riskProfiles.length > 0 && (
            <>
              {" "}
              — your account has {riskProfiles.length} profile{riskProfiles.length === 1 ? "" : "s"}:{" "}
              {riskProfiles.map((p) => p.name ?? p.id).join(", ")}
            </>
          )}
          .
        </p>
        {spans.length > 0 && <p>({compact(spans.length)} spans in the window, none scored.)</p>}
      </EmptyState>
    );
  }

  const legendItems = RISK_LEVELS.map((l) => ({ label: l, color: RISK_COLOR[l], icon: RISK_ICON[l] }));

  return (
    <div>
      {summary.unscoredAgents.length > 0 && (
        <div className="notice">
          <strong>Partial coverage:</strong>
          <span>
            {summary.unscoredAgents.length} of {agents.length} agents produced spans but no risk scores — likely missing a{" "}
            <code>risk_profile_id</code>: {summary.unscoredAgents.map((id) => agentName(id)).join(", ")}
          </span>
        </div>
      )}

      <div className="tiles">
        <StatCard
          label="Spans risk-scored"
          value={compact(summary.scoredSpans)}
          detail={`${pct(summary.coverage)} of ${compact(summary.totalSpans)} spans`}
        />
        <StatCard
          label="High or critical"
          value={compact(summary.highPlus)}
          detail={summary.scoredSpans ? `${pct(summary.highPlus / summary.scoredSpans)} of scored` : undefined}
        />
        <StatCard label="Max risk score" value={summary.maxScore == null ? "—" : String(summary.maxScore)} />
        <StatCard
          label="Sensitive-marked spans"
          value={compact(summary.sensitive.spansMarked)}
          detail={
            (summary.totalSpans ? `${pct(summary.sensitive.spansMarked / summary.totalSpans)} of spans` : "") +
            (summary.sensitive.spansEncoded > 0 ? ` · ${compact(summary.sensitive.spansEncoded)} encoded, unlabelled` : "")
          }
        />
        <StatCard label="Open alerts" value={alerts == null ? "—" : String(alerts)} detail="account-wide" />
        <ActionsTile actions={actions} />
      </div>

      <ChartCard
        title="Risk-scored spans over time"
        sub="per day, stacked by level"
        table={{
          columns: ["Day", ...RISK_LEVELS.map((l) => `${RISK_ICON[l]} ${l}`)],
          rows: summary.byDay.map((r) => [shortDay(r.day), r.low, r.medium, r.high, r.critical]),
          numeric: [1, 2, 3, 4],
        }}
        legend={<VizLegend items={legendItems} />}
      >
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={summary.byDay} margin={{ top: 4, right: 8, left: 4, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={GRID_STROKE} />
            <XAxis dataKey="day" tickFormatter={shortDay} tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={false} />
            <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={40} allowDecimals={false} />
            <Tooltip cursor={{ fill: "var(--gridline)", opacity: 0.35 }} content={<VizTooltip labelFormat={shortDay} />} />
            {RISK_LEVELS.map((l, i) => (
              <Bar
                key={l}
                dataKey={l}
                stackId="risk"
                fill={RISK_COLOR[l]}
                stroke="var(--surface-1)"
                strokeWidth={2}
                maxBarSize={24}
                radius={i === RISK_LEVELS.length - 1 ? [4, 4, 0, 0] : undefined}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid-2">
        <ChartCard
          title="Risk by span type"
          sub="which activities carry the risk"
          table={{
            columns: ["Span type", ...RISK_LEVELS.map((l) => `${RISK_ICON[l]} ${l}`)],
            rows: summary.bySchema.map((r) => [r.schema, r.low, r.medium, r.high, r.critical]),
            numeric: [1, 2, 3, 4],
          }}
          legend={<VizLegend items={legendItems} />}
        >
          <ResponsiveContainer width="100%" height={Math.max(120, summary.bySchema.length * 34 + 30)}>
            <BarChart data={summary.bySchema} layout="vertical" margin={{ top: 4, right: 16, left: 4, bottom: 0 }}>
              <CartesianGrid horizontal={false} stroke={GRID_STROKE} />
              <XAxis
                type="number"
                tick={AXIS_TICK}
                axisLine={AXIS_LINE}
                tickLine={false}
                allowDecimals={false}
                tickFormatter={(v: number) => compact(v)}
              />
              <YAxis type="category" dataKey="schema" tick={AXIS_TICK} axisLine={false} tickLine={false} width={170} />
              <Tooltip cursor={{ fill: "var(--gridline)", opacity: 0.35 }} content={<VizTooltip format={compact} />} />
              {RISK_LEVELS.map((l, i) => (
                <Bar
                  key={l}
                  dataKey={l}
                  stackId="schema"
                  fill={RISK_COLOR[l]}
                  stroke="var(--surface-1)"
                  strokeWidth={2}
                  maxBarSize={18}
                  radius={i === RISK_LEVELS.length - 1 ? [0, 4, 4, 0] : undefined}
                  isAnimationActive={false}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Risk score distribution"
          sub="scored spans by ten-point bucket"
          table={{ columns: ["Score", "Spans"], rows: summary.scoreHistogram.map((b) => [b.bucket, b.count]), numeric: [1] }}
        >
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={summary.scoreHistogram} margin={{ top: 4, right: 8, left: 4, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke={GRID_STROKE} />
              <XAxis dataKey="bucket" tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={false} />
              <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={40} allowDecimals={false} tickFormatter={(v: number) => compact(v)} />
              <Tooltip cursor={{ fill: "var(--gridline)", opacity: 0.35 }} content={<VizTooltip format={compact} />} />
              <Bar
                dataKey="count"
                name="spans"
                fill="var(--accent)"
                stroke="var(--surface-1)"
                strokeWidth={2}
                maxBarSize={24}
                radius={[4, 4, 0, 0]}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <div className="grid-21">
        <ChartCard title="Riskiest spans" sub="by score, in this window">
          <div className="table-scroll">
            <table className="viz">
              <thead>
                <tr>
                  <th>Span</th>
                  <th>Agent</th>
                  <th>Level</th>
                  <th className="num">Score</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {summary.top.map((r) => (
                  <tr key={r.spanId}>
                    <td>{r.name}</td>
                    <td>{agentName(r.agentId)}</td>
                    <td>
                      <RiskChip level={r.level} />
                    </td>
                    <td className="num strong">{r.score}</td>
                    <td>{fmtWhen(r.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ChartCard>

        <ChartCard
          title="Level distribution"
          table={{
            columns: ["Level", "Spans"],
            rows: RISK_LEVELS.map((l) => [`${RISK_ICON[l]} ${l}`, summary.byLevel[l]]),
            numeric: [1],
          }}
        >
          <div className="barlist">
            {RISK_LEVELS.map((l) => {
              const max = Math.max(...RISK_LEVELS.map((x) => summary.byLevel[x]), 1);
              return (
                <div className="row" key={l}>
                  <span className="name">
                    <RiskChip level={l} />
                  </span>
                  <span className="track">
                    <span className="fill" style={{ width: `${Math.max(1.5, (summary.byLevel[l] / max) * 100)}%`, background: RISK_COLOR[l] }} />
                  </span>
                  <span className="val">{compact(summary.byLevel[l])}</span>
                </div>
              );
            })}
          </div>
        </ChartCard>
      </div>

      <ActionsChartCard actions={actions} />

      <ChartCard
        title="Sensitive data exposure"
        sub="values the SDK marked sensitive, by label"
        table={{
          columns: ["Label", "Occurrences"],
          rows: summary.sensitive.byLabel.map((l) => [l.label, l.count]),
          numeric: [1],
        }}
      >
        {summary.sensitive.byLabel.length === 0 ? (
          <div className="empty">
            <h4>
              {summary.sensitive.spansEncoded > 0
                ? `${compact(summary.sensitive.spansEncoded)} spans carry sensitive values, but no labels are available`
                : "No sensitive-marked values in this window"}
            </h4>
            <p>
              {summary.sensitive.spansEncoded > 0 ? (
                <>
                  Those spans are flagged <code>sensitive_encoding</code>: the content was encoded before it reached the API, so the category labels
                  aren't exposed to read back. Declare <code>data_risk</code> categories on the span's schema to see a breakdown here.
                </>
              ) : (
                <>
                  Values wrapped with the SDK's sensitive markers (e.g. <code>personal_identifiers</code>, <code>financial</code>) are counted here by
                  label. Payload contents themselves are never displayed.
                </>
              )}
            </p>
          </div>
        ) : (
          <BarList
            rows={summary.sensitive.byLabel.slice(0, 8).map((l) => ({ name: l.label, value: l.count, display: compact(l.count) }))}
            color="var(--accent)"
          />
        )}
      </ChartCard>

      <div className="notice">
        <span>
          Instance-level risk rollups are unreliable on the API today — everything above is computed per-span. Span payload contents are never
          rendered here; only schema names, levels, scores, and sensitivity labels.
        </span>
      </div>
    </div>
  );
}
