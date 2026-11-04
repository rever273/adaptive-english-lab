import { useId, useState } from "react";

/**
 * The one chart used across the app (Typing, Vocabulary and Analytics pages): optional bars and/or a line over the same x slots,
 * a labelled value axis, light gridlines and a hover/focus tooltip. Missing values are gaps, never zeros.
 */

export interface ChartPoint {
  key: string;
  /** short x-axis label */
  label: string;
  /** tooltip lines; the first one is the heading */
  tip: string[];
  bar?: number | null;
  line?: number | null;
  /** drawn faded (few answers, failed attempt …) */
  muted?: boolean;
  /** optional interval around the line value (drawn as a whisker) */
  band?: { low: number; high: number } | null;
}

export interface ChartSeries {
  color: string;
  format: (v: number) => string;
  /** fixed upper bound of the axis (e.g. 1 for rates); otherwise a "nice" value above the data */
  max?: number;
}

const W = 640;
const H = 210;
const PAD_T = 14;
const PAD_B = 26;

function niceTicks(max: number, count = 4): { top: number; ticks: number[] } {
  const raw = Math.max(max, 1e-9) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const top = Math.ceil(max / step - 1e-9) * step || step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 1000; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { top, ticks };
}

function axisOf(values: Array<number | null | undefined>, s: ChartSeries): { top: number; ticks: number[] } {
  const present = values.filter((v): v is number => typeof v === "number");
  if (s.max !== undefined) return niceTicks(s.max, s.max <= 1 ? 4 : 4);
  return niceTicks(Math.max(1, ...present));
}

export function Chart({ points, bars, line, ariaLabel, legend, secondary }: { points: ChartPoint[]; bars?: ChartSeries; line?: ChartSeries; ariaLabel: string; legend?: string; secondary?: { factor: number; color: string; format: (v: number) => string } }) {
  const id = useId().replace(/:/g, "");
  const [hover, setHover] = useState<number | null>(null);
  const n = points.length;
  if (n === 0) return null;

  const both = Boolean(bars && line);
  const padL = 46;
  const padR = both || secondary ? 50 : 14;
  const plotW = W - padL - padR;
  const plotH = H - PAD_T - PAD_B;
  const slot = plotW / n;
  const x = (i: number) => padL + slot * (i + 0.5);

  const barAxis = bars ? axisOf(points.map((p) => p.bar), bars) : null;
  const lineAxis = line ? axisOf(points.map((p) => p.line), line) : null;
  const leftAxis = (barAxis ?? lineAxis)!;
  const leftSeries = (bars ?? line)!;
  const yOf = (v: number, axis: { top: number }) => PAD_T + plotH - (v / axis.top) * plotH;
  const bw = Math.max(3, Math.min(34, slot - 4));

  // the line is split into runs so gaps stay gaps
  const runs: Array<Array<{ x: number; y: number }>> = [];
  if (line && lineAxis) {
    let cur: Array<{ x: number; y: number }> = [];
    points.forEach((p, i) => {
      if (typeof p.line !== "number") {
        if (cur.length) runs.push(cur);
        cur = [];
      } else cur.push({ x: x(i), y: yOf(p.line, lineAxis) });
    });
    if (cur.length) runs.push(cur);
  }
  const path = (run: Array<{ x: number; y: number }>) => run.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const base = PAD_T + plotH;

  const every = Math.max(1, Math.ceil(n / 8));
  const hovered = hover !== null ? points[hover] : null;
  const tipLeft = hover !== null ? Math.min(82, Math.max(18, (x(hover) / W) * 100)) : 0;

  return (
    <figure className="chart-wrap">
      <div className="chart2" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} className="chart2-svg">
          <defs>
            {bars && (
              <linearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={bars.color} stopOpacity="0.95" />
                <stop offset="100%" stopColor={bars.color} stopOpacity="0.45" />
              </linearGradient>
            )}
            {line && (
              <linearGradient id={`${id}a`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={line.color} stopOpacity="0.32" />
                <stop offset="100%" stopColor={line.color} stopOpacity="0" />
              </linearGradient>
            )}
          </defs>
          {leftAxis.ticks.map((t) => (
            <g key={t}>
              <line className="chart2-grid" x1={padL} x2={W - padR} y1={yOf(t, leftAxis)} y2={yOf(t, leftAxis)} />
              <text className="chart2-label" x={padL - 6} y={yOf(t, leftAxis) + 3} textAnchor="end">{leftSeries.format(t)}</text>
            </g>
          ))}
          {both && lineAxis && line && lineAxis.ticks.map((t) => (
            <text key={t} className="chart2-label" x={W - padR + 6} y={yOf(t, lineAxis) + 3} fill={line.color}>{line.format(t)}</text>
          ))}
          {secondary && leftAxis.ticks.map((t) => (
            <text key={`s${t}`} className="chart2-label" x={W - padR + 6} y={yOf(t, leftAxis) + 3} fill={secondary.color}>{secondary.format(t * secondary.factor)}</text>
          ))}
          {points.map((p, i) => (i % every === 0 || i === n - 1) && (
            <text key={p.key} className="chart2-label" x={x(i)} y={H - 8} textAnchor="middle">{p.label}</text>
          ))}
          {hover !== null && <rect className="chart2-hover" x={padL + slot * hover} y={PAD_T} width={slot} height={plotH} rx={4} />}
          {bars && barAxis && points.map((p, i) => typeof p.bar === "number" && (
            <rect key={p.key} x={x(i) - bw / 2} y={yOf(p.bar, barAxis)} width={bw} height={Math.max(1.5, base - yOf(p.bar, barAxis))} rx={Math.min(4, bw / 2)} fill={`url(#${id}b)`} opacity={p.muted ? 0.4 : hover === i ? 1 : 0.88} />
          ))}
          {line && lineAxis && runs.map((run, i) => (
            <g key={i}>
              {run.length > 1 && !bars && <path d={`${path(run)} L${run[run.length - 1]!.x},${base} L${run[0]!.x},${base} Z`} fill={`url(#${id}a)`} />}
              {run.length > 1 && <path d={path(run)} fill="none" stroke={line.color} strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />}
            </g>
          ))}
          {line && lineAxis && points.map((p, i) => {
            if (typeof p.line !== "number") return null;
            const cy = yOf(p.line, lineAxis);
            return (
              <g key={p.key}>
                {p.band && <line x1={x(i)} x2={x(i)} y1={yOf(p.band.low, lineAxis)} y2={yOf(p.band.high, lineAxis)} stroke={line.color} strokeWidth={2} opacity={0.4} />}
                <circle cx={x(i)} cy={cy} r={hover === i ? 5.5 : n > 40 ? 2 : 3.2} fill={p.muted ? "var(--surface)" : line.color} stroke={line.color} strokeWidth={p.muted ? 1.8 : 0} opacity={p.muted && hover !== i ? 0.7 : 1} />
              </g>
            );
          })}
          {points.map((p, i) => (
            <rect key={p.key} className="chart2-hit" x={padL + slot * i} y={PAD_T} width={slot} height={plotH} tabIndex={0} aria-label={p.tip.join(", ")} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} />
          ))}
        </svg>
        {hovered && (
          <div className="chart2-tip" style={{ left: `${tipLeft}%` }} role="status">
            <strong>{hovered.tip[0]}</strong>
            {hovered.tip.slice(1).map((l, i) => <span key={i}>{l}</span>)}
          </div>
        )}
      </div>
      {legend && <figcaption className="muted small">{legend}</figcaption>}
    </figure>
  );
}
