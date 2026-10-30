import { useCallback, useEffect, useState } from "react";
import { ApiRequestError, createExport, decideExternalReport, fetchExternal, fetchFindings, fetchReport, importExternalReport, type DiscoveryAuditData, type ExternalData, type FindingData, type Ratio, type SavedReportData } from "../api";

const pct = (x: number | null): string => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);
const frac = (r: Ratio): string => (r.denominator === 0 ? "no data yet" : `${r.numerator} of ${r.denominator}`);
const range = (r: Ratio): string => (r.wilson ? `${pct(r.wilson.low)}–${pct(r.wilson.high)}` : "—");

function Cell({ r }: { r: Ratio }) {
  return (
    <>
      <td>{r.denominator === 0 ? <span className="muted">unknown</span> : <strong>{pct(r.rate)}</strong>}</td>
      <td>{frac(r)}</td>
      <td>{range(r)}</td>
      <td>{r.denominator > 0 && r.lowN ? <span className="badge badge-warn">few answers</span> : null}</td>
    </>
  );
}

/** held-out accuracy by week with Wilson whiskers; weeks without data are GAPS, never zeros */
function WeeklyChart({ points }: { points: Array<{ week: string; r: Ratio }> }) {
  if (points.length === 0 || points.every((p) => p.r.rate === null)) return <p className="muted">No held-out answers yet. A delayed check opens once a skill has been practised for 7 days.</p>;
  const W = 640;
  const H = 180;
  const pad = 30;
  const x = (i: number) => pad + (points.length === 1 ? (W - 2 * pad) / 2 : (i * (W - 2 * pad)) / (points.length - 1));
  const y = (v: number) => H - pad - v * (H - 2 * pad);
  const segs: string[] = [];
  let cur: string[] = [];
  points.forEach((p, i) => {
    if (p.r.rate === null) {
      if (cur.length > 1) segs.push(cur.join(" "));
      cur = [];
    } else cur.push(`${x(i)},${y(p.r.rate)}`);
  });
  if (cur.length > 1) segs.push(cur.join(" "));
  return (
    <svg role="img" aria-label="Held-out accuracy by week with 95% intervals" viewBox={`0 0 ${W} ${H}`} className="chart">
      {[0, 0.5, 1].map((t) => (
        <g key={t}>
          <line x1={pad} x2={W - pad} y1={y(t)} y2={y(t)} className="chart-grid" />
          <text x={4} y={y(t) + 4} className="chart-label">{t * 100}%</text>
        </g>
      ))}
      {segs.map((s, i) => (
        <polyline key={i} points={s} className="chart-line" />
      ))}
      {points.map((p, i) =>
        p.r.rate === null || !p.r.wilson ? (
          <text key={p.week} x={x(i)} y={H - 8} textAnchor="middle" className="chart-label">·</text>
        ) : (
          <g key={p.week}>
            <line x1={x(i)} x2={x(i)} y1={y(p.r.wilson.low)} y2={y(p.r.wilson.high)} className="chart-whisker" />
            <circle cx={x(i)} cy={y(p.r.rate)} r={4} className={p.r.lowN ? "chart-dot chart-dot-low" : "chart-dot"} />
          </g>
        ),
      )}
    </svg>
  );
}

