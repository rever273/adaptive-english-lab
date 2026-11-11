import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../api';
import { DailyGoalCheck } from '../components/DailyGoalNotice';
import { HOTKEYS, Kbd, isPressable, isTextField, useKeys } from '../components/hotkeys';
import { useClozeActivity } from '../grammarClozeActivity';
import { AI_CHECK_WAIT_S } from '../practiceFlow';
import { playPracticeSound } from '../practiceSounds';
import { PauseButton, PauseOverlay, useAutoPause, usePauseKeys } from '../components/Pause';
import { RevealPicture } from '../components/RevealPicture';
import { groupDigits } from '../stats';
import { Markdown } from './Tutor';

/** one tab id per browser tab, kept across reloads (the same key as Practice) */
function tabId(): string {
    try {
        const existing = sessionStorage.getItem('el_tab');
        if (existing) return existing;
        const id = crypto.randomUUID();
        sessionStorage.setItem('el_tab', id);
        return id;
    } catch {
        return crypto.randomUUID();
    }
}
const errorText = (e: unknown): string => (e instanceof api.ApiRequestError ? e.message : e instanceof Error ? e.message : 'Something went wrong.');
const level = (n: number): string => `L${String(n).padStart(2, '0')}`;

type Screen = { kind: 'overview' } | { kind: 'session'; session: api.ClozeSessionView } | { kind: 'summary'; summary: api.ClozeSummary };

