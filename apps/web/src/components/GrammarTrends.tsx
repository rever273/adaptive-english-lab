import { useEffect, useState } from "react";
import * as api from "../api";
import { wilson } from "../stats";
import { Chart } from "./Chart";
import { LINE_COLORS, MultiLineChart } from "./MultiLineChart";

const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);
const sec = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)} s`);

/** Trend charts of the classic Grammar Practice: the same set the Grammar Cloze analytics has (share correct, answer time, skills over time). */
export function GrammarTrends({ days }: { days: "7" | "30" | "90" | "all" }) {
  const [data, setData] = useState<api.GrammarTrendsData | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let live = true;
    setData(null);
    setError(false);
    void api.fetchGrammarTrends(days).then((d) => { if (live) setData(d); }).catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [days]);
  if (error) return <p className="muted">Trend charts are unavailable.</p>;
  if (!data) return <p className="muted">Loading trend charts…</p>;
  if (data.byDay.length === 0) return null;
  const sk = data.skillSeries;
  return (
    <>
      <section className="card" data-testid="grammar-trends">
        <h2>Correct first tries, %</h2>
        <Chart
          ariaLabel="Share of correct independent first tries per day"
          line={{ color: "#3fbf6f", format: (v) => `${Math.round(v * 100)}%`, max: 1 }}
          points={data.byDay.map((d) => ({ key: d.date, label: d.date.slice(5), line: d.scored ? d.correct / d.scored : null, muted: d.scored < 5, band: d.scored >= 5 ? wilson(d.correct, d.scored) : null, tip: [d.date, `${pct(d.correct / d.scored)} correct`, `${d.correct} of ${d.scored}`] }))}
          legend="Independent first tries (no hint, answer not seen, not “I don’t know”) that were right. Faded points have fewer than 5 tries; whiskers show the 95% range."
        />
      </section>
      <section className="card">
        <h2>Median answer time per day</h2>
        <Chart
          ariaLabel="Median time to the first answer per day"
          line={{ color: "#f3c94d", format: (v) => `${v.toFixed(0)} s` }}
          points={data.byDay.map((d) => ({ key: d.date, label: d.date.slice(5), line: d.medianMs === null ? null : d.medianMs / 1000, muted: d.scored < 5, tip: [d.date, `median ${sec(d.medianMs)}`, `${d.scored} tries`] }))}
          legend="Time from the task appearing to the first answer. Tasks differ in length, so read the trend rather than single days."
        />
      </section>
      {sk.series.length > 0 && (
        <section className="card">
          <h2>Skills over time (the {sk.series.length} most practised)</h2>
          <MultiLineChart
            ariaLabel="Accuracy per skill over time"
            labels={sk.labels}
            series={sk.series.map((s, i) => ({ key: s.skillId, name: s.name, color: LINE_COLORS[i % LINE_COLORS.length]!, values: s.accuracy, counts: s.counts }))}
            legend={`Share of right independent first tries per skill, by ${sk.bucket}. Only the skills with the most tries are drawn (at most 8); click a name to hide its line. Gaps mean no tries.`}
          />
        </section>
      )}
    </>
  );
}