function ExternalSection() {
  const [series, setSeries] = useState<ExternalData[]>([]);
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<ExternalData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [format, setFormat] = useState<"md" | "json">("md");
  const [source, setSource] = useState("");
  const [date, setDate] = useState("");
  const [method, setMethod] = useState("");
  const load = useCallback(async () => {
    try {
      const r = await fetchExternal();
      setSeries(r.series.filter((x) => x.status === "approved"));
      setNote(r.note);
    } catch {
      /* the section simply stays empty */
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const doPreview = async () => {
    setErr(null);
    try {
      setPreview(await importExternalReport({ format, text, source, assessedAt: date, method }));
    } catch (e) {
      setErr(e instanceof ApiRequestError ? e.message : "Could not read that report.");
    }
  };
  const decide = async (d: "confirm" | "reject") => {
    if (!preview) return;
    try {
      await decideExternalReport(preview.id, d);
      setPreview(null);
      setText("");
      await load();
    } catch (e) {
      setErr(e instanceof ApiRequestError ? e.message : "Could not save.");
    }
  };
  return (
    <section className="card" aria-labelledby="x-h" data-testid="external">
      <h2 id="x-h">Outside assessments</h2>
      <p className="lede">Reports from somewhere else (a tutor, another tool). They are kept as their own series and are never added to your scores.</p>
      {series.length > 0 && (
        <ul>
          {series.map((x) => (
            <li key={x.id}><strong>{x.assessedAt}</strong> · {x.source} · {x.method} — {x.normalized.assertions.length} statements, {x.normalized.assertions.filter((a) => a.percent !== null).length} with percentages <span className="muted small">(not comparable with the numbers above)</span></li>
          ))}
        </ul>
      )}
      {note && series.length > 0 && <p className="muted small">{note}</p>}
      <details>
        <summary>Add an outside report</summary>
        {err && <p className="notice notice-error" role="alert">{err}</p>}
        <div className="form-grid">
          <label>Source<input value={source} onChange={(e) => setSource(e.target.value)} /></label>
          <label>Date assessed<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label>Method<input value={method} onChange={(e) => setMethod(e.target.value)} /></label>
          <label>Format<select value={format} onChange={(e) => setFormat(e.target.value as "md" | "json")}><option value="md">Markdown</option><option value="json">JSON</option></select></label>
        </div>
        <label className="small" htmlFor="ext-text">Report text (up to 1 MB)</label>
        <textarea id="ext-text" rows={6} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="actions"><button className="btn" disabled={!text.trim() || !source.trim() || !date || !method.trim()} onClick={() => void doPreview()}>Preview</button></div>
        {preview && (
          <div data-testid="external-preview">
            <h3>Preview — nothing is saved as a result yet</h3>
            <p className="small muted">{preview.comparability.reasons[0]}</p>
            {preview.normalized.flags.length > 0 && <p className="notice notice-warn small">{preview.normalized.flags.join(" ")}</p>}
            <ul className="small">
              {preview.normalized.assertions.slice(0, 30).map((a, i) => (
                <li key={i}>{a.text} <span className="muted">({a.source.section}, line {a.source.line}{a.percent !== null ? "; reported figure, uncertain" : ""})</span></li>
              ))}
            </ul>
            <div className="actions">
              <button className="btn btn-primary" onClick={() => void decide("confirm")}>Keep as a separate series</button>
              <button className="btn" onClick={() => void decide("reject")}>Discard</button>
            </div>
          </div>
        )}
      </details>
    </section>
  );
}

export function Analytics() {
  const [protocol, setProtocol] = useState<"practice" | "diagnostic-v1">("practice");
  const [difficulty, setDifficulty] = useState("B2");
  const [saved, setSaved] = useState<SavedReportData | null>(null);
  const [findings, setFindings] = useState<FindingData[] | null>(null);
  const [audit, setAudit] = useState<DiscoveryAuditData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState<{ dir: string; files: Array<{ name: string; bytes: number }> } | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, f] = await Promise.all([fetchReport({ protocol, difficulty }), fetchFindings()]);
      setSaved(r);
      setFindings(f.findings);
      setAudit(f.discovery);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Cannot load the report.");
    }
  }, [protocol, difficulty]);
  useEffect(() => {
    void load();
  }, [load]);

  const doExport = async () => {
    try {
      setExported(await createExport({ protocol, difficulty }));
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Export failed.");
    }
  };

  if (error && !saved) return <p className="notice notice-error" role="alert">{error}</p>;
  if (!saved) return <p role="status">Calculating from your saved answers…</p>;
  const r = saved.report;
  const m = r.metrics;
  const ai = (findings ?? []).filter((f) => f.provenance.model !== null || f.originalStatus !== "confirmed");
  const empty = r.counts.attempts === 0;

  return (
    <>
      <section className="card" aria-labelledby="an-h">
        <h2 id="an-h">Analytics</h2>
        <p className="lede">Only confirmed answers count here. A first attempt without hints is the main line; answers waiting for the AI are listed as pending and are never counted as wrong.</p>
        {error && <p className="notice notice-error" role="alert">{error}</p>}
        <div className="actions">
          <label className="inline"><span className="small">Series</span>
            <select value={protocol} onChange={(e) => setProtocol(e.target.value as "practice" | "diagnostic-v1")} aria-label="Series">
              <option value="practice">Practice (with delayed checks)</option>
              <option value="diagnostic-v1">Starting diagnostic</option>
            </select>
          </label>
          <label className="inline"><span className="small">Level</span>
            <select value={difficulty} onChange={(e) => setDifficulty(e.target.value)} aria-label="Level">
              {["A2", "B1", "B2", "C1"].map((d) => <option key={d}>{d}</option>)}
            </select>
          </label>
          <button className="btn" onClick={() => void doExport()} data-testid="export">Export CSV, JSON and summary</button>
        </div>
        <p className="muted small" data-testid="run-id">Report {saved.id.slice(0, 8)} · as of {new Date(r.asOf).toLocaleString()} ({r.timezone}) · fingerprint {saved.inputHash.slice(0, 10)} · {r.counts.attempts} answers{saved.reused ? " · saved earlier, unchanged" : " · new"}</p>
        {exported && (
          <div className="notice notice-info" role="status" data-testid="export-result">
            Saved on this computer in <code>exports/{exported.dir}</code>:{" "}
            {exported.files.map((f) => (
              <a key={f.name} href={`/api/v1/exports/${exported.dir}/${f.name}`} download>{f.name}</a>
            )).reduce<React.ReactNode[]>((a, x, i) => (i === 0 ? [x] : [...a, " · ", x]), [])}
          </div>
        )}
        {r.otherCohorts.length > 0 && (
          <p className="notice notice-info small" data-testid="other-cohorts">
            Other series exist and are kept apart (they use a different rubric, level or protocol): {r.otherCohorts.map((c) => `${c.criterionVersion} · ${c.difficulty} · ${c.protocol === "practice" ? "practice" : "diagnostic"} (${c.attempts})`).join("; ")}.
          </p>
        )}
        {r.changeMarkers.length > 0 && <p className="muted small">AI-assessed answers appear in this series from {r.changeMarkers.map((c) => `${c.id} (${c.firstDate}–${c.lastDate})`).join(", ")}.</p>}
      </section>

      {empty ? (
        <section className="card"><p className="muted">No answers in this series yet. Do a practice session or a diagnostic block and the numbers appear here, with the counts behind them.</p></section>
      ) : (
        <>
          <section className="card" aria-labelledby="m-h">
            <h2 id="m-h">Verified results</h2>
            <div className="table-wrap">
              <table className="summary-table wide" data-testid="metrics">
                <thead><tr><th>Measure</th><th>Value</th><th>Counts</th><th>95% range</th><th /></tr></thead>
                <tbody>
                  <tr><td>First try, no hints <span className="muted small">(main line)</span></td><Cell r={m.firstAttemptAccuracy} /></tr>
                  <tr><td>First try with a hint or shown answer <span className="muted small">(separate)</span></td><td colSpan={3}>{m.firstAttemptAccuracy.assisted.correct} of {m.firstAttemptAccuracy.assisted.attempts} right</td><td /></tr>
                  <tr><td>Practice, last answer <span className="muted small">(includes retries)</span></td><Cell r={m.practiceAccuracy} /></tr>
                  <tr><td>Delayed check (held-out)</td><Cell r={m.heldoutAccuracy} /></tr>
                  <tr><td>Remembered after 7+ days</td><Cell r={m.delayedRetention} /></tr>
                  <tr><td>Same mistake again <span className="muted small">(after the first time)</span></td><Cell r={m.errorRecurrence.rate} /></tr>
                  <tr><td>“I don’t know”</td><Cell r={m.idk} /></tr>
                  <tr><td>Skipped</td><Cell r={m.skip} /></tr>
                </tbody>
              </table>
            </div>
            <p className="muted small" data-testid="pending">Waiting for AI review: {m.pending.slots} answer{m.pending.slots === 1 ? "" : "s"} (not marked right or wrong). Session: {m.sessionProgress.closed} of {m.sessionProgress.total} done. Lessons completed: {m.courseProgress.completedBlueprints} of {m.courseProgress.publishedBlueprints}.</p>
          </section>

          <section className="card" aria-labelledby="h-h">
            <h2 id="h-h">Delayed checks by week</h2>
            <WeeklyChart points={r.weeklyHeldout.map((w) => ({ week: w.week, r: w.heldout }))} />
            <details>
              <summary>Table behind the chart</summary>
              <table className="summary-table wide">
                <thead><tr><th>Week starting</th><th>Right</th><th>Counts</th><th>95% range</th></tr></thead>
                <tbody>{r.weeklyHeldout.map((w) => <tr key={w.week}><td>{w.week}</td><td>{pct(w.heldout.rate)}</td><td>{frac(w.heldout)}</td><td>{range(w.heldout)}</td></tr>)}</tbody>
              </table>
            </details>
            <h3>Last 28 days against the 28 before</h3>
            {r.comparison.status === "ok" ? (
              <p data-testid="comparison">{pct(r.comparison.current.firstTry.rate)} ({frac(r.comparison.current.firstTry)}, {r.comparison.current.from} to {r.comparison.current.to}) against {pct(r.comparison.previous.firstTry.rate)} ({frac(r.comparison.previous.firstTry)}, {r.comparison.previous.from} to {r.comparison.previous.to}){r.comparison.mixDiffers ? ". The mix of exercise types differs, so read this with care." : "."}</p>
            ) : (
              <p className="muted" data-testid="comparison">Insufficient comparison data: each window needs at least 10 answers. No claim of progress is made.</p>
            )}
          </section>

          <section className="card" aria-labelledby="d-h">
            <h2 id="d-h">By kind of task and by skill</h2>
            <table className="summary-table wide">
              <thead><tr><th>Kind</th><th>Right (first try)</th><th>Counts</th><th>95% range</th></tr></thead>
              <tbody>
                {(["recognition", "correction", "production"] as const).map((d) => (
                  <tr key={d}><td>{{ recognition: "Recognise", correction: "Correct", production: "Produce" }[d]}</td><td>{pct(r.byDimension[d].rate)}</td><td>{frac(r.byDimension[d])}</td><td>{range(r.byDimension[d])}</td></tr>
                ))}
              </tbody>
            </table>
            <h3>Skills with the most slips</h3>
            <table className="summary-table wide" data-testid="skills">
              <thead><tr><th>Skill</th><th>Slips</th><th>Chances</th><th /></tr></thead>
              <tbody>
                {[...r.skills].sort((a, b) => (b.rate.rate ?? 0) - (a.rate.rate ?? 0) || b.opportunities - a.opportunities).slice(0, 12).map((s) => (
                  <tr key={s.skillId}>
                    <td><code>{s.skillId}</code></td>
                    <td>{s.failures}</td>
                    <td>{s.opportunities}{s.rate.lowN ? <span className="muted small"> (few)</span> : null}</td>
                    <td><span className="bar" aria-hidden="true"><span style={{ width: `${(s.rate.rate ?? 0) * 100}%` }} /></span> {pct(s.rate.rate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {r.recurring.length > 0 && (
              <>
                <h3>Mistakes that came back</h3>
                <ul data-testid="recurring">
                  {r.recurring.map((x) => (
                    <li key={x.skillId}><code>{x.skillId}</code>: {x.failuresAfterFirst} more slip{x.failuresAfterFirst === 1 ? "" : "s"} in {x.opportunitiesAfterFirst} later chances; first {x.firstFailure}, latest {x.lastFailure} ({x.contexts} different contexts).</li>
                  ))}
                </ul>
              </>
            )}
          </section>

          <section className="card" aria-labelledby="a-h">
            <h2 id="a-h">Days you practised</h2>
            <p className="muted small">Just a record, no streaks and no targets.</p>
            <p className="small" data-testid="activity">{r.activity.map((a) => `${a.date}: ${a.attempts}`).join(" · ")}</p>
          </section>
        </>
      )}

      <ExternalSection />

      <section className="card" aria-labelledby="f-h" data-testid="ai-findings">
        <h2 id="f-h">AI-detected, not verified</h2>
        <p className="lede">The local AI sometimes points at something in a written answer. These are suggestions, not confirmed mistakes. They are not counted in any number above and they never change your scores.</p>
        {audit && (
          <p className="notice notice-info small" data-testid="discovery">
            {audit.enabled ? "The AI hint can nudge which exercise comes next." : `${audit.disabledReason}.`} {audit.note}
          </p>
        )}
        {ai.length === 0 ? (
          <p className="muted">No AI suggestions yet.</p>
        ) : (
          <ul className="findings">
            {ai.map((f) => (
              <li key={f.findingId} data-status={f.effectiveStatus}>
                <span className={`badge ${f.effectiveStatus === "rejected" ? "badge-warn" : "badge-info"}`}>{f.label}</span> <code>{f.skillId}</code>
                {f.correction && <> — suggested: <strong>{f.correction}</strong></>}
                <div className="small muted">Model {f.provenance.model ?? "unknown"} · confidence {f.confidence ?? "n/a"} · {f.inputMode}{f.transcriptEdited ? ", edited transcript" : ""}{f.isLatestAnalysis ? "" : " · superseded analysis"}</div>
                {f.history.length > 0 && (
                  <details className="small">
                    <summary>History ({f.history.length})</summary>
                    <ul>{f.history.map((h) => <li key={h.sequence}>{h.verdict} by {h.reviewer}: {h.reason}</li>)}</ul>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
