import { useEffect, useState } from "react";
import { Chart } from "../components/Chart";
import { LineChart } from "../components/LineChart";
import { PracticeActivityChart } from "../components/PracticeActivityChart";
import { fmtDuration } from "../format";
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

/** fixed categorical order for the dark surface (validated: CVD and normal-vision separation, 3:1 contrast) */
const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181"] as const;
const GROUPS: Record<"active" | "weak" | "recent", { label: string; note: string }> = {
  active: { label: "Most practised", note: "the words with the most answers in this period" },
  weak: { label: "Hardest to remember", note: "the lowest strength among words with at least 3 answers" },
  recent: { label: "Latest", note: "the words practised most recently" },
};
const short = (date: string) => date.slice(5);
const MODE: Record<Data["progress"]["modes"][number]["source"], { label: string; icon: string }> = {
  practice: { label: "Vocabulary Practice", icon: "pi-list-check" },
  oneWord: { label: "Single Word", icon: "pi-star" },
  contextLoop: { label: "Context Loop", icon: "pi-sync" },
  checks: { label: "Context Loop checks", icon: "pi-pencil" },
};

/** the four sources side by side: answers, share right, time and words, each bar on its own scale across the modes */
function ModeCompare({ pr }: { pr: Data["progress"] }) {
  const modes = pr.modes.filter((m) => m.answers > 0 || m.timeMs > 0);
  if (modes.length === 0) return <p className="muted">No practice in this period yet.</p>;
  const maxA = Math.max(1, ...modes.map((m) => m.answers));
  const maxT = Math.max(1, ...modes.map((m) => m.timeMs));
  return (
    <div className="mode-cmp" data-testid="vocab-mode-compare">
      {modes.map((m) => {
        const rate = m.answers ? m.right / m.answers : null;
        return (
          <div className="mode-cmp-card" key={m.source}>
            <div className="mode-cmp-head"><i className={`pi ${MODE[m.source].icon}`} aria-hidden="true" /> <strong>{MODE[m.source].label}</strong></div>
            <div className="mode-cmp-row"><span>Answers</span><span className="mode-bar"><span style={{ width: `${(m.answers / maxA) * 100}%` }} /></span><span className="num">{m.answers}</span></div>
            <div className="mode-cmp-row"><span>Right</span><span className="mode-bar mode-bar-ok"><span style={{ width: `${(rate ?? 0) * 100}%` }} /></span><span className="num">{rate === null ? "—" : `${Math.round(rate * 100)}%`}</span></div>
            <div className="mode-cmp-row"><span>Time</span><span className="mode-bar mode-bar-time"><span style={{ width: `${(m.timeMs / maxT) * 100}%` }} /></span><span className="num">{fmtDuration(m.timeMs)}</span></div>
            <div className="muted small">{m.words} word(s){m.answers > 0 && m.timeMs > 0 ? ` · ${Math.round(m.timeMs / m.answers / 1000)} s per answer` : ""}</div>
          </div>
        );
      })}
    </div>
  );
}

/** the words that took the most time in the period, as horizontal bars */
function TimeTop({ pr }: { pr: Data["progress"] }) {
  if (pr.timeTop.length === 0) return <p className="muted">No timed practice in this period yet.</p>;
  const max = Math.max(1, ...pr.timeTop.map((w) => w.timeMs));
  return (
    <ul className="time-top" role="list" data-testid="vocab-time-top">
      {pr.timeTop.map((w) => (
        <li key={w.entryId} title={`${w.lemma}: ${fmtDuration(w.timeMs)}, ${w.answers} answer(s)`}>
          <span className="time-top-word">{w.lemma}</span>
          <span className="mode-bar mode-bar-time"><span style={{ width: `${(w.timeMs / max) * 100}%` }} /></span>
          <span className="num small">{fmtDuration(w.timeMs)}</span>
        </li>
      ))}
    </ul>
  );
}

/** right and not-right answers per day (or week), all three vocabulary modes together */
function AnswersChart({ pr }: { pr: Data["progress"] }) {
  const pts = pr.points.filter((p) => p.right + p.missed > 0);
  if (pts.length === 0) return <p className="muted">No answers in this period yet.</p>;
  const unit = pr.grouping === "week" ? "week to" : "";
  return (
    <Chart
      ariaLabel={`Right and not-right answers per ${pr.grouping}`}
      bars={{ color: "#0ca30c", format: (v) => `${Math.round(v)}` }}
      bars2={{ color: "#d03b3b", format: (v) => `${Math.round(v)}` }}
      points={pr.points.map((p) => ({
        key: p.date,
        label: short(p.date),
        bar: p.right + p.missed > 0 ? p.right : null,
        bar2: p.right + p.missed > 0 ? p.missed : null,
        tip: [`${unit} ${p.date}`.trim(), `Right: ${p.right}`, `Not right: ${p.missed}`, p.right + p.missed > 0 ? `${Math.round((p.right / (p.right + p.missed)) * 100)}% right` : "No answers", `${p.words} word(s) practised`],
      }))}
      legend="Green: answers right · red: missed, “I don’t know” or with a hint. Practice, Single Word and Context Loop together."
    />
  );
}

