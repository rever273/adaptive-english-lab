import { useCallback, useEffect, useState } from 'react';
import { NumberInput } from '../../components/NumberInput';
import { fetchTypingOverview, fetchDictationPool, prepareDictationTracks, fetchRealAudit, setRealAudit, type DictationPoolSummary } from '../../api';
import type { RealAuditStatus } from '../../api/typing';
import { errorText } from './shared';

export function DictationTracks() {
    const [info, setInfo] = useState<Awaited<ReturnType<typeof fetchTypingOverview>>['dictation'] | null>(null);
    const [pool, setPool] = useState<DictationPoolSummary | null>(null);
    const [count, setCount] = useState(10);
    const [error, setError] = useState<string | null>(null);
    const [audit, setAudit] = useState<RealAuditStatus | null>(null);
    const load = useCallback(() => {
        void fetchTypingOverview()
            .then((o) => setInfo(o.dictation))
            .catch(() => undefined);
        void fetchDictationPool()
            .then(setPool)
            .catch(() => undefined);
        void fetchRealAudit().then(setAudit).catch(() => undefined);
    }, []);
    useEffect(load, [load]);
    const generating = (info?.pool.generating ?? 0) > 0;
    useEffect(() => {
        if (!generating && !audit?.enabled) return;
        const id = window.setInterval(load, 2500);
        return () => window.clearInterval(id);
    }, [generating, audit?.enabled, load]);
    const minutes = pool ? Math.floor(pool.audioSeconds / 60) : 0;
    const day = (iso: string) => new Date(iso).toLocaleDateString();
    return (
        <>
            <section className="card">
                <h2>Real speech: automatic checks</h2>
                <p className="lede">Two local Whisper models check that each Australian Common Voice recording matches its original transcript. Matching recordings become available for practice automatically.</p>
                {audit ? <>
                    <button className="btn" data-testid="dictation-real-audit-toggle" onClick={() => {
                        setError(null);
                        void setRealAudit(!audit.enabled).then(setAudit).catch((e) => setError(errorText(e)));
                    }}>{audit.enabled ? 'Stop automatic checks' : 'Start automatic checks'}</button>
                    <p className="muted small" role="status">{audit.running ? audit.enabled ? 'Checking audio' : 'Stopping' : audit.enabled ? 'Waiting' : 'Off'}{!audit.batch && audit.progress ? ` · ${audit.progress}` : ''} · {audit.checked} recordings checked · {audit.matched} matched</p>
                    {audit.running && audit.batch && <p className="muted small" data-testid="dictation-real-audit-progress">
                        Current batch: Whisper large-v3 {audit.batch.largeDone}/{audit.batch.total} · Whisper medium {audit.batch.mediumDone}/{audit.batch.total}
                        {audit.batch.activeModel ? ` · running ${audit.batch.activeModel}` : ''}
                        {audit.batch.etaSeconds === null ? ' · estimating time…' : ` · about ${Math.max(1, Math.ceil(audit.batch.etaSeconds / 60))} min remaining`}
                    </p>}
                    {audit.error && <p className="notice notice-warning" role="status">{audit.error}</p>}
                </> : <p className="muted small">Automatic checks are unavailable until the server is restarted.</p>}
            </section>
            <section className="card">
                <h2>Piper Audio Dictation tracks</h2>
                <p className="lede">
                    Prepare spoken sentences ahead of time, so Audio Dictation lessons start without waiting. Sentences stay hidden here so the dictation is not
                    spoiled.
                </p>
                {error && (
                    <p className="notice notice-error" role="alert">
                        {error}
                    </p>
                )}
                {info && !info.available && (
                    <p className="notice notice-warning small" role="status">
                        Audio Dictation is not available yet{info.reason ? `: ${info.reason}` : ''}.
                    </p>
                )}
                <div className="dictation-prepare">
                    <label className="small">
                        Prepare{' '}
                        <NumberInput
                            min={1}
                            max={50}
                            value={count}
                            onChange={setCount}
                            aria-label="Number of audio tracks to prepare"
                            data-testid="dictation-prepare-count"
                        />{' '}
                        audio tracks for later
                    </label>
                    <button
                        className="btn"
                        disabled={!info?.available}
                        onClick={() => {
                            setError(null);
                            void prepareDictationTracks(count)
                                .catch((e) => setError(errorText(e)))
                                .finally(load);
                        }}
                        data-testid="dictation-prepare"
                    >
                        Prepare
                    </button>
                    {info && (
                        <p className="muted small" role="status">
                            {info.pool.prepared} ready for the next lessons{info.pool.generating > 0 ? ` · ${info.pool.generating} being prepared` : ''}
                        </p>
                    )}
                </div>
            </section>
            <section className="card">
                <h2>Prepared tracks</h2>
                {!pool || (pool.ready === 0 && pool.used === 0) ? (
                    <p className="muted">No prepared tracks yet.</p>
                ) : (
                    <>
                        <div className="prepared-track-stats" data-testid="dictation-pool-summary">
                            <div className="stat"><span className="stat-num">{pool.ready}</span><span className="stat-label">ready to play</span></div>
                            <div className="stat"><span className="stat-num">{minutes > 0 ? `${minutes}m ` : ''}{pool.audioSeconds % 60}s</span><span className="stat-label">prepared audio</span></div>
                            <div className="stat"><span className="stat-num">{pool.used}</span><span className="stat-label">used in lessons</span></div>
                            <div className="stat"><span className="stat-num">{pool.topicTotal}</span><span className="stat-label">topics</span></div>
                        </div>
                        {pool.ready > 0 && <p className="muted small">{pool.minWords}-{pool.maxWords} words per track{pool.oldest ? ` | prepared ${day(pool.oldest)}${pool.newest && day(pool.newest) !== day(pool.oldest) ? ` to ${day(pool.newest)}` : ''}` : ''}.</p>}
                        {pool.voices.length > 0 && (
                            <>
                                <h3>Voices in prepared tracks</h3>
                                <p className="chips">
                                    {pool.voices.map((v) => (
                                        <span key={v.name} className="chip">
                                            {v.name} · {v.n}
                                        </span>
                                    ))}
                                </p>
                            </>
                        )}
                    </>
                )}
            </section>
        </>
    );
}
