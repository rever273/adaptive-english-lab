import { useEffect, useRef, useState } from "react";

/**
 * Several lines over the same x slots on ONE value axis (never two scales): a legend, a short label at the end of each line, an optional
 * dashed reference level, and a crosshair tooltip that lists every series at the hovered slot. Missing values are gaps, never zeros.
 * Colours come from the caller in a fixed categorical order (validated for the dark surface), so a word keeps its colour while shown.
 */
export interface LineSeries {
  key: string;
  name: string;
  color: string;
  values: Array<number | null>;
  dashed?: boolean;
}

const H = 240;
const PAD_T = 14;
const PAD_B = 26;
const PAD_L = 44;

function ticksFor(max: number): number[] {
  const raw = Math.max(max, 1) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const top = Math.ceil(max / step - 1e-9) * step || step;
  const out: number[] = [];
  for (let v = 0; v <= top + step / 1000; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

export function LineChart({ labels, tips, series, max, format = (v) => `${Math.round(v)}`, reference, ariaLabel, note }: {
  labels: string[];
  /** heading of the tooltip per slot */
  tips: string[];
  series: LineSeries[];
  max?: number;
  format?: (v: number) => string;
  reference?: { value: number; label: string };
  ariaLabel: string;
  note?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setW(Math.max(300, Math.round(el.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const n = labels.length;
  if (n === 0 || series.length === 0) return null;
  const longest = Math.max(...series.map((s) => s.name.length));
  const padR = Math.min(130, 16 + longest * 7);
  const plotW = W - PAD_L - padR;
  const plotH = H - PAD_T - PAD_B;
  const present = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const ticks = ticksFor(max ?? Math.max(1, ...present, reference?.value ?? 0));
  const top = ticks[ticks.length - 1]!;
  const x = (i: number) => PAD_L + (n === 1 ? plotW / 2 : (plotW * i) / (n - 1));
  const y = (v: number) => PAD_T + plotH - (v / top) * plotH;
  const every = Math.max(1, Math.ceil(n / Math.max(3, Math.floor(plotW / 70))));

  const runs = (s: LineSeries) => {
    const out: Array<Array<[number, number]>> = [];
    let cur: Array<[number, number]> = [];
    s.values.forEach((v, i) => {
      if (v === null) {
        if (cur.length) out.push(cur);
        cur = [];
      } else cur.push([x(i), y(v)]);
    });
    if (cur.length) out.push(cur);
    return out;
  };
  // end labels: at the last value of each line, nudged apart so they never overlap
  const ends = series
    .map((s) => {
      const i = s.values.map((v, j) => (v === null ? -1 : j)).filter((j) => j >= 0).pop();
      return i === undefined ? null : { s, yy: y(s.values[i]!) };
    })
    .filter((e): e is { s: LineSeries; yy: number } => e !== null)
    .sort((a, b) => a.yy - b.yy);
  for (let i = 1; i < ends.length; i++) if (ends[i]!.yy - ends[i - 1]!.yy < 13) ends[i]!.yy = ends[i - 1]!.yy + 13;

  const pick = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const px = ((clientX - r.left) / r.width) * W;
    setHover(Math.max(0, Math.min(n - 1, Math.round(n === 1 ? 0 : ((px - PAD_L) / plotW) * (n - 1)))));
  };
  const tipLeft = hover === null ? 0 : Math.min(80, Math.max(15, (x(hover) / W) * 100));

  return (
    <figure className="chart-wrap lc">
      <div className="lc-legend" aria-hidden="true">
        {series.map((s) => (
          <span key={s.key}><i className={s.dashed ? "lc-key lc-key-dash" : "lc-key"} style={{ borderColor: s.color, background: s.dashed ? "transparent" : s.color }} />{s.name}</span>
        ))}
      </div>
      <div className="chart2" ref={box} onMouseMove={(e) => pick(e.clientX)} onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} className="chart2-svg" tabIndex={0} onKeyDown={(e) => {
          if (e.key === "ArrowRight") setHover((h) => Math.min(n - 1, (h ?? -1) + 1));
          if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? n) - 1));
        }} onBlur={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="chart2-grid" x1={PAD_L} x2={W - padR} y1={y(t)} y2={y(t)} />
              <text className="chart2-label" x={PAD_L - 6} y={y(t) + 3} textAnchor="end">{format(t)}</text>
            </g>
          ))}
          {labels.map((l, i) => (i % every === 0 || i === n - 1) && <text key={i} className="chart2-label" x={x(i)} y={H - 8} textAnchor="middle">{l}</text>)}
          {reference && (
            <g>
              <line x1={PAD_L} x2={W - padR} y1={y(reference.value)} y2={y(reference.value)} className="lc-ref" />
              <text className="chart2-label" x={PAD_L + 4} y={y(reference.value) - 4}>{reference.label}</text>
            </g>
          )}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={PAD_T + plotH} className="lc-cross" />}
          {series.map((s) => (
            <g key={s.key}>
              {runs(s).map((run, j) =>
                run.length === 1 ? (
                  <circle key={j} cx={run[0]![0]} cy={run[0]![1]} r={3} fill={s.color} />
                ) : (
                  <path key={j} d={run.map(([px, py], k) => `${k ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ")} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.dashed ? "6 4" : undefined} strokeLinejoin="round" strokeLinecap="round" />
                ),
              )}
              {hover !== null && s.values[hover] !== null && <circle cx={x(hover)} cy={y(s.values[hover]!)} r={4.5} fill={s.color} stroke="var(--surface)" strokeWidth={2} />}
            </g>
          ))}
          {ends.map(({ s, yy }) => (
            <text key={s.key} className="chart2-label lc-end" x={W - padR + 6} y={yy + 4}>{s.name}</text>
          ))}
        </svg>
        {hover !== null && (
          <div className="chart2-tip" style={{ left: `${tipLeft}%` }} role="status">
            <strong>{tips[hover]}</strong>
            {series.map((s) => (
              <span key={s.key}><i className="lc-key" style={{ background: s.color, borderColor: s.color }} /> {s.name}: {s.values[hover] === null ? "—" : format(s.values[hover]!)}</span>
            ))}
          </div>
        )}
      </div>
      {note && <figcaption className="muted small">{note}</figcaption>}
    </figure>
  );
}
