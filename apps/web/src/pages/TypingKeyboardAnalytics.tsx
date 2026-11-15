import { useMemo, useState, type CSSProperties } from "react";
import type { TypingKeyboardAnalytics } from "../api";
import { Chart } from "../components/Chart";

/**
 * keybr.com's per-key view, shared by every typing mode: a keyboard coloured by each key's best speed against the goal, the speed and
 * error rate of every key, one key's learning curve, and the forecast to the goal.
 */

const ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short" });

type Key = TypingKeyboardAnalytics["keys"][number];

/** a key fills from the bottom with its best speed against the goal; the colour goes from red (half the goal) to green (the goal) */
export function keyFillStyle(c: number | null): CSSProperties {
  const v = c ?? 0;
  return { "--fill": `${Math.round(Math.min(1, Math.max(0, v)) * 100)}%`, "--hue": Math.round(Math.min(1, Math.max(0, (v - 0.5) / 0.5)) * 120) } as CSSProperties;
}

function KeyHeatmap({ keys, goalCpm, selected, onSelect }: { keys: Key[]; goalCpm: number; selected: string | null; onSelect: ((l: string) => void) | null }) {
  const by = new Map(keys.map((k) => [k.letter, k]));
  return (
    <div className="keys-heatmap" role="group" aria-label="Keys coloured by their best speed against the goal">
      {ROWS.map((row) => (
        <div key={row} className="keys-heatmap-row">
          {[...row].map((l) => {
            const k = by.get(l);
            const tip = !k || k.cpm === null ? `${l.toUpperCase()}: no data yet` : `${l.toUpperCase()}: ${k.cpm} CPM now, best ${k.bestCpm} CPM (${Math.round((k.bestConfidence ?? 0) * 100)}% of the ${goalCpm} CPM goal) · ${k.errorRate === null ? "—" : `${Math.round(k.errorRate * 1000) / 10}% wrong`} · ${k.lessons} sessions`;
            return (
              <button key={l} type="button" className={`keys-chip keys-heat-key${!k || k.cpm === null ? " off" : ""}${selected === l ? " focused" : ""}`} style={k && k.cpm !== null ? keyFillStyle(k.readiness) : undefined} title={tip} aria-label={tip} onClick={onSelect ? () => onSelect(l) : undefined} disabled={!onSelect}>
                {l}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function KeyboardSection({ data, mode }: { data: TypingKeyboardAnalytics; mode: string }) {
  // Books is not about single letters, so there is no per-letter learning curve there
  const showCurve = mode !== "books";
  const known = useMemo(() => data.keys.filter((k) => k.cpm !== null), [data.keys]);
  const slowest = useMemo(() => [...known].sort((a, b) => (a.confidence ?? 0) - (b.confidence ?? 0))[0]?.letter ?? null, [known]);
  const [picked, setPicked] = useState<string | null>(null);
  const selected = showCurve ? (picked ?? slowest) : null;
  const key = data.keys.find((k) => k.letter === selected) ?? null;
  const goal = data.goalCpm;
  const top = Math.max(goal, ...known.map((k) => k.bestCpm ?? 0)) * 1.1;
  const f = data.forecast;
  const goalWpm = Math.round(goal / 5);
  // the share of wrong presses a key may have (Settings: key accuracy), in percent
  const errorLimit = Math.round((1 - data.minAccuracy) * 1000) / 10;

  return (
    <div className="card keyboard-analytics">
      <h3>Keys <span className="muted small">(all time, not limited by the period above)</span></h3>
      {known.length === 0 ? (
        <p className="muted small">Per-key speed is collected as you type; a few sessions are needed first.</p>
      ) : (
        <>
          <KeyHeatmap keys={data.keys} goalCpm={goal} selected={selected} onSelect={showCurve ? setPicked : null} />
          <p className="muted small">
            Each key fills up as it nears your goal of {goalWpm} WPM ({goal} CPM) with enough accuracy: red is half way, green is reached. A key's
            speed is its time per press smoothed over sessions (keybr.com method; the first 10 sessions are a plain mean); a key with too many
            wrong presses is held back even when it is fast.{showCurve ? " Click a key to see its learning curve below." : ""}
          </p>
          <div className="keyboard-charts">
            <div>
              <h4 className="chart-title">Key speed against the goal</h4>
              <Chart
                ariaLabel="Speed of every key now and its best, against the goal"
                bars={{ color: "#6ab7ff", format: (v) => `${Math.round(v)} CPM`, max: top }}
                bars2={{ color: "#51b788", format: (v) => `${Math.round(v)} CPM`, max: top }}
                line={{ color: "#f3c94d", format: (v) => `${Math.round(v)} CPM`, max: top }}
                connectGaps
                points={known.map((k) => ({
                  key: k.letter,
                  label: k.letter.toUpperCase(),
                  bar: k.cpm,
                  bar2: k.bestCpm,
                  line: goal,
                  highlight: k.letter === selected,
                  tip: [k.letter.toUpperCase(), `Now: ${k.cpm} CPM`, `Best: ${k.bestCpm} CPM`, `Goal: ${goal} CPM`, `${k.lessons} sessions`],
                }))}
                legend="Blue: speed now · green: best speed · yellow: your goal. Keys in the order they open in Key Builder (most frequent first)."
              />
            </div>
            <div>
              <h4 className="chart-title">Wrong keys per key</h4>
              <Chart
                ariaLabel="Share of wrong presses when each key was expected"
                bars={{ color: "#ef7777", format: (v) => `${Math.round(v * 10) / 10}%` }}
                line2={{ color: "#f3c94d", format: (v) => `${Math.round(v * 10) / 10}%` }}
                points={known.map((k) => ({
                  key: k.letter,
                  label: k.letter.toUpperCase(),
                  bar: k.errorRate === null ? null : k.errorRate * 100,
                  line2: errorLimit,
                  highlight: k.letter === selected,
                  tip: [k.letter.toUpperCase(), `${k.errorRate === null ? "—" : `${Math.round(k.errorRate * 1000) / 10}%`} wrong`, `${k.hits} correct · ${k.misses} wrong`, `Limit: ${errorLimit}%`],
                }))}
                legend={`Wrong presses when this key was the one to type, as a share of all its presses · yellow: the most a key may have (${errorLimit}%, set in Settings; a key counts as reached when it is surely not above it).`}
              />
            </div>
            {showCurve && (
            <div>
              <h4 className="chart-title">Learning curve: key {selected?.toUpperCase() ?? "—"}</h4>
              {!key || key.curve.length === 0 ? (
                <p className="muted small">No data for this key yet.</p>
              ) : (
                <Chart
                  ariaLabel={`Speed of key ${key.letter} per session`}
                  bars={{ color: "#9aa4b8", format: (v) => `${Math.round(v)} CPM`, max: Math.max(goal, ...key.curve.map((p) => p.cpm)) * 1.1 }}
                  line={{ color: "#6ab7ff", format: (v) => `${Math.round(v)} CPM`, max: Math.max(goal, ...key.curve.map((p) => p.cpm)) * 1.1 }}
                  points={key.curve.map((p, i) => ({ key: `${p.at}-${i}`, label: fmtDay(p.at), bar: p.cpm, line: p.smoothed, tip: [fmtDay(p.at), `This session: ${p.cpm} CPM`, `Smoothed: ${p.smoothed} CPM`, `Goal: ${goal} CPM`] }))}
                  legend={`Grey: the key's speed in each session · blue: smoothed (what opens keys and sets the focus). Goal ${goal} CPM. Last 60 sessions.`}
                />
              )}
            </div>
            )}
          </div>
        </>
      )}
      <h4 className="chart-title">Forecast to {goalWpm} WPM</h4>
      {!f ? (
        <p className="muted small">At least 10 finished sessions are needed for a forecast.</p>
      ) : f.lessonsToGoal === 0 ? (
        <p className="small">Your recent sessions are already at the goal.</p>
      ) : f.lessonsToGoal === null ? (
        <p className="small">No upward trend in the last 50 sessions yet ({f.cpmPerLesson} CPM per session), so there is no honest estimate.</p>
      ) : (
        <p className="small">
          At the pace of the last 50 sessions (+{f.cpmPerLesson} CPM each): about <b>{f.lessonsToGoal} sessions</b>, or <b>{f.hoursToGoal} h</b> of typing in this mode.
        </p>
      )}
      <p className="muted small">A straight line through the speed of the last 50 sessions; progress usually slows near the goal, so treat it as a lower bound. The goal is set in Settings.</p>
    </div>
  );
}
