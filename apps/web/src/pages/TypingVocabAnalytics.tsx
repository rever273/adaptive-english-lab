import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { VtAnalytics, VtWordFilter, VtWordRow } from "@english-lab/contracts";
import * as api from "../api";
import { Chart } from "../components/Chart";
import { fmtTotalTime } from "../format";

const fmtDay = (iso: string) => new Date(iso.slice(0, 10) + "T00:00:00").toLocaleDateString("en-AU", { day: "numeric", month: "short" });
const num = (n: number) => n.toLocaleString("en-US");
const STATE_LABEL: Record<string, string> = {
  unscreened: "Not screened",
  known_screening: "Known (screening)",
  excluded_by_learner: "Archived by you",
  excluded_by_cleanup: "Archived by cleanup",
  learning: "Learning",
  awaiting_verification: "Learned, not checked",
  verified: "Verified",
};
const FILTERS: Array<{ value: VtWordFilter | ""; label: string }> = [
  { value: "", label: "All words" },
  { value: "unscreened", label: "Not screened" },
  { value: "known_screening", label: "Known" },
  { value: "learning", label: "Learning" },
  { value: "awaiting_verification", label: "Awaiting check" },
  { value: "verified", label: "Verified" },
  { value: "excluded", label: "Archived" },
  { value: "no_examples", label: "No examples" },
];
const PAGE = 50;

