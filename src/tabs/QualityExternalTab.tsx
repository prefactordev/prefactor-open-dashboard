// Quality (externally-created) — the contents of quality_payload, which is
// always written by YOUR code (agent instrumentation or an eval tool PUTting
// scores onto finished runs). Fields are discovered generically: numeric
// fields chart as daily averages, booleans as daily pass rates.

import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useDashboard } from "../state";
import { summarizeExternalQuality, type PayloadField } from "../lib/quality";
import { AXIS_LINE, AXIS_TICK, ChartCard, EmptyState, GRID_STROKE, StatCard, VizTooltip } from "../components/viz";
import { seriesColor } from "../palette";
import { useIsDark } from "../useTheme";
import { fmtWhen, pct, shortDay, shortId } from "../lib/util";

export default function QualityExternalTab() {
  const { details, detailCapped, windowStart, windowEnd, agentName } = useDashboard();
  const dark = useIsDark();
  const [selected, setSelected] = useState<string | null>(null);

  const summary = useMemo(() => summarizeExternalQuality(details, windowStart, windowEnd), [details, windowStart, windowEnd]);

  const chartable = summary.fields.filter((f) => f.kind !== "string");
  const field: PayloadField | undefined = chartable.find((f) => f.path === selected) ?? chartable[0];

  if (summary.withPayload === 0) {
    return (
      <EmptyState title="No quality payloads found">
        <p>
          This tab shows scores your own tooling attaches to runs. Push one onto any finished instance with{" "}
          <code>{'PUT /api/v1/agent_instance/{id} {"details":{"quality_payload":{…}}}'}</code> — no schema declaration required.
        </p>
        <p>
          The PUT <em>replaces</em> the whole payload, so merge under your own namespaced key (read the current payload first) to avoid clobbering
          scores other tools wrote.
        </p>
        {detailCapped && <p>Quality details are read newest-first in the background; older runs fill in as the sync catches up.</p>}
      </EmptyState>
    );
  }

  const fieldValue = (f: PayloadField): string =>
    f.kind === "number" ? (f.avg == null ? "—" : f.avg.toFixed(Math.abs(f.avg) >= 100 ? 0 : 2)) : f.kind === "boolean" ? pct(f.passRate) : "—";

  const trendData = field?.byDay.map((d) => ({ day: d.day, value: d.value == null ? null : field.kind === "boolean" ? d.value * 100 : d.value }));
  const fmtVal = (v: number) => (field?.kind === "boolean" ? `${v.toFixed(0)}%` : v.toFixed(Math.abs(v) >= 100 ? 0 : 2));

  // Columns for the recent-runs table: the most common fields, capped so it stays readable.
  const columns = summary.fields.slice(0, 5).map((f) => f.path);

  return (
    <div>
      {detailCapped && (
        <div className="notice">
          <span>
            Quality details are read newest-first in the background — {summary.finished} of the window's runs checked so far; older runs fill in as
            the sync catches up.
          </span>
        </div>
      )}

      <div className="tiles">
        <StatCard label="Runs with quality scores" value={String(summary.withPayload)} detail={`of ${summary.finished} finished runs checked`} />
        <StatCard label="Score coverage" value={pct(summary.coverage)} />
        <StatCard label="Distinct fields" value={String(summary.fields.length)} />
      </div>

      <div className="grid-21">
        <ChartCard
          title={field ? `${field.path} over time` : "Trend"}
          sub={field ? (field.kind === "boolean" ? "daily pass rate" : "daily average") : undefined}
          table={
            field && {
              columns: ["Day", field.kind === "boolean" ? "Pass rate" : "Average", "Runs"],
              rows: field.byDay.map((d) => [
                shortDay(d.day),
                d.value == null ? "—" : field.kind === "boolean" ? pct(d.value) : d.value.toFixed(2),
                d.n,
              ]),
              numeric: [1, 2],
            }
          }
        >
          {field ? (
            <>
              {chartable.length > 1 && (
                <div className="seg" style={{ marginBottom: 10 }}>
                  {chartable.slice(0, 4).map((f) => (
                    <button key={f.path} aria-pressed={f.path === field.path} onClick={() => setSelected(f.path)}>
                      {f.path}
                    </button>
                  ))}
                </div>
              )}
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={trendData} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke={GRID_STROKE} />
                  <XAxis dataKey="day" tickFormatter={shortDay} tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={false} />
                  <YAxis
                    tick={AXIS_TICK}
                    axisLine={false}
                    tickLine={false}
                    width={44}
                    domain={field.kind === "boolean" ? [0, 100] : ["auto", "auto"]}
                    tickFormatter={(v: number) => (field.kind === "boolean" ? `${v}%` : String(v))}
                  />
                  <Tooltip cursor={{ stroke: "var(--baseline)" }} content={<VizTooltip format={fmtVal} labelFormat={shortDay} />} />
                  <Line
                    type="monotone"
                    dataKey="value"
                    name={field.path}
                    stroke={seriesColor(0, dark)}
                    strokeWidth={2}
                    connectNulls
                    dot={{ r: 4, fill: seriesColor(0, dark), stroke: "var(--surface-1)", strokeWidth: 2 }}
                    activeDot={{ r: 5 }}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </>
          ) : (
            <div className="empty">
              <h4>No numeric or boolean fields to chart</h4>
              <p>String fields are listed in the field table.</p>
            </div>
          )}
        </ChartCard>

        <ChartCard title="Discovered fields" sub="across all payloads in scope">
          <div className="table-scroll">
            <table className="viz">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Type</th>
                  <th className="num">Runs</th>
                  <th className="num">Avg / pass</th>
                </tr>
              </thead>
              <tbody>
                {summary.fields.map((f) => (
                  <tr key={f.path}>
                    <td className="strong">{f.path}</td>
                    <td>{f.kind}</td>
                    <td className="num">{f.count}</td>
                    <td className="num">{fieldValue(f)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ChartCard>
      </div>

      <ChartCard
        title="Recent scored runs"
        sub={columns.length < summary.fields.length ? `showing ${columns.length} of ${summary.fields.length} fields` : undefined}
      >
        <div className="table-scroll">
          <table className="viz">
            <thead>
              <tr>
                <th>Run</th>
                <th>Agent</th>
                <th>Started</th>
                {columns.map((c) => (
                  <th key={c} className="num">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {summary.recent.map((r) => (
                <tr key={r.instanceId}>
                  <td>{shortId(r.instanceId)}</td>
                  <td>{agentName(r.agentId)}</td>
                  <td>{fmtWhen(r.startedAt)}</td>
                  {columns.map((c) => (
                    <td key={c} className="num">
                      {r.values[c] ?? "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ChartCard>
    </div>
  );
}
