import { useEffect, useRef, useState } from "react";

export interface LineSeries {
  key: string;
  name: string;
  color: string;
  /** one value per label, 0..1; null = no data (a gap, never a zero) */
  values: Array<number | null>;
  /** answers behind each value, shown in the tip */
  counts?: number[];
}

/** a few clearly different colours for up to 8 lines */
export const LINE_COLORS = ["#6ab7ff", "#3fbf6f", "#f3c94d", "#ef7777", "#b78bff", "#ff9f5a", "#4dd0c8", "#e48bd1"];

const H = 240, PAD_T = 14, PAD_B = 26, PAD_L = 46, PAD_R = 14;

/** Several accuracy lines (0-100 %) over the same x labels, with a legend that can hide a line. Same look as Chart. */
export function MultiLineChart({ labels, series, ariaLabel, legend }: { labels: string[]; series: LineSeries[]; ariaLabel: string; legend?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(640);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setW((prev) => { const w = Math.max(300, Math.round(el.clientWidth)); return Math.abs(prev - w) < 2 ? prev : w; });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const n = labels.length;
  if (n === 0 || series.length === 0) return null;
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B, slot = plotW / n;
  const x = (i: number) => PAD_L + slot * (i + 0.5);
  const y = (v: number) => PAD_T + plotH - v * plotH;
  const shown = series.filter((s) => !hidden.has(s.key));
  const every = Math.max(1, Math.ceil(n / Math.max(3, Math.floor(W / 72))));
  const tipLeft = hover !== null ? Math.min(82, Math.max(18, (x(hover) / W) * 100)) : 0;
  const toggle = (key: string) => setHidden((h) => { const c = new Set(h); if (c.has(key)) c.delete(key); else c.add(key); return c; });
  return (
    <figure className="chart-wrap">
      <div className="chart2" ref={box} onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} className="chart2-svg">
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <g key={t}>
              <line className="chart2-grid" x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} />
              <text className="chart2-label" x={PAD_L - 6} y={y(t) + 3} textAnchor="end">{Math.round(t * 100)}%</text>
            </g>
          ))}
          {labels.map((l, i) => (i % every === 0 || i === n - 1) && <text key={l} className="chart2-label" x={x(i)} y={H - 8} textAnchor="middle">{l.slice(5)}</text>)}
          {hover !== null && <rect className="chart2-hover" x={PAD_L + slot * hover} y={PAD_T} width={slot} height={plotH} rx={4} />}
          {shown.map((s) => {
            const runs: Array<Array<[number, number]>> = [];
            let cur: Array<[number, number]> = [];
            s.values.forEach((v, i) => { if (v === null) { if (cur.length) runs.push(cur); cur = []; } else cur.push([x(i), y(v)]); });
            if (cur.length) runs.push(cur);
            return (
              <g key={s.key}>
                {runs.map((r, i) => r.length > 1 && <path key={i} d={r.map((p, j) => `${j === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ")} fill="none" stroke={s.color} strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />)}
                {s.values.map((v, i) => v !== null && <circle key={i} cx={x(i)} cy={y(v)} r={hover === i ? 5 : n > 40 ? 2 : 3.2} fill={s.color} stroke="var(--surface)" strokeWidth={1.2} />)}
              </g>
            );
          })}
          {labels.map((l, i) => (
            <rect key={l} className="chart2-hit" x={PAD_L + slot * i} y={PAD_T} width={slot} height={plotH} tabIndex={0} aria-label={`${l}: ${shown.map((s) => `${s.name} ${s.values[i] === null ? "no answers" : `${Math.round(s.values[i]! * 100)}%`}`).join(", ")}`} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} />
          ))}
        </svg>
        {hover !== null && (
          <div className="chart2-tip" style={{ left: `${tipLeft}%` }} role="status">
            <strong>{labels[hover]}</strong>
            {shown.map((s) => <span key={s.key} style={{ color: s.color }}>{s.name}: {s.values[hover] === null ? "no answers" : `${Math.round(s.values[hover]! * 100)}% (${s.counts?.[hover] ?? "?"})`}</span>)}
          </div>
        )}
      </div>
      <ul className="ml-legend" aria-label="Lines">
        {series.map((s) => (
          <li key={s.key}>
            <button type="button" className={`ml-legend-btn${hidden.has(s.key) ? " off" : ""}`} onClick={() => toggle(s.key)} aria-pressed={!hidden.has(s.key)}>
              <span className="ml-dot" style={{ background: s.color }} /> {s.name}
            </button>
          </li>
        ))}
      </ul>
      {legend && <figcaption className="muted small">{legend}</figcaption>}
    </figure>
  );
}
