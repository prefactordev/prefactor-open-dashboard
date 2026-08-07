// Quality (Prefactor-created) — signals the platform computes or renders
// itself: run outcomes + durations from lifecycle data, thumbs feedback from
// prefactor:quality spans, and server-rendered quality_summary text.

import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useDashboard } from "../state";
import { summarizeNativeQuality } from "../lib/quality";
import { hourOfWeekHeatmap, spansBySchemaByDay } from "../lib/activity";
import { AXIS_LINE, AXIS_TICK, ChartCard, EmptyState, GRID_STROKE, heatmapTable, HourHeatmap, StatCard, VizLegend, VizTooltip } from "../components/viz";
import { assignSlots, seriesColor, OTHER_DARK, OTHER_LIGHT, STATUS } from "../palette";
import { useIsDark } from "../useTheme";
import { ActionsChartCard, ActionsTile, useActions } from "../components/ActionsSection";
import { compact, fmtMs, fmtWhen, pct, shortDay, shortId } from "../lib/util";

// Outcomes are state, so they wear status colors (with labels, never color alone).
const OUTCOME_COLOR = {
  complete: STATUS.good,
  failed: STATUS.critical,
  terminated: STATUS.serious, // killswitch — deliberately stopped, not a crash
  cancelled: STATUS.warning,
} as const;
const OUTCOME_KEYS = ["complete", "failed", "terminated", "cancelled"] as const;

// Accounts routinely have 50+ span types. Show the busiest inline; the card's
// Table view still lists every one.
const SPAN_TYPE_ROWS = 15;

