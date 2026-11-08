import { Journey, MODE_INFO } from './Journey';
import { useCallback, useEffect, useState } from 'react';
import { VocabularyAnalytics } from './VocabularyAnalytics';
import { TypingAnalytics } from './TypingAnalytics';
import { ConversationAnalytics } from './ConversationAnalytics';
import { Chart } from '../components/Chart';
import { PracticeActivityChart } from '../components/PracticeActivityChart';
import {
    ApiRequestError,
    createExport,
    decideExternalReport,
    fetchExternal,
    fetchReport,
    importExternalReport,
    type ExternalData,
    type Ratio,
    type SavedReportData,
} from '../api';

const pct = (x: number | null): string => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);
const frac = (r: Ratio): string => (r.denominator === 0 ? 'no data yet' : `${r.numerator} of ${r.denominator}`);
const range = (r: Ratio): string => (r.wilson ? `${pct(r.wilson.low)}–${pct(r.wilson.high)}` : '—');

/** held-out accuracy by week with Wilson whiskers; weeks without data are GAPS, never zeros */
function WeeklyChart({ points }: { points: Array<{ week: string; r: Ratio }> }) {
    if (points.length === 0 || points.every((p) => p.r.rate === null))
        return <p className="muted">No held-out answers yet. A delayed check opens once a skill has been practised for 7 days.</p>;
    return (
        <Chart
            ariaLabel="Held-out accuracy by week with 95% intervals"
            line={{ color: '#6ab7ff', format: (v) => `${Math.round(v * 100)}%`, max: 1 }}
            points={points.map((p) => ({
                key: p.week,
                label: p.week,
                line: p.r.rate,
                band: p.r.wilson ? { low: p.r.wilson.low, high: p.r.wilson.high } : null,
                muted: p.r.lowN,
                tip: [
                    p.week,
                    p.r.rate === null ? 'No held-out answers' : `Accuracy: ${Math.round(p.r.rate * 100)}%`,
                    ...(p.r.wilson ? [`95% interval: ${Math.round(p.r.wilson.low * 100)}–${Math.round(p.r.wilson.high * 100)}%`] : []),
                    ...(p.r.lowN && p.r.rate !== null ? ['Few answers'] : []),
                ],
            }))}
            legend="Weeks without data are gaps. Whiskers show the 95% interval; hollow points have few answers."
        />
    );
}