/** Vocabulary Typing analytics (TASK_038 section 8): an estimate of the vocabulary with its interval, screening and learning progress, typing, and the word list */
export function TypingVocabAnalytics({ days, toolbar }: { days: "7" | "30" | "90" | "all"; toolbar: ReactNode }) {
  const [data, setData] = useState<VtAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<VtWordFilter | "">("");
  const load = useCallback(() => {
    api.fetchVocabTypingAnalytics(days === "all" ? 3650 : Number(days)).then(setData).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [days]);
  useEffect(() => {
    setData(null);
    load();
  }, [load]);
  if (error) return <p role="alert">{error}</p>;
  if (!data) return <p className="muted">Loading vocabulary analytics…</p>;
  const e = data.estimate;
  const k = data.knownNow;
  return (
    <section aria-label="Vocabulary Typing analytics">
      {toolbar}
      <div className="card" data-testid="vt-size">
        <h3>Vocabulary size</h3>
        {e.value === null ? (
          <p className="vt-estimate-big">Need more screening</p>
        ) : (
          <p className="vt-estimate-big" title={`Estimate ${e.version}`}>≈ {num(e.value)} <span className="muted small">words ({num(e.low ?? e.value)}–{num(e.high ?? e.value)}, 95% interval)</span></p>
        )}
        <p className="muted small">Out of {num(e.poolSize)} words of the dictionary, from {num(e.screened)} screened words ({num(e.probes)} of them random probes). {e.value === null ? `Screen ${Math.max(0, 100 - e.screened)} more words to see a number.` : "A guess from a sample of what you said you know, not a test."}</p>
        {e.assumedKnown > 0 && <p className="muted small">Includes the {num(e.assumedKnown)} most frequent words, assumed known: they are not practised.</p>}
        <div className="stat-grid-2">
          <div className="stat" title="Known from screening + learned (not yet checked) + verified"><span className="stat-num">{num(k.total)}</span><span className="stat-label">known now</span></div>
          <div className="stat"><span className="stat-num">{num(k.knownScreening)}</span><span className="stat-label">known from screening</span></div>
          <div className="stat" title="Words you marked Learned; they are checked later"><span className="stat-num">{num(k.awaiting)}</span><span className="stat-label">learned (self-reported)</span></div>
          <div className="stat" title="Words you passed a missing-word check on"><span className="stat-num">{num(k.verified)}</span><span className="stat-label">verified</span></div>
        </div>
        <p className="small">New words learned: <strong>{data.newWordsLearned.selfReported}</strong> self-reported · <strong>{data.newWordsLearned.verified}</strong> verified.</p>
        {data.series.length > 1 && (
          <Chart
            ariaLabel="Estimated vocabulary and known words over time"
            line={{ color: "#6ab7ff", format: (v) => num(Math.round(v)) }}
            bars={{ color: "#51b788", format: (v) => num(Math.round(v)) }}
            points={data.series.map((p) => ({ key: p.date, label: fmtDay(p.date), ...(p.estimate !== null ? { line: p.estimate } : {}), bar: p.knownNow, tip: [fmtDay(p.date), `Estimate: ${p.estimate === null ? "—" : num(p.estimate)}`, `Known now: ${num(p.knownNow)}`] }))}
            legend="Line: estimated vocabulary at the end of each day; bars: words known now (screening, learned, verified)."
          />
        )}
      </div>

      <div className="vt-grid">
        <section className="card" data-testid="vt-screening">
          <h3>Screening</h3>
          <p><strong>{num(data.screening.screened)}</strong> screened · <strong>{num(data.screening.remaining)}</strong> left ({data.estimate.poolSize > 0 ? Math.round((data.screening.screened / data.estimate.poolSize) * 100) : 0}%)</p>
          <p className="muted small">Not counted: {num(data.excluded.cleanup)} archived by the dictionary cleanup, {num(data.excluded.learner)} archived by you.</p>
        </section>
        <section className="card" data-testid="vt-learning">
          <h3>Learning</h3>
          <p>{data.learning.learning} learning · {data.learning.awaiting} awaiting a check · {data.learning.verified} verified</p>
          <p className="small">Checks due now: <strong>{data.learning.dueNow}</strong> · in the next 7 days: {data.learning.dueNext7}</p>
          <p className="small">In this period: {data.learning.checksPassed} passed · {data.learning.checksFailed} failed · {data.learning.returnedToLearning} returned to learning</p>
          <p className="muted small">{data.learning.noExamples} words to learn have no example sentence yet.</p>
        </section>
        <section className="card" data-testid="vt-typing">
          <h3>Typing</h3>
          <p>{data.typing.sessions} {data.typing.sessions === 1 ? "session" : "sessions"} · {fmtTotalTime(data.typing.activeMs / 1000)}</p>
          <p>{data.typing.wpm === null ? "—" : Math.round(data.typing.wpm)} WPM · {data.typing.accuracy === null ? "—" : `${Math.round(data.typing.accuracy)}%`} accuracy · {data.typing.errors} wrong keys</p>
          <p className="muted small">Missing-word answers are not part of the speed.</p>
          {data.typing.troublePairs.length > 0 && <p className="small">Trouble letters: {data.typing.troublePairs.map((p) => `${p.pair} (${Math.round(p.errorRate * 100)}%)`).join(", ")}</p>}
        </section>
      </div>

      <DailyCharts data={data} />

      <section className="card">
        <h3>By frequency band</h3>
        <div className="table-wrap">
          <table className="data-table small vt-bands" data-testid="vt-bands">
            <thead><tr><th>Words (by frequency)</th><th>In dictionary</th><th>Screened</th><th>Known</th><th>Share known</th><th /></tr></thead>
            <tbody>
              {data.bands.map((b) => (
                <tr key={b.band}>
                  <td>{num((b.band - 1) * 1000 + 1)}–{num(b.band * 1000)}</td>
                  <td>{num(b.pool)}</td>
                  <td>{num(b.screened)}</td>
                  <td>{num(b.known)}</td>
                  <td>{b.share === null ? "—" : `${Math.round(b.share * 100)}%`}</td>
                  <td><span className="vt-bar" style={{ width: `${Math.round((b.share ?? 0) * 80)}px` }} aria-hidden="true" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <WordList filter={filter} setFilter={setFilter} onChanged={load} />
      <p className="muted small">{data.attribution}</p>
    </section>
  );
}

function WordList({ filter, setFilter, onChanged }: { filter: VtWordFilter | ""; setFilter: (f: VtWordFilter | "") => void; onChanged: () => void }) {
  const [rows, setRows] = useState<VtWordRow[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.fetchVocabWords({ ...(filter ? { state: filter } : {}), ...(search.trim() ? { q: search.trim() } : {}), limit: PAGE, offset })
      .then((r) => { setRows(r.words); setTotal(r.total); setError(null); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [filter, search, offset]);
  useEffect(() => {
    const t = window.setTimeout(load, 200);
    return () => window.clearTimeout(t);
  }, [load]);
  const restore = (lemma: string) => {
    api.restoreVocabWord(lemma).then(() => { load(); onChanged(); }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  return (
    <section className="card" data-testid="vt-words">
      <h3>Words</h3>
      <div className="vt-words-tools">
        <select value={filter} onChange={(e) => { setOffset(0); setFilter(e.target.value as VtWordFilter | ""); }} aria-label="Filter by state">
          {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
        <input type="search" value={search} onChange={(e) => { setOffset(0); setSearch(e.target.value); }} placeholder="Search a word" aria-label="Search a word" maxLength={60} />
        <span className="muted small">{num(total)} words</span>
      </div>
      {error && <p role="alert" className="notice notice-warning small">{error}</p>}
      <div className="table-wrap">
        <table className="data-table small">
          <thead><tr><th>#</th><th>Word</th><th>Translation</th><th>State</th><th>Next check</th><th>Lapses</th><th>Examples</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.lemma}>
                <td>{num(r.rank)}</td>
                <td><strong>{r.lemma}</strong></td>
                <td>{r.translationRu}</td>
                <td>{STATE_LABEL[r.state] ?? r.state}{r.noExamples ? " · no examples" : ""}</td>
                <td>{r.nextCheck ?? "—"}</td>
                <td>{r.lapses || "—"}</td>
                <td>{r.contextCount}</td>
                <td>{(r.state === "excluded_by_learner" || r.state === "excluded_by_cleanup") && <button className="btn" onClick={() => restore(r.lemma)}>Restore</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="actions">
        <button className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
        <button className="btn" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Next</button>
      </div>
    </section>
  );
}

const fmtWeek = (iso: string) => `week of ${fmtDay(iso)}`;

/** the charts of the period, from the raw sessions, events and checks (D181); every number is shown with its heading in the tooltip */
function DailyCharts({ data }: { data: VtAnalytics }) {
  // leading days without any activity only squash the charts
  const firstActive = data.daily.findIndex((d) => d.minutes > 0 || d.known + d.unknown + d.notUseful + d.learned + d.verified > 0);
  const daily = firstActive < 0 ? [] : data.daily.slice(firstActive);
  const none = <p className="muted small">no data yet</p>;
  const r = data.records;
  return (
    <>
      <div className="charts-grid">
        <div>
          <h4 className="chart-title">Typing speed and accuracy</h4>
          {daily.every((d) => d.wpm === null) ? none : (
            <Chart ariaLabel="Typing speed and accuracy per day" bars={{ color: "#51b788", format: (v) => `${Math.round(v)}%`, max: 100 }} line={{ color: "#6ab7ff", format: (v) => `${Math.round(v * 10) / 10} wpm` }} secondary={{ factor: 5, color: "#9aa4b8", format: (v) => `${Math.round(v)}` }} legend="Line: WPM (right axis: CPM) · bars: accuracy. Only the typed words and sentences count, not the time spent deciding or the missing-word answers." points={daily.map((d) => ({ key: d.date, label: fmtDay(d.date), line: d.wpm, bar: d.accuracy, tip: [fmtDay(d.date), `WPM: ${d.wpm ?? "—"}`, `Accuracy: ${d.accuracy === null ? "—" : `${Math.round(d.accuracy)}%`}`] }))} />
          )}
        </div>
        <div>
          <h4 className="chart-title">Minutes of practice</h4>
          {daily.every((d) => d.minutes === 0) ? none : (
            <Chart ariaLabel="Minutes of Vocabulary Typing per day" bars={{ color: "#b78bff", format: (v) => `${Math.round(v * 10) / 10} min` }} legend="Visible time spent in this mode each learning day." points={daily.map((d) => ({ key: d.date, label: fmtDay(d.date), bar: d.minutes, tip: [fmtDay(d.date), `${d.minutes} min`] }))} />
          )}
        </div>
        <div>
          <h4 className="chart-title">Words screened</h4>
          {daily.every((d) => d.known + d.unknown + d.notUseful === 0) ? none : (
            <Chart ariaLabel="Words screened per day" bars={{ color: "#51b788", format: (v) => `${Math.round(v)}` }} bars2={{ color: "#ef7777", format: (v) => `${Math.round(v)}` }} line={{ color: "#f3c94d", format: (v) => `${Math.round(v)}` }} legend="Green: known · red: unknown · yellow line: archived words" points={daily.map((d) => ({ key: d.date, label: fmtDay(d.date), bar: d.known, bar2: d.unknown, line: d.notUseful, tip: [fmtDay(d.date), `Known: ${d.known}`, `Unknown: ${d.unknown}`, `Archived: ${d.notUseful}`] }))} />
          )}
        </div>
        <div>
          <h4 className="chart-title">Learned and verified</h4>
          {daily.every((d) => d.learned + d.verified === 0) ? none : (
            <Chart ariaLabel="Words marked learned and checks passed per day" bars={{ color: "#6ab7ff", format: (v) => `${Math.round(v)}` }} bars2={{ color: "#3fbf6f", format: (v) => `${Math.round(v)}` }} legend="Blue: words you marked Learned (your own opinion) · green: checks passed (verified)" points={daily.map((d) => ({ key: d.date, label: fmtDay(d.date), bar: d.learned, bar2: d.verified, tip: [fmtDay(d.date), `Learned (Tab): ${d.learned}`, `Checks passed: ${d.verified}`] }))} />
          )}
        </div>
        <div>
          <h4 className="chart-title">Checks passed by week</h4>
          {data.weekly.length === 0 ? none : (
            <Chart ariaLabel="Share of checks passed per week" bars={{ color: "#9aa4b8", format: (v) => `${Math.round(v)}` }} line={{ color: "#3fbf6f", format: (v) => `${Math.round(v)}%`, max: 100 }} legend="Line: share of checks answered right · bars: checks taken" points={data.weekly.map((w) => ({ key: w.week, label: fmtDay(w.week), bar: w.passed + w.failed, line: w.rate, tip: [fmtWeek(w.week), `Passed: ${w.passed}`, `Failed: ${w.failed}`, `Rate: ${w.rate === null ? "—" : `${Math.round(w.rate)}%`}`] }))} />
          )}
        </div>
        <div>
          <h4 className="chart-title">Checks due, next 14 days</h4>
          {data.dueForecast.every((d) => d.count === 0) ? none : (
            <Chart ariaLabel="Checks falling due in the next 14 days" bars={{ color: "#f3c94d", format: (v) => `${Math.round(v)}` }} legend="Words whose next check falls on each day; overdue checks count today." points={data.dueForecast.map((d) => ({ key: d.date, label: fmtDay(d.date), bar: d.count, tip: [fmtDay(d.date), `${d.count} ${d.count === 1 ? "check" : "checks"}`] }))} />
          )}
        </div>
      </div>
      <section className="card" data-testid="vt-records">
        <h3>Records</h3>
        <div className="stat-grid-2">
          <div className="stat"><span className="stat-num">{r.bestWpm === null ? "—" : Math.round(r.bestWpm)}</span><span className="stat-label">best WPM in a session</span></div>
          <div className="stat"><span className="stat-num">{r.bestAccuracy === null ? "—" : `${Math.round(r.bestAccuracy)}%`}</span><span className="stat-label">best accuracy</span></div>
          <div className="stat"><span className="stat-num">{r.mostCards}</span><span className="stat-label">most cards in a session</span></div>
          <div className="stat"><span className="stat-num">{fmtTotalTime(r.longestMs / 1000)}</span><span className="stat-label">longest session</span></div>
        </div>
      </section>
    </>
  );
}
