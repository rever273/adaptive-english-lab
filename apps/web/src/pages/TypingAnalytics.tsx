import { useEffect, useState } from "react";
import { fetchTypingAnalytics, type TypingAnalyticsData as Data } from "../api";
import { Chart } from "../components/Chart";
import { fmtTotalTime } from "../format";
import { TypingDictationAnalytics } from "./TypingDictationAnalytics";

const fmtDay = (iso: string) => new Date(iso.slice(0, 10) + "T00:00:00").toLocaleDateString("en-AU", { day: "numeric", month: "short" });
const fmtWpm = (v: number | null) => (v === null ? "—" : String(Math.round(v)));

const SERIES_COLOR = { wpm: "#6ab7ff", accuracy: "#51b788", score: "#f3c94d", duration: "#b78bff" } as const;

function LineChart({ title, points, unit, color, cpm }: { title: string; points: Data["series"]["wpm"]; unit: string; color: keyof typeof SERIES_COLOR; cpm?: boolean }) {
  if (points.length === 0) return <figure className="chart-wrap"><figcaption className="muted small">{title}: no data yet</figcaption></figure>;
  const fmt = (v: number) => `${Math.round(v * 10) / 10}${unit}`;
  return (
    <div>
      <h4 className="chart-title">{title}</h4>
      <Chart
        ariaLabel={title}
        line={{ color: SERIES_COLOR[color], format: fmt }}
        points={points.map((p, i) => ({ key: `${p.at}-${i}`, label: fmtDay(p.at), line: p.value, muted: p.status !== "completed", tip: [fmtDay(p.at), `${title}: ${fmt(p.value)}`, ...(cpm ? [`CPM: ${Math.round(p.value * 5)}`] : []), `Attempt: ${p.status}`] }))}
        secondary={cpm ? { factor: 5, color: "#9aa4b8", format: (v) => `${Math.round(v)}` } : undefined}
        legend={cpm ? "Left axis: WPM · right axis: CPM (characters per minute = WPM × 5) · hollow points are failed or interrupted attempts" : "Hollow points are failed or interrupted attempts"}
      />
    </div>
  );
}

type Mode = "words" | "books" | "dictation";
type Days = "7" | "30" | "90" | "all";

function Toolbar({ mode, setMode, days, setDays }: { mode: Mode; setMode: (m: Mode) => void; days: Days; setDays: (d: Days) => void }) {
  return (
    <div className="analytics-toolbar">
      <div className="segmented" role="radiogroup" aria-label="Typing mode">
        {(["words", "books", "dictation"] as const).map((m) => (
          <label key={m} className={mode === m ? "on" : ""}><input type="radio" name="typing-mode" checked={mode === m} onChange={() => setMode(m)} /> {m === "words" ? "Words" : m === "books" ? "Books" : "Audio Dictation"}</label>
        ))}
      </div>
      <div className="segmented" role="radiogroup" aria-label="Period">
        {(["7", "30", "90", "all"] as const).map((d) => (
          <label key={d} className={days === d ? "on" : ""}><input type="radio" name="typing-days" checked={days === d} onChange={() => setDays(d)} /> {d === "all" ? "All" : `${d}d`}</label>
        ))}
      </div>
    </div>
  );
}

/** slow and often mistyped letter pairs (Words and Books together); the next Words levels favour them a little */
function KeyInsights({ data }: { data: Data["keyInsights"] }) {
  if (data.slowPairs.length === 0 && data.errorPairs.length === 0) return <p className="muted small">Letter pairs: collected as you play Words and Books; a few levels are needed first.</p>;
  return (
    <div className="card key-insights">
      <h4 className="chart-title">Letter pairs to practise</h4>
      <div className="key-insights-cols">
        <div>
          <p className="small"><strong>Slowest</strong>{data.typicalMs !== null && <span className="muted"> (typical gap {data.typicalMs} ms)</span>}</p>
          <ul className="small">{data.slowPairs.map((p) => <li key={p.pair}><code>{p.pair}</code> · {p.meanMs} ms · {p.count}×</li>)}</ul>
        </div>
        <div>
          <p className="small"><strong>Most mistyped</strong></p>
          <ul className="small">{data.errorPairs.length === 0 ? <li className="muted">none yet</li> : data.errorPairs.map((p) => <li key={p.pair}><code>{p.pair}</code> · {Math.round(p.errorRate * 100)}% wrong · {p.count}×</li>)}</ul>
        </div>
      </div>
      <p className="muted small">About one word in ten in the next Words levels contains one of the weakest pairs. The time is the gap between two correct key presses (pauses over 2 s are ignored).</p>
    </div>
  );
}

/** the dictation mode has its own endpoint: its value never reaches the Words/Books analytics request */
export function TypingAnalytics() {
  const [mode, setMode] = useState<Mode>("words");
  const [days, setDays] = useState<Days>("30");
  const toolbar = <Toolbar mode={mode} setMode={setMode} days={days} setDays={setDays} />;
  if (mode === "dictation") return <TypingDictationAnalytics days={days} toolbar={toolbar} />;
  return <ClassicAnalytics mode={mode} days={days} toolbar={toolbar} />;
}

