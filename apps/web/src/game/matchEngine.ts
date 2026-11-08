/**
 * Word ↔ translation matching game played after a vocabulary practice. Pure logic, no DOM, no timers (the page owns those).
 * It is not evidence: nothing here is sent to the server or counted for Mastery.
 *
 * Two modes:
 *  - once: every word is matched one time; matched buttons stay green and become unclickable.
 *  - rush: every word must be matched ROUNDS times; a matched pair is replaced by another word's pair, and a word does not come back
 *    until about COOLDOWN other pairs were matched (relaxed only when there are too few words to wait that long).
 */
export type Side = "left" | "right";
export type MatchMode = "once" | "rush";
export interface MatchWord {
    id: string;
    en: string;
    ru: string;
}
export interface Cell {
    /** unique per button instance, so a replaced button is a new element */
    key: number;
    wordId: string;
    matched: boolean;
}
export interface MatchState {
    mode: MatchMode;
    left: Array<Cell | null>;
    right: Array<Cell | null>;
    selected: { side: Side; key: number } | null;
    /** the two keys of a wrong pair, shown red until `clearWrong` */
    wrong: { left: number; right: number } | null;
    /** matches still needed per word */
    remaining: Record<string, number>;
    /** word ids in the order they were matched (newest last) */
    recent: string[];
    /** per word: pairs matched and wrong pairs it was part of (kept for the result sent after the game) */
    stats: Record<string, { matched: number; wrong: number }>;
    nextKey: number;
    total: number;
    matches: number;
    done: boolean;
}
export type MatchEvent = { kind: 'match'; wordId: string; leftKey: number; rightKey: number } | { kind: 'wrong' } | null;

export const ROUNDS = 5;
export const COOLDOWN = 3;
export const MAX_ROWS = 5;
export const MIN_WORDS = 3;

type Rng = () => number;

export function shuffle<T>(items: readonly T[], rng: Rng = Math.random): T[] {
    const a = [...items];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
}

/** how many rows are on screen at once in the rush mode */
export function rushRows(wordCount: number): number {
    return Math.min(MAX_ROWS, Math.max(2, wordCount - 1));
}

export function createMatch(words: readonly MatchWord[], mode: MatchMode, rng: Rng = Math.random): MatchState {
    const rows = mode === 'once' ? words.length : rushRows(words.length);
    const chosen = shuffle(words, rng).slice(0, rows);
    let key = 0;
    const make = (): Cell[] => shuffle(chosen, rng).map((w) => ({ key: key++, wordId: w.id, matched: false }));
    let left = make();
    let right = make();
    // never start with a column pair already lined up row for row
    for (let tries = 0; tries < 8 && chosen.length > 1 && left.every((c, i) => c.wordId === right[i]!.wordId); tries++) right = shuffle(right, rng);
    const per = mode === 'once' ? 1 : ROUNDS;
    return {
        mode,
        left,
        right,
        selected: null,
        wrong: null,
        remaining: Object.fromEntries(words.map((w) => [w.id, per])),
        recent: [],
        stats: Object.fromEntries(words.map((w) => [w.id, { matched: 0, wrong: 0 }])),
        nextKey: key,
        total: words.length * per,
        matches: 0,
        done: false,
    };
}

const find = (cells: Array<Cell | null>, key: number): Cell | undefined => cells.find((c): c is Cell => c !== null && c.key === key);

