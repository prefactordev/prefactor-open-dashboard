// Shared chart chrome: stat tiles, the card wrapper (every chart ships a table
// twin — tooltips enhance, they never gate), legend, and the tooltip readout.

import { Fragment, useState, type ReactNode } from "react";

// --- stat tile --------------------------------------------------------------

export function StatCard(props: { label: string; value: string; detail?: ReactNode }) {
  return (
    <div className="card stat">
      <div className="label">{props.label}</div>
      <div className="value">{props.value}</div>
      {props.detail ? <div className="detail">{props.detail}</div> : null}
    </div>
  );
}

// --- card with chart/table toggle ------------------------------------------

export interface TableSpec {
  columns: string[];
  rows: Array<Array<string | number>>;
  /** Column indexes to right-align (numbers). */
  numeric?: number[];
}

export function ChartCard(props: { title: string; sub?: string; table?: TableSpec; children: ReactNode; legend?: ReactNode }) {
  const [view, setView] = useState<"chart" | "table">("chart");
  return (
    <div className="card">
      <div className="card-head">
        <h3>{props.title}</h3>
        {props.sub ? <span className="sub">{props.sub}</span> : null}
        {props.table ? (
          <span className="toggle" role="group" aria-label="View as">
            <button aria-pressed={view === "chart"} onClick={() => setView("chart")}>
              Chart
            </button>
            <button aria-pressed={view === "table"} onClick={() => setView("table")}>
              Table
            </button>
          </span>
        ) : null}
      </div>
      {view === "table" && props.table ? (
        <DataTable spec={props.table} />
      ) : (
        <>
          {props.children}
          {props.legend}
        </>
      )}
    </div>
  );
}

export function DataTable({ spec }: { spec: TableSpec }) {
  const numeric = new Set(spec.numeric ?? []);
  return (
    <div className="table-scroll">
      <table className="viz">
        <thead>
          <tr>
            {spec.columns.map((c, i) => (
              <th key={c} className={numeric.has(i) ? "num" : undefined}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spec.rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td key={ci} className={numeric.has(ci) ? "num" : undefined}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- legend -----------------------------------------------------------------

export interface LegendItem {
  label: string;
  color: string;
  /** "rect" mirrors bars/areas; "line" mirrors lines. */
  mark?: "rect" | "line";
  icon?: string;
}

export function VizLegend({ items }: { items: LegendItem[] }) {
  if (items.length < 2) return null; // one series: the title names it
  return (
    <div className="legend">
      {items.map((it) => (
        <span className="key" key={it.label}>
          <span className={it.mark === "line" ? "line-key" : "swatch"} style={{ background: it.color }} />
          {it.icon ? `${it.icon} ` : ""}
          {it.label}
        </span>
      ))}
    </div>
  );
}

// --- tooltip (Recharts custom content) --------------------------------------

interface RcTooltipPayload {
  dataKey?: string | number;
  name?: string | number;
  value?: number | string;
  color?: string;
}

export function VizTooltip(props: {
  active?: boolean;
  label?: string | number;
  payload?: RcTooltipPayload[];
  format?: (v: number) => string;
  labelFormat?: (l: string) => string;
}) {
  if (!props.active || !props.payload?.length) return null;
  const fmt = props.format ?? ((v: number) => String(v));
  const rows = props.payload.filter((p) => typeof p.value === "number");
  return (
    <div className="viz-tooltip">
      {props.label != null ? <div className="when">{props.labelFormat ? props.labelFormat(String(props.label)) : String(props.label)}</div> : null}
      {rows.map((p) => (
        <div className="row" key={String(p.dataKey ?? p.name)}>
          <span className="k" style={{ background: p.color }} />
          <span>{String(p.name ?? p.dataKey)}</span>
          <span className="v">{fmt(p.value as number)}</span>
        </div>
      ))}
    </div>
  );
}

// --- horizontal bar list -----------------------------------------------------

export function BarList(props: { rows: Array<{ name: string; value: number; display: string }>; color: string }) {
  const max = Math.max(...props.rows.map((r) => r.value), 1);
  return (
    <div className="barlist">
      {props.rows.map((r) => (
        <div className="row" key={r.name} title={r.name}>
          <span className="name">{r.name}</span>
          <span className="track">
            <span className="fill" style={{ width: `${Math.max(1.5, (r.value / max) * 100)}%`, background: props.color }} />
          </span>
          <span className="val">{r.display}</span>
        </div>
      ))}
    </div>
  );
}

// --- hour-of-week heatmap -----------------------------------------------------
// Sequential encoding: one hue, light→dark (the palette's documented blue
// ramp); zero cells stay on the surface. Values are also reachable via the
// card's table view, so color never carries the number alone.

// One-hue sequential ramp (brand teal), light→dark, lightness-monotonic.
const HEAT_RAMP = ["#c6f0e5", "#93e2cd", "#57cfae", "#14b491", "#0b8a70", "#075c4b"];
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function HourHeatmap({ cells, max }: { cells: number[][]; max: number }) {
  return (
    <div className="table-scroll">
      <div className="heatmap" role="img" aria-label="Activity by UTC hour of week">
        <div className="hm-corner" />
        {Array.from({ length: 24 }, (_, h) => (
          <div key={h} className="hm-hour">
            {h % 3 === 0 ? h : ""}
          </div>
        ))}
        {cells.map((row, d) => (
          <Fragment key={d}>
            <div className="hm-dow">{DOW[d]}</div>
            {row.map((v, h) => {
              const step = v === 0 || max === 0 ? -1 : Math.min(HEAT_RAMP.length - 1, Math.floor((v / max) * HEAT_RAMP.length));
              return (
                <div
                  key={h}
                  className="hm-cell"
                  style={{ background: step < 0 ? "var(--page)" : HEAT_RAMP[step] }}
                  title={`${DOW[d]} ${String(h).padStart(2, "0")}:00 UTC — ${v.toLocaleString("en-US")} spans`}
                />
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

export function heatmapTable(cells: number[][]): TableSpec {
  return {
    columns: ["Day", ...Array.from({ length: 24 }, (_, h) => String(h))],
    rows: cells.map((row, d) => [DOW[d], ...row]),
    numeric: Array.from({ length: 24 }, (_, i) => i + 1),
  };
}

// --- empty state --------------------------------------------------------------

export function EmptyState(props: { title: string; children: ReactNode }) {
  return (
    <div className="card">
      <div className="empty">
        <h4>{props.title}</h4>
        {props.children}
      </div>
    </div>
  );
}

// Recharts axis/grid defaults, spread onto elements for a recessive hairline look.
export const AXIS_TICK = { fill: "var(--muted)", fontSize: 11 } as const;
export const AXIS_LINE = { stroke: "var(--baseline)" } as const;
export const GRID_STROKE = "var(--gridline)";
