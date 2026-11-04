import { useEffect, useState } from "react";
import { fetchTypingAnalytics, type TypingAnalyticsData as Data } from "../api";
import { Chart } from "../components/Chart";
import { fmtTotalTime } from "../format";

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

export function TypingAnalytics() {
  const [mode, setMode] = useState<"words" | "books">("words");
  const [days, setDays] = useState<"7" | "30" | "90" | "all">("30");
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
      <div className="analytics-toolbar">
        <div className="segmented" role="radiogroup" aria-label="Typing mode">
          <label className={mode === "words" ? "on" : ""}><input type="radio" name="typing-mode" checked={mode === "words"} onChange={() => setMode("words")} /> Words</label>
          <label className={mode === "books" ? "on" : ""}><input type="radio" name="typing-mode" checked={mode === "books"} onChange={() => setMode("books")} /> Books</label>
        </div>
        <div className="segmented" role="radiogroup" aria-label="Period">
          {(["7", "30", "90", "all"] as const).map((d) => (
            <label key={d} className={days === d ? "on" : ""}><input type="radio" name="typing-days" checked={days === d} onChange={() => setDays(d)} /> {d === "all" ? "All" : `${d}d`}</label>
          ))}
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat"><span className="stat-num">{fmtTotalTime(s.totalActiveMs / 1000)}</span><span className="stat-label">total practice time</span></div>
        <div className="stat"><span className="stat-num">{s.attempts}</span><span className="stat-label">attempts</span></div>
        <div className="stat"><span className="stat-num">{s.completed}</span><span className="stat-label">completed levels</span></div>
        {mode === "words" && <div className="stat"><span className="stat-num">{s.failed}</span><span className="stat-label">failed attempts</span></div>}
        <div className="stat"><span className="stat-num">{fmtWpm(s.avgWpm)}</span><span className="stat-label">average WPM</span></div>
        <div className="stat"><span className="stat-num">{fmtWpm(s.maxWpm)}</span><span className="stat-label">best WPM</span></div>
        <div className="stat" title="Characters per minute: correct characters per minute of active time (WPM × 5)"><span className="stat-num">{s.avgWpm === null ? "—" : Math.round(s.avgWpm * 5)}</span><span className="stat-label">average CPM</span></div>
        <div className="stat"><span className="stat-num">{s.avgAccuracy === null ? "—" : `${Math.round(s.avgAccuracy)}%`}</span><span className="stat-label">average accuracy</span></div>
        <div className="stat"><span className="stat-num">{s.maxScore ?? "—"}</span><span className="stat-label">best score</span></div>
      </div>

      {mode === "words" && s.wordsShown !== undefined && (
        <p className="muted small">Words shown {s.wordsShown} · destroyed {s.wordsDestroyed} (all-time).</p>
      )}
      {mode === "books" && s.currentLevel !== undefined && (
        <p className="muted small">Current level {s.currentLevel}{s.chapter ? ` · ${s.chapter}` : ""}{s.percentRead !== null ? ` · ${s.percentRead}% read` : ""}.</p>
      )}

      <div className="charts-grid">
        <LineChart title="Typing speed over time" points={data.series.wpm} unit=" wpm" color="wpm" cpm />
        <LineChart title="Accuracy over time" points={data.series.accuracy} unit="%" color="accuracy" />
        <LineChart title="Score over time" points={data.series.score} unit="" color="score" />
        <LineChart title="Practice duration" points={data.series.duration} unit=" s" color="duration" />
      </div>

      <DailyActivity data={data.series.daily} />
      <PersonalBest data={data.series.personalBest} />

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
        points={data.map((d) => ({ key: d.date, label: fmtDay(d.date), bar: d.activeSeconds, tip: [fmtDay(d.date), `Practice time: ${fmtTotalTime(d.activeSeconds)}`, `Attempts: ${d.attempts}`] }))}
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