/** a click on one button; returns the new state and what happened (for sounds and timers) */
export function pickCell(state: MatchState, side: Side, key: number): { state: MatchState; event: MatchEvent } {
    if (state.done || state.wrong) return { state, event: null };
    const cell = find(side === 'left' ? state.left : state.right, key);
    if (!cell || cell.matched) return { state, event: null };
    const sel = state.selected;
    if (!sel) return { state: { ...state, selected: { side, key } }, event: null };
    if (sel.side === side) {
        // same button again: unselect; another button of the same column: move the selection
        return { state: { ...state, selected: sel.key === key ? null : { side, key } }, event: null };
    }
    const other = find(sel.side === 'left' ? state.left : state.right, sel.key);
    if (!other || other.matched) return { state: { ...state, selected: { side, key } }, event: null };
    const leftKey = side === 'left' ? key : sel.key;
    const rightKey = side === 'right' ? key : sel.key;
    if (other.wordId !== cell.wordId) {
        const stats = { ...state.stats };
        for (const id of [cell.wordId, other.wordId]) stats[id] = { ...stats[id]!, wrong: stats[id]!.wrong + 1 };
        return { state: { ...state, stats, selected: null, wrong: { left: leftKey, right: rightKey } }, event: { kind: 'wrong' } };
    }
    const flag = (cells: Array<Cell | null>) => cells.map((c) => (c && (c.key === leftKey || c.key === rightKey) ? { ...c, matched: true } : c));
    const remaining = { ...state.remaining, [cell.wordId]: state.remaining[cell.wordId]! - 1 };
    return {
        state: {
            ...state,
            left: flag(state.left),
            right: flag(state.right),
            selected: null,
            remaining,
            recent: [...state.recent, cell.wordId],
            stats: { ...state.stats, [cell.wordId]: { ...state.stats[cell.wordId]!, matched: state.stats[cell.wordId]!.matched + 1 } },
            matches: state.matches + 1,
            // rush: when only ONE word is left to go, the game ends (it would only ask for that same word again and again)
            done: Object.values(remaining).filter((n) => n > 0).length <= (state.mode === 'rush' ? 1 : 0),
        },
        event: { kind: 'match', wordId: cell.wordId, leftKey, rightKey },
    };
}

export function clearWrong(state: MatchState): MatchState {
    return state.wrong ? { ...state, wrong: null } : state;
}

/**
 * Rush mode: the matched pair (by its two button keys) is replaced by a word that is not on screen and still has matches to go.
 * Words not matched during the last COOLDOWN matches are preferred, otherwise the one matched longest ago; the choice is random,
 * weighted strongly by matches left so words finish together and few are left alone at the end. Does nothing for a pair that is already replaced.
 */
export function replacePair(state: MatchState, leftKey: number, rightKey: number, rng: Rng = Math.random): MatchState {
    if (state.mode !== 'rush') return state;
    const li = state.left.findIndex((c) => c !== null && c.key === leftKey && c.matched);
    const ri = state.right.findIndex((c) => c !== null && c.key === rightKey && c.matched);
    if (li < 0 || ri < 0) return state;
    const onScreen = new Set(state.left.filter((c): c is Cell => c !== null && !c.matched).map((c) => c.wordId));
    const pool = Object.keys(state.remaining).filter((id) => (state.remaining[id] ?? 0) > 0 && !onScreen.has(id));
    const cooling = new Set(state.recent.slice(-COOLDOWN));
    const rested = pool.filter((id) => !cooling.has(id));
    let candidates = rested;
    if (candidates.length === 0 && pool.length > 0) {
        const age = (id: string) => state.recent.lastIndexOf(id); // -1 = never matched
        const oldest = Math.min(...pool.map(age));
        candidates = pool.filter((id) => age(id) === oldest);
    }
    let nextKey = state.nextKey;
    const put = (cells: Array<Cell | null>, index: number, wordId: string | null) => cells.map((c, i) => (i !== index ? c : wordId === null ? null : { key: nextKey++, wordId, matched: false }));
    let pick: string | null = null;
    if (candidates.length > 0) {
        const weight = (id: string) => state.remaining[id]! ** 3;
        const total = candidates.reduce((n, id) => n + weight(id), 0);
        let roll = rng() * total;
        pick = candidates[candidates.length - 1]!;
        for (const id of candidates) {
            roll -= weight(id);
            if (roll < 0) {
                pick = id;
                break;
            }
        }
    }
    return { ...state, left: put(state.left, li, pick), right: put(state.right, ri, pick), nextKey };
}

export interface MatchResult {
    lemma: string;
    matched: number;
    wrong: number;
}

/** the raw outcome per word of a finished game: pairs matched (of ROUNDS, or 1) and wrong pairs it was part of */
export function matchResults(state: MatchState): MatchResult[] {
    return Object.entries(state.stats).map(([lemma, s]) => ({ lemma, matched: s.matched, wrong: s.wrong }));
}