/** the dictionary over time as lines: saved, being practised, strong by the strength figure, and the learner's own mark */
function WordsOverTime({ pr }: { pr: Data["progress"] }) {
  if (pr.points.every((p) => p.total === 0)) return <p className="muted">No saved words yet.</p>;
  return (
    <LineChart
      ariaLabel="Saved, practised, strong and marked-learned words over time"
      labels={pr.points.map((p) => short(p.date))}
      tips={pr.points.map((p) => (pr.grouping === "week" ? `Week to ${p.date}` : p.date))}
      series={[
        { key: "total", name: "Saved", color: SERIES[0], values: pr.points.map((p) => p.total) },
        { key: "practised", name: "Practised", color: SERIES[1], values: pr.points.map((p) => p.learning + p.strong) },
        { key: "strong", name: `Strong (≥ ${pr.strong})`, color: SERIES[2], values: pr.points.map((p) => p.strong) },
        { key: "marked", name: "Marked learned", color: SERIES[3], values: pr.points.map((p) => p.markedLearned), dashed: true },
      ]}
      note={`Strong = word strength ${pr.strong} or more out of 10, counted from your answers (${pr.strengthVersion}); “Marked learned” is your own mark.`}
    />
  );
}

/** how strong the practised words are now, in bands of two points */
function StrengthBands({ pr, unpractised }: { pr: Data["progress"]; unpractised: number }) {
  if (pr.practisedWords === 0) return <p className="muted">No word has been practised yet.</p>;
  return (
    <Chart
      ariaLabel="Practised words by strength now"
      height={200}
      bars={{ color: "#3987e5", format: (v) => `${Math.round(v)}` }}
      points={pr.bands.map((b) => ({ key: `${b.from}`, label: `${b.from}–${b.to}`, bar: b.words, highlight: b.from >= pr.strong - 1, tip: [`Strength ${b.from}–${b.to}`, `${b.words} word(s)`] }))}
      legend={`${pr.practisedWords} practised word(s) by strength now (0–10); ${unpractised} saved word(s) not practised yet.`}
    />
  );
}

