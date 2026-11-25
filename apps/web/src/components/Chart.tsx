import { useEffect, useId, useRef, useState } from "react";

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
  bar2?: number | null;
  line?: number | null;
  /** a second, dashed reference line on the same axis as the line (a target, a limit) */
  line2?: number | null;
  /** a third, thin solid line on the line axis (a running average) */
  line3?: number | null;
  /** drawn faded (few answers, failed attempt …) */
  muted?: boolean;
  highlight?: boolean;
  /** optional interval around the line value (drawn as a whisker) */
  band?: { low: number; high: number } | null;
}

export interface ChartSeries {
  color: string;
  format: (v: number) => string;
  /** fixed upper bound of the axis (e.g. 1 for rates); otherwise a "nice" value above the data */
  max?: number;
  /**
   * line only: the axis starts at a "nice" value just below the lowest value instead of at 0 (accuracy never reaches 0, so a scale
   * from 0 would squash the whole line against the top)
   */
  floating?: boolean;
}

/** the chart is drawn at the width it is shown at, so the text is the same size in every chart whatever its width */
const DEFAULT_W = 640;
const DEFAULT_H = 230;
const PAD_T = 14;
const PAD_B = 26;

interface Axis {
  top: number;
  min: number;
  ticks: number[];
}

function niceTicks(max: number, count = 4): Axis {
  const raw = Math.max(max, 1e-9) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const top = Math.ceil(max / step - 1e-9) * step || step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 1000; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { top, min: 0, ticks };
}