/** Grammar Cloze / Sentence Survival (TASK_032): Stage 1 plays; later stages are shown, not playable yet. */
export function GrammarCloze({ dailyStart = false, onDailyDone }: { dailyStart?: boolean; onDailyDone?: () => void }) {
    const [screen, setScreen] = useState<Screen>({ kind: 'overview' });
    const [overview, setOverview] = useState<api.ClozeOverview | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [sounds, setSounds] = useState(true);
    const tab = useRef(tabId());
    const loadOverview = useCallback(async () => {
        try {
            setOverview(await api.fetchClozeOverview());
            setError(null);
        } catch (e) {
            setError(errorText(e));
        }
    }, []);
    useEffect(() => {
        void loadOverview();
    }, [loadOverview]);
    useEffect(() => {
        let active = true;
        const load = () => {
            void api
                .fetchSettings()
                .then((s) => {
                    if (active) setSounds(s.values.practiceSoundsEnabled ?? true);
                })
                .catch(() => undefined);
        };
        load();
        window.addEventListener('focus', load);
        return () => {
            active = false;
            window.removeEventListener('focus', load);
        };
    }, []);
    const start = useCallback(async () => {
        try {
            const r = await api.startClozeSession(tab.current);
            setScreen({ kind: 'session', session: r.session });
            setError(null);
        } catch (e) {
            setError(errorText(e));
            void loadOverview();
        }
    }, [loadOverview]);
    const dailyStarted = useRef(false);
    useEffect(() => {
        if (!dailyStart || dailyStarted.current || !overview?.available) return;
        dailyStarted.current = true;
        if (overview.stages[0]?.ready || overview.activeSession) void start();
    }, [dailyStart, overview, start]);

    if (screen.kind === 'session') {
        return (
            <ClozeSession
                initial={screen.session}
                tab={tab.current}
                sounds={sounds}
                onExit={() => {
                    setScreen({ kind: 'overview' });
                    void loadOverview();
                }}
                onDone={(summary) => {
                    setScreen({ kind: 'summary', summary });
                    void loadOverview();
                }}
            />
        );
    }
    if (screen.kind === 'summary') {
        const s = screen.summary;
        return (
            <section aria-labelledby="gc-sum-h" data-testid="cloze-summary">
                <DailyGoalCheck mode="grammarCloze" />
                <h2 id="gc-sum-h">{level(s.levelNo)} complete</h2>
                <div className="actions">
                    {onDailyDone && (
                        <button type="button" className="btn btn-primary" onClick={onDailyDone}>
                            Continue Daily Practice <i className="pi pi-arrow-right" />
                        </button>
                    )}
                    {s.stageProgress.ready && (
                        <button className="btn btn-primary" onClick={() => void start()} data-testid="cloze-next">
                            Next session ({level(s.levelNo + 1)})
                        </button>
                    )}
                    <button className="btn" onClick={() => setScreen({ kind: 'overview' })}>
                        Back to stages
                    </button>
                </div>
                {error && (
                    <p className="notice notice-error" role="alert">
                        {error}
                    </p>
                )}
                <p className="muted">Your first choice for each sentence counts. Excluded sentences are neither right nor wrong.</p>
                <div className="stat-grid" role="list" aria-label="Session summary">
                    <Tile cls="ok" icon="pi-check-circle" label="Correct" value={String(s.correct)} />
                    <Tile cls="bad" icon="pi-times-circle" label="Not this time" value={String(s.incorrect)} />
                    <Tile cls="skip" icon="pi-ban" label="Excluded" value={String(s.excluded)} />
                    <Tile cls="info" icon="pi-percentage" label="Accuracy" value={s.accuracy === null ? '—' : `${Math.round(s.accuracy * 100)}%`} />
                    <Tile
                        cls="info"
                        icon="pi-clock"
                        label="Active time"
                        value={`${Math.floor(s.activeMs / 60000)}:${String(Math.floor((s.activeMs % 60000) / 1000)).padStart(2, '0')}`}
                    />
                    <Tile cls="wait" icon="pi-arrow-right" label="Added to Stage 2" value={String(s.carriedToNext)} />
                </div>
                {s.byRule.length > 0 && (
                    <div className="card">
                        <h3>By rule</h3>
                        <ul className="gc-rules">
                            {s.byRule.map((r) => (
                                <li key={r.ruleKey}>
                                    <span>{r.name}</span>{' '}
                                    <span className="muted small">
                                        {r.correct} right · {r.incorrect} wrong
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
                <StageCards stages={[s.stageProgress]} />
            </section>
        );
    }
    return (
        <section aria-labelledby="gc-h" data-testid="cloze-overview">
            <h2 id="gc-h">
                <i className="pi pi-th-large" aria-hidden="true" /> Grammar Cloze
            </h2>
            {error && (
                <p className="notice notice-error" role="alert">
                    {error}
                </p>
            )}
            {!overview ? (
                <p role="status">Loading…</p>
            ) : !overview.available ? (
                <div className="card">
                    <p>No sentences are loaded yet.</p>
                    <p className="muted small">
                        Run <code>npm run cloze:prepare</code>, then <code>npm run cloze:import -- --apply</code> (see the project README).
                    </p>
                </div>
            ) : (
                <>
                    <p className="muted">
                        Every sentence appears once per stage. Mistakes wait in the next stage. {overview.taskCount} sentences per session (change it in
                        Settings → Practice).
                    </p>
                    <StageCards
                        stages={overview.stages}
                        onStart={() => void start()}
                        activeLabel={
                            overview.activeSession
                                ? `Continue ${level(overview.activeSession.levelNo)} (${overview.activeSession.answered} / ${overview.activeSession.planned})`
                                : `Start ${level(overview.nextLevelNo)}`
                        }
                    />
                </>
            )}
        </section>
    );
}

function Tile({ cls, icon, label, value }: { cls: string; icon: string; label: string; value: string }) {
    return (
        <div className={`stat stat-${cls}`} role="listitem">
            <i className={`pi ${icon}`} aria-hidden="true" />
            <span className="stat-value">{value}</span>
            <span className="stat-label">{label}</span>
        </div>
    );
}

function StageCards({ stages, onStart, activeLabel }: { stages: api.ClozeStageView[]; onStart?: () => void; activeLabel?: string }) {
    return (
        <div className="gc-stages">
            {stages.map((s) => (
                <div className={`card gc-stage${s.status === 'locked' ? ' gc-locked' : ''}`} key={s.stage} data-testid={`cloze-stage-${s.stage}`}>
                    <div className="gc-stage-head">
                        <h3>{s.title}</h3>
                        <span className="muted small">
                            {s.status === 'locked' ? 'Locked' : s.status === 'done' ? 'Done' : s.status === 'in_progress' ? 'In progress' : 'Not started'}
                        </span>
                    </div>
                    <div
                        className="progress-bar"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Number(s.percent)}
                        aria-label={`Stage ${s.stage} progress`}
                    >
                        <div style={{ width: `${s.percent}%` }} />
                    </div>
                    <p className="gc-numbers">
                        <strong>{s.percent} %</strong>{' '}
                        <span className="muted">
                            · {groupDigits(s.processed)} / {groupDigits(s.total)} processed
                        </span>
                    </p>
                    <p className="muted small">
                        Rules touched {s.rulesTouched} / {s.rulesPresent} (completed {s.rulesCompleted}) · Excluded {s.excluded} ·{' '}
                        {s.stage === 1 ? `Mistakes moved to Stage 2: ${s.carriedToNext}` : 'Stage 2 opens in a later update'}
                    </p>
                    {s.stage === 1 ? (
                        <button className="btn btn-primary" disabled={!s.ready || !onStart} onClick={onStart} data-testid="cloze-start">
                            {s.ready ? (activeLabel ?? 'Start') : s.status === 'done' ? 'Stage 1 finished' : 'Start'}
                        </button>
                    ) : (
                        <button className="btn" disabled data-testid={`cloze-stage-${s.stage}-start`}>
                            Start (opens later)
                        </button>
                    )}
                    {s.stage === 1 && s.total > 0 && <RevealPicture processed={s.processed} total={s.total} src="/practice/reward-1.jpg" />}
                </div>
            ))}
        </div>
    );
}

/** the dialogue turns of a sentence ("- A - B" -> separate lines), with the gap drawn as a box (or the chosen word once answered) */
function Sentence({ text, fill, state }: { text: string; fill: string | null; state: api.ClozeSlotView['state'] }) {
    const gap = (k: string) => (
        <span key={k} className={`gc-gap${state === 'correct' ? ' gc-gap-ok' : state === 'incorrect' ? ' gc-gap-bad' : ''}`}>
            {fill ?? '      '}
        </span>
    );
    const line = (t: string, k: string) => t.split('___').flatMap((part, i, arr) => (i < arr.length - 1 ? [part, gap(`${k}-${i}`)] : [part]));
    if (!text.trimStart().startsWith('- '))
        return (
            <p className="prompt gc-sentence" data-testid="cloze-sentence">
                {line(text, 's')}
            </p>
        );
    const turns = text.split(/(?:^|\s)-\s+/).filter((t) => t.trim() !== '');
    return (
        <div className="gc-sentence" data-testid="cloze-sentence">
            {turns.map((t, i) => (
                <p className="prompt" key={i}>
                    – {line(t, String(i))}
                </p>
            ))}
        </div>
    );
}

function ClozeSession({
    initial,
    tab,
    sounds,
    onExit,
    onDone,
}: {
    initial: api.ClozeSessionView;
    tab: string;
    sounds: boolean;
    onExit: () => void;
    onDone: (s: api.ClozeSummary) => void;
}) {
    const [session, setSession] = useState(initial);
    const [pos, setPos] = useState<number>(initial.nextPosition ?? 1);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [chosenIdx, setChosenIdx] = useState<number | null>(null);
    const [confirmExclude, setConfirmExclude] = useState(false);
    const [reason, setReason] = useState('');
    const shownAt = useRef(performance.now());
    const slot = session.slots.find((s) => s.position === pos) ?? session.slots[0]!;
    const answered = slot.state !== 'pending';
    const lastShown = useRef<number>(0);
    const [paused, setPaused] = useState(false);
    usePauseKeys(paused, setPaused, session.status === 'active');
    const auto = useAutoPause(session.status === 'active' && !paused);
    useClozeActivity(session.id, tab, session.status === 'active' && !paused && !auto.reason);
    // F3: Russian translation of the sentence WITH the answer put in; F4: the same sentence read aloud by the local Piper voice
    const [tr, setTr] = useState<{ itemId: string; status: 'loading' | 'ready' | 'error'; text: string; shown: boolean } | null>(null);
    const trCache = useRef(new Map<string, string>());
    const clip = useRef<{ itemId: string; url: Promise<string> } | null>(null);
    const audio = useRef<HTMLAudioElement | null>(null);
    const [speechMsg, setSpeechMsg] = useState<string | null>(null);
    const [speaking, setSpeaking] = useState(false);
    const filled = (): string => {
        const t = slot.gappedText.replace('___', slot.correct ?? '');
        return t.trimStart().startsWith('- ')
            ? t
                  .split(/(?:^|\s)-\s+/)
                  .filter((x) => x.trim() !== '')
                  .join(' ')
            : t;
    };
    const toggleTranslation = () => {
        if (!answered || slot.correct === undefined) return;
        if (tr?.itemId === slot.itemId && tr.status !== 'loading') {
            setTr({ ...tr, shown: !tr.shown });
            return;
        }
        const cached = trCache.current.get(slot.itemId);
        if (cached !== undefined) {
            setTr({ itemId: slot.itemId, status: 'ready', text: cached, shown: true });
            return;
        }
        const itemId = slot.itemId;
        setTr({ itemId, status: 'loading', text: '', shown: true });
        void api
            .translateSentence(filled())
            .then((r) => {
                trCache.current.set(itemId, r.text);
                setTr((cur) => (cur?.itemId === itemId ? { itemId, status: 'ready', text: r.text, shown: true } : cur));
            })
            .catch((e: unknown) =>
                setTr((cur) =>
                    cur?.itemId === itemId
                        ? { itemId, status: 'error', text: e instanceof api.ApiRequestError ? e.message : 'Translation unavailable right now.', shown: true }
                        : cur,
                ),
            );
    };
    const speak = async () => {
        if (!answered || slot.correct === undefined) return;
        try {
            setSpeechMsg(null);
            if (clip.current?.itemId !== slot.itemId)
                clip.current = { itemId: slot.itemId, url: api.fetchBookSpeech({ text: filled() }).then((b) => URL.createObjectURL(b)) };
            setSpeaking(true);
            const url = await clip.current.url;
            audio.current?.pause();
            const a = new Audio(url);
            audio.current = a;
            a.onended = () => setSpeaking(false);
            await a.play();
        } catch (e) {
            clip.current = null;
            setSpeaking(false);
            setSpeechMsg(e instanceof Error ? e.message : 'Could not read this sentence aloud.');
        }
    };
    useEffect(
        () => () => {
            audio.current?.pause();
        },
        [],
    );
    useEffect(() => {
        shownAt.current = performance.now();
        setChosenIdx(null);
        setConfirmExclude(false);
        setReason('');
        setError(null);
        setSpeechMsg(null);
        setSpeaking(false);
        audio.current?.pause();
        if (slot.state === 'pending' && lastShown.current !== pos) {
            lastShown.current = pos;
            void api.markClozeShown(session.id, pos).catch(() => undefined);
        }
    }, [pos]); // eslint-disable-line react-hooks/exhaustive-deps

    const refresh = async (): Promise<api.ClozeSessionView> => {
        const s = await api.fetchClozeSession(session.id);
        setSession(s);
        return s;
    };
    const choose = async (idx: number) => {
        if (busy || answered || paused || auto.reason) return;
        const text = slot.options[idx];
        if (text === undefined) return;
        setBusy(true);
        setChosenIdx(idx);
        try {
            const r = await api.answerCloze(session.id, {
                id: crypto.randomUUID(),
                position: pos,
                chosen: text,
                responseMs: Math.round(performance.now() - shownAt.current),
            });
            playPracticeSound(r.correct ? 'correct' : 'incorrect', sounds);
            api.announceXp();
            await refresh();
        } catch (e) {
            // a position answered elsewhere (another tab, a reload): show what was recorded
            if (e instanceof api.ApiRequestError && e.code === 'ALREADY_ANSWERED') await refresh().catch(() => undefined);
            else setError(errorText(e));
            setChosenIdx(null);
        } finally {
            setBusy(false);
        }
    };
    const next = async () => {
        if (busy || !answered) return;
        setBusy(true);
        try {
            const s = await refresh();
            if (s.nextPosition === null) {
                const sum = await api.completeClozeSession(session.id);
                playPracticeSound('complete', sounds);
                onDone(sum);
            } else setPos(s.nextPosition);
        } catch (e) {
            setError(errorText(e));
        } finally {
            setBusy(false);
        }
    };
    const exclude = async () => {
        if (busy || slot.excluded) return;
        if (!confirmExclude) {
            setConfirmExclude(true);
            return;
        }
        setBusy(true);
        try {
            await api.excludeClozeItem(slot.itemId, { sessionId: session.id, ...(reason.trim() ? { reason: reason.trim() } : {}) });
            await refresh();
            setConfirmExclude(false);
        } catch (e) {
            setError(errorText(e));
        } finally {
            setBusy(false);
        }
    };

    useKeys((e) => {
        if (paused || auto.reason) return;
        if ((e.key === HOTKEYS.translate || e.key === HOTKEYS.listen) && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            if (answered) {
                if (e.key === HOTKEYS.translate) toggleTranslation();
                else void speak();
            }
            return;
        }
        if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTextField(e.target) || busy) return;
        if (e.key === 'Enter') {
            if (isPressable(e.target)) return;
            if (answered) {
                e.preventDefault();
                void next();
            }
        } else if (!answered && /^[1-4]$/.test(e.key)) {
            const i = Number(e.key) - 1;
            if (i < slot.options.length) {
                e.preventDefault();
                void choose(i);
            }
        }
    });

    const total = session.planned;
    const doneCount = session.slots.filter((s) => s.state !== 'pending').length;
    return (
        <section aria-labelledby="gc-s-h" data-testid="cloze-session">
            <div className="session-header">
                <h2 id="gc-s-h">{level(session.levelNo)}</h2>
                <p className="progress" data-testid="cloze-progress">
                    {Math.min(pos, total)} / {total}
                </p>
                <PauseButton paused={paused} onToggle={() => setPaused(!paused)} />
                <button className="btn" onClick={onExit}>
                    Back to stages
                </button>
            </div>
            {paused && <PauseOverlay onResume={() => setPaused(false)} />}
            {!paused && auto.reason && <PauseOverlay auto={auto.reason} onResume={auto.resume} />}
            <div className="progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={doneCount} aria-label="Session progress">
                <div style={{ width: `${(doneCount / total) * 100}%` }} />
            </div>
            {error && (
                <p className="notice notice-error" role="alert">
                    {error}
                </p>
            )}
            <div className="card gc-card">
                <p className="gc-focus" data-testid="cloze-rule">
                    <i className="pi pi-graduation-cap" aria-hidden="true" /> Choose the answer that best fits this grammar focus: <strong>{slot.ruleName}</strong>
                    {!slot.exact && <span> · {slot.sourceTopic.replace(/_/g, ' ')}</span>}
                </p>
                <Sentence text={slot.gappedText} fill={answered ? (slot.correct ?? null) : null} state={slot.state} />
                <fieldset className="options" aria-label="Answer options" disabled={answered || busy}>
                    {slot.options.map((o, i) => {
                        const isRight = answered && slot.correct !== undefined && o.toLowerCase() === slot.correct.toLowerCase();
                        const isWrongPick = answered && slot.chosen === o && !isRight;
                        return (
                            <button
                                type="button"
                                key={`${pos}-${i}`}
                                className={`option has-kbd gc-option${isRight ? ' gc-right' : ''}${isWrongPick ? ' gc-wrong' : ''}${!answered && chosenIdx === i ? ' gc-picked' : ''}`}
                                onClick={() => void choose(i)}
                                data-testid={`cloze-option-${i + 1}`}
                                aria-pressed={slot.chosen === o}
                            >
                                {!answered && <Kbd k={String(i + 1)} />}
                                <span>{o}</span>
                                {isRight && <i className="pi pi-check" aria-hidden="true" />}
                                {isWrongPick && <i className="pi pi-times" aria-hidden="true" />}
                            </button>
                        );
                    })}
                </fieldset>
                {slot.excluded && (
                    <p className="notice notice-info small" role="status">
                        This sentence is excluded. It will not come back and does not go to Stage 2.
                    </p>
                )}
                {answered && slot.state !== 'excluded' && !slot.excluded && (
                    <p className={`notice ${slot.state === 'correct' ? 'notice-info' : 'notice-warn'} small`} role="status" data-testid="cloze-feedback">
                        {slot.state === 'correct' ? (
                            'Correct. +10 XP.'
                        ) : (
                            <>
                                Not this time. The answer is <strong>{slot.correct}</strong>. This sentence goes to Stage 2.
                            </>
                        )}
                    </p>
                )}
                <div className="actions">
                    {answered && (
                        <button className="btn btn-primary has-kbd" onClick={() => void next()} disabled={busy} data-testid="cloze-continue" autoFocus>
                            <Kbd k="⏎" /> {session.nextPosition === null ? 'Finish' : 'Next'}
                        </button>
                    )}
                    {answered && (
                        <button
                            type="button"
                            className="btn has-kbd"
                            onClick={toggleTranslation}
                            title="Show the Russian translation (F3)"
                            data-testid="cloze-translate"
                        >
                            <Kbd k="F3" />
                            <i className="pi pi-language" aria-hidden="true" /> Translation
                        </button>
                    )}
                    {answered && (
                        <button type="button" className="btn has-kbd" onClick={() => void speak()} title="Listen (F4)" data-testid="cloze-speak">
                            <Kbd k="F4" />
                            <i className={`pi ${speaking ? 'pi-spin pi-spinner' : 'pi-volume-up'}`} aria-hidden="true" /> Listen
                        </button>
                    )}
                    {!slot.excluded &&
                        (confirmExclude ? (
                            <span className="gc-exclude">
                                <input
                                    type="text"
                                    value={reason}
                                    maxLength={200}
                                    placeholder="Why? (optional)"
                                    aria-label="Reason (optional)"
                                    onChange={(e) => setReason(e.target.value)}
                                />
                                <button className="btn" onClick={() => void exclude()} disabled={busy} data-testid="cloze-exclude-confirm">
                                    Confirm exclude
                                </button>
                                <button className="btn" onClick={() => setConfirmExclude(false)}>
                                    Cancel
                                </button>
                            </span>
                        ) : (
                            <button className="btn" onClick={() => void exclude()} disabled={busy} data-testid="cloze-exclude">
                                <i className="pi pi-ban" aria-hidden="true" /> Exclude question
                            </button>
                        ))}
                </div>
                {speechMsg && (
                    <p className="notice notice-warn small" role="alert">
                        {speechMsg}
                    </p>
                )}
                {answered && tr?.itemId === slot.itemId && tr.shown && (
                    <p
                        lang="ru"
                        className={`gc-translation${tr.status === 'error' ? ' notice notice-warn small' : ''}`}
                        role="status"
                        data-testid="cloze-translation"
                    >
                        {tr.status === 'loading' ? 'Translating…' : tr.text}
                    </p>
                )}
                {answered && <AnalysisPanel sessionId={session.id} itemId={slot.itemId} position={pos} disabled={paused || Boolean(auto.reason)} />}
            </div>
        </section>
    );
}

/** the local model's advisory opinion about this sentence; it never changes an answer, a statistic or an exclusion */
function AnalysisPanel({ sessionId, itemId, position, disabled }: { sessionId: string; itemId: string; position: number; disabled: boolean }) {
    const [state, setState] = useState<
        { kind: 'idle' } | { kind: 'waiting' } | { kind: 'done'; view: api.ClozeAnalysisView } | { kind: 'failed'; message: string }
    >({ kind: 'idle' });
    useEffect(() => setState({ kind: 'idle' }), [itemId]);
    const run = async () => {
        setState({ kind: 'waiting' });
        try {
            let v = await api.requestClozeAnalysis(itemId, { sessionId, position });
            const deadline = Date.now() + AI_CHECK_WAIT_S * 1000;
            while (v.status === 'pending' && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 1500));
                v = await api.fetchClozeAnalysis(v.id);
            }
            if (v.status === 'done' && v.result) setState({ kind: 'done', view: v });
            else
                setState({
                    kind: 'failed',
                    message: v.status === 'pending' ? 'The local model is still busy. Try again in a moment.' : 'Could not analyse now.',
                });
        } catch (e) {
            setState({ kind: 'failed', message: errorText(e) });
        }
    };
    useKeys((e) => {
        if (disabled || (state.kind !== 'idle' && state.kind !== 'failed') || e.key !== 'F7' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing || isTextField(e.target)) return;
        e.preventDefault();
        void run();
    });
    if (state.kind === 'idle')
        return (
            <p>
                <button className="btn has-kbd" onClick={() => void run()} data-testid="cloze-analyse" title="Analyse with AI (F7)">
                    <Kbd k="F7" /><i className="pi pi-sparkles" aria-hidden="true" /> Analyse with AI
                </button>
            </p>
        );
    if (state.kind === 'waiting')
        return (
            <p className="muted" role="status">
                <i className="pi pi-spin pi-spinner" aria-hidden="true" /> The local model is reading this question…
            </p>
        );
    if (state.kind === 'failed')
        return (
            <p className="notice notice-warn small" role="alert">
                {state.message}{' '}
                <button className="btn has-kbd" onClick={() => void run()} title="Try again (F7)">
                    <Kbd k="F7" />Try again
                </button>
            </p>
        );
    const r = state.view.result!;
    const verdict: Record<string, string> = {
        key_ok: 'The listed answer looks right',
        several_correct: 'Several options may be correct',
        key_wrong: 'The listed answer may be wrong',
        ambiguous: 'The question is ambiguous',
        broken: 'The exercise looks broken',
    };
    return (
        <div className="notice notice-info gc-analysis" data-testid="cloze-analysis">
            <p>
                <strong>Local AI opinion — it can be wrong.</strong> {verdict[r.verdict]}
            </p>
            <ul className="gc-rules">
                {r.options.map((o) => (
                    <li key={o.text}>
                        <strong>{o.text}</strong> — {o.fits === 'yes' ? 'may fit' : o.fits === 'no' ? 'unlikely to fit' : 'depends on context'}{' '}
                        <span lang="ru" className="muted small">
                            {o.why_ru}
                        </span>
                    </li>
                ))}
            </ul>
            {r.rule_en && (
                <p className="small">
                    <strong>Grammar rule: </strong><em>{r.rule_en}</em>
                </p>
            )}
            <div lang="ru" className="ru">
                <Markdown text={r.explanation_ru} />
            </div>
            {r.caution_ru && (
                <p lang="ru" className="muted small">
                    {r.caution_ru}
                </p>
            )}
            <p className="muted small">It changes nothing by itself. Use “Exclude question” if you want the sentence gone.</p>
        </div>
    );
}