export default function QualityPrefactorTab() {
  const { instances, spans, details, detailCapped, windowStart, windowEnd, agentName } = useDashboard();

  const summary = useMemo(
    () => summarizeNativeQuality(instances, spans, details, windowStart, windowEnd),
    [instances, spans, details, windowStart, windowEnd],
  );
  const activity = useMemo(() => spansBySchemaByDay(spans, windowStart, windowEnd), [spans, windowStart, windowEnd]);
  const heat = useMemo(() => hourOfWeekHeatmap(spans), [spans]);
  const dark = useIsDark();
  const actions = useActions();

  // Fixed slots by total volume; schemas past the slot cap fold into "Other".
  const { named: actNamed, other: actOther } = assignSlots(activity.schemas);
  const actKeys = [...actNamed, ...(actOther.length ? ["Other"] : [])];
  const actRows = activity.rows.map((r) => {
    const row: Record<string, number | string> = { day: r.day };
    for (const s of actNamed) row[s] = Number(r[s] ?? 0);
    if (actOther.length) row.Other = actOther.reduce((a, s) => a + Number(r[s] ?? 0), 0);
    return row;
  });
  const actColor = (key: string, i: number) => (key === "Other" ? (dark ? OTHER_DARK : OTHER_LIGHT) : seriesColor(i, dark));

  if (summary.runs === 0) {
    return (
      <EmptyState title="No agent runs in this window">
        <p>
          This tab reads run outcomes, durations, and platform feedback from registered agent instances. Widen the time range, or check
          that your agents register instances via the SDK.
        </p>
      </EmptyState>
    );
  }

  const legendItems = OUTCOME_KEYS.map((k) => ({ label: k, color: OUTCOME_COLOR[k] }));

  return (
    <div>
      <div className="tiles">
        <StatCard
          label="Runs"
          value={compact(summary.runs)}
          detail={[
            summary.outcomes.active ? `${summary.outcomes.active} active` : null,
            summary.outcomes.other ? `${summary.outcomes.other} other status` : null,
            summary.purposes.length > 1
              ? summary.purposes.map((p) => `${p.purpose} ${compact(p.count)}`).join(" / ")
              : `all ${summary.purposes[0]?.purpose ?? "live"}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        />
        <StatCard
          label="Success rate"
          value={pct(summary.successRate)}
          detail={
            `${compact(summary.outcomes.complete)} complete / ${compact(summary.outcomes.failed)} failed` +
            (summary.outcomes.terminated ? ` / ${compact(summary.outcomes.terminated)} killed` : "")
          }
        />
        <StatCard label="Run duration p50" value={fmtMs(summary.p50Ms)} detail={`p95 ${fmtMs(summary.p95Ms)}`} />
        <StatCard
          label="User feedback"
          value={summary.feedback.rate == null ? "—" : pct(summary.feedback.rate)}
          detail={
            summary.feedback.up + summary.feedback.down > 0
              ? `${summary.feedback.up} up / ${summary.feedback.down} down` +
                (summary.feedback.other ? ` · ${summary.feedback.other} other rating${summary.feedback.other === 1 ? "" : "s"}` : "")
              : summary.feedback.other
                ? `${summary.feedback.other} rating${summary.feedback.other === 1 ? "" : "s"}, none up/down`
                : "no rated runs in this window"
          }
        />
        <ActionsTile actions={actions} />
      </div>

      <ChartCard
        title="Run outcomes over time"
        sub="finished runs per day"
        table={{
          columns: ["Day", "Complete", "Failed", "Killed", "Cancelled"],
          rows: summary.byDay.map((r) => [shortDay(r.day), r.complete, r.failed, r.terminated, r.cancelled]),
          numeric: [1, 2, 3, 4],
        }}
        legend={<VizLegend items={legendItems} />}
      >
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={summary.byDay} margin={{ top: 4, right: 8, left: 4, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={GRID_STROKE} />
            <XAxis dataKey="day" tickFormatter={shortDay} tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={false} />
            <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={40} allowDecimals={false} />
            <Tooltip cursor={{ fill: "var(--gridline)", opacity: 0.35 }} content={<VizTooltip labelFormat={shortDay} />} />
            {OUTCOME_KEYS.map((k, i) => (
              <Bar
                key={k}
                dataKey={k}
                stackId="outcomes"
                fill={OUTCOME_COLOR[k]}
                stroke="var(--surface-1)"
                strokeWidth={2}
                maxBarSize={24}
                radius={i === OUTCOME_KEYS.length - 1 ? [4, 4, 0, 0] : undefined}
               isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid-2">
        <ChartCard
          title="User feedback over time"
          sub="thumbs recorded on runs, per day"
          table={{
            columns: ["Day", "👍 up", "👎 down"],
            rows: summary.feedbackByDay.map((r) => [shortDay(r.day), r.up, r.down]),
            numeric: [1, 2],
          }}
          legend={<VizLegend items={[{ label: "up", color: STATUS.good }, { label: "down", color: STATUS.critical }]} />}
        >
          {summary.feedback.up + summary.feedback.down === 0 ? (
            <div className="empty">
              <h4>No feedback spans in this window</h4>
              <p>
                Thumbs appear when your app records a span carrying <code>inputs.feedback.rating</code> or{" "}
                <code>inputs.rating</code> set to "up" / "down" — the schema name doesn't matter.
              </p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={summary.feedbackByDay} margin={{ top: 4, right: 8, left: 4, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke={GRID_STROKE} />
                <XAxis dataKey="day" tickFormatter={shortDay} tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={false} />
                <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={40} allowDecimals={false} />
                <Tooltip cursor={{ fill: "var(--gridline)", opacity: 0.35 }} content={<VizTooltip labelFormat={shortDay} />} />
                <Bar dataKey="up" name="up" stackId="fb" fill={STATUS.good} stroke="var(--surface-1)" strokeWidth={2} maxBarSize={24}  isAnimationActive={false} />
                <Bar dataKey="down" name="down" stackId="fb" fill={STATUS.critical} stroke="var(--surface-1)" strokeWidth={2} maxBarSize={24} radius={[4, 4, 0, 0]}  isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        <ChartCard title="Activity heatmap" sub="span starts by UTC hour of week" table={heatmapTable(heat.cells)}>
          <HourHeatmap cells={heat.cells} max={heat.max} />
        </ChartCard>
      </div>

      <ActionsChartCard actions={actions} />

      <ChartCard
        title="Activity mix over time"
        sub="spans per day by type"
        table={{
          columns: ["Day", ...activity.schemas],
          rows: activity.rows.map((r) => [shortDay(String(r.day)), ...activity.schemas.map((s) => Number(r[s] ?? 0))]),
          numeric: activity.schemas.map((_, i) => i + 1),
        }}
        legend={<VizLegend items={actKeys.map((s, i) => ({ label: s, color: actColor(s, i) }))} />}
      >
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={actRows} margin={{ top: 4, right: 8, left: 4, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={GRID_STROKE} />
            <XAxis dataKey="day" tickFormatter={shortDay} tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={false} />
            <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={44} allowDecimals={false} tickFormatter={(v: number) => compact(v)} />
            <Tooltip cursor={{ fill: "var(--gridline)", opacity: 0.35 }} content={<VizTooltip format={compact} labelFormat={shortDay} />} />
            {actKeys.map((s, i) => (
              <Bar
                key={s}
                dataKey={s}
                stackId="act"
                fill={actColor(s, i)}
                stroke="var(--surface-1)"
                strokeWidth={2}
                maxBarSize={24}
                radius={i === actKeys.length - 1 ? [4, 4, 0, 0] : undefined}
               isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard
        title="Timings by span type"
        sub={
          summary.bySpanType.length > SPAN_TYPE_ROWS
            ? `busiest ${SPAN_TYPE_ROWS} of ${summary.bySpanType.length} span types`
            : "the same cut the app's Quality tab shows"
        }
        table={{
          columns: ["Span type", "Count", "p50", "p95", "Failed"],
          rows: summary.bySpanType.map((t) => [t.schema, t.count, fmtMs(t.p50Ms), fmtMs(t.p95Ms), t.failed]),
          numeric: [1, 2, 3, 4],
        }}
      >
        <div className="table-scroll">
          <table className="viz">
            <thead>
              <tr>
                <th>Span type</th>
                <th className="num">Count</th>
                <th className="num">p50</th>
                <th className="num">p95</th>
                <th className="num">Failed</th>
              </tr>
            </thead>
            <tbody>
              {summary.bySpanType.slice(0, SPAN_TYPE_ROWS).map((t) => (
                <tr key={t.schema}>
                  <td className="strong">{t.schema}</td>
                  <td className="num">{compact(t.count)}</td>
                  <td className="num">{fmtMs(t.p50Ms)}</td>
                  <td className="num">{fmtMs(t.p95Ms)}</td>
                  <td className="num">{t.failed || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ChartCard>

      <ChartCard
        title="Rendered quality summaries"
        sub={`server-rendered from each agent's declared quality_schema template${detailCapped ? " · newest runs checked first, older ones still filling in" : ""}`}
      >
        {summary.summaries.length === 0 ? (
          <div className="empty">
            <h4>No rendered summaries</h4>
            <p>
              A summary appears when an agent declares a <code>quality_schema</code> with a <code>template</code> at register time and a{" "}
              <code>quality_payload</code> is recorded for the run. Instances registered before the template was added never render one.
            </p>
          </div>
        ) : (
          summary.summaries.map((s) => (
            <div className="summary-block" key={s.instanceId}>
              <div className="meta">
                {agentName(s.agentId)} · run {shortId(s.instanceId)} · {fmtWhen(s.startedAt)}
              </div>
              {s.summary}
            </div>
          ))
        )}
      </ChartCard>
    </div>
  );
}