function ExternalSection() {
    const [series, setSeries] = useState<ExternalData[]>([]);
    const [note, setNote] = useState('');
    const [preview, setPreview] = useState<ExternalData | null>(null);
    const [err, setErr] = useState<string | null>(null);
    const [text, setText] = useState('');
    const [format, setFormat] = useState<'md' | 'json'>('md');
    const [source, setSource] = useState('');
    const [date, setDate] = useState('');
    const [method, setMethod] = useState('');
    const load = useCallback(async () => {
        try {
            const r = await fetchExternal();
            setSeries(r.series.filter((x) => x.status === 'approved'));
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
            setErr(e instanceof ApiRequestError ? e.message : 'Could not read that report.');
        }
    };
    const decide = async (d: 'confirm' | 'reject') => {
        if (!preview) return;
        try {
            await decideExternalReport(preview.id, d);
            setPreview(null);
            setText('');
            await load();
        } catch (e) {
            setErr(e instanceof ApiRequestError ? e.message : 'Could not save.');
        }
    };
    return (
        <section className="card" aria-labelledby="x-h" data-testid="external">
            <h2 id="x-h">Outside assessments</h2>
            <p className="lede">Reports from somewhere else (a tutor, another tool). They are kept as their own series and are never added to your scores.</p>
            {series.length > 0 && (
                <ul>
                    {series.map((x) => (
                        <li key={x.id}>
                            <strong>{x.assessedAt}</strong> · {x.source} · {x.method} — {x.normalized.assertions.length} statements,{' '}
                            {x.normalized.assertions.filter((a) => a.percent !== null).length} with percentages{' '}
                            <span className="muted small">(not comparable with the numbers above)</span>
                        </li>
                    ))}
                </ul>
            )}
            {note && series.length > 0 && <p className="muted small">{note}</p>}
            <details>
                <summary>Add an outside report</summary>
                {err && (
                    <p className="notice notice-error" role="alert">
                        {err}
                    </p>
                )}
                <div className="form-grid">
                    <label>
                        Source
                        <input value={source} onChange={(e) => setSource(e.target.value)} />
                    </label>
                    <label>
                        Date assessed
                        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                    </label>
                    <label>
                        Method
                        <input value={method} onChange={(e) => setMethod(e.target.value)} />
                    </label>
                    <label>
                        Format
                        <select value={format} onChange={(e) => setFormat(e.target.value as 'md' | 'json')}>
                            <option value="md">Markdown</option>
                            <option value="json">JSON</option>
                        </select>
                    </label>
                </div>
                <label className="small" htmlFor="ext-text">
                    Report text (up to 1 MB)
                </label>
                <textarea id="ext-text" rows={6} value={text} onChange={(e) => setText(e.target.value)} />
                <div className="actions">
                    <button className="btn" disabled={!text.trim() || !source.trim() || !date || !method.trim()} onClick={() => void doPreview()}>
                        Preview
                    </button>
                </div>
                {preview && (
                    <div data-testid="external-preview">
                        <h3>Preview — nothing is saved as a result yet</h3>
                        <p className="small muted">{preview.comparability.reasons[0]}</p>
                        {preview.normalized.flags.length > 0 && <p className="notice notice-warn small">{preview.normalized.flags.join(' ')}</p>}
                        <ul className="small">
                            {preview.normalized.assertions.slice(0, 30).map((a, i) => (
                                <li key={i}>
                                    {a.text}{' '}
                                    <span className="muted">
                                        ({a.source.section}, line {a.source.line}
                                        {a.percent !== null ? '; reported figure, uncertain' : ''})
                                    </span>
                                </li>
                            ))}
                        </ul>
                        <div className="actions">
                            <button className="btn btn-primary" onClick={() => void decide('confirm')}>
                                Keep as a separate series
                            </button>
                            <button className="btn" onClick={() => void decide('reject')}>
                                Discard
                            </button>
                        </div>
                    </div>
                )}
            </details>
        </section>
    );
}

function GrammarAnalytics({ days }: { days: '7' | '30' | '90' | 'all' }) {
    const [protocol, setProtocol] = useState<'practice' | 'diagnostic-v1'>('practice');
    const [difficulty, setDifficulty] = useState('B2');
    const [saved, setSaved] = useState<SavedReportData | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [exported, setExported] = useState<{ dir: string; files: Array<{ name: string; bytes: number }> } | null>(null);

    const load = useCallback(async () => {
        try {
            setSaved(await fetchReport({ protocol, difficulty }));
            setError(null);
        } catch (e) {
            setError(e instanceof ApiRequestError ? e.message : 'Cannot load the report.');
        }
    }, [protocol, difficulty]);
    useEffect(() => {
        void load();
    }, [load]);

    const doExport = async () => {
        try {
            setExported(await createExport({ protocol, difficulty }));
        } catch (e) {
            setError(e instanceof ApiRequestError ? e.message : 'Export failed.');
        }
    };

    if (error && !saved)
        return (
            <p className="notice notice-error" role="alert">
                {error}
            </p>
        );
    if (!saved) return <p role="status">Calculating from your saved answers…</p>;
    const r = saved.report;
    const m = r.metrics;
    const empty = r.counts.attempts === 0;

    return (
        <>

            {empty ? (
                <section className="card">
                    <p className="muted">
                        No answers in this series yet. Do a practice session or a diagnostic block and the numbers appear here, with the counts behind them.
                    </p>
                </section>
            ) : (
                <>
                    <p className="muted small">Summary and evidence cover the selected report series. The period filter applies to the charts.</p>
                    <div className="stat-grid-2">
                        {([
                            ['First try, no hints', m.firstAttemptAccuracy],
                            ['Practice, last answer', m.practiceAccuracy],
                            ['Delayed check', m.heldoutAccuracy],
                            ['Remembered after 7+ days', m.delayedRetention],
                            ['Mistake repeated', m.errorRecurrence.rate],
                            ["I don't know", m.idk],
                            ['Skipped', m.skip],
                        ] as const).map(([label, value]) => <div className="stat" key={label}><span className="stat-num">{pct(value.rate)}</span><span className="stat-label">{label} <span className="muted">({frac(value)})</span>{value.wilson && <span className="muted"> | 95%: {range(value)}</span>}{value.denominator > 0 && value.lowN && <span className="muted"> | few answers</span>}</span></div>)}
                        <div className="stat"><span className="stat-num">{m.courseProgress.completedBlueprints}</span><span className="stat-label">lessons completed ({m.courseProgress.publishedBlueprints} available)</span></div>
                        <div className="stat"><span className="stat-num">{m.firstAttemptAccuracy.assisted.correct}/{m.firstAttemptAccuracy.assisted.attempts}</span><span className="stat-label">first tries with help correct</span></div>
                        <div className="stat"><span className="stat-num">{m.pending.slots}</span><span className="stat-label">answers awaiting review ({m.pending.attempts} attempts)</span></div>
                        <div className="stat"><span className="stat-num">{m.sessionProgress.closed}/{m.sessionProgress.total}</span><span className="stat-label">latest session slots done</span></div>
                    </div>
                    <section className="card"><h2>Practice activity</h2><PracticeActivityChart mode="grammar" days={days} /><Chart ariaLabel="Grammar answers per day" bars={{ color: '#6ab7ff', format: (v) => `${Math.round(v)}` }} points={(days === 'all' ? r.activity : r.activity.filter((a) => a.date >= new Date(Date.now() - (Number(days) - 1) * 86400000).toLocaleDateString('en-CA'))).map((a) => ({ key: a.date, label: a.date.slice(5), bar: a.attempts, tip: [a.date, `Answers: ${a.attempts}`] }))} legend="Answers recorded per day for the selected report series." /></section>
                    <section className="card"><h2>Three kinds of evidence</h2><div className="rate-grid">
                      {(['recognition', 'correction', 'production'] as const).map((kind) => <div className="rate-row" key={kind}><div className="rate-head"><strong>{{ recognition: 'Recognise', correction: 'Correct', production: 'Produce' }[kind]}</strong><span>{pct(r.byDimension[kind].rate)}</span></div><span className="bar rate-bar" aria-hidden="true"><span style={{ width: `${(r.byDimension[kind].rate ?? 0) * 100}%` }} /></span><span className="small muted">{frac(r.byDimension[kind])}{r.byDimension[kind].lowN ? ' - few answers' : ''}</span></div>)}
                    </div></section>
                    <section className="card" aria-labelledby="h-h">
                        <h2 id="h-h">Delayed checks by week</h2>
                        <WeeklyChart points={r.weeklyHeldout.map((w) => ({ week: w.week, r: w.heldout }))} />
                        <details>
                            <summary>Table behind the chart</summary>
                            <table className="summary-table wide">
                                <thead>
                                    <tr>
                                        <th>Week starting</th>
                                        <th>Right</th>
                                        <th>Counts</th>
                                        <th>95% range</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {r.weeklyHeldout.map((w) => (
                                        <tr key={w.week}>
                                            <td>{w.week}</td>
                                            <td>{pct(w.heldout.rate)}</td>
                                            <td>{frac(w.heldout)}</td>
                                            <td>{range(w.heldout)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </details>
                        <h3>Last 28 days against the 28 before</h3>
                        {r.comparison.status === 'ok' ? (
                            <p data-testid="comparison">
                                {pct(r.comparison.current.firstTry.rate)} ({frac(r.comparison.current.firstTry)}, {r.comparison.current.from} to{' '}
                                {r.comparison.current.to}) against {pct(r.comparison.previous.firstTry.rate)} ({frac(r.comparison.previous.firstTry)},{' '}
                                {r.comparison.previous.from} to {r.comparison.previous.to})
                                {r.comparison.mixDiffers ? '. The mix of exercise types differs, so read this with care.' : '.'}
                            </p>
                        ) : (
                            <p className="muted" data-testid="comparison">
                                Insufficient comparison data: each window needs at least 10 answers. No claim of progress is made.
                            </p>
                        )}
                    </section>

                    <section className="card" aria-labelledby="d-h">
                        <h2 id="d-h">Skills with the most slips</h2>
                        <table className="summary-table wide" data-testid="skills">
                            <thead>
                                <tr>
                                    <th>Skill</th>
                                    <th>Slips</th>
                                    <th>Chances</th>
                                    <th />
                                </tr>
                            </thead>
                            <tbody>
                                {[...r.skills]
                                    .sort((a, b) => (b.rate.rate ?? 0) - (a.rate.rate ?? 0) || b.opportunities - a.opportunities)
                                    .slice(0, 12)
                                    .map((s) => (
                                        <tr key={s.skillId}>
                                            <td>
                                                <code>{s.skillId}</code>
                                            </td>
                                            <td>{s.failures}</td>
                                            <td>
                                                {s.opportunities}
                                                {s.rate.lowN ? <span className="muted small"> (few)</span> : null}
                                            </td>
                                            <td>
                                                <span className="bar" aria-hidden="true">
                                                    <span style={{ width: `${(s.rate.rate ?? 0) * 100}%` }} />
                                                </span>{' '}
                                                {pct(s.rate.rate)}
                                            </td>
                                        </tr>
                                    ))}
                            </tbody>
                        </table>
                        {r.recurring.length > 0 && (
                            <>
                                <h3>Mistakes that came back</h3>
                                <ul data-testid="recurring">
                                    {r.recurring.map((x) => (
                                        <li key={x.skillId}>
                                            <code>{x.skillId}</code>: {x.failuresAfterFirst} more slip{x.failuresAfterFirst === 1 ? '' : 's'} in{' '}
                                            {x.opportunitiesAfterFirst} later chances; first {x.firstFailure}, latest {x.lastFailure} ({x.contexts} different
                                            contexts).
                                        </li>
                                    ))}
                                </ul>
                            </>
                        )}
                    </section>


                </>
            )}

            <ExternalSection />

            <section className="card" aria-labelledby="an-h">
                <h2 id="an-h"><i className="pi pi-chart-line" aria-hidden="true" /> Analytics</h2>
                <p className="lede">
                    Only confirmed answers count here. A first attempt without hints is the main line; answers waiting for the AI are listed as pending and are
                    never counted as wrong.
                </p>
                {error && (
                    <p className="notice notice-error" role="alert">
                        {error}
                    </p>
                )}
                <div className="actions">
                    <label className="inline">
                        <span className="small">Series</span>
                        <select value={protocol} onChange={(e) => setProtocol(e.target.value as 'practice' | 'diagnostic-v1')} aria-label="Series">
                            <option value="practice">Practice (with delayed checks)</option>
                            <option value="diagnostic-v1">Starting diagnostic</option>
                        </select>
                    </label>
                    <label className="inline">
                        <span className="small">Level</span>
                        <select value={difficulty} onChange={(e) => setDifficulty(e.target.value)} aria-label="Level">
                            {['A2', 'B1', 'B2', 'C1', 'C2'].map((d) => (
                                <option key={d}>{d}</option>
                            ))}
                        </select>
                    </label>
                    <button className="btn" onClick={() => void doExport()} data-testid="export">
                        Export CSV, JSON and summary
                    </button>
                </div>
                <p className="muted small" data-testid="run-id">
                    Report {saved.id.slice(0, 8)} · as of {new Date(r.asOf).toLocaleString()} ({r.timezone}) · fingerprint {saved.inputHash.slice(0, 10)} ·{' '}
                    {r.counts.attempts} answers{saved.reused ? ' · saved earlier, unchanged' : ' · new'}
                </p>
                {exported && (
                    <div className="notice notice-info" role="status" data-testid="export-result">
                        Saved on this computer in <code>exports/{exported.dir}</code>:{' '}
                        {exported.files
                            .map((f) => (
                                <a key={f.name} href={`/api/v1/exports/${exported.dir}/${f.name}`} download>
                                    {f.name}
                                </a>
                            ))
                            .reduce<React.ReactNode[]>((a, x, i) => (i === 0 ? [x] : [...a, ' · ', x]), [])}
                    </div>
                )}
                {r.otherCohorts.length > 0 && (
                    <p className="notice notice-info small" data-testid="other-cohorts">
                        Other series exist and are kept apart (they use a different rubric, level or protocol):{' '}
                        {r.otherCohorts
                            .map((c) => `${c.criterionVersion} · ${c.difficulty} · ${c.protocol === 'practice' ? 'practice' : 'diagnostic'} (${c.attempts})`)
                            .join('; ')}
                        .
                    </p>
                )}
                {r.changeMarkers.length > 0 && (
                    <p className="muted small">
                        AI-assessed answers appear in this series from {r.changeMarkers.map((c) => `${c.id} (${c.firstDate}–${c.lastDate})`).join(', ')}.
                    </p>
                )}
            </section>


        </>
    );
}

/** Grammar | Vocabulary: two separate analytics areas with their own filters; nothing is mixed between them */
export function Analytics({ initialView = 'grammar' }: { initialView?: 'grammar' | 'vocabulary' | 'journey' } = {}) {
    const [view, setView] = useState<'grammar' | 'vocabulary' | 'typing' | 'conversation' | 'journey'>(initialView);
    const [days, setDays] = useState<'7' | '30' | '90' | 'all'>('30');
    return (
        <>
            <div className="segmented page-switch" role="radiogroup" aria-label="Which analytics">
                <label className={view === 'grammar' ? 'on' : ''}>
                    <input type="radio" name="an-view" checked={view === 'grammar'} onChange={() => setView('grammar')} />{' '}
                    <i className={`pi ${MODE_INFO.grammar.icon}`} aria-hidden="true" /> Grammar
                </label>
                <label className={view === 'vocabulary' ? 'on' : ''}>
                    <input
                        type="radio"
                        name="an-view"
                        checked={view === 'vocabulary'}
                        onChange={() => setView('vocabulary')}
                        data-testid="analytics-vocabulary"
                    />{' '}
                    <i className={`pi ${MODE_INFO.vocabulary.icon}`} aria-hidden="true" /> Vocabulary
                </label>
                <label className={view === 'typing' ? 'on' : ''}>
                    <input type="radio" name="an-view" checked={view === 'typing'} onChange={() => setView('typing')} data-testid="analytics-typing" />{' '}
                    <i className="pi pi-bullseye" aria-hidden="true" /> Typing
                </label>
                <label className={view === 'conversation' ? 'on' : ''}><input type="radio" name="an-view" checked={view === 'conversation'} onChange={() => setView('conversation')} data-testid="analytics-conversation" /> <i className="pi pi-comments" aria-hidden="true" /> Conversation</label>
            </div>

            <label className={view === 'journey' ? 'on journey-tab' : 'journey-tab'}>
                <input type="radio" name="an-view" checked={view === 'journey'} onChange={() => setView('journey')} />{' '}
                <i className="pi pi-compass" aria-hidden="true" /> Journey
            </label>

            {view !== 'journey' && <div className="analytics-period"><div className="segmented" role="radiogroup" aria-label="Period">{(['7', '30', '90', 'all'] as const).map((d) => <label key={d} className={days === d ? 'on' : ''}><input type="radio" name="analytics-days" checked={days === d} onChange={() => setDays(d)} /> {d === 'all' ? 'All time' : `${d} days`}</label>)}</div></div>}

            {view === 'grammar' ? (
                <GrammarAnalytics days={days} />
            ) : view === 'vocabulary' ? (
                <VocabularyAnalytics days={days} />
            ) : view === 'typing' ? (
                <TypingAnalytics days={days} />
            ) : view === 'conversation' ? (
                <ConversationAnalytics days={days} />
            ) : (
                <Journey />
            )}
        </>
    );
}
