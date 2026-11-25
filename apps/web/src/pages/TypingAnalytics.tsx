import { useEffect, useMemo, useState } from 'react';
import { fetchTypingAnalytics, type TypingAnalyticsData as Data } from '../api';
import { Chart } from '../components/Chart';
import { CumulativeCharacters } from '../components/CharacterCharts';
import { fmtTotalTime } from '../format';
import { TypingDictationAnalytics } from './TypingDictationAnalytics';
import { TypingVocabAnalytics } from './TypingVocabAnalytics';
import { KeyboardSection } from './TypingKeyboardAnalytics';
import { KeyChips } from './TypingKeys';
import { MODE_INFO } from '../journey/model';
import { wordAccuracy } from '../typingWordAccuracy';

const fmtDay = (iso: string) => new Date(iso.slice(0, 10) + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
const fmtWpm = (v: number | null) => (v === null ? '—' : String(Math.round(v)));

const SERIES_COLOR = { wpm: '#6ab7ff', accuracy: '#51b788', score: '#f3c94d', duration: '#b78bff' } as const;

function LineChart({
    title,
    points,
    unit,
    color,
    cpm,
}: {
    title: string;
    points: Data['series']['wpm'];
    unit: string;
    color: keyof typeof SERIES_COLOR;
    cpm?: boolean;
}) {
    if (points.length === 0)
        return (
            <figure className="chart-wrap">
                <figcaption className="muted small">{title}: no data yet</figcaption>
            </figure>
        );
    const fmt = (v: number) => `${Math.round((color === 'duration' ? v / 60 : v) * 10) / 10}${unit}`;
    const eligible = points.filter((p) => p.status === 'completed');
    const best = (color === 'wpm' || color === 'score') && eligible.length ? Math.max(...eligible.map((p) => p.value)) : null;
    return (
        <div>
            <h4 className="chart-title">{title}</h4>
            <Chart
                ariaLabel={title}
                line={{ color: SERIES_COLOR[color], format: fmt, floating: color === 'accuracy' }}
                points={points.map((p, i) => ({
                    key: `${p.at}-${i}`,
                    label: fmtDay(p.at),
                    line: p.value,
                    muted: p.status !== 'completed',
                    highlight: best !== null && p.status === 'completed' && p.value === best,
                    tip: [
                        fmtDay(p.at),
                        `${title}: ${fmt(p.value)}`,
                        ...(cpm ? [`CPM: ${Math.round(p.value * 5)}`] : []),
                        `Attempt: ${p.status}`,
                        ...(best !== null && p.status === 'completed' && p.value === best ? ['Best completed result on this chart'] : []),
                    ],
                }))}
                secondary={cpm ? { factor: 5, color: '#9aa4b8', format: (v) => `${Math.round(v)}` } : undefined}
                legend={
                    cpm
                        ? 'Left axis: WPM · right axis: CPM (characters per minute = WPM × 5) · hollow points are failed or interrupted attempts'
                        : 'Hollow points are failed or interrupted attempts'
                }
            />
        </div>
    );
}

type Mode = 'words' | 'drills' | 'keys' | 'books' | 'dictation' | 'vocab';
type Days = '7' | '30' | '90' | 'all';

function Toolbar({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
    return (
        <div className="analytics-toolbar">
            <div className="segmented" role="radiogroup" aria-label="Typing mode">
                {(['words', 'drills', 'keys', 'books', 'dictation', 'vocab'] as const).map((m) => (
                    <label key={m} className={mode === m ? 'on' : ''}>
                        <input type="radio" name="typing-mode" checked={mode === m} onChange={() => setMode(m)} />{' '}
                        <i className={`pi ${m === 'drills' ? 'pi-th-large' : m === 'keys' ? 'pi-key' : m === 'vocab' ? 'pi-language' : MODE_INFO[m].icon}`} aria-hidden="true" />{' '}
                        {m === 'words' ? 'Meteor Rain' : m === 'drills' ? 'Finger Drills' : m === 'keys' ? 'Key Builder' : m === 'books' ? 'Books' : m === 'vocab' ? 'Vocabulary Typing' : 'Audio Dictation'}
                    </label>
                ))}
            </div>
        </div>
    );
}

/** slow and often mistyped letter pairs (Words and Books together); the next Words levels favour them a little */
function KeyInsights({ data }: { data: Data['keyInsights'] }) {
    if (data.slowPairs.length === 0 && data.errorPairs.length === 0)
        return <p className="muted small">Letter pairs: collected as you play Words and Books; a few levels are needed first.</p>;
    return (
        <div className="card key-insights">
            <h4 className="chart-title">Letter pairs to practise</h4>
            {data.typicalMs !== null && <p className="muted small">Typical gap: {data.typicalMs} ms</p>}
            <div className="table-wrap">
                <table className="data-table small">
                    <thead>
                        <tr>
                            <th>Kind</th>
                            <th>Letter pair</th>
                            <th>Result</th>
                            <th>Samples</th>
                        </tr>
                    </thead>
                    <tbody>
                        {data.slowPairs.map((p) => (
                            <tr key={`slow-${p.pair}`}>
                                <td>Slowest</td>
                                <td>
                                    <code>{p.pair}</code>
                                </td>
                                <td>{p.meanMs} ms</td>
                                <td>{p.count}</td>
                            </tr>
                        ))}
                        {data.errorPairs.map((p) => (
                            <tr key={`error-${p.pair}`}>
                                <td>Most mistyped</td>
                                <td>
                                    <code>{p.pair}</code>
                                </td>
                                <td>{Math.round(p.errorRate * 100)}% wrong</td>
                                <td>{p.count}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <p className="muted small">
                About one word in ten in the next Words levels contains one of the weakest pairs. The time is the gap between two correct key presses (pauses
                over 2 s are ignored).
            </p>
        </div>
    );
}

/** the dictation mode has its own endpoint: its value never reaches the Words/Books analytics request */
export function TypingAnalytics({ days = '30' }: { days?: Days }) {
    const [mode, setMode] = useState<Mode>('words');
    const toolbar = <Toolbar mode={mode} setMode={setMode} />;
    if (mode === 'dictation') return <TypingDictationAnalytics days={days} toolbar={toolbar} />;
    if (mode === 'vocab') return <TypingVocabAnalytics days={days} toolbar={toolbar} />;
    return <ClassicAnalytics mode={mode} days={days} toolbar={toolbar} />;
}

function ClassicAnalytics({ mode, days, toolbar }: { mode: 'words' | 'drills' | 'keys' | 'books'; days: Days; toolbar: React.ReactNode }) {
    const words = mode === 'words' || mode === 'drills'; // Meteor Rain and Finger Drills are both Words variants
    const keys = mode === 'keys';
    const [data, setData] = useState<Data | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let off = false;
        fetchTypingAnalytics(mode, days)
            .then((d) => {
                if (!off) setData(d);
            })
            .catch((e) => {
                if (!off) setError(e instanceof Error ? e.message : String(e));
            });
        return () => {
            off = true;
        };
    }, [mode, days]);

    if (error) return <p role="alert">{error}</p>;
    if (!data) return <p className="muted">Loading typing analytics…</p>;

    const s = data.summary;
    const lastWords = s.last ? wordAccuracy(s.last) : null;
    const bookWordSeries = data.series.bookWordAccuracy ?? [];
    const bookWordTotal = bookWordSeries.reduce((n, w) => n + w.completed, 0);
    const bookWordErrors = bookWordSeries.reduce((n, w) => n + w.withErrors, 0);
    return (
        <section aria-label="Typing analytics">
            {toolbar}

            {/* the first nine tiles are the same, in the same order, in Words, Books and Audio Dictation; what differs comes last */}
            <div className="stat-grid-2">
                <div className="stat">
                    <span className="stat-num">{fmtTotalTime(s.totalActiveMs / 1000)}</span>
                    <span className="stat-label">total practice time</span>
                </div>
                <div className="stat">
                    <span className="stat-num">{s.completed}</span>
                    <span className="stat-label">{keys ? 'completed lessons' : 'completed levels'}</span>
                </div>
                <div className="stat">
                    <span className="stat-num">{s.attempts}</span>
                    <span className="stat-label">attempts</span>
                </div>
                <div className="stat">
                    <span className="stat-num">{fmtWpm(s.avgWpm)}</span>
                    <span className="stat-label">average WPM</span>
                </div>
                <div className="stat">
                    <span className="stat-num">{fmtWpm(s.maxWpm)}</span>
                    <span className="stat-label">best WPM</span>
                </div>
                <div className="stat" title="Characters per minute: correct characters per minute of active time (WPM × 5)">
                    <span className="stat-num">{s.avgWpm === null ? '—' : Math.round(s.avgWpm * 5)}</span>
                    <span className="stat-label">average CPM</span>
                </div>
                <div className="stat">
                    <span className="stat-num">{s.avgAccuracy === null ? '—' : `${Math.round(s.avgAccuracy)}%`}</span>
                    <span className="stat-label">{words || keys ? 'average key accuracy' : 'average accuracy'}</span>
                </div>
                {keys ? (
                    <div className="stat" title="Letters open in Key Builder, out of 26">
                        <span className="stat-num">{s.keyBuilder ? `${s.keyBuilder.openKeys} / 26` : '—'}</span>
                        <span className="stat-label">open keys</span>
                    </div>
                ) : (
                    <div className="stat">
                        <span className="stat-num">{s.maxScore ?? '—'}</span>
                        <span className="stat-label">best score</span>
                    </div>
                )}
                <div className="stat" title="Every key pressed in finished attempts, wrong ones included">
                    <span className="stat-num">{(s.totalChars ?? 0).toLocaleString('en-AU')}</span>
                    <span className="stat-label">characters typed</span>
                </div>
                {words && (
                    <div className="stat" title="Most words in a row typed without a wrong key">
                        <span className="stat-num">{s.bestCombo ?? '?'}</span>
                        <span className="stat-label">best combo (words)</span>
                    </div>
                )}
                {keys && (
                    <div className="stat" title="Most consecutive correct keys in one lesson. Lessons before this was recorded are not counted.">
                        <span className="stat-num">{s.bestCharStreak ?? '?'}</span>
                        <span className="stat-label">best character streak</span>
                    </div>
                )}
                {keys && s.keyBuilder && (
                    <div className="stat" title="Median speed of your last 10 lessons. Shown for information: letters open by the fixed target speed in Settings">
                        <span className="stat-num">{Math.round(s.keyBuilder.currentCpm / 5)}</span>
                        <span className="stat-label">current WPM · goal {Math.round(s.keyBuilder.goalCpm / 5)}</span>
                    </div>
                )}
                {mode === 'books' && (
                    <div className="stat" title="Longest recorded run of correct characters. Older results may cover only the final visit.">
                        <span className="stat-num">{s.bestCharStreak ?? '?'}</span>
                        <span className="stat-label">best character streak</span>
                    </div>
                )}
                {words && (
                    <div className="stat" title="Most consecutive correct characters, across words. Older sessions did not record this.">
                        <span className="stat-num">{s.bestCharStreak ?? '?'}</span>
                        <span className="stat-label">best character streak</span>
                    </div>
                )}
                {words && (
                    <div className="stat">
                        <span className="stat-num">{s.failed}</span>
                        <span className="stat-label">failed attempts</span>
                    </div>
                )}
            </div>

            {mode === 'words' && s.wordsShown !== undefined && (
                <p className="muted small">
                    Words shown {s.wordsShown} · destroyed {s.wordsDestroyed} (all-time).
                </p>
            )}
            {mode === 'drills' && s.drills && <DrillsProgress drills={s.drills} typed={s.wordsDestroyed ?? 0} />}
            {keys && s.keyBuilder && (
                <p className="muted small" data-testid="keys-summary">
                    {s.keyBuilder.openKeys} of 26 keys open{s.keyBuilder.focused ? ` · focus ${s.keyBuilder.focused.toUpperCase()}` : ''} · target {s.keyBuilder.targetCpm} CPM
                    (fixed for this stage; your speed now {s.keyBuilder.currentCpm} CPM) · goal {s.keyBuilder.goalCpm} CPM. A new key opens when every open key has once been at the
                    target with at least the set accuracy; the open key furthest from that is the focus of the next lesson (keybr.com method).
                </p>
            )}
            {mode === 'books' && s.currentLevel !== undefined && (
                <p className="muted small">
                    Current level {s.currentLevel}
                    {s.chapter ? ` · ${s.chapter}` : ''}
                    {s.percentRead !== null ? ` · ${s.percentRead}% read` : ''}.
                </p>
            )}

            {s.recall && s.recall.words > 0 && (
                <p className="muted small">
                    Memory check after levels: {s.recall.checks} checks · {s.recall.words} words ·{' '}
                    {s.recall.withoutHelpRate === null ? '—' : `${Math.round(s.recall.withoutHelpRate)}%`} typed from memory without help ·{' '}
                    {s.recall.avgPoints ?? '—'} points per word on average.
                </p>
            )}

            {keys ? (
                <>
                    <KeyBuilderCharts series={data.series.keyProgress ?? []} />
                    <div className="charts-grid">
                        <LineChart title="Practice duration" points={data.series.duration} unit=" min" color="duration" />
                        <StreakChart series={data.series.charStreak} mode={mode} />
                    </div>
                </>
            ) : (
                <div className="charts-grid">
                    <LineChart title="Typing speed over time" points={data.series.wpm} unit=" wpm" color="wpm" cpm />
                    <LineChart title={words ? 'Key accuracy over time' : 'Accuracy over time'} points={data.series.accuracy} unit="%" color="accuracy" />
                    <LineChart title="Score over time" points={data.series.score} unit="" color="score" />
                    <LineChart title="Practice duration" points={data.series.duration} unit=" min" color="duration" />
                </div>
            )}
            {mode === 'books' && (
                <div className="card">
                    <h3>Words typed in Books</h3>
                    {bookWordSeries.length ? (
                        <>
                            <p className="small">
                                {bookWordTotal} recorded words · {bookWordErrors} with errors ·{' '}
                                {bookWordTotal ? `${Math.round(((bookWordTotal - bookWordErrors) / bookWordTotal) * 100)}%` : '—'} without errors ·{' '}
                                {bookWordSeries.length} tracked levels{bookWordSeries.some((w) => w.partial) ? ' (includes partially tracked levels)' : ''}
                            </p>
                            <Chart
                                ariaLabel="Words with and without typing errors per Books level"
                                bars={{ color: '#3fbf6f', format: (v) => String(Math.round(v)) }}
                                bars2={{ color: '#ef7777', format: (v) => String(Math.round(v)) }}
                                line={{ color: '#6ca9ff', format: (v) => `${Math.round(v)}%`, max: 100 }}
                                points={bookWordSeries.map((w, i) => ({
                                    key: `${w.at}-${i}`,
                                    label: fmtDay(w.at),
                                    bar: w.completed - w.withErrors,
                                    bar2: w.withErrors,
                                    line: w.completed ? ((w.completed - w.withErrors) / w.completed) * 100 : null,
                                    muted: w.partial,
                                    tip: [
                                        fmtDay(w.at),
                                        `${w.completed - w.withErrors} words without errors`,
                                        `${w.withErrors} words with errors`,
                                        ...(w.partial ? ['Partial tracking'] : []),
                                    ],
                                }))}
                                legend="Green: words without errors · red: words with errors · blue: word accuracy. Faded bars indicate partial tracking; earlier levels without word details are omitted."
                            />
                        </>
                    ) : (
                        <p className="muted small">Word tracking starts with the updated Books practice; earlier levels have no word-level error records.</p>
                    )}
                </div>
            )}

            {!keys && <StreakChart series={data.series.charStreak} mode={mode} />}
            <DailyActivity data={data.series.daily} />
            <CumulativeCharacters data={data.series.daily} />
            {mode === 'drills' && <DrillsCharts series={data.series.drillProgress ?? []} />}
            {mode === 'drills' && s.drills && <DrillsWords drills={s.drills} />}
            {keys && s.keyBuilder && (
                <div>
                    <h4 className="chart-title">Keys in opening order, against the current target</h4>
                    <KeyChips keys={s.keyBuilder.keys} targetCpm={s.keyBuilder.targetCpm} />
                </div>
            )}
            {data.keyboard && <KeyboardSection data={data.keyboard} mode={mode} />}

            <KeyInsights data={data.keyInsights} />

            {s.last && (
                <div className="card">
                    <h3>Last result</h3>
                    <p className="small">
                        Level {s.last.level} · {s.last.status} · {Math.round(s.last.metrics.wpm)} WPM ·{' '}
                        {s.last.metrics.accuracy === null ? '—' : `${Math.round(s.last.metrics.accuracy)}%`} {words ? 'key accuracy' : 'accuracy'} · score{' '}
                        {s.last.metrics.score} · {s.last.xpAwarded} XP
                    </p>
                    {lastWords && (
                        <p className="small">
                            Word accuracy: {lastWords.accuracy === null ? '—' : `${Math.round(lastWords.accuracy)}%`} · {lastWords.clean} /{' '}
                            {lastWords.completed} completed without errors · {lastWords.withErrors} / {lastWords.shown} shown with errors ·{' '}
                            {lastWords.unfinished} / {lastWords.shown} not completed
                            {lastWords.unknown > 0 ? ` · ${lastWords.unknown} with unknown error details` : ''}
                            {lastWords.unassigned ? ` · ${lastWords.unassigned} wrong keys without a selected word` : ''}
                        </p>
                    )}
                    {mode === 'books' && s.last.bookWords && (
                        <p className="small">
                            {s.last.bookWords.partial ? 'Partial tracking · ' : ''}
                            {s.last.bookWords.completed - s.last.bookWords.withErrors} / {s.last.bookWords.completed} words without errors ·{' '}
                            {s.last.bookWords.withErrors} with errors
                        </p>
                    )}
                </div>
            )}
        </section>
    );
}

function StreakChart({ series, mode }: { series: Data['series']['charStreak']; mode: Mode }) {
    return (
        <div>
            <h4 className="chart-title">Longest error-free character streak</h4>
            {!series || !series.some((point) => point.value !== null) ? (
                <p className="muted small">No recorded character streaks in this period yet.</p>
            ) : (
                <Chart
                    ariaLabel="Longest error-free character streak per attempt"
                    line={{ color: '#b78bff', format: (v) => `${Math.round(v)} chars` }}
                    points={series.map((point, i) => ({
                        key: `${point.at}-${i}`,
                        label: fmtDay(point.at),
                        line: point.value,
                        muted: point.status !== 'completed',
                        tip: [
                            fmtDay(point.at),
                            point.value === null ? 'Not recorded' : `Longest streak: ${point.value} characters`,
                            `Attempt: ${point.status}`,
                        ],
                    }))}
                    legend={
                        mode === 'books'
                            ? 'Longest recorded streak per attempt; older sessions may only cover the final visit after a restart. Gaps are unrecorded sessions.'
                            : 'Longest streak of correct characters per attempt, across words. Failed attempts are hollow; gaps are unrecorded sessions.'
                    }
                />
            )}
        </div>
    );
}

/**
 * Key Builder progress, lesson by lesson, in two full-width charts that share the letters open (bars): the lesson's speed against the
 * target it was judged by, and its accuracy against the limit. A lesson that opened a new letter is the orange point: speed and
 * accuracy usually drop there, because the new key is the slowest and the least accurate one.
 */
function KeyBuilderCharts({ series }: { series: NonNullable<Data['series']['keyProgress']> }) {
    if (series.length === 0)
        return <p className="muted small">No finished lessons in this period yet.</p>;
    const opened = (p: (typeof series)[number]) => (p.newKeys.length ? [`New key: ${p.newKeys.map((k) => k.toUpperCase()).join(', ')} opened`] : []);
    return (
        <>
            <div>
                <h4 className="chart-title">Speed, target and open keys</h4>
                <Chart
                    ariaLabel="Speed of each lesson against its target, and the letters open"
                    height={340}
                    bars={{ color: '#51b788', format: (v) => `${Math.round(v)} keys`, max: 26 }}
                    line={{ color: '#6ab7ff', format: (v) => `${Math.round(v)} WPM` }}
                    line2={{ color: '#f3c94d', format: (v) => `${Math.round(v)} WPM` }}
                    points={series.map((p, i) => ({
                        key: `${p.at}-${i}`,
                        label: fmtDay(p.at),
                        bar: p.open,
                        line: p.wpm,
                        line2: Math.round((p.targetCpm / 5) * 10) / 10,
                        highlight: p.newKeys.length > 0,
                        tip: [fmtDay(p.at), `Speed: ${p.wpm} WPM`, `Target: ${Math.round((p.targetCpm / 5) * 10) / 10} WPM`, `Open keys: ${p.open} / 26`, ...opened(p)],
                    }))}
                    legend="Blue line: speed of the lesson (right axis) · yellow dashed: the target it was judged by (it is set when a letter opens) · green bars: letters open (left axis) · orange point: a new letter opened, so a dip there is expected."
                />
            </div>
            <div>
                <h4 className="chart-title">Accuracy, limit and open keys</h4>
                <Chart
                    ariaLabel="Accuracy of each lesson against the limit, and the letters open"
                    bars={{ color: '#51b788', format: (v) => `${Math.round(v)} keys`, max: 26 }}
                    line={{ color: '#7bd88f', format: (v) => `${Math.round(v)}%`, max: 100, floating: true }}
                    line2={{ color: '#ef7777', format: (v) => `${Math.round(v)}%` }}
                    connectGaps
                    points={series.map((p, i) => ({
                        key: `${p.at}-${i}`,
                        label: fmtDay(p.at),
                        bar: p.open,
                        line: p.accuracy,
                        line2: p.accuracyLimit,
                        highlight: p.newKeys.length > 0,
                        tip: [fmtDay(p.at), `Accuracy: ${p.accuracy === null ? '—' : `${p.accuracy}%`}`, `Limit per key: ${p.accuracyLimit}%`, `Open keys: ${p.open} / 26`, ...opened(p)],
                    }))}
                    legend="Green line: accuracy of the lesson (right axis) · red dashed: the limit a key must keep (set in Settings; it applies to each key, the lesson as a whole is usually a little better) · green bars: letters open · orange point: a new letter opened."
                />
            </div>
        </>
    );
}

/** Finger Drills: learning progress, clean words per level and the words being practised */
function DrillsProgress({ drills, typed }: { drills: NonNullable<Data['summary']['drills']>; typed: number }) {
    return (
        <>
            <p className="muted small" data-testid="drills-summary">
                Stage {drills.stage} of 6 · {drills.learned} words learned · {drills.practised} words practised · {typed} words typed (all-time). A word is
                learned when at least {Math.round(drills.accuracyNeeded * 100)}% of its last {drills.accuracyWindow} showings (all levels together) were
                perfect, after {drills.minShowings} showings. Each later level where it is all perfect at {drills.targetMsPerLetter} ms per letter or faster
                (90% of your usual time in Meteor Rain and Books) moves it one review step up, so it comes back less often; a mistake moves it down.
            </p>
        </>
    );
}

/** Finger Drills only: learning progress and clean words per level (after the charts every Words variant shares) */
function DrillsCharts({ series }: { series: NonNullable<Data['series']['drillProgress']> }) {
    return (
            <div className="charts-grid">
                <div>
                    <h4 className="chart-title">Words learned</h4>
                    {series.length === 0 ? (
                        <p className="muted small">No finished drills in this period yet.</p>
                    ) : (
                        <Chart
                            ariaLabel="Words learned after each level"
                            line={{ color: '#51b788', format: (v) => `${Math.round(v)} words` }}
                            points={series.map((p, i) => ({
                                key: `${p.at}-${i}`,
                                label: fmtDay(p.at),
                                line: p.learned,
                                muted: p.status !== 'completed',
                                tip: [fmtDay(p.at), `Learned after this level: ${p.learned}`, `Attempt: ${p.status}`],
                            }))}
                            legend="Words that count as learned after each level; a word drops out again after a mistake. Hollow points are failed levels."
                        />
                    )}
                </div>
                <div>
                    <h4 className="chart-title">Words per level: clean and with errors</h4>
                    {series.length === 0 ? (
                        <p className="muted small">No finished drills in this period yet.</p>
                    ) : (
                        <Chart
                            ariaLabel="Words typed without and with errors per level"
                            bars={{ color: '#3fbf6f', format: (v) => String(Math.round(v)) }}
                            bars2={{ color: '#ef7777', format: (v) => String(Math.round(v)) }}
                            line={{ color: '#6ca9ff', format: (v) => `${Math.round(v)}%`, max: 100 }}
                            points={series.map((p, i) => {
                                const n = p.clean + p.withErrors;
                                return {
                                    key: `${p.at}-${i}`,
                                    label: fmtDay(p.at),
                                    bar: p.clean,
                                    bar2: p.withErrors,
                                    line: n ? (p.clean / n) * 100 : null,
                                    muted: p.status !== 'completed',
                                    tip: [
                                        fmtDay(p.at),
                                        `${p.clean} words without errors`,
                                        `${p.withErrors} words with errors`,
                                        `Word accuracy: ${n ? Math.round((p.clean / n) * 100) : '—'}%`,
                                    ],
                                };
                            })}
                            legend="Green: words typed perfectly · red: words with a wrong key · blue: word accuracy. Faded bars are failed levels."
                        />
                    )}
                </div>
            </div>
    );
}

type DrillWord = NonNullable<Data['summary']['drills']>['words'][number];
type SortKey = 'lemma' | 'showings' | 'accuracy' | 'msPerLetter' | 'step';
const PAGE = 20;
const SPARK_W = 220;
const SPARK_H = 30;
/** typing speed in letters per second (higher = faster), so a rising line is progress */
const lettersPerSecond = (ms: number) => 1000 / Math.max(ms, 1);

/** shared scale for every sparkline: the 3rd to 97th percentile of all speeds, so one outlier does not flatten the rest */
function speedBounds(words: readonly DrillWord[]): { lo: number; hi: number } {
    const all = words.flatMap((w) => w.speed.map(lettersPerSecond)).sort((a, b) => a - b);
    if (all.length === 0) return { lo: 0, hi: 1 };
    const at = (q: number) => all[Math.min(all.length - 1, Math.max(0, Math.round(q * (all.length - 1))))]!;
    let lo = at(0.03);
    let hi = at(0.97);
    if (hi - lo < 0.2) {
        const mid = (hi + lo) / 2;
        lo = mid - 0.1;
        hi = mid + 0.1;
    }
    return { lo, hi };
}

function Sparkline({ values, lo, hi }: { values: number[]; lo: number; hi: number }) {
    if (values.length === 0) return <span className="muted">—</span>;
    const y = (v: number) => SPARK_H - 3 - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (SPARK_H - 6);
    const x = (i: number) => (values.length === 1 ? SPARK_W / 2 : 2 + (i / (values.length - 1)) * (SPARK_W - 4));
    const d = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
    return (
        <svg className="word-spark" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" aria-hidden="true">
            <path d={d} fill="none" stroke="#6ab7ff" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            <circle cx={x(values.length - 1)} cy={y(values[values.length - 1]!)} r="2.6" fill="#6ab7ff" />
        </svg>
    );
}

function WordProgressDialog({ word, onClose }: { word: DrillWord; onClose: () => void }) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);
    return (
        <div className="word-dialog-backdrop" onClick={onClose} data-testid="word-progress-dialog">
            <div className="word-dialog" role="dialog" aria-modal="true" aria-label={`Progress for ${word.lemma}`} onClick={(e) => e.stopPropagation()}>
                <div className="word-dialog-head">
                    <h4 className="chart-title">{word.lemma}</h4>
                    <button type="button" className="btn-small" onClick={onClose} autoFocus>
                        Close
                    </button>
                </div>
                <h5 className="chart-title">Typing speed (letters per second, higher is faster)</h5>
                {word.speed.length === 0 ? (
                    <p className="muted small">No timed showings yet.</p>
                ) : (
                    <Chart
                        ariaLabel={`Typing speed of ${word.lemma} over all showings`}
                        line={{ color: '#6ab7ff', format: (v) => `${v.toFixed(1)} letters/s` }}
                        points={word.speed.map((ms, i) => ({
                            key: `s${i}`,
                            label: String(i + 1),
                            line: Math.round(lettersPerSecond(ms) * 100) / 100,
                            tip: [`Showing ${i + 1}`, `${(Math.round(lettersPerSecond(ms) * 10) / 10).toFixed(1)} letters/s`, `${ms} ms per letter`],
                        }))}
                    />
                )}
                <h5 className="chart-title">Accuracy (share of perfect showings among the recent ones)</h5>
                <Chart
                    ariaLabel={`Accuracy of ${word.lemma} over all showings`}
                    line={{ color: '#51b788', format: (v) => `${Math.round(v)}%`, max: 100 }}
                    points={word.trend.map((pct, i) => ({
                        key: `a${i}`,
                        label: String(i + 1),
                        line: pct,
                        tip: [`Showing ${i + 1}`, `${pct}% perfect`],
                    }))}
                />
            </div>
        </div>
    );
}

/** Finger Drills: the words being practised (after all the charts): sortable, loaded 20 at a time while scrolling */
function DrillsWords({ drills }: { drills: NonNullable<Data['summary']['drills']> }) {
    const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'accuracy', dir: 1 });
    const [shown, setShown] = useState(PAGE);
    const [open, setOpen] = useState<DrillWord | null>(null);
    const bounds = useMemo(() => speedBounds(drills.words), [drills.words]);
    const rows = useMemo(() => {
        const val = (w: DrillWord): number | string => {
            switch (sort.key) {
                case 'lemma':
                    return w.lemma;
                case 'showings':
                    return w.showings;
                case 'accuracy':
                    return w.accuracy;
                case 'msPerLetter':
                    return w.msPerLetter ?? Number.POSITIVE_INFINITY;
                case 'step':
                    return w.step;
            }
        };
        return [...drills.words].sort((a, b) => {
            const x = val(a);
            const y = val(b);
            const c = typeof x === 'string' ? x.localeCompare(y as string) : x === y ? 0 : x < (y as number) ? -1 : 1;
            return c * sort.dir || a.lemma.localeCompare(b.lemma);
        });
    }, [drills.words, sort]);
    if (drills.words.length === 0) return null;
    const sortBy = (key: SortKey) => {
        setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
        setShown(PAGE);
    };
    const th = (key: SortKey, label: string) => (
        <th aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
            <button type="button" className="th-sort" onClick={() => sortBy(key)}>
                {label}
                <span aria-hidden="true">{sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</span>
            </button>
        </th>
    );
    return (
        <div className="card">
            <h4 className="chart-title"></h4>
            <div
                className="table-wrap drills-words-scroll"
                data-testid="drills-words-scroll"
                onScroll={(e) => {
                    const el = e.currentTarget;
                    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) setShown((n) => Math.min(rows.length, n + PAGE));
                }}
            >
                <table className="data-table small">
                    <thead>
                        <tr>
                            {th('lemma', 'Word')}
                            {th('showings', 'Typed')}
                            {th('accuracy', 'Perfect (recent)')}
                            {th('msPerLetter', 'Time per letter')}
                            {th('step', 'Status')}
                            <th>Speed progress</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.slice(0, shown).map((w) => (
                            <tr key={w.lemma}>
                                <td>
                                    <strong>{w.lemma}</strong>
                                </td>
                                <td>{w.showings}</td>
                                <td className={w.accuracy >= drills.accuracyNeeded ? 'typing-compare faster' : undefined}>{Math.round(w.accuracy * 100)}%</td>
                                <td className={w.msPerLetter !== null && w.msPerLetter <= drills.targetMsPerLetter ? 'typing-compare faster' : undefined}>
                                    {w.msPerLetter === null ? '—' : `${w.msPerLetter} ms`} <span className="muted">/ {drills.targetMsPerLetter}</span>
                                </td>
                                <td>
                                    {w.learned
                                        ? `Learned · step ${w.step}/${drills.maxStep} · ${w.nextInLevels === 0 ? 'next level' : `in ${w.nextInLevels} levels`}`
                                        : 'Practising'}
                                </td>
                                <td className="spark-cell">
                                    <button type="button" className="spark-btn" aria-label={`Show the progress charts for ${w.lemma}`} onClick={() => setOpen(w)}>
                                        <Sparkline values={w.speed.map(lettersPerSecond)} lo={bounds.lo} hi={bounds.hi} />
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <p className="muted small">
                Showing {Math.min(shown, rows.length)} of {rows.length} words; more load as you scroll. Perfect (recent) is the share of the last{' '}
                {drills.accuracyWindow} showings without a wrong key. Time per letter is the median of the recent perfect showings, from the first letter to
                the space. The blue line is your typing speed (letters per second) over every showing of the word, on one scale for all words; click it for
                the large charts. Learned words never disappear: at the top step they come back every few levels.
            </p>
            {open && <WordProgressDialog word={open} onClose={() => setOpen(null)} />}
        </div>
    );
}

function DailyActivity({ data }: { data: Data['series']['daily'] }) {
    const active = data.filter((d) => d.attempts > 0);
    if (active.length === 0) return <p className="muted">No typing activity in this period yet.</p>;
    return (
        <div>
            <h4 className="chart-title">Daily activity</h4>
            <Chart
                ariaLabel="Daily activity"
                bars={{ color: '#3fbf6f', format: (v) => fmtTotalTime(v) }}
                line={{ color: '#b78bff', format: (v) => Math.round(v).toLocaleString('en-AU') }}
                points={data.map((d) => ({
                    key: d.date,
                    label: fmtDay(d.date),
                    bar: d.activeSeconds,
                    line: d.chars ?? 0,
                    tip: [
                        fmtDay(d.date),
                        `Practice time: ${fmtTotalTime(d.activeSeconds)}`,
                        `Attempts: ${d.attempts}`,
                        `Characters typed: ${(d.chars ?? 0).toLocaleString('en-AU')}`,
                    ],
                }))}
                legend="Bars: practice time; line: characters typed (right axis). Finished attempts are attributed to their end date."
            />
        </div>
    );
}
