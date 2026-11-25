import { useEffect, useRef, useState } from 'react';
import { vocabularyTextSpeech } from '../api';
import type { MatchWord } from '../api';
import { clearWrong, createMatch, matchResults, pickCell, replacePair, type Cell, type MatchResult, type MatchMode, type MatchState, type Side } from '../game/matchEngine';
import { playPracticeSound } from '../practiceSounds';
import { Kbd, isTextField, useKeys } from './hotkeys';

/** in the single round matched pairs leave the table and the rest move up, so the number keys always reach the rows still open */
const visible = (cells: Array<Cell | null>, mode: MatchMode): Array<Cell | null> => (mode === 'once' ? cells.filter((c) => c && !c.matched) : cells);

const WRONG_MS = 550;
const REPLACE_MS = 450;
const FINISH_MS = 1100;
const SPEECH_DELAY_MS = 350; // let the short chime finish first

export const MATCH_TITLE: Record<MatchMode, { icon: string; title: string; hint: string }> = {
    once: { icon: 'pi-link', title: 'Match the pairs', hint: 'Pick a word, then its translation, or start from the translation. Tap a selected button again to unselect it.' },
    rush: { icon: 'pi-bolt', title: 'Pair rush', hint: 'Keep matching: every word comes back until you have matched it several times. You cannot lose; just keep going.' },
};

/**
 * The matching game after a vocabulary practice (see game/matchEngine.ts). Nothing is saved: it is practice, not evidence.
 * `onDone` is called once, a moment after the last pair (or when the learner skips the game).
 */
export function MatchGame({ words, mode, rounds, soundsEnabled, speechEnabled, onDone }: { words: MatchWord[]; mode: MatchMode; rounds: number; soundsEnabled: boolean; speechEnabled: boolean; onDone: (results: MatchResult[] | null) => void }) {
    const [state, setState] = useState<MatchState>(() => createMatch(words, mode, Math.random, rounds));
    const ref = useRef(state);
    const timers = useRef<number[]>([]);
    const alive = useRef(true);
    const audio = useRef<HTMLAudioElement | null>(null);
    const blobs = useRef(new Map<string, Promise<Blob | null>>());
    const finished = useRef(false);
    const update = (next: MatchState) => {
        ref.current = next;
        setState(next);
    };
    const later = (fn: () => void, ms: number) => {
        timers.current.push(window.setTimeout(() => alive.current && fn(), ms));
    };
    /** results are given only when the game was played to the end; skipping it records nothing */
    const finish = (played: boolean) => {
        if (finished.current) return;
        finished.current = true;
        onDone(played ? matchResults(ref.current) : null);
    };
    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
            timers.current.forEach(window.clearTimeout);
            audio.current?.pause();
        };
    }, []);

    const pronounce = (word: MatchWord) => {
        if (!speechEnabled) return;
        let blob = blobs.current.get(word.id);
        if (!blob) {
            blob = vocabularyTextSpeech(word.en).catch(() => null);
            blobs.current.set(word.id, blob);
        }
        void blob.then((b) => {
            if (!b || !alive.current) return;
            audio.current?.pause();
            const url = URL.createObjectURL(b);
            const a = new Audio(url);
            a.onended = () => URL.revokeObjectURL(url);
            audio.current = a;
            void a.play().catch(() => {});
        });
    };

    function click(side: Side, cell: Cell) {
        const r = pickCell(ref.current, side, cell.key);
        if (r.state === ref.current) return;
        update(r.state);
        const event = r.event;
        if (!event) return;
        if (event.kind === 'wrong') {
            playPracticeSound('incorrect', soundsEnabled);
            later(() => update(clearWrong(ref.current)), WRONG_MS);
            return;
        }
        playPracticeSound('correct', soundsEnabled);
        const word = words.find((w) => w.id === event.wordId);
        if (word) later(() => pronounce(word), SPEECH_DELAY_MS);
        if (r.state.done) later(() => finish(true), FINISH_MS);
        else if (r.state.mode === 'rush') later(() => update(replacePair(ref.current, event.leftKey, event.rightKey)), REPLACE_MS);
    }

    // keys 1-5: the number picks the word in that row of the LEFT column first, then the row of the right column (a second number finishes the pair);
    // Alt+number starts from the RIGHT column. After a first pick the number always means the other column.
    useKeys((e) => {
        if (e.ctrlKey || e.metaKey || e.isComposing || e.repeat || isTextField(e.target)) return;
        const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
        if (!m) return;
        e.preventDefault();
        const s = ref.current;
        const side: Side = s.selected ? (s.selected.side === 'left' ? 'right' : 'left') : e.altKey ? 'right' : 'left';
        const cell = visible(side === 'left' ? s.left : s.right, s.mode)[Number(m[1]) - 1];
        if (cell) click(side, cell);
    });

    const text = (cell: Cell, side: Side): string => {
        const w = words.find((x) => x.id === cell.wordId);
        return (side === 'left' ? w?.en : w?.ru) ?? '';
    };
    const column = (side: Side, cells: Array<Cell | null>) => (
        <div className="match-col" role="group" aria-label={side === 'left' ? 'English words' : 'Translations'}>
            {cells.map((cell, i) => {
                if (!cell) return <span key={`gap-${i}`} className="match-btn match-gap" aria-hidden="true" />;
                const isWrong = state.wrong !== null && (side === 'left' ? state.wrong.left : state.wrong.right) === cell.key;
                const isSelected = state.selected?.side === side && state.selected.key === cell.key;
                const cls = cell.matched ? 'match-ok' : isWrong ? 'match-bad' : isSelected ? 'match-sel' : '';
                return (
                    <button
                        key={cell.key}
                        type="button"
                        lang={side === 'left' ? 'en' : 'ru'}
                        className={`match-btn has-kbd ${cls}${state.mode === 'rush' ? ' match-enter' : ''}`}
                        aria-pressed={isSelected}
                        disabled={cell.matched || state.done}
                        onClick={() => click(side, cell)}
                    >
                        {i < 9 && <Kbd k={side === 'left' ? String(i + 1) : `Alt+${i + 1}`} />}
                        {text(cell, side)}
                    </button>
                );
            })}
        </div>
    );

    const look = MATCH_TITLE[mode];
    return (
        <section aria-labelledby="match-h" className="card match-game" data-testid="match-game" data-mode={mode}>
            <header className="session-header">
                <h2 id="match-h">
                    <i className={`pi ${look.icon}`} aria-hidden="true" /> {look.title}
                </h2>
                <p className="progress" data-testid="match-progress" aria-live="polite">
                    {state.done ? state.total : state.matches} / {state.total}
                </p>
            </header>
            <div className="progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={state.total} aria-valuenow={state.done ? state.total : state.matches} aria-label="Matching progress">
                <div style={{ width: `${((state.done ? state.total : state.matches) / state.total) * 100}%` }} />
            </div>
            <p className="muted small">{mode === 'rush' ? look.hint.replace('several', String(rounds)) : look.hint}</p>
            <p className="muted small">Keys: a number picks the word in that row on the left, the next number picks its translation on the right. Alt + number starts from the right column.</p>
            <div className="match-cols">
                {column('left', visible(state.left, state.mode))}
                {column('right', visible(state.right, state.mode))}
            </div>
            {state.done ? (
                <p role="status" className="match-done">
                    <i className="pi pi-check-circle" aria-hidden="true" /> All pairs matched
                </p>
            ) : (
                <p className="small">
                    <button type="button" className="link" onClick={() => finish(false)}>
                        Skip this game
                    </button>
                </p>
            )}
        </section>
    );
}
