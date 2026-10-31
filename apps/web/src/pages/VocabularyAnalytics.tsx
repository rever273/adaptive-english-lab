import { useEffect, useState } from "react";
import { ApiRequestError, fetchVocabAnalytics, type Rate, type VocabAnalytics as Data } from "../api";

const FAMILY: Record<string, { label: string; icon: string; note: string }> = {
  recognition: { label: "Word in context", icon: "pi-bookmark", note: "choosing the word that fits a sentence" },
  guided_recall: { label: "Recall", icon: "pi-pencil", note: "typing the word from a clue" },
  collocation: { label: "Collocations", icon: "pi-link", note: "the natural partner word or preposition" },
};
/** the list shows the ten most recently practised words; the rest unfolds on request */
const WEAK_SHOWN = 10;
const pct = (r: Rate) => (r.rate === null ? null : Math.round(r.rate * 100));
const day = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short" });

/** a rate with its sample size; below the minimum sample it says so instead of pretending to be a score */
function RateBar({ r, label, icon, note, extra }: { r: Rate; label: string; icon: string; note?: string; extra?: string }) {
  const v = pct(r);
  return (
    <div className="rate-row">
      <div className="rate-head">
        <span><i className={`pi ${icon}`} aria-hidden="true" /> <strong>{label}</strong>{note && <span className="muted small"> · {note}</span>}</span>
        <span className="rate-value">{v === null ? <span className="muted small">insufficient data</span> : `${v}%`}</span>
      </div>
      <span className="bar rate-bar" aria-hidden="true"><span style={{ width: `${v ?? 0}%` }} /></span>
      <span className="muted small">{r.correct} of {r.total} first tries{extra ? ` · ${extra}` : ""}</span>
    </div>
  );
}

/** main chart: per day, first-try accuracy (bars, only days with at least one scored try) and Vocabulary XP (line) */
function DailyChart({ series }: { series: Data["series"] }) {
  if (series.length === 0) return <p className="muted">No vocabulary practice in this period yet.</p>;
  const W = 640;
  const H = 180;
  const pad = 28;
  const n = series.length;
  const bw = Math.max(6, Math.min(36, (W - pad * 2) / n - 6));
  const x = (i: number) => pad + ((W - pad * 2) * (i + 0.5)) / n;
  const maxXp = Math.max(10, ...series.map((s) => s.xp));
  const y = (v: number) => H - pad - v * (H - pad * 2);
  const line = series.map((s, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(s.xp / maxXp).toFixed(1)}`).join(" ");
  return (
    <figure className="chart-wrap">
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Daily first-try accuracy and XP over ${n} day(s)`}>
        {[0, 0.5, 1].map((g) => (
          <g key={g}>
            <line className="chart-grid" x1={pad} x2={W - pad} y1={y(g)} y2={y(g)} />
            <text className="chart-label" x={4} y={y(g) + 3}>{Math.round(g * 100)}%</text>
          </g>
        ))}
        {series.map((s, i) => {
          const r = s.total ? s.correct / s.total : 0;
          return (
            <g key={s.date}>
              {s.total > 0 && <rect className={`chart-bar${s.total < 5 ? " chart-bar-thin" : ""}`} x={x(i) - bw / 2} y={y(r)} width={bw} height={Math.max(1, H - pad - y(r))} rx={3}><title>{`${s.date}: ${s.correct}/${s.total} first tries right, ${s.xp} XP`}</title></rect>}
              {(n <= 14 || i % Math.ceil(n / 10) === 0) && <text className="chart-label" x={x(i)} y={H - 8} textAnchor="middle">{s.date.slice(5)}</text>}
            </g>
          );
        })}
        <path className="chart-line chart-line-xp" d={line} />
        {series.map((s, i) => <circle key={s.date} className="chart-dot chart-dot-xp" cx={x(i)} cy={y(s.xp / maxXp)} r={3}><title>{`${s.date}: ${s.xp} XP`}</title></circle>)}
        <text className="chart-label" x={W - pad} y={12} textAnchor="end">XP max {maxXp}</text>
      </svg>
      <figcaption className="muted small">
        <span className="legend legend-bar" /> first-try accuracy per day (faded = fewer than 5 tries) · <span className="legend legend-xp" /> Vocabulary XP per day
      </figcaption>
    </figure>
  );
}

/**
 * Vocabulary Analytics (vocabulary TZ, stage F): its own filters and figures, all counted on the server from stored events. XP shows
 * activity; accuracy shows first independent tries with their sample size; "learned" is the learner's own flag, not proof.
 */
