import { useEffect, useState, type ReactNode } from "react";
import { fetchDictationAnalytics, type DictationAnalytics } from "../api";
import { Chart } from "../components/Chart";
import { CumulativeCharacters } from "../components/CharacterCharts";
import { fmtTotalTime } from "../format";

const fmtDay = (iso: string) => new Date(iso.slice(0, 10) + "T00:00:00").toLocaleDateString("en-AU", { day: "numeric", month: "short" });
const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v)}%`);

/** Audio Dictation analytics: derived by the server from raw attempts and events; an empty history shows a dash, never 0 or 100. */
export function TypingDictationAnalytics({ days, toolbar }: { days: "7" | "30" | "90" | "all"; toolbar: ReactNode }) {
  const [data, setData] = useState<DictationAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let off = false;
    setData(null);
    fetchDictationAnalytics(days)
      .then((d) => { if (!off) setData(d); })
      .catch((e) => { if (!off) setError(e instanceof Error ? e.message : String(e)); });
    return () => { off = true; };
  }, [days]);
  if (error) return <p role="alert">{error}</p>;
  if (!data) return <p className="muted">Loading dictation analytics…</p>;
  const s = data.summary;
  const speeds = data.series.flatMap((p) => p.wpm === null ? [] : [p.wpm]);
  const bestSpeed = speeds.length ? Math.max(...speeds) : null;
  const bestScore = data.series.length ? Math.max(...data.series.map((p) => p.score)) : null;
  return (
    <section aria-label="Audio Dictation analytics">
      {toolbar}
      <div className="stat-grid-2">
        <div className="stat"><span className="stat-num">{fmtTotalTime(s.totalActiveMs / 1000)}</span><span className="stat-label">total practice time</span></div>
        <div className="stat"><span className="stat-num">{s.lessons}</span><span className="stat-label">completed lessons</span></div>
        <div className="stat"><span className="stat-num">{s.exercises}</span><span className="stat-label">sentences typed</span></div>
        <div className="stat" title="Words per minute while typing: correct characters / 5 per minute of typing time (listening is not counted)"><span className="stat-num">{s.avgWpm === null ? "—" : Math.round(s.avgWpm)}</span><span className="stat-label">average WPM</span></div>
        <div className="stat"><span className="stat-num">{s.bestWpm === null ? "—" : Math.round(s.bestWpm)}</span><span className="stat-label">best WPM</span></div>
        <div className="stat" title="Characters per minute of typing (WPM × 5)"><span className="stat-num">{s.avgCpm ?? "—"}</span><span className="stat-label">average CPM</span></div>
        <div className="stat" title="1 minus word errors over words, averaged over first answers"><span className="stat-num">{pct(s.dictationAccuracy)}</span><span className="stat-label">average accuracy</span></div>
        <div className="stat"><span className="stat-num">{s.bestScore ?? "—"}</span><span className="stat-label">best score</span></div>
        <div className="stat" title="Characters in submitted answers for completed sentences, including retries; edits are not counted"><span className="stat-num">{s.totalChars.toLocaleString("en-AU")}</span><span className="stat-label">submitted characters</span></div>
        <div className="stat" title="Sentences typed correctly on the first try"><span className="stat-num">{pct(s.firstAttemptAccuracy)}</span><span className="stat-label">first-attempt accuracy</span></div>
        <div className="stat" title="Full credit: no mistakes, no hints, no translation"><span className="stat-num">{pct(s.noHelpRate)}</span><span className="stat-label">independent</span></div>
        <div className="stat" title="Only replays you pressed yourself; automatic replays are not counted"><span className="stat-num">{s.avgManualReplays ?? "—"}</span><span className="stat-label">replays per sentence</span></div>
        <div className="stat" title="Hints shown per sentence (after a wrong answer or on request)"><span className="stat-num">{s.avgHints ?? "—"}</span><span className="stat-label">hints per sentence</span></div>
        <div className="stat"><span className="stat-num">{pct(s.translationUsedRate)}</span><span className="stat-label">translation used</span></div>
      </div>
      <div className="charts-grid">
        <div>
          <h4 className="chart-title">Understanding by ear</h4>
          {data.series.length === 0 ? <p className="muted small">no data yet</p> : (
            <Chart ariaLabel="First-attempt accuracy and independent sentences" bars={{ color: "#51b788", format: (v) => `${Math.round(v)}%`, max: 100 }} line={{ color: "#6ab7ff", format: (v) => `${Math.round(v)}%`, max: 100 }} legend="Line: sentences right on the first try · bars: sentences done without any help" points={data.series.map((p, i) => ({ key: `u${p.at}-${i}`, label: fmtDay(p.at), bar: p.independent, line: p.firstAttemptAccuracy, tip: [fmtDay(p.at), `Right first time: ${Math.round(p.firstAttemptAccuracy)}%`, `Independent: ${Math.round(p.independent)}%`] }))} />
          )}
        </div>
        <div>
          <h4 className="chart-title">Replays and hints per sentence</h4>
          {data.series.every((p) => p.replays === null && p.hints === null) ? <p className="muted small">no data yet</p> : (
            <Chart ariaLabel="Replays and hints per sentence" bars={{ color: "#b78bff", format: (v) => `${Math.round(v * 10) / 10}` }} line={{ color: "#f3c94d", format: (v) => `${Math.round(v * 10) / 10}` }} legend="Bars: replays you pressed · line: hints shown" points={data.series.map((p, i) => ({ key: `r${p.at}-${i}`, label: fmtDay(p.at), bar: p.replays, line: p.hints, tip: [fmtDay(p.at), `Replays: ${p.replays ?? "—"}`, `Hints: ${p.hints ?? "—"}`] }))} />
          )}
        </div>
        <div>
          <h4 className="chart-title">Typing speed over time</h4>
          {data.series.every((p) => p.wpm === null) ? <p className="muted small">no data yet</p> : (
            <Chart ariaLabel="Typing speed" line={{ color: "#6ab7ff", format: (v) => `${Math.round(v * 10) / 10} wpm` }} secondary={{ factor: 5, color: "#9aa4b8", format: (v) => `${Math.round(v)}` }} legend="Left axis: WPM · right axis: CPM (characters per minute = WPM × 5)" points={data.series.map((p, i) => ({ key: `${p.at}-${i}`, label: fmtDay(p.at), line: p.wpm, highlight: bestSpeed !== null && p.wpm === bestSpeed, tip: [fmtDay(p.at), ...(bestSpeed !== null && p.wpm === bestSpeed ? ["Best lesson speed in this period"] : []), `WPM: ${p.wpm === null ? "—" : Math.round(p.wpm * 10) / 10}`, `CPM: ${p.wpm === null ? "—" : Math.round(p.wpm * 5)}`] }))} />
          )}
        </div>
        <div>
          <h4 className="chart-title">Lesson score</h4>
          {data.series.length === 0 ? <p className="muted small">no data yet</p> : (
            <Chart ariaLabel="Lesson score" line={{ color: "#f3c94d", format: (v) => `${Math.round(v)}` }} points={data.series.map((p, i) => ({ key: `${p.at}-${i}`, label: fmtDay(p.at), line: p.score, highlight: bestScore !== null && p.score === bestScore, tip: [fmtDay(p.at), ...(bestScore !== null && p.score === bestScore ? ["Best lesson score in this period"] : []), `Score: ${p.score}`, `First-attempt accuracy: ${Math.round(p.firstAttemptAccuracy)}%`] }))} />
          )}
        </div>
      </div>
      <div><h4 className="chart-title">Sentences per day</h4>
        <Chart ariaLabel="Sentences and submitted characters per day" bars={{ color: "#6ab7ff", format: (v) => `${Math.round(v)}` }} line={{ color: "#b78bff", format: (v) => Math.round(v).toLocaleString("en-AU") }} legend="Bars: completed sentences; line: submitted characters (right axis), including retries for completed sentences." points={data.daily.map((d) => ({ key: d.date, label: fmtDay(d.date), bar: d.exercises, line: d.chars ?? 0, tip: [fmtDay(d.date), `Sentences: ${d.exercises}`, `Submitted characters: ${(d.chars ?? 0).toLocaleString("en-AU")}`, `Time: ${fmtTotalTime(d.activeSeconds)}`] }))} />
      </div>
      <CumulativeCharacters data={data.daily} submitted />
      <section className="card"><h3>Mistakes by kind</h3>
      {data.errorTypes.length === 0 ? <p className="muted small">No mistakes in first answers in this period.</p> : (
        <table className="data-table small" data-testid="dictation-error-types">
          <thead><tr><th>Kind</th><th>Mistakes</th><th>Share</th></tr></thead>
          <tbody>{data.errorTypes.map((e) => <tr key={e.type}><td>{e.label}</td><td>{e.count}</td><td>{Math.round(e.share)}%</td></tr>)}</tbody>
        </table>
      )}
      <p className="muted small">Found by comparing what you typed with the sentence, without AI, so it is approximate: a written answer cannot say what was misheard. It does not change your Grammar progress.</p>
      </section>
      <section className="card"><h3>Voices</h3>
      {data.voices.length === 0 ? <p className="muted small">no data yet</p> : (
        <table className="data-table small">
          <thead><tr><th>Voice</th><th>Sentences</th><th>First-attempt accuracy</th><th>Replays</th><th>Hint rate</th></tr></thead>
          <tbody>{data.voices.map((v) => <tr key={v.name}><td>{v.name}</td><td>{v.exercises}</td>{v.enoughData ? <><td>{pct(v.firstAttemptAccuracy)}</td><td>{v.avgManualReplays ?? "—"}</td><td>{pct(v.hintRate)}</td></> : <td colSpan={3} className="muted">not enough data (needs 20 sentences)</td>}</tr>)}</tbody>
        </table>
      )}
      </section>
      <section className="card"><h3>Voice balance</h3>
      <table className="data-table small" data-testid="dictation-voice-balance">
        <thead><tr><th>Voice</th><th title="Whisper checks of this voice">Checks</th><th title="Share of voiced attempts that Whisper heard back exactly">Heard back</th><th title="Starting weight x speech check x your Sounds bad marks">Weight</th><th title="Expected share of the sentences">Share</th><th title="Sentences you marked Sounds bad">Marked</th></tr></thead>
        <tbody>{data.voiceBalance.map((v) => <tr key={v.name} className={v.enabled ? undefined : "muted"}><td>{v.name}{v.ageGroup === "adult" ? "" : " (older voice)"}{v.enabled ? "" : " (off)"}</td><td>{v.checks}</td><td>{pct(v.heardRate)}</td><td>{v.weight}</td><td>{v.share}%</td><td>{v.flags}</td></tr>)}</tbody>
      </table>
      <p className="muted small">A voice that the speech check often misses is chosen less, one that is always heard back a little more. Older-sounding voices start with a lower weight and are not given topics such as software or video games. Change the starting weights in Settings → Voices.</p>
      </section>
    </section>
  );
}
