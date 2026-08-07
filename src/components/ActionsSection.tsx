// Shared "Actions taken" visuals — used by both the Risk and Quality tabs.
// Action kinds are identity (who/what intervened), so they wear categorical
// slots in fixed order; the same kind keeps the same color on both tabs.

import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useDashboard } from "../state";
import { ACTION_KINDS, summarizeActions, type ActionKind, type ActionsSummary } from "../lib/actions";
import { AXIS_LINE, AXIS_TICK, ChartCard, GRID_STROKE, StatCard, VizLegend, VizTooltip } from "./viz";
import { seriesColor } from "../palette";
import { useIsDark } from "../useTheme";
import { compact, fmtWhen, pct, shortDay, shortId } from "../lib/util";

const KIND_LABEL: Record<ActionKind, string> = {
  hitl: "HITL approvals",
  killswitch: "killswitch",
  feedback: "human feedback",
};

export function useActions(): ActionsSummary {
  const { spans, instances, windowStart, windowEnd } = useDashboard();
  return useMemo(() => summarizeActions(spans, instances, windowStart, windowEnd), [spans, instances, windowStart, windowEnd]);
}

export function ActionsTile({ actions }: { actions: ActionsSummary }) {
  return (
    <StatCard
      label="Actions taken"
      value={compact(actions.totalActions)}
      detail={actions.rate == null ? "no spans in window" : `${pct(actions.rate)} of ${compact(actions.totalSpans)} spans`}
    />
  );
}

export function ActionsChartCard({ actions }: { actions: ActionsSummary }) {
  const { agentName } = useDashboard();
  const dark = useIsDark();
  const kindColor = (k: ActionKind) => seriesColor(ACTION_KINDS.indexOf(k), dark);

  return (
    <ChartCard
      title="Actions taken over time"
      sub="oversight interventions per day — HITL approvals, killswitch, human feedback"
      table={{
        columns: ["Day", ...ACTION_KINDS.map((k) => KIND_LABEL[k])],
        rows: actions.byDay.map((r) => [shortDay(r.day), r.hitl, r.killswitch, r.feedback]),
        numeric: [1, 2, 3],
      }}
      legend={<VizLegend items={ACTION_KINDS.map((k) => ({ label: KIND_LABEL[k], color: kindColor(k) }))} />}
    >
      {actions.totalActions === 0 ? (
        <div className="empty">
          <h4>No actions in this window</h4>
          <p>
            Counted here: HITL approvals (a schema-name <em>segment</em> of <code>hitl</code> or <code>approval</code>, e.g.{" "}
            <code>hitl:human-approval</code> — tool spans never count), killswitch terminations (
            <code>POST /agent_instance/&#123;id&#125;/terminate</code>), and any span carrying a human rating at{" "}
            <code>inputs.feedback.rating</code> or <code>inputs.rating</code>, whatever its schema is called.
          </p>
        </div>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={actions.byDay} margin={{ top: 4, right: 8, left: 4, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke={GRID_STROKE} />
              <XAxis dataKey="day" tickFormatter={shortDay} tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={false} />
              <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={40} allowDecimals={false} tickFormatter={(v: number) => compact(v)} />
              <Tooltip cursor={{ fill: "var(--gridline)", opacity: 0.35 }} content={<VizTooltip format={compact} labelFormat={shortDay} />} />
              {ACTION_KINDS.map((k, i) => (
                <Bar
                  key={k}
                  dataKey={k}
                  name={KIND_LABEL[k]}
                  stackId="act"
                  fill={kindColor(k)}
                  stroke="var(--surface-1)"
                  strokeWidth={2}
                  maxBarSize={24}
                  radius={i === ACTION_KINDS.length - 1 ? [4, 4, 0, 0] : undefined}
                 isAnimationActive={false} />
              ))}
            </BarChart>
          </ResponsiveContainer>
          {actions.recentKills.length > 0 && (
            <div className="table-scroll" style={{ marginTop: 10 }}>
              <table className="viz">
                <thead>
                  <tr>
                    <th>Killed run</th>
                    <th>Agent</th>
                    <th>Reason</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {actions.recentKills.map((k) => (
                    <tr key={k.instanceId}>
                      <td>{shortId(k.instanceId)}</td>
                      <td>{agentName(k.agentId)}</td>
                      <td className="strong">{k.reason}</td>
                      <td>{fmtWhen(k.when)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </ChartCard>
  );
}
