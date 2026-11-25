import { useCallback, useEffect, useState } from 'react';
import * as api from '../api';
import { groupDigits } from '../stats';

const VERDICT: Record<string, string> = {
    key_ok: 'Answer is unique',
    several_correct: 'Several answers fit',
    key_wrong: 'Answer key looks wrong',
    ambiguous: 'Not enough context',
    broken: 'Sentence looks broken',
    by_hand: 'Hidden by you',
};
/** measured ~4-6 s per sentence on the local model; shown only as a rough guide */
const SECONDS_PER_SENTENCE = 5;

function stateText(o: api.ClozeAuditOverview): string {
    if (!o.enabled) return o.job ? 'Paused' : 'Off';
    if (o.remaining === 0 && !o.job) return 'All sentences checked';
    if (!o.job) return 'Starting…';
    if (o.job.state === 'running') return 'Checking…';
    if (o.job.state === 'paused') return o.job.reason === 'preempted_by_practice' ? 'Paused while you practise' : 'Paused';
    if (o.job.state === 'waiting_for_gpu') return 'Waiting for the GPU';
    return 'Waiting for more important model work';
}

/**
 * Content Studio: the background check of Grammar Cloze sentences by the local model. It hides sentences with more than one possible answer
 * (or a doubtful key) from new sessions and stores a short reason; you can restore any hidden sentence.
 */
export function GrammarClozeAudit() {
    const [o, setO] = useState<api.ClozeAuditOverview | null>(null);
    const [rows, setRows] = useState<api.ClozeAuditRow[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const load = useCallback(async () => {
        try {
            setO(await api.fetchClozeAudit());
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, []);
    useEffect(() => {
        void load();
        const t = window.setInterval(() => {
            if (document.visibilityState === 'visible') void load();
        }, 5000);
        return () => window.clearInterval(t);
    }, [load]);
    const toggle = async () => {
        if (!o) return;
        setBusy(true);
        try {
            setO(await api.setClozeAudit(!o.enabled));
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };
    const loadRows = async (more: boolean) => {
        try {
            const r = await api.fetchClozeAuditItems(more && rows ? rows.length : 0);
            setRows(more && rows ? [...rows, ...r.items] : r.items);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    };
    const override = async (row: api.ClozeAuditRow) => {
        try {
            const action = row.hidden ? 'restore' : 'hide';
            const r = await api.setClozeAuditOverride(row.itemId, action);
            setRows((cur) => cur?.map((x) => (x.itemId === row.itemId ? { ...x, hidden: r.hidden, override: action } : x)) ?? null);
            void load();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    };
    if (!o) return null;
    const pct = o.total === 0 ? 0 : (o.checked / o.total) * 100;
    const problems = Object.entries(o.byVerdict).filter(([v]) => v !== 'key_ok');
    const hours = (o.remaining * SECONDS_PER_SENTENCE) / 3600;
    return (
        <section className="card" data-testid="cloze-audit">
            <h2>
                <i className="pi pi-shield" aria-hidden="true" /> Grammar Cloze check
            </h2>
            <p className="small muted">
                The local model reads each sentence once in the background. Sentences where more than one answer fits, or the key looks wrong, are
                hidden from new sessions and do not move to Stage 2. It pauses during speech practice and gives way to your own requests to the model.
                The model can be wrong: restore any sentence below.
            </p>
            <div className="actions">
                <button className={`btn${o.enabled ? '' : ' btn-primary'}`} onClick={() => void toggle()} disabled={busy} data-testid="cloze-audit-toggle">
                    <i className={`pi ${o.enabled ? 'pi-pause' : 'pi-play'}`} aria-hidden="true" /> {o.enabled ? 'Pause' : 'Start'}
                </button>
                <span className="small" role="status" data-testid="cloze-audit-state">
                    {o.job?.state === 'running' && <i className="pi pi-spin pi-spinner" aria-hidden="true" />} {stateText(o)}
                </span>
            </div>
            <div className="progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label="Sentences checked">
                <div style={{ width: `${pct}%` }} />
            </div>
            <p className="small">
                Checked <strong>{groupDigits(o.checked)}</strong> of {groupDigits(o.total)} sentences
                {o.remaining > 0 && <> · about {hours < 1 ? `${Math.max(1, Math.round(hours * 60))} min` : `${hours.toFixed(1)} h`} of model time left</>}
                {o.failed > 0 && <> · {o.failed} could not be read (not counted as checked; asked again automatically after 2 hours while this page is open, up to 5 tries)</>}
            </p>
            <ul className="small" data-testid="cloze-audit-breakdown">
                <li>
                    Unique answer: {groupDigits(o.ok)} <span className="muted">(stay in sessions)</span>
                </li>
                {problems.map(([v, n]) => (
                    <li key={v}>
                        {VERDICT[v] ?? v}: {groupDigits(n)} <span className="muted">(hidden)</span>
                    </li>
                ))}
                <li>
                    <strong>
                        {groupDigits(o.ok)}
                        {problems.map(([, n]) => ` + ${groupDigits(n)}`).join('')} = {groupDigits(o.checked)} checked
                    </strong>
                </li>
            </ul>
            <p className="small" data-testid="cloze-audit-hidden">
                Hidden now: <strong>{groupDigits(o.hidden)}</strong>
                {o.restored > 0 && <> (you restored {o.restored})</>}. All of them are removed from Stage 1 and cannot move to Stage 2
                {o.hiddenAnswered > 0 && <>; {groupDigits(o.hiddenAnswered)} you had already answered, and those answers stay in your history only</>}.
            </p>
            {error && (
                <p className="notice notice-error small" role="alert">
                    {error}
                </p>
            )}
            <details onToggle={(e) => (e.currentTarget.open && rows === null ? void loadRows(false) : undefined)}>
                <summary>Hidden and doubtful sentences</summary>
                {rows === null ? (
                    <p className="small muted">Loading…</p>
                ) : rows.length === 0 ? (
                    <p className="small muted">Nothing yet.</p>
                ) : (
                    <ul className="gc-rules gc-audit-list">
                        {rows.map((r) => (
                            <li key={r.itemId} data-testid="cloze-audit-row">
                                <div>
                                    <div>{r.gappedText}</div>
                                    <div className="small">
                                        Key <strong>{r.solution}</strong>
                                        {r.otherCorrect.length > 0 && <> · also fits: {r.otherCorrect.join(', ')}</>} · <span className="muted">{VERDICT[r.verdict] ?? r.verdict}</span>
                                    </div>
                                    <div lang="ru" className="small muted">
                                        {r.reasonRu}
                                    </div>
                                </div>
                                <button className="btn" onClick={() => void override(r)} title={r.hidden ? 'Use this sentence in sessions again' : 'Keep this sentence out of sessions'}>
                                    {r.hidden ? 'Restore' : 'Hide'}
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
                {rows && rows.length > 0 && rows.length % 50 === 0 && (
                    <button className="btn" onClick={() => void loadRows(true)}>
                        Show more
                    </button>
                )}
            </details>
        </section>
    );
}