export function VocabularyAnalytics() {
  const [days, setDays] = useState<"7" | "30" | "90" | "all">(() => {
    try {
      return (localStorage.getItem("vocabAnalytics.days") as "7" | "30" | "90" | "all" | null) ?? "30";
    } catch {
      return "30";
    }
  });
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allWeak, setAllWeak] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem("vocabAnalytics.days", days);
    } catch {
      /* convenience only */
    }
    setD(null);
    fetchVocabAnalytics(days).then(setD).catch((e) => setError(e instanceof ApiRequestError ? e.message : "Cannot load vocabulary analytics."));
  }, [days]);

  return (
    <section className="card" aria-labelledby="va-h" data-testid="vocab-analytics">
      <h2 id="va-h"><i className="pi pi-chart-line" aria-hidden="true" /> Vocabulary analytics</h2>
      <div className="filter-row">
        <div className="segmented" role="radiogroup" aria-label="Period">
          {(["7", "30", "90", "all"] as const).map((v) => (
            <label key={v} className={days === v ? "on" : ""}><input type="radio" name="va-days" checked={days === v} onChange={() => setDays(v)} /> {v === "all" ? "All time" : `${v} days`}</label>
          ))}
        </div>
        {d && <span className="muted small">Time zone {d.window.timezone}. Rates need at least {d.minSample} first tries.</span>}
      </div>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {!d ? (
        !error && <p role="status">Loading…</p>
      ) : (
        <>
          <div className="stat-grid">
            <div className="stat stat-info"><i className="pi pi-bookmark-fill" aria-hidden="true" /><span className="stat-value">Lv {d.xp.level}</span><span className="stat-label">{d.xp.total} Vocabulary XP (activity, not a grade)</span></div>
            <div className="stat stat-ok"><i className="pi pi-check-circle" aria-hidden="true" /><span className="stat-value">{pct(d.overall) === null ? "—" : `${pct(d.overall)}%`}</span><span className="stat-label">first try right · {d.overall.correct}/{d.overall.total}</span></div>
            <div className="stat stat-info"><i className="pi pi-eye" aria-hidden="true" /><span className="stat-value">{d.encounters.uniqueWordsShown}</span><span className="stat-label">your words actually shown · {d.encounters.displays} times</span></div>
            <div className="stat stat-skip"><i className="pi pi-database" aria-hidden="true" /><span className="stat-value">{d.encounters.bankWords}</span><span className="stat-label">words present in approved exercises · {d.encounters.bankContexts} places</span></div>
          </div>

          <h3>Day by day</h3>
          <DailyChart series={d.series} />

          <h3>Three kinds of evidence <span className="muted small">(never added together into one score)</span></h3>
          <div className="rate-grid">
            {(["recognition", "guided_recall", "collocation"] as const).map((f) => (
              <RateBar key={f} r={d.families[f]} label={FAMILY[f]!.label} icon={FAMILY[f]!.icon} note={FAMILY[f]!.note} extra={[d.families[f].assisted ? `${d.families[f].assisted} with a hint (apart)` : "", d.families[f].pending ? `${d.families[f].pending} waiting` : ""].filter(Boolean).join(", ")} />
            ))}
            <RateBar r={d.retention} label="Later, new sentence" icon="pi-replay" note="the same word again in a sentence you had not seen" />
          </div>
          <p className="muted small">Not in any rate: {d.overall.skipped} skipped, {d.overall.assisted} with a hint or the answer shown first, {d.overall.pending} not confirmed yet. “I don’t know” counts as a miss.</p>

          <h3>Words that need another look <span className="muted small">(missed on {d.weakMinMisses}+ first tries)</span></h3>
          {d.weak.length === 0 ? (
            <p className="muted">No word has been missed on {d.weakMinMisses} or more first tries in this period.</p>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th>Word</th><th>Missed first tries</th><th>First tries</th><th>Last result</th><th>First / last seen</th><th>Sentence of the last miss</th></tr></thead>
                <tbody>
                  {(allWeak ? d.weak : d.weak.slice(0, WEAK_SHOWN)).map((w) => (
                    <tr key={w.lemma}>
                      <td className="c"><strong>{w.lemma}</strong></td>
                      <td className="c num">{w.misses}</td>
                      <td className="c num">{w.attempts}</td>
                      <td className="c small">{w.lastResult === "correct" ? <span className="result-chip result-ok"><i className="pi pi-check-circle" aria-hidden="true" /> right</span> : <span className="result-chip result-bad"><i className="pi pi-times-circle" aria-hidden="true" /> missed</span>}</td>
                      <td className="c small nowrap">{day(w.firstSeen)} – {day(w.lastSeen)}</td>
                      <td className="small example">{w.example ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {d.weak.length > WEAK_SHOWN && (
                <div className="actions">
                  <button className="btn btn-small" onClick={() => setAllWeak((v) => !v)} aria-expanded={allWeak} data-testid="weak-toggle">
                    <i className={`pi ${allWeak ? "pi-chevron-up" : "pi-chevron-down"}`} aria-hidden="true" /> {allWeak ? `Show only the latest ${WEAK_SHOWN}` : `Show all ${d.weak.length} words`}
                  </button>
                  {!allWeak && <span className="muted small">The {WEAK_SHOWN} most recently practised are shown.</span>}
                </div>
              )}
            </div>
          )}

          <h3>Your dictionary</h3>
          {d.growth.series.length === 0 ? (
            <p className="muted">No words added or marked learned in this period.</p>
          ) : (
            <ul className="growth">
              {d.growth.series.map((g) => (
                <li key={g.date}>
                  <span className="growth-date">{g.date}</span>
                  <span className="growth-bars">
                    {g.added > 0 && <span className="growth-added" title={`${g.added} added`}>+{g.added} added</span>}
                    {g.learned > 0 && <span className="growth-learned" title={`${g.learned} marked learned`}>{g.learned} marked learned</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">
            {d.growth.learnedNow} word(s) are marked learned now{d.growth.learnedWithoutDate > 0 ? `; ${d.growth.learnedWithoutDate} were marked before dates were recorded` : ""}. “Learned” is your own mark, not a test result.
          </p>
        </>
      )}
    </section>
  );
}
