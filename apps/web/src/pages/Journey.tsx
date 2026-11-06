import { useEffect, useState } from 'react';
import * as api from '../api';

export const MODE_INFO: Record<api.JourneyMode, { label: string; icon: string; description: string }> = {
    grammar: { label: 'Grammar', icon: 'pi-pencil', description: 'Build confident sentences' },
    vocabulary: { label: 'Vocabulary', icon: 'pi-bookmark', description: 'Practise words in context' },
    words: { label: 'Typing - Words', icon: 'pi-bolt', description: 'Type and discover words' },
    books: { label: 'Typing - Books', icon: 'pi-book', description: 'Continue your book' },
    dictation: { label: 'Audio Dictation', icon: 'pi-volume-up', description: 'Listen and type' },
};
export const MODES: api.JourneyMode[] = ['grammar', 'vocabulary', 'words', 'books', 'dictation'];
export const formatTime = (ms: number) => {
    const m = Math.floor(ms / 60000);
    return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m} min`;
};
export function journeyProgress(d: api.JourneyData) {
    const ms = Object.values(d.totals).reduce((a, b) => a + b, 0),
        hours = ms / 3600000;
    const targets: [number, number, number] = [d.journeyHours.b2, d.journeyHours.c1, d.journeyHours.c2];
    const cuts: [number, number, number, number] = [0, targets[0], targets[0] + targets[1], targets[0] + targets[1] + targets[2]];
    const stage = hours < cuts[1]! ? 0 : hours < cuts[2]! ? 1 : 2;
    const stageProgress = Math.max(0, Math.min(1, (hours - cuts[stage]!) / targets[stage]!));
    return { ms, hours, targets, cuts, stage, stageProgress, whole: Math.min(1, hours / cuts[3]!) };
}
/** Milestones are measured from the start of the current stage, including its exact target. */
export function stageMilestones(targetHours: number, completedHours: number) {
    const marks = Array.from({ length: Math.floor(targetHours / 5) }, (_, i) => (i + 1) * 5);
    if (marks.at(-1) !== targetHours) marks.push(targetHours);
    const next = marks.findIndex((hours) => hours > completedHours);
    return marks.map((hours, i) => ({ hours, complete: hours <= completedHours, next: i === next }));
}

export function useJourney() {
    const [data, setData] = useState<api.JourneyData | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        let alive = true;
        const load = () =>
            void api
                .fetchJourney()
                .then((x) => {
                    if (alive) {
                        setData(x);
                        setError(null);
                    }
                })
                .catch((e) => {
                    if (alive) setError(e instanceof Error ? e.message : 'Could not load journey');
                });
        load();
        const timer = window.setInterval(load, 15000);
        return () => {
            alive = false;
            window.clearInterval(timer);
        };
    }, []);
    return { data, error };
}
export function JourneyButton({ onOpen }: { onOpen: () => void }) {
    const { data } = useJourney();
    const p = data ? journeyProgress(data) : null;
    return (
        <button
            type="button"
            className="journey-header"
            onClick={onOpen}
            aria-label={p ? `Journey, ${Math.round(p.stageProgress * 100)} percent of current hours goal` : 'Open journey'}
        >
            <span>✦ Journey</span>
            <span className="journey-header-track">
                <span style={{ width: `${p ? p.stageProgress * 100 : 0}%` }} />
            </span>
        </button>
    );
}
function Improvement() {
    const [comparison, setComparison] = useState<api.ReportData['comparison'] | null>(null);
    useEffect(() => {
        let active = true;
        void api
            .fetchReport({ protocol: 'practice', difficulty: 'B2' })
            .then((r) => {
                if (active) setComparison(r.report.comparison);
            })
            .catch(() => {});
        return () => {
            active = false;
        };
    }, []);
    const current = comparison?.current.firstTry,
        previous = comparison?.previous.firstTry;
    if (comparison?.status === 'ok' && !comparison.mixDiffers && current?.rate != null && previous?.rate != null && current.rate > previous.rate)
        return (
            <>
                <p>
                    Independent first answers in B2 practice improved:{' '}
                    <strong>
                        {current.numerator} / {current.denominator}
                    </strong>{' '}
                    in the last 28 days, compared with{' '}
                    <strong>
                        {previous.numerator} / {previous.denominator}
                    </strong>{' '}
                    in the previous 28 days.
                </p>
                <p className="small muted">Confirmed first attempts without hints. A pattern in this series, not a level assessment.</p>
            </>
        );
    return (
        <>
            <p>No comparable improvement is identified yet. More independent answers may reveal a trend.</p>
            <p className="small muted">Detailed skill evidence remains available in Grammar analytics.</p>
        </>
    );
}
export function Journey() {
    const { data: d, error } = useJourney();
    if (!d) return <div className="card">{error ?? 'Loading your journey...'}</div>;
    const p = journeyProgress(d),
        stageHours = Math.max(0, p.hours - p.cuts[p.stage]!),
        milestones = stageMilestones(p.targets[p.stage]!, stageHours),
        nextMilestone = milestones.find((m) => m.next),
        stages = ['B1', 'B2', 'C1', 'C2'],
        x = (n: number) => 40 + (920 * n) / p.cuts[3]!;
    return (
        <section className="journey-page">
            <div className="journey-hero">
                <div className="journey-eyebrow">YOUR ENGLISH JOURNEY</div>
                <h2>Every hour moves you forward.</h2>
                <p className="muted">A personal goal for time spent practising. The milestones are not a CEFR assessment.</p>
                <div className="journey-metrics">
                    <div>
                        <strong>{formatTime(p.ms)}</strong>
                        <span>practice recorded</span>
                    </div>
                    <div>
                        <strong>{Math.round(p.stageProgress * 100 * 100) / 100}%</strong>
                        <span>
                            {stages[p.stage]} → {stages[p.stage + 1]} hours goal
                        </span>
                    </div>
                    <div>
                        <strong>{nextMilestone ? formatTime(Math.max(0, (nextMilestone.hours - stageHours) * 3600000)) : 'Complete'}</strong>
                        <span>{nextMilestone ? `to ${nextMilestone.hours} hours in this stage` : 'all stage milestones reached'}</span>
                    </div>
                </div>
                <div className="journey-map">
                    <svg
                        viewBox="0 0 1000 130"
                        role="img"
                        aria-label={`Your route from B1 to C2. ${Math.round(p.stageProgress * 100)} percent of the current time goal.`}
                    >
                        <defs>
                            <linearGradient id="journey-gradient" gradientUnits="userSpaceOnUse" x1="40" y1="0" x2="960" y2="0">
                                <stop stopColor="#6ca9ff" />
                                <stop offset=".52" stopColor="#9b87fb" />
                                <stop offset="1" stopColor="#65dbbd" />
                            </linearGradient>
                        </defs>
                        <path d="M40 54 H960" className="journey-rail" />
                        <path d={`M40 54 H${x(Math.min(p.hours, p.cuts[3]!))}`} className="journey-fill" />
                        <path d={`M40 54 H${x(Math.min(p.hours, p.cuts[3]!))}`} className="journey-shimmer" aria-hidden="true" />
                        {p.cuts.map((n, i) => (
                            <g key={n}>
                                <circle cx={x(n)} cy="54" r="9" className={p.hours >= n ? 'journey-node done' : 'journey-node'} />
                                <text x={x(n)} y="94" textAnchor="middle">
                                    {stages[i]}
                                </text>
                                <text x={x(n)} y="116" textAnchor="middle" className="journey-small">
                                    {n}h
                                </text>
                            </g>
                        ))}
                        <circle cx={x(Math.min(p.hours, p.cuts[3]!))} cy="54" r="15" className="journey-current" />
                    </svg>
                </div>
                <p className="small muted">
                    Time goal only · Grammar and vocabulary history starts when tracking was enabled. Earlier typing totals are included; past daily breakdown
                    is unavailable.
                </p>
            </div>
            <section className="card journey-milestones" aria-labelledby="journey-milestones-title">
                <div className="journey-milestones-heading">
                    <div>
                        <h3 id="journey-milestones-title">{stages[p.stage]} &rarr; {stages[p.stage + 1]} milestones</h3>
                        <p className="muted small">Practice hours in this stage &middot; a check marks a completed time goal.</p>
                    </div>
                    <span className="journey-milestones-count">{milestones.filter((m) => m.complete).length} / {milestones.length} reached</span>
                </div>
                <div className="journey-milestones-scroll">
                    <table aria-label={`${stages[p.stage]} to ${stages[p.stage + 1]} practice hour milestones`}>
                        <tbody>
                            {Array.from({ length: Math.ceil(milestones.length / 5) }, (_, row) => (
                                <tr key={row}>
                                    {milestones.slice(row * 5, row * 5 + 5).map((m) => (
                                        <td key={m.hours}>
                                            <span className={`journey-milestone${m.complete ? ' complete' : ''}${m.next ? ' next' : ''}`}>
                                                <i className={`pi ${m.complete ? 'pi-check-circle' : m.next ? 'pi-circle-fill' : 'pi-circle'}`} aria-hidden="true" />
                                                <span>{m.hours}h</span>
                                                <span className="visually-hidden">{m.complete ? ' completed' : m.next ? ' next milestone' : ' upcoming'}</span>
                                            </span>
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>
            <div className="journey-grid">
                <div className="card journey-breakdown">
                    <h3>Your practice</h3>
                    {MODES.map((m) => (
                        <div className="journey-row" key={m}>
                            <span>
                                <i className={`pi ${MODE_INFO[m].icon}`} /> {MODE_INFO[m].label}
                            </span>
                            <strong>{formatTime(d.totals[m])}</strong>
                        </div>
                    ))}
                </div>
                <div className="card journey-insight">
                    <h3>
                        <i className="pi pi-sparkles" /> What is getting better
                    </h3>
                    <Improvement />
                    <div className="journey-week">
                        <strong>{d.activeDays} / 7</strong>
                        <span>days with recorded practice in the last week</span>
                    </div>
                </div>
            </div>
        </section>
    );
}

export function JourneySettings() {
    const { data, error } = useJourney();
    const [daily, setDaily] = useState<api.JourneyData['dailyMinutes'] | null>(null),
        [hours, setHours] = useState<api.JourneyData['journeyHours'] | null>(null),
        [message, setMessage] = useState(''),
        [order, setOrder] = useState<api.JourneyMode[] | null>(null);
    useEffect(() => {
        if (data) {
            setDaily((x) => x ?? data.dailyMinutes);
            setHours((x) => x ?? data.journeyHours);
            setOrder((x) => x ?? data.dailyOrder);
        }
    }, [data]);
    if (!daily || !hours || !order) return <div className="card">{error ?? 'Loading journey settings...'}</div>;
    const save = async () => {
        try {
            await api.saveJourneySettings({ dailyMinutes: daily, journeyHours: hours, dailyOrder: order });
            setMessage('Saved.');
        } catch (e) {
            setMessage(e instanceof Error ? e.message : 'Could not save.');
        }
    };
    return (
        <div className="card journey-settings">
            <h3>Daily Practice & Journey</h3>
            <p className="muted small">Set a flexible daily target for each practice. Zero leaves it out of the plan.</p>
            {MODES.map((m) => (
                <label key={m} className="journey-setting-row">
                    <span>{MODE_INFO[m].label}</span>
                    <input type="range" min="0" max="120" step="5" value={daily[m]} onChange={(e) => setDaily({ ...daily, [m]: Number(e.target.value) })} />
                    <strong>{daily[m]} min</strong>
                </label>
            ))}
            <p>
                <strong>Total: {Object.values(daily).reduce((a, b) => a + b, 0)} min / day</strong>{' '}
                <span className="muted small">· Book session setting: {data?.bookMinutes} min</span>
            </p>
            <p className="small muted">Base order (the starting point rotates daily):</p>
            <div className="daily-order">
                {order.map((m, i) => (
                    <span key={m}>
                        {MODE_INFO[m].label}{' '}
                        <button
                            type="button"
                            aria-label={`Move ${MODE_INFO[m].label} earlier`}
                            disabled={i === 0}
                            onClick={() => {
                                const x = [...order];
                                [x[i - 1], x[i]] = [x[i]!, x[i - 1]!];
                                setOrder(x);
                            }}
                        >
                            &uarr;
                        </button>
                        <button
                            type="button"
                            aria-label={`Move ${MODE_INFO[m].label} later`}
                            disabled={i === order.length - 1}
                            onClick={() => {
                                const x = [...order];
                                [x[i], x[i + 1]] = [x[i + 1]!, x[i]!];
                                setOrder(x);
                            }}
                        >
                            &darr;
                        </button>
                    </span>
                ))}
            </div>
            <div className="journey-goals">
                {(['b2', 'c1', 'c2'] as const).map((k, i) => (
                    <label key={k}>
                        {['B1 → B2', 'B2 → C1', 'C1 → C2'][i]}{' '}
                        <input
                            type="number"
                            min={1}
                            max={5000}
                            value={hours[k]}
                            onChange={(e) => setHours({ ...hours, [k]: Math.max(1, Math.min(5000, Number(e.target.value) || 1)) })}
                        />{' '}
                        hours
                    </label>
                ))}
            </div>
            <button className="btn btn-primary" type="button" onClick={() => void save()}>
                Save journey settings
            </button>{' '}
            <span role="status">{message}</span>
        </div>
    );
}