function ClassicAnalytics({ mode, days, toolbar }: { mode: "words" | "books"; days: Days; toolbar: React.ReactNode }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let off = false;
    fetchTypingAnalytics(mode, days)
      .then((d) => { if (!off) setData(d); })
      .catch((e) => { if (!off) setError(e instanceof Error ? e.message : String(e)); });
    return () => { off = true; };
  }, [mode, days]);

  if (error) return <p role="alert">{error}</p>;
  if (!data) return <p className="muted">Loading typing analytics…</p>;

  const s = data.summary;
  return (
    <section aria-label="Typing analytics">
      {toolbar}

      {/* the first nine tiles are the same, in the same order, in Words, Books and Audio Dictation; what differs comes last */}
      <div className="stat-grid-2">
        <div className="stat"><span className="stat-num">{fmtTotalTime(s.totalActiveMs / 1000)}</span><span className="stat-label">total practice time</span></div>
        <div className="stat"><span className="stat-num">{s.completed}</span><span className="stat-label">completed levels</span></div>
        <div className="stat"><span className="stat-num">{s.attempts}</span><span className="stat-label">attempts</span></div>
        <div className="stat"><span className="stat-num">{fmtWpm(s.avgWpm)}</span><span className="stat-label">average WPM</span></div>
        <div className="stat"><span className="stat-num">{fmtWpm(s.maxWpm)}</span><span className="stat-label">best WPM</span></div>
        <div className="stat" title="Characters per minute: correct characters per minute of active time (WPM × 5)"><span className="stat-num">{s.avgWpm === null ? "—" : Math.round(s.avgWpm * 5)}</span><span className="stat-label">average CPM</span></div>
        <div className="stat"><span className="stat-num">{s.avgAccuracy === null ? "—" : `${Math.round(s.avgAccuracy)}%`}</span><span className="stat-label">average accuracy</span></div>
        <div className="stat"><span className="stat-num">{s.maxScore ?? "—"}</span><span className="stat-label">best score</span></div>
        <div className="stat" title="Every key pressed in finished attempts, wrong ones included"><span className="stat-num">{(s.totalChars ?? 0).toLocaleString("en-AU")}</span><span className="stat-label">characters typed</span></div>
        <div className="stat" title={mode === "books" ? "Longest run of characters typed correctly in a row (Precision Combo)" : "Most words in a row destroyed without a wrong key"}><span className="stat-num">{s.bestCombo ?? "—"}</span><span className="stat-label">best combo ({mode === "books" ? "characters" : "words"})</span></div>
        {mode === "words" && <div className="stat"><span className="stat-num">{s.failed}</span><span className="stat-label">failed attempts</span></div>}
      </div>

      {mode === "words" && s.wordsShown !== undefined && (
        <p className="muted small">Words shown {s.wordsShown} · destroyed {s.wordsDestroyed} (all-time).</p>
      )}
      {mode === "books" && s.currentLevel !== undefined && (
        <p className="muted small">Current level {s.currentLevel}{s.chapter ? ` · ${s.chapter}` : ""}{s.percentRead !== null ? ` · ${s.percentRead}% read` : ""}.</p>
      )}

      {s.recall && s.recall.words > 0 && (
        <p className="muted small">Memory check after levels: {s.recall.checks} checks · {s.recall.words} words · {s.recall.withoutHelpRate === null ? "—" : `${Math.round(s.recall.withoutHelpRate)}%`} typed from memory without help · {s.recall.avgPoints ?? "—"} points per word on average.</p>
      )}

      <div className="charts-grid">
        <LineChart title="Typing speed over time" points={data.series.wpm} unit=" wpm" color="wpm" cpm />
        <LineChart title="Accuracy over time" points={data.series.accuracy} unit="%" color="accuracy" />
        <LineChart title="Score over time" points={data.series.score} unit="" color="score" />
        <LineChart title="Practice duration" points={data.series.duration} unit=" s" color="duration" />
      </div>

      <DailyActivity data={data.series.daily} />
      <PersonalBest data={data.series.personalBest} />

      <KeyInsights data={data.keyInsights} />

      {s.last && (
        <div className="card">
          <h3>Last result</h3>
          <p className="small">
            Level {s.last.level} · {s.last.status} · {Math.round(s.last.metrics.wpm)} WPM · {s.last.metrics.accuracy === null ? "—" : `${Math.round(s.last.metrics.accuracy)}%`} accuracy · score {s.last.metrics.score} · {s.last.xpAwarded} XP
          </p>
        </div>
      )}
    </section>
  );
}

function DailyActivity({ data }: { data: Data["series"]["daily"] }) {
  const active = data.filter((d) => d.attempts > 0);
  if (active.length === 0) return <p className="muted">No typing activity in this period yet.</p>;
  return (
    <div>
      <h4 className="chart-title">Daily activity</h4>
      <Chart
        ariaLabel="Daily activity"
        bars={{ color: "#3fbf6f", format: (v) => fmtTotalTime(v) }}
        points={data.map((d) => ({ key: d.date, label: fmtDay(d.date), bar: d.activeSeconds, tip: [fmtDay(d.date), `Practice time: ${fmtTotalTime(d.activeSeconds)}`, `Attempts: ${d.attempts}`, `Characters typed: ${(d.chars ?? 0).toLocaleString("en-AU")}`] }))}
        legend="Practice time per day; empty days are zero"
      />
    </div>
  );
}

function PersonalBest({ data }: { data: Data["series"]["personalBest"] }) {
  if (data.length === 0) return <p className="muted">No completed levels yet, so there is no personal best to show.</p>;
  const last = data[data.length - 1]!;
  return (
    <div className="card">
      <h3>Personal best</h3>
      <p className="small">
        Best WPM <strong>{Math.round(last.wpm)}</strong> · best score <strong>{last.score}</strong> (first reached {fmtDay(last.at)}).
      </p>
    </div>
  );
}