/** an axis from a nice value below the lowest value to a nice value above the highest one */
export function floatingTicks(lo: number, hi: number, count = 4): Axis {
  const span = Math.max(hi - lo, 1);
  const step = niceTicks(span, count).ticks[1] ?? 1;
  // a little room under the lowest value, but never below 0 for values that are not negative
  const min = Math.max(lo >= 0 ? 0 : -Infinity, Math.floor((lo - span * 0.05) / step + 1e-9) * step);
  const top = Math.max(Math.ceil(hi / step - 1e-9) * step, min + step);
  const ticks: number[] = [];
  for (let v = min; v <= top + step / 1000; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { top, min, ticks };
}

function axisOf(values: Array<number | null | undefined>, s: ChartSeries): Axis {
  const present = values.filter((v): v is number => typeof v === "number");
  if (s.floating && present.length > 0) {
    const hi = s.max !== undefined ? Math.max(s.max, ...present) : Math.max(...present);
    return floatingTicks(Math.min(...present), hi);
  }
  if (s.max !== undefined) return niceTicks(s.max, s.max <= 1 ? 4 : 4);
  return niceTicks(Math.max(1, ...present));
}

export function Chart({ points, bars, bars2, line, line2, ariaLabel, legend, secondary, connectGaps, height = DEFAULT_H, line3 }: { line3?: Pick<ChartSeries, "color">; height?: number; connectGaps?: boolean; points: ChartPoint[]; bars?: ChartSeries; bars2?: ChartSeries; line?: ChartSeries; line2?: ChartSeries; ariaLabel: string; legend?: string; secondary?: { factor: number; color: string; format: (v: number) => string } }) {
  const id = useId().replace(/:/g, "");
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(DEFAULT_W);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setW((prev) => { const w = Math.max(300, Math.round(el.clientWidth)); return Math.abs(prev - w) < 2 ? prev : w; });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = height;
  const n = points.length;
  if (n === 0) return null;

  const both = Boolean(bars && line);
  const padL = 52;
  const padR = both || secondary ? 56 : 14;
  const plotW = W - padL - padR;
  const plotH = H - PAD_T - PAD_B;
  const slot = plotW / n;
  const x = (i: number) => padL + slot * (i + 0.5);

  const barAxis = bars ? axisOf(points.flatMap((p) => [p.bar, ...(bars2 ? [p.bar2] : []), ...(!line && line2 ? [p.line2] : [])]), bars) : null;
  const lineAxis = line ? axisOf(points.flatMap((p) => [p.line, ...(line2 ? [p.line2] : []), ...(line3 ? [p.line3] : [])]), line) : null;
  const leftAxis = (barAxis ?? lineAxis)!;
  const leftSeries = (bars ?? line)!;
  const yOf = (v: number, axis: Axis) => PAD_T + plotH - ((v - axis.min) / (axis.top - axis.min)) * plotH;
  const bw = Math.max(0.4, Math.min(34, slot * 0.8));

  // the line is split into runs so gaps stay gaps
  const runs: Array<Array<{ x: number; y: number }>> = [];
  if (line && lineAxis) {
    let cur: Array<{ x: number; y: number }> = [];
    points.forEach((p, i) => {
      if (typeof p.line !== "number") {
        if (cur.length && !connectGaps) runs.push(cur);
        if (!connectGaps) cur = [];
      } else cur.push({ x: x(i), y: yOf(p.line, lineAxis) });
    });
    if (cur.length) runs.push(cur);
  }
  // the reference line is drawn as steps: a target or a limit holds until it changes
  const ref: Array<{ x: number; y: number }> = [];
  const refAxis = lineAxis ?? barAxis;
  if (line2 && refAxis) {
    points.forEach((p, i) => { if (typeof p.line2 === "number") ref.push({ x: x(i), y: yOf(p.line2, refAxis) }); });
    // the reference holds from edge to edge of the plot
    if (ref.length > 0) {
      ref.unshift({ x: padL, y: ref[0]!.y });
      ref.push({ x: W - padR, y: ref[ref.length - 1]!.y });
    }
  }
  const avg: Array<{ x: number; y: number }> = [];
  if (line3 && lineAxis) points.forEach((p, i) => { if (typeof p.line3 === "number") avg.push({ x: x(i), y: yOf(p.line3, lineAxis) }); });
  const path = (run: Array<{ x: number; y: number }>) => run.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const base = PAD_T + plotH;

  const every = Math.max(1, Math.ceil(n / Math.max(3, Math.floor(W / 72))));
  const hovered = hover !== null ? points[hover] : null;
  const tipLeft = hover !== null ? Math.min(82, Math.max(18, (x(hover) / W) * 100)) : 0;

  return (
    <figure className="chart-wrap">
      <div className="chart2" ref={box} onMouseLeave={() => setHover(null)}>
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
            <rect key={p.key} x={x(i) - bw / 2} y={yOf(p.bar, barAxis)} width={bars2 ? bw / 2 : bw} height={Math.max(1.5, base - yOf(p.bar, barAxis))} rx={Math.min(4, bw / 2)} fill={`url(#${id}b)`} opacity={p.muted ? 0.4 : hover === i ? 1 : 0.88} />
          ))}
          {bars2 && barAxis && points.map((p, i) => typeof p.bar2 === "number" && (
            <rect key={`b2-${p.key}`} x={x(i)} y={yOf(p.bar2, barAxis)} width={bw / 2} height={Math.max(1.5, base - yOf(p.bar2, barAxis))} rx={Math.min(3, bw / 4)} fill={bars2.color} opacity={p.muted ? 0.4 : 0.88} />
          ))}
          {line2 && ref.length > 1 && <path d={ref.map((q, i) => (i === 0 ? `M${q.x.toFixed(1)},${q.y.toFixed(1)}` : `L${q.x.toFixed(1)},${ref[i - 1]!.y.toFixed(1)} L${q.x.toFixed(1)},${q.y.toFixed(1)}`)).join(" ")} fill="none" stroke={line2.color} strokeWidth={1.8} strokeDasharray="6 4" strokeLinejoin="round" opacity={0.9} />}
          {line && lineAxis && runs.map((run, i) => (
            <g key={i}>
              {run.length > 1 && !bars && <path d={`${path(run)} L${run[run.length - 1]!.x},${base} L${run[0]!.x},${base} Z`} fill={`url(#${id}a)`} />}
              {run.length > 1 && <path d={path(run)} fill="none" stroke={line.color} strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />}
            </g>
          ))}
          {line3 && avg.length > 1 && <path d={path(avg)} fill="none" stroke={line3.color} strokeWidth={2.6} strokeLinejoin="round" strokeLinecap="round" />}
          {line && lineAxis && points.map((p, i) => {
            if (typeof p.line !== "number") return null;
            const cy = yOf(p.line, lineAxis);
            return (
              <g key={p.key}>
                {p.band && <line x1={x(i)} x2={x(i)} y1={yOf(p.band.low, lineAxis)} y2={yOf(p.band.high, lineAxis)} stroke={line.color} strokeWidth={2} opacity={0.4} />}
                <circle cx={x(i)} cy={cy} r={p.highlight ? (hover === i ? 7 : 6) : hover === i ? 5.5 : n > 40 ? 2 : 3.2} fill={p.highlight ? "#ffbd59" : p.muted ? "var(--surface)" : line.color} stroke={p.highlight ? "var(--surface)" : line.color} strokeWidth={p.highlight ? 2 : p.muted ? 1.8 : 0} opacity={p.muted && hover !== i ? 0.7 : 1} />
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
