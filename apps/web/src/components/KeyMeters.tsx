import type { CSSProperties } from "react";

/**
 * The bars of the Key Builder report, in one place.
 *  - ProgressBar: a plain 0–100% bar (keys open, progress to the next key).
 *  - SpeedMeter: a speed from 0 up, with a tick at the target and one at the goal.
 *  - ErrorMeter: a share of wrong presses from 0% up (green up to the limit, red beyond it), with a tick at the limit.
 * A meter's scale is set by the caller, so the bars of one column can be compared with each other.
 */

export type SpeedUnit = "cpm" | "wpm";

const UNIT_KEY = "el_keys_unit";
export const readUnit = (): SpeedUnit => { try { return localStorage.getItem(UNIT_KEY) === "wpm" ? "wpm" : "cpm"; } catch { return "cpm"; } };
export const saveUnit = (u: SpeedUnit): void => { try { localStorage.setItem(UNIT_KEY, u); } catch { /* unavailable */ } };

/** a speed given in CPM, written in the chosen unit (WPM = CPM ÷ 5) */
export function fmtSpeed(cpm: number, unit: SpeedUnit, withUnit = true): string {
  const v = unit === "wpm" ? Math.round((cpm / 5) * 10) / 10 : Math.round(cpm);
  return withUnit ? `${v} ${unit.toUpperCase()}` : String(v);
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const pc = (v: number): string => `${(clamp01(v) * 100).toFixed(1)}%`;

/** a bar from empty to full; the colour runs from red to green with the fill */
export function ProgressBar({ value, label }: { value: number; label: string }) {
  const v = clamp01(value);
  const style = { "--w": `${Math.round(v * 100)}%`, "--hue": Math.round(clamp01((v - 0.4) / 0.6) * 120) } as CSSProperties;
  return (
    <span className="keys-bar" style={style} role="img" aria-label={`${label}: ${Math.round(v * 100)}%`}>
      <i />
    </span>
  );
}

interface Mark {
  at: number;
  kind: "target" | "goal" | "limit";
  title: string;
}

function Meter({ max, fills, marks, label }: { max: number; fills: Array<{ from: number; to: number; color: string }>; marks: Mark[]; label: string }) {
  const at = (v: number) => clamp01(v / max);
  return (
    <span className="kmeter" role="img" aria-label={label} title={label}>
      <span className="kmeter-fills">
        {fills.filter((f) => f.to > f.from).map((f, i) => (
          <i key={i} style={{ left: pc(at(f.from)), width: `${((at(f.to) - at(f.from)) * 100).toFixed(1)}%`, background: f.color }} />
        ))}
      </span>
      {marks.map((m) => <b key={m.kind} className={`kmeter-mark ${m.kind}`} style={{ left: pc(at(m.at)) }} title={m.title} />)}
    </span>
  );
}

/** `max` = the scale of the bar, at least the goal; the fill goes from red (half the target) to green (the target) */
export function SpeedMeter({ cpm, targetCpm, goalCpm, max, unit, label }: { cpm: number; targetCpm: number; goalCpm: number; max: number; unit: SpeedUnit; label: string }) {
  // red for a slow key, yellow when it is close, green only once the target is reached
  const r = cpm / targetCpm;
  const hue = r >= 1 ? 125 : Math.round(clamp01((r - 0.5) / 0.5) * 55);
  const scale = Math.max(max, goalCpm, cpm);
  return (
    <Meter
      max={scale}
      fills={[{ from: 0, to: cpm, color: `hsl(${hue} 65% 45%)` }]}
      marks={[
        { at: targetCpm, kind: "target", title: `target ${fmtSpeed(targetCpm, unit)}` },
        { at: goalCpm, kind: "goal", title: `goal ${fmtSpeed(goalCpm, unit)}` },
      ]}
      label={`${label}: ${fmtSpeed(cpm, unit)} · target ${fmtSpeed(targetCpm, unit)} · goal ${fmtSpeed(goalCpm, unit)}`}
    />
  );
}

/** `rate`, `limit` and `max` are shares (0.05 = 5%); the bar starts at 0% wrong (the aim) and the tick is the limit from Settings */
export function ErrorMeter({ rate, limit, max, label }: { rate: number; limit: number; max: number; label: string }) {
  const scale = Math.max(max, limit, rate, 1e-9);
  return (
    <Meter
      max={scale}
      fills={[
        { from: 0, to: Math.min(rate, limit), color: rate > limit ? "hsl(48 90% 50%)" : "hsl(125 60% 42%)" },
        { from: limit, to: rate, color: "hsl(2 70% 52%)" },
      ]}
      marks={[{ at: limit, kind: "limit", title: `limit ${Math.round(limit * 1000) / 10}%` }]}
      label={`${label}: ${Math.round(rate * 1000) / 10}% wrong · limit ${Math.round(limit * 1000) / 10}% · aim 0%`}
    />
  );
}
