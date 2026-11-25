import { useEffect, useState } from "react";
import * as api from "../api";
import { Chart } from "../components/Chart";
import { wilson } from "../stats";
import { ClozeRules } from "./GrammarClozeRules";
import { fmtDuration } from "../format";

const time = fmtDuration;
const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);
const sec = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)} s`);

/** Grammar -> Grammar Cloze statistics (TASK_032). Own numbers only: nothing here comes from the classic Grammar Practice. */
export function GrammarClozeAnalytics({ days }: { days: "7" | "30" | "90" | "all" }) {
  const [data, setData] = useState<api.ClozeAnalyticsData | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let live = true;
    setData(null);
    setError(false);
    void api.fetchClozeAnalytics(days).then((d) => { if (live) setData(d); }).catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [days]);
  if (error) return <p className="notice notice-error" role="alert">Could not load Grammar Cloze analytics.</p>;
  if (!data) return <p role="status">Loading…</p>;
  const t = data.totals;
  const s1 = data.stages[0];
  const w = wilson(t.correct, t.answered);
  const cur = data.comparison.current, prev = data.comparison.previous;
  const enough = cur.answered >= 10 && prev.answered >= 10;
  return (
    <div data-testid="cloze-analytics">
      <section className="card">
        <h2><i className="pi pi-th-large" aria-hidden="true" /> Grammar Cloze analytics</h2>
        {t.answered === 0 ? (
          <p className="muted">No Grammar Cloze answers in this period yet. Play a session and the numbers appear here.</p>
        ) : (
          <>
            <p className="muted small">Your first choice for each sentence, in the selected period. Excluded sentences are not counted as answers. The period filter applies to every chart below.</p>
            <div className="stat-grid-2 vocab-analytics-stats">
              {([
                ["Accuracy (first choice)", pct(t.correct / t.answered), `${t.correct} of ${t.answered}${w ? `, 95% range ${pct(w.low)}–${pct(w.high)}` : ""}`],
                ["Sessions", String(t.sessions), ""],
                ["Answers", String(t.answered), `${t.incorrect} wrong`],
                ["Excluded sentences", String(t.excluded), ""],
                ["Active time", fmtDuration(t.activeMs), t.sessions ? `${fmtDuration(t.activeMs / t.sessions)} per session` : ""],
                ["Median answer time", sec(data.responseMs.median), `75% answer within ${sec(data.responseMs.p75)}`],
              ] as const).map(([label, value, note]) => (
                <div className="stat" key={label}><span className="stat-num">{value}</span><span className="stat-label">{label}{note && <span className="muted"> ({note})</span>}</span></div>
              ))}
            </div>
          </>
        )}
        {s1 && (
          <p className="muted small" data-testid="cloze-analytics-stage">
            Stage 1: {s1.percent} % ({s1.processed} / {s1.total}). Waiting for Stage 2: {s1.carriedToNext} sentences.
          </p>
        )}
      </section>

      {t.answered > 0 && (
        <>
          <section className="card">
            <h2>Practice activity</h2>
            <h3>Practice time per day</h3>
            <Chart ariaLabel="Grammar Cloze practice time per day" bars={{ color: "#b78bff", format: (v) => `${Math.round(v)} min` }} line={{ color: "#6ab7ff", format: (v) => `${Math.round(v)}` }} points={data.byDay.map((d) => ({ key: d.day, label: d.day.slice(5), bar: d.activeMs / 60000, line: d.answered, tip: [d.day, `${time(d.activeMs)} active`, `${d.answered} answers`] }))} legend="Bars: recorded active time (left axis). Line: answers that day (right axis). Learning day in Australia/Brisbane." />
          </section>

          <section className="card">
            <h2>Correct answers, %</h2>
            <Chart
              ariaLabel="Share of correct first choices per day"
              line={{ color: "#3fbf6f", format: (v) => `${Math.round(v * 100)}%`, max: 1 }}
              points={data.byDay.map((d) => ({ key: d.day, label: d.day.slice(5), line: d.answered ? d.correct / d.answered : null, muted: d.answered < 5, band: ((): { low: number; high: number } | null => { const b = wilson(d.correct, d.answered); return b && d.answered >= 5 ? b : null; })(), tip: [d.day, d.answered ? `${pct(d.correct / d.answered)} correct` : "no answers", `${d.correct} of ${d.answered}`] }))}
              legend="One point per day: first choices that were right. Faded points have fewer than 5 answers. Whiskers show the 95% range."
            />
            <details>
              <summary>Table behind the chart</summary>
              <table className="summary-table wide">
                <thead><tr><th>Week starting</th><th>Right</th><th>Counts</th><th>95% range</th></tr></thead>
                <tbody>{data.weekly.map((x) => { const b = wilson(x.correct, x.answered); return <tr key={x.week}><td>{x.week}</td><td>{pct(x.correct / x.answered)}</td><td>{x.correct} of {x.answered}</td><td>{b ? `${pct(b.low)}–${pct(b.high)}` : "—"}</td></tr>; })}</tbody>
              </table>
            </details>
            <h3>Last 28 days against the 28 before</h3>
            {enough ? (
              <p data-testid="cloze-comparison">
                {pct(cur.correct / cur.answered)} ({cur.correct} of {cur.answered}, {cur.from} to {cur.to}) against {pct(prev.correct / prev.answered)} ({prev.correct} of {prev.answered}, {prev.from} to {prev.to}).
                The sentences differ every time, so read this with care.
              </p>
            ) : (
              <p className="muted" data-testid="cloze-comparison">Insufficient comparison data: each window needs at least 10 answers. No claim of progress is made.</p>
            )}
          </section>

          <section className="card">
            <h2>Median answer time per day</h2>
            <Chart
              ariaLabel="Median answer time per day"
              line={{ color: "#f3c94d", format: (v) => `${v.toFixed(1)} s` }}
              points={data.byDay.map((d) => ({ key: d.day, label: d.day.slice(5), line: d.medianMs === null ? null : d.medianMs / 1000, muted: d.answered < 5, tip: [d.day, `median ${sec(d.medianMs)}`, `${d.answered} answers`] }))}
              legend="Time from the sentence appearing to the choice. A lower line means quicker recognition; faded points have fewer than 5 answers."
            />
          </section>

          {data.progress.length > 0 && (
            <section className="card">
              <h2>Stage 1 progress</h2>
              <Chart
                ariaLabel="Share of Stage 1 answered, by day"
                line={{ color: "#51b788", format: (v) => `${Math.round(v)}%`, max: 100 }}
                points={data.progress.map((p) => ({ key: p.day, label: p.day.slice(5), line: p.percent, tip: [p.day, `${p.percent.toFixed(2)} % of Stage 1`, `${p.processed} sentences answered`] }))}
                legend="Cumulative: how much of the whole sentence set has been answered once."
              />
            </section>
          )}

          <ClozeRules data={data} />
        </>
      )}
    </div>
  );
}
