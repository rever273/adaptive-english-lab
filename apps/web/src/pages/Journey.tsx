import { MODE_INFO, MODES, formatTime, journeyProgress, stageMilestones, percentShares } from '../journey/model';
import { useJourney } from '../journey/useJourney';
export { MODE_INFO, MODES, formatTime, journeyProgress, stageMilestones, percentShares } from '../journey/model';
export { useJourney } from '../journey/useJourney';
export { JourneyButton } from '../components/JourneyButton';

import { useEffect, useRef, useState } from 'react';
import { Chart } from '../components/Chart';
import { NumberInput } from '../components/NumberInput';
import * as api from '../api';

/** total practice time per day, one value per day (no time frames) */
function DailyTimeChart() {
    const [rows, setRows] = useState<Array<{ date: string; ms: number }> | null>(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let alive = true;
        api.fetchJourneyDailyTotals()
            .then((r) => alive && setRows(r.days))
            .catch(() => alive && setFailed(true));
        return () => {
            alive = false;
        };
    }, []);
    if (failed) return <div className="card muted">Daily practice time is unavailable.</div>;
    if (!rows) return <div className="card muted">Loading daily practice time...</div>;
    if (rows.length === 0) return <div className="card muted">No recorded practice time yet.</div>;
    const byDate = new Map(rows.map((r) => [r.date, r.ms]));
    const last = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Brisbane', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() - 3600000));
    const points = [];
    for (let at = Date.parse(rows[0]!.date + 'T00:00:00Z'), end = Date.parse(last + 'T00:00:00Z'); at <= end; at += 86400000) {
        const date = new Date(at).toISOString().slice(0, 10),
            minutes = (byDate.get(date) ?? 0) / 60000;
        points.push({ key: date, label: date.slice(5), line: minutes, tip: [date, `Practice: ${formatTime(minutes * 60000)}`] });
    }
    return (
        <div className="card">
            <h3>Practice time per day</h3>
            <Chart
                ariaLabel="Total practice time per day"
                line={{ color: '#6ca9ff', format: (v) => `${Math.round(v)} min` }}
                points={points}
                legend="All practice together; the learning day starts at 1 am Brisbane time. Earlier typing totals have no daily breakdown."
            />
        </div>
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
        shares = percentShares(MODES.map((m) => d.totals[m])),
        nextAt = milestones.findIndex((m) => m.next),
        // reached milestones stay; of the upcoming ones only the next and the one after it are shown
        visible = nextAt < 0 ? milestones : milestones.filter((_, i) => i <= nextAt + 1),
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
                    is unavailable. Earlier conversation time is included without a daily breakdown.
                </p>
            </div>

            <DailyTimeChart />

            <div className="journey-grid">
                <div className="card journey-breakdown">
                    <h3>Your practice</h3>
                    {MODES.map((m, i) => ({ m, share: shares?.[i] ?? 0, i }))
                        .sort((a, b) => b.share - a.share || d.totals[b.m] - d.totals[a.m] || a.i - b.i)
                        .map(({ m, i }) => (
                        <div className="journey-row" key={m}>
                            <span>
                                <i className={`pi ${MODE_INFO[m].icon}`} /> {MODE_INFO[m].label}
                            </span>
                            <strong>
                                {formatTime(d.totals[m])}
                                {shares && <span className="muted small"> ({shares[i]}%)</span>}
                            </strong>
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

            <section className="card journey-milestones" aria-labelledby="journey-milestones-title">
                <div className="journey-milestones-heading">
                    <div>
                        <h3 id="journey-milestones-title">
                            {stages[p.stage]} &rarr; {stages[p.stage + 1]} milestones
                        </h3>
                        <p className="muted small">Practice hours in this stage &middot; a check marks a completed time goal.</p>
                    </div>
                    <span className="journey-milestones-count">
                        {milestones.filter((m) => m.complete).length} / {milestones.length} reached
                    </span>
                </div>
                <div className="journey-milestones-scroll">
                    <table aria-label={`${stages[p.stage]} to ${stages[p.stage + 1]} practice hour milestones`}>
                        <tbody>
                            {Array.from({ length: Math.ceil(visible.length / 5) }, (_, row) => (
                                <tr key={row}>
                                    {visible.slice(row * 5, row * 5 + 5).map((m) => (
                                        <td key={m.hours}>
                                            <span className={`journey-milestone${m.complete ? ' complete' : ''}${m.next ? ' next' : ''}`}>
                                                <i
                                                    className={`pi ${m.complete ? 'pi-check-circle' : m.next ? 'pi-circle-fill' : 'pi-circle'}`}
                                                    aria-hidden="true"
                                                />
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
        </section>
    );
}

export function JourneySettings() {
    const { data, error } = useJourney();
    const [daily, setDaily] = useState<api.JourneyData['dailyMinutes'] | null>(null),
        [hours, setHours] = useState<api.JourneyData['journeyHours'] | null>(null),
        [message, setMessage] = useState(''),
        [order, setOrder] = useState<api.JourneyMode[] | null>(null);
    const initial = useRef<string | null>(null);
    const queue = useRef<Promise<void>>(Promise.resolve());
    const sequence = useRef(0);
    const mounted = useRef(true);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    useEffect(() => {
        if (data) {
            setDaily((x) => x ?? data.dailyMinutes);
            setHours((x) => x ?? data.journeyHours);
            setOrder((x) => x ?? data.dailyOrder);
        }
    }, [data]);
    useEffect(() => {
        if (!daily || !hours || !order) return;
        const payload = { dailyMinutes: daily, journeyHours: hours, dailyOrder: order };
        const snapshot = JSON.stringify(payload);
        if (initial.current === null) { initial.current = snapshot; return; }
        if (initial.current === snapshot) { sequence.current++; setMessage(''); return; }
        const version = ++sequence.current;
        setMessage('Saving…');
        const timer = window.setTimeout(() => {
            initial.current = snapshot;
            queue.current = queue.current.then(async () => {
                try {
                    await api.saveJourneySettings(payload);
                    if (mounted.current && version === sequence.current) setMessage('Saved.');
                } catch (e) {
                    if (mounted.current && version === sequence.current) setMessage(e instanceof Error ? e.message : 'Could not save.');
                }
            });
        }, 500);
        return () => window.clearTimeout(timer);
    }, [daily, hours, order]);
    if (!daily || !hours || !order) return <div className="card">{error ?? 'Loading journey settings...'}</div>;
    return (
        <div className="card journey-settings">
            <h3>Daily Practice & Journey</h3>
            <p className="muted small">Set a flexible daily target for each practice. Zero leaves it out of the plan.</p>
            {MODES.map((m) => (
                <label key={m} className="journey-setting-row">
                    <span>{MODE_INFO[m].label}</span>
                    <input type="range" min="0" max="120" step={m === 'conversation' ? 0.5 : 1} value={daily[m]} onChange={(e) => setDaily({ ...daily, [m]: Number(e.target.value) })} />
                    <strong>{daily[m]} min</strong>
                </label>
            ))}
            <p>
                <strong>Total: {Object.values(daily).reduce((a, b) => a + b, 0)} min / day</strong>{' '}
                <span className="muted small">· Book session setting: {data?.bookMinutes} min</span>
            </p>
            <p className="small muted">Base order when progress is equal:</p>
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
                        <NumberInput min={1} max={5000} value={hours[k]} onChange={(value) => setHours((current) => current && { ...current, [k]: value })} />{' '}
                        hours
                    </label>
                ))}
            </div>
            <span role="status">{message}</span>
        </div>
    );
}
