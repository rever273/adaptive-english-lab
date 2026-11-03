import { useEffect, useState } from "react";
import { fetchTypingAnalytics, type TypingAnalyticsData as Data } from "../api";

const fmtDay = (iso: string) => new Date(iso.slice(0, 10) + "T00:00:00").toLocaleDateString("en-AU", { day: "numeric", month: "short" });
const fmtDur = (s: number) => (s >= 60 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);
const fmtWpm = (v: number | null) => (v === null ? "—" : String(Math.round(v)));

function LineChart({ title, points, unit, color }: { title: string; points: Data["series"]["wpm"]; unit: string; color: "wpm" | "accuracy" | "score" | "duration" }) {
  if (points.length === 0) return <figure className="chart-wrap"><figcaption className="muted small">{title}: no data yet</figcaption></figure>;
  const W = 640;
  const H = 160;
  const pad = 28;
  const xs = points.map((_, i) => pad + ((W - pad * 2) * i) / Math.max(1, points.length - 1));
  const max = Math.max(1, ...points.map((p) => p.value));
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${xs[i]!.toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  return (
    <figure className="chart-wrap">
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
        <line className="chart-grid" x1={pad} x2={W - pad} y1={H - pad} y2={H - pad} />
        <line className="chart-grid" x1={pad} x2={W - pad} y1={pad} y2={pad} />
        <text className="chart-label" x={4} y={pad + 3}>{Math.round(max)}{unit}</text>
        <text className="chart-label" x={4} y={H - pad + 3}>0</text>
        <path className={`chart-line chart-line-${color}`} d={line} />
        {points.map((p, i) => (
          <circle key={i} className={`chart-dot chart-dot-${color}${p.status !== "completed" ? " chart-dot-muted" : ""}`} cx={xs[i]!} cy={y(p.value)} r={3}>
            <title>{`${fmtDay(p.at)}: ${Math.round(p.value)}${unit} (${p.status})`}</title>
          </circle>
        ))}
      </svg>
      <figcaption className="muted small">{title} · faded points are failed or interrupted attempts</figcaption>
    </figure>
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
        <div className="stat"><span className="stat-num">{fmtDur(s.totalActiveMs / 1000)}</span><span className="stat-label">total practice time</span></div>
        <div className="stat"><span className="stat-num">{s.attempts}</span><span className="stat-label">attempts</span></div>
        <div className="stat"><span className="stat-num">{s.completed}</span><span className="stat-label">completed levels</span></div>
        {mode === "words" && <div className="stat"><span className="stat-num">{s.failed}</span><span className="stat-label">failed attempts</span></div>}
        <div className="stat"><span className="stat-num">{fmtWpm(s.avgWpm)}</span><span className="stat-label">average WPM</span></div>
        <div className="stat"><span className="stat-num">{fmtWpm(s.maxWpm)}</span><span className="stat-label">best WPM</span></div>
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
        <LineChart title="Typing speed over time" points={data.series.wpm} unit=" wpm" color="wpm" />
        <LineChart title="Accuracy over time" points={data.series.accuracy} unit="%" color="accuracy" />
        <LineChart title="Score over time" points={data.series.score} unit="" color="score" />
        <LineChart title="Practice duration" points={data.series.duration} unit="s" color="duration" />
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
  const W = 640;
  const H = 120;
  const pad = 20;
  const max = Math.max(1, ...data.map((d) => d.activeSeconds));
  const bw = Math.max(3, (W - pad * 2) / data.length - 2);
  const x = (i: number) => pad + ((W - pad * 2) * (i + 0.5)) / data.length;
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
  return (
    <figure className="chart-wrap">
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Daily activity">
        {data.map((d, i) => (
          <rect key={d.date} className="chart-bar" x={x(i) - bw / 2} y={y(d.activeSeconds)} width={bw} height={Math.max(1, H - pad - y(d.activeSeconds))} rx={2}>
            <title>{`${d.date}: ${d.attempts} attempts, ${fmtDur(d.activeSeconds)}`}</title>
          </rect>
        ))}
      </svg>
      <figcaption className="muted small">Daily activity (practice seconds per day; empty days are zero)</figcaption>
    </figure>
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
