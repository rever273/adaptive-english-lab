import type { JourneyMode } from '../api';
import { MODE_INFO, MODES, formatTime } from '../journey/model';
import { useJourney } from '../journey/useJourney';
export { dailyOrder } from './dailyOrder';
import { dailyOrder } from './dailyOrder';
/** a random practice from today's plan; practices whose goal is not reached yet are preferred */
function pickRandom(order: JourneyMode[], todayMs: Record<JourneyMode, number>, minutes: Record<JourneyMode, number>): JourneyMode {
    const open = order.filter((m) => todayMs[m] < minutes[m] * 60000);
    const pool = open.length > 0 ? open : order;
    return pool[Math.floor(Math.random() * pool.length)]!;
}
export function DailyPractice({
    onStart,
    sequential,
    onSequential,
}: {
    onStart: (m: JourneyMode) => void;
    sequential: boolean;
    onSequential: (v: boolean) => void;
}) {
    const { data: d, error } = useJourney();
    if (!d) return <div className="card">{error ?? 'Loading today’s plan...'}</div>;
    const order = dailyOrder(d.dailyMinutes, d.todayMs, d.dailyOrder),
        done = order.filter((m) => d.todayMs[m] >= d.dailyMinutes[m] * 60000).length,
        totalMs = Object.values(d.todayMs).reduce((a, b) => a + b, 0),
        plannedMin = Object.values(d.dailyMinutes).reduce((a, b) => a + b, 0);
    return (
        <section className="daily-page">
            <div className="daily-heading">
                <div>
                    <span className="journey-eyebrow">YOUR PLAN FOR TODAY</span>
                    <h2>Make time for your English.</h2>
                    <p className="muted">A flexible plan. Finish at your own pace; practice from any screen counts.</p>
                </div>
                <div className="daily-counts">
                    <div className={`daily-count${totalMs >= plannedMin * 60000 && plannedMin > 0 ? ' reached' : ''}`}>
                        <strong>{formatTime(totalMs)}</strong>
                        <small>practised today</small>
                    </div>
                    <div className="daily-count">
                        <strong>
                            {done}
                            <span> / {order.length}</span>
                        </strong>
                        <small>goals reached</small>
                    </div>
                    <button type="button" className="daily-random" disabled={order.length === 0} onClick={() => onStart(pickRandom(order, d.todayMs, d.dailyMinutes))} title="Start a random practice from today’s plan">
                        <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
                            <rect x="3" y="3" width="18" height="18" rx="4" />
                            <circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
                            <circle cx="16" cy="8" r="1.4" fill="currentColor" stroke="none" />
                            <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
                            <circle cx="8" cy="16" r="1.4" fill="currentColor" stroke="none" />
                            <circle cx="16" cy="16" r="1.4" fill="currentColor" stroke="none" />
                        </svg>
                        <strong>Surprise me</strong>
                        <small>random practice</small>
                    </button>
                </div>
            </div>
            <div className="daily-summary">
                <span>
                    <i className="pi pi-clock" /> {Object.values(d.dailyMinutes).reduce((a, b) => a + b, 0)} min planned
                </span>
                <span>
                    <i className="pi pi-calendar" /> {d.activeDays} of 7 days active
                </span>
                <label className="check">
                    <input type="checkbox" checked={sequential} onChange={(e) => onSequential(e.target.checked)} /> Offer the next practice after results
                </label>
            </div>
            <div className="daily-list">
                {order.length === 0 && <div className="card">No practice selected. Set daily minutes in Settings.</div>}
                {order.map((m) => {
                    const target = d.dailyMinutes[m],
                        actual = d.todayMs[m],
                        pct = Math.min(100, Math.round((actual / (target * 60000)) * 100)),
                        complete = actual >= target * 60000;
                    return (
                        <div className={`daily-item${complete ? ' complete' : ''}`} key={m}>
                            <span className="daily-icon">
                                <i className={`pi ${complete ? 'pi-check' : MODE_INFO[m].icon}`} />
                            </span>
                            <div className="daily-copy">
                                <strong>{MODE_INFO[m].label}</strong>
                                <small>
                                    {MODE_INFO[m].description}
                                    {m === 'books' ? ` · session ${d.bookMinutes} min` : ''}
                                </small>
                                <div className="daily-progress">
                                    <span style={{ width: `${pct}%` }} />
                                </div>
                            </div>
                            <div className="daily-time">
                                <strong>
                                    {formatTime(actual)} / {target} min
                                </strong>
                                <small>{complete ? 'Goal reached' : `${pct}% complete`}</small>
                            </div>
                            <button type="button" className={`btn ${complete ? '' : 'btn-primary'}`} onClick={() => onStart(m)}>
                                {complete ? 'Practise again' : 'Start'} <i className="pi pi-arrow-right" />
                            </button>
                        </div>
                    );
                })}
            </div>
            <p className="muted small">
                Targets are approximate. A session is never interrupted when its target is reached. Typing daily time begins with the new tracker.
            </p>
        </section>
    );
}