/** strength of a few words day by day, switchable between the most practised, the hardest and the latest */
function WordTracks({ pr }: { pr: Data["progress"] }) {
  const [group, setGroup] = useState<"active" | "weak" | "recent">("active");
  const ids = pr.groups[group];
  const byId = new Map(pr.tracks.map((t) => [t.entryId, t]));
  const tracks = ids.map((id) => byId.get(id)!).filter(Boolean);
  return (
    <div>
      <div className="seg" role="tablist" aria-label="Which words">
        {(Object.keys(GROUPS) as Array<keyof typeof GROUPS>).map((g) => (
          <button key={g} role="tab" aria-selected={group === g} className={`seg-btn${group === g ? " active" : ""}`} onClick={() => setGroup(g)} disabled={pr.groups[g].length === 0}>{GROUPS[g].label}</button>
        ))}
      </div>
      <p className="muted small">{GROUPS[group].note}.</p>
      {tracks.length === 0 ? (
        <p className="muted">No word fits here in this period.</p>
      ) : (
        <>
          <LineChart
            ariaLabel={`Strength of ${tracks.map((t) => t.lemma).join(", ")} over time`}
            labels={pr.points.map((p) => short(p.date))}
            tips={pr.points.map((p) => (pr.grouping === "week" ? `Week to ${p.date}` : p.date))}
            series={tracks.map((t, i) => ({ key: t.entryId, name: t.lemma, color: SERIES[i % SERIES.length]!, values: t.strength }))}
            max={10}
            format={(v) => (Number.isInteger(v) ? `${v}` : v.toFixed(1))}
            reference={{ value: pr.strong, label: "strong" }}
          />
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Word</th><th>Strength now</th><th>Right</th><th>Not right</th><th>Time</th><th>Answers in all</th></tr></thead>
              <tbody>
                {tracks.map((t, i) => {
                  const right = t.right.reduce((a, b) => a + b, 0);
                  const missed = t.missed.reduce((a, b) => a + b, 0);
                  return (
                    <tr key={t.entryId}>
                      <td><i className="lc-key" style={{ background: SERIES[i % SERIES.length], borderColor: SERIES[i % SERIES.length] }} /> <strong>{t.lemma}</strong></td>
                      <td className="c num">{t.now.toFixed(1)}</td>
                      <td className="c num">{right}</td>
                      <td className="c num">{missed}</td>
                      <td className="c num">{fmtDuration(t.timeMs)}</td>
                      <td className="c num">{t.evidence}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Vocabulary Analytics (vocabulary TZ, stage F): its own filters and figures, all counted on the server from stored events. XP shows
 * activity; accuracy shows first independent tries with their sample size; "learned" is the learner's own flag, not proof.
 */
export function VocabularyAnalytics({ days = "30" }: { days?: "7" | "30" | "90" | "all" }) {
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allWeak, setAllWeak] = useState(false);
  useEffect(() => {
    setD(null);
    fetchVocabAnalytics(days).then(setD).catch((e) => setError(e instanceof ApiRequestError ? e.message : "Cannot load vocabulary analytics."));
  }, [days]);

  return (
    <section className="card" aria-labelledby="va-h" data-testid="vocab-analytics">
      <h2 id="va-h"><i className="pi pi-chart-line" aria-hidden="true" /> Vocabulary analytics</h2>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {!d ? (
        !error && <p role="status">Loading…</p>
      ) : (
        <>
          <div className="stat-grid-2 vocab-analytics-stats">
            <div className="stat stat-info"><i className="pi pi-bookmark-fill" aria-hidden="true" /><span className="stat-value">Lv {d.xp.level}</span><span className="stat-label">{d.xp.total} Vocabulary XP (activity, not a grade)</span></div>
            <div className="stat stat-ok"><i className="pi pi-check-circle" aria-hidden="true" /><span className="stat-value">{pct(d.overall) === null ? "—" : `${pct(d.overall)}%`}</span><span className="stat-label">first try right · {d.overall.correct}/{d.overall.total}</span></div>
            <div className="stat stat-info"><i className="pi pi-eye" aria-hidden="true" /><span className="stat-value">{d.encounters.uniqueWordsShown}</span><span className="stat-label">your words actually shown · {d.encounters.displays} times</span></div>
            <div className="stat stat-info"><i className="pi pi-book" aria-hidden="true" /><span className="stat-value">{d.encounters.typedInBooks.words}</span><span className="stat-label">your words typed in Books · {d.encounters.typedInBooks.occurrences} times</span></div>
            <div className="stat stat-info"><i className="pi pi-check-square" aria-hidden="true" /><span className="stat-value">{d.growth.learnedNow}</span><span className="stat-label">words marked learned</span></div>
            <div className="stat stat-skip"><i className="pi pi-database" aria-hidden="true" /><span className="stat-value">{d.encounters.bankWords}</span><span className="stat-label">words present in approved exercises · {d.encounters.bankContexts} places</span></div>
          </div>

          <div className="charts-grid"><PracticeActivityChart mode="vocabulary" days={days} /><div><h3>Answers by {d.progress.grouping}</h3><AnswersChart pr={d.progress} /></div></div>

          <div className="charts-grid">
            <div><h3>Your words over time</h3><WordsOverTime pr={d.progress} /></div>
            <div><h3>Strength now</h3><StrengthBands pr={d.progress} unpractised={d.progress.points.at(-1)?.notStarted ?? 0} /></div>
          </div>

          <h3>Modes side by side <span className="muted small">({fmtDuration(d.progress.timeTotalMs)} on words in this period)</span></h3>
          <ModeCompare pr={d.progress} />
          <p className="muted small">Time: Practice = how long each answer took; Single Word = a finished pass; Context Loop = from the previous card to the answer. Each piece is capped, so a pause away from the screen does not count.</p>

          <h3>Word progress <span className="muted small">(strength 0–10 by {d.progress.grouping})</span></h3>
          <WordTracks pr={d.progress} />
          <h3>Where your time went <span className="muted small">(top 10 words)</span></h3>
          <TimeTop pr={d.progress} />
          <p className="muted small">
            {d.growth.learnedNow} word(s) are marked learned now{d.growth.learnedWithoutDate > 0 ? `; ${d.growth.learnedWithoutDate} were marked before dates were recorded` : ""}. “Learned” is your own mark, not a test result.
          </p>

          <h3>Three kinds of evidence <span className="muted small">(never added together into one score)</span></h3>
          <div className="rate-grid">
            {(["recognition", "guided_recall", "collocation"] as const).map((f) => (
              <RateBar key={f} r={d.families[f]} label={FAMILY[f]!.label} icon={FAMILY[f]!.icon} note={FAMILY[f]!.note} extra={[d.families[f].assisted ? `${d.families[f].assisted} with a hint (apart)` : "", d.families[f].pending ? `${d.families[f].pending} waiting` : ""].filter(Boolean).join(", ")} />
            ))}
            <RateBar r={d.retention} label="Later, new sentence" icon="pi-replay" note="the same word again in a sentence you had not seen" />
          </div>
          <p className="muted small">Not in any rate: {d.overall.skipped} skipped, {d.overall.assisted} with a hint or the answer shown first, {d.overall.pending} not confirmed yet. “I don’t know” counts as a miss.</p>

          <div className="card"><h3>Words that need another look <span className="muted small">(missed on {d.weakMinMisses}+ first tries)</span></h3>
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

          </div>
        </>
      )}
    </section>
  );
}
