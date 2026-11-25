import type { Db } from '../../db/open.js';
import {
    TYPING_DRILL_RULES_VERSION,
    typingDrillWordsPerLevel,
    type SettingsV1,
    type TypingDrillWord,
    type TypingDrillsCompleteRequest,
    type TypingDrillsStartResponse,
    type TypingSpeed,
} from '@english-lab/contracts';
import { ApiError } from '../../errors.js';
import { loadSettings } from '../sessions/policy.js';
import { currentTranslations } from '../vocabulary/repository.js';
import { lookupBankTranslation } from '../vocabulary/wordBankLookup.js';
import { DRILL_STAGES, fingerCost, stageOf } from './fingerCost.js';
import { hasPair, saveKeyStats, weakPairs } from './keyStats.js';
import { computeMetrics, METRICS_VERSION } from './metrics.js';
import { buildTypingResult, sessionRow, type TypingSessionRow } from './result.js';
import { awardTypingXp, typingXpForWordBands, wordErrorBands } from './xp.js';

/**
 * Finger Drills (TASK_033): a few comfortable words typed many times, so the fingers learn whole letter sequences. Everything about
 * progress (learned words, stage) is derived from the raw per-showing rows each time; nothing derived is stored.
 */

export interface DrillsDeps {
    now: () => Date;
    newId: () => string;
    random?: () => number;
}

/**
 * drill-rules-v2 (user decision 2026-11-10): a word is judged by its whole history, not by one level. It becomes learned when, over its
 * last ACCURACY_WINDOW showings (all levels together), at least ACCURACY_NEEDED of them were perfect, after MIN_SHOWINGS showings.
 * A learned word then climbs review steps: every later level in which all its showings were perfect and fast enough (ACQUIRE_SPEED_FACTOR of
 * the usual time per letter) moves it one step up, so it comes back less and less often (REVIEW_INTERVALS), never disappearing; a level
 * with an error moves it one step down, or back to practice when its accuracy falls below ACCURACY_NEEDED.
 */
export const ACCURACY_WINDOW = 30;
export const ACCURACY_NEEDED = 0.9;
export const MIN_SHOWINGS = 10;
/** a clean level moves a learned word up only when its typing is at least this fast against the usual time per letter in the other modes */
export const ACQUIRE_SPEED_FACTOR = 0.9;
/** levels between showings and showings per level, by review step (index = step; 0 = still in practice) */
export const REVIEW_INTERVALS = [0, 1, 1, 2, 4, 8] as const;
export const REVIEW_SHOWINGS = [0, 3, 2, 1, 1, 1] as const;
export const MAX_STEP = REVIEW_INTERVALS.length - 1;
/** new words mixed into every level while earlier words are still in practice, so a level is never only the same few words */
export const FRESH_PER_LEVEL = 2;
/** learned words of a stage's own new words needed to open the next stage */
export const STAGE_TARGET = 12;
export const TRANSLATION_EVERY = 1; // every showing (user decision 2026-11-09; was every fifth)
/** a word is read aloud on its first showing in a level and then on every SPEAK_EVERY-th (1st, 8th, 15th…; user decision 2026-11-10) */
export const SPEAK_EVERY = 7;
/** lives = the wrong keys expected at the learner's recent error rate × LIVES_SLACK + LIVES_SPARE, within LIVES_MIN..LIVES_MAX */
export const LIVES_SLACK = 1.2; // 1.25 gave ~50 lives for 60 words; set to 1 by the user (2026-11-09)
export const LIVES_SPARE = 3;
export const LIVES_MIN = 5;
export const LIVES_MAX = 99;
/** error rate per keystroke when there is no history yet */
const DEFAULT_ERROR_RATE = 0.05;
const MIN_WORKING = 3;
const MAX_WORKING = 10;
/** learned (review) words never take more than this share of a level */
const REVIEW_CAP = 0.3;
/** without any informative session in the other modes */
const DEFAULT_WPM = 25;

interface Candidate {
    lemma: string;
    source: 'general' | 'vocabulary';
    vocabularyEntryId: string | null;
    translationRu: string | null;
    cost: number;
    stage: number;
}

interface Rep {
    errors: number;
    ms: number | null;
    session: number;
}

export interface WordProgress {
    showings: number;
    /** share of perfect showings among the last ACCURACY_WINDOW */
    accuracy: number;
    /** 0 = in practice, 1..MAX_STEP = learned, higher = shown less often */
    step: number;
    /** index of the last level the word was typed in */
    lastSession: number;
    /** median time per letter of the perfect timed showings among the last ACCURACY_WINDOW (null without any) */
    msPerLetter: number | null;
    /** whether the word was learned after each level it was typed in: [level index, learned] */
    history: Array<[number, boolean]>;
}

export interface DrillState {
    baseWpm: number;
    /** the learner's usual time per character outside Drills (no speed multiplier) */
    baseMsPerChar: number;
    reps: Map<string, Rep[]>;
    progress: Map<string, WordProgress>;
    sessions: number;
    learned: Set<string>;
}

const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** usual typing speed over the last informative finished sessions of Meteor Rain and Books (Drills repeat words, so they would inflate it) */
export function baselineWpm(db: Db): number {
    const rows = db
        .prepare(
            "SELECT wpm FROM typing_sessions WHERE variant <> 'drills' AND status IN ('completed','failed') AND wpm > 0 AND active_ms >= 15000 AND COALESCE(chars_correct, 0) >= 40 ORDER BY ended_at DESC LIMIT 10",
        )
        .all() as Array<{ wpm: number }>;
    if (rows.length === 0) return DEFAULT_WPM;
    const sorted = rows.map((r) => r.wpm).sort((a, b) => a - b);
    const drop = Math.floor(sorted.length * 0.2);
    return Math.round(median(drop * 2 < sorted.length ? sorted.slice(drop, sorted.length - drop) : sorted) * 10) / 10;
}

/** replays a word's showings level by level (drill-rules-v2); `reps` oldest first, one level's showings together */
export function wordProgress(lemma: string, reps: readonly Rep[], baseMsPerChar: number): WordProgress {
    let step = 0;
    const history: Array<[number, boolean]> = [];
    let i = 0;
    while (i < reps.length) {
        const session = reps[i]!.session;
        let j = i;
        while (j < reps.length && reps[j]!.session === session) j++;
        const level = reps.slice(i, j);
        const window = reps.slice(Math.max(0, j - ACCURACY_WINDOW), j);
        const accuracy = window.filter((r) => r.errors === 0).length / window.length;
        const good = j >= MIN_SHOWINGS && accuracy >= ACCURACY_NEEDED;
        if (step === 0) {
            if (good) step = 1;
        } else if (level.some((r) => r.errors > 0)) {
            step = good ? Math.max(1, step - 1) : 0;
        } else {
            const times = level.filter((r) => r.ms !== null).map((r) => r.ms! / lemma.length);
            if (times.length > 0 && median(times) <= ACQUIRE_SPEED_FACTOR * baseMsPerChar) step = Math.min(MAX_STEP, step + 1);
        }
        history.push([session, step > 0]);
        i = j;
    }
    const window = reps.slice(-ACCURACY_WINDOW);
    const timed = window.filter((r) => r.errors === 0 && r.ms !== null).map((r) => r.ms! / lemma.length);
    return {
        showings: reps.length,
        accuracy: window.length ? window.filter((r) => r.errors === 0).length / window.length : 0,
        step,
        lastSession: reps.at(-1)?.session ?? 0,
        msPerLetter: timed.length ? Math.round(median(timed)) : null,
        history,
    };
}

/** every finished Drills showing, oldest first (optionally without one session, to see the state before it) */
export function drillState(db: Db, excludeSessionId: string | null = null): DrillState {
    const baseWpm = baselineWpm(db);
    const baseMsPerChar = 12_000 / baseWpm;
    const sessionIds = (
        db
            .prepare(
                "SELECT id FROM typing_sessions WHERE mode = 'words' AND variant = 'drills' AND status IN ('completed','failed') AND id IS NOT ? ORDER BY started_at, rowid",
            )
            .all(excludeSessionId) as Array<{ id: string }>
    ).map((r) => r.id);
    const index = new Map(sessionIds.map((id, i) => [id, i]));
    const rows = db
        .prepare(
            `SELECT w.lemma AS lemma, r.errors AS errors, r.type_ms AS ms, w.session_id AS sid
         FROM typing_words w
         JOIN typing_sessions s ON s.id = w.session_id
         JOIN typing_word_results r ON r.session_id = w.session_id AND r.plan_index = w.plan_index
        WHERE s.mode = 'words' AND s.variant = 'drills' AND s.status IN ('completed','failed') AND w.destroyed_at IS NOT NULL AND s.id IS NOT ?
        ORDER BY s.started_at, s.rowid, w.appearance_order`,
        )
        .all(excludeSessionId) as Array<{ lemma: string; errors: number; ms: number | null; sid: string }>;
    const reps = new Map<string, Rep[]>();
    for (const r of rows) {
        const list = reps.get(r.lemma) ?? reps.set(r.lemma, []).get(r.lemma)!;
        list.push({ errors: r.errors, ms: r.ms, session: index.get(r.sid) ?? 0 });
    }
    const progress = new Map([...reps].map(([lemma, list]) => [lemma, wordProgress(lemma, list, baseMsPerChar)]));
    const learned = new Set([...progress].filter(([, p]) => p.step > 0).map(([lemma]) => lemma));
    return { baseWpm, baseMsPerChar, reps, progress, sessions: sessionIds.length, learned };
}

/** the typing word bank plus the learner's own single words that fit some stage */
function candidates(db: Db): Candidate[] {
    const out = new Map<string, Candidate>();
    const bank = db
        .prepare('SELECT lemma, translation_ru AS t, difficulty AS d FROM typing_word_bank WHERE typing_ok = 1 AND archived = 0 AND char_count BETWEEN 3 AND 12')
        .all() as Array<{ lemma: string; t: string; d: number }>;
    for (const b of bank) {
        const stage = stageOf(b.lemma, b.d);
        const cost = fingerCost(b.lemma);
        if (stage !== null && cost !== null)
            out.set(b.lemma, { lemma: b.lemma, source: 'general', vocabularyEntryId: null, translationRu: b.t || null, cost, stage });
    }
    const personal = db
        .prepare(
            `SELECT e.id, e.lemma FROM vocabulary_entries e
        WHERE (SELECT kind FROM vocabulary_entry_events ev WHERE ev.entry_id = e.id ORDER BY ev.created_at DESC, ev.rowid DESC LIMIT 1) IS NOT 'removed'`,
        )
        .all() as Array<{ id: string; lemma: string }>;
    const fitting = personal.filter((p) => stageOf(p.lemma, null) !== null);
    const translations = currentTranslations(
        db,
        fitting.map((p) => p.id),
    );
    for (const p of fitting) {
        const translation = translations.get(p.id) ?? lookupBankTranslation(db, p.lemma)?.translationRu ?? null;
        if (!translation) continue; // a word without a translation cannot teach anything here (as in Meteor Rain, D77)
        out.set(p.lemma, {
            lemma: p.lemma,
            source: 'vocabulary',
            vocabularyEntryId: p.id,
            translationRu: translation,
            cost: fingerCost(p.lemma)!,
            stage: stageOf(p.lemma, null)!,
        });
    }
    return [...out.values()];
}

/** the first stage whose own new words are not yet learned enough (STAGE_TARGET, or all of them when it has fewer) */
export function currentStage(cands: readonly Candidate[], learned: ReadonlySet<string>): number {
    for (let s = 1; s <= DRILL_STAGES.length; s++) {
        const pool = cands.filter((c) => c.stage === s);
        const target = Math.min(STAGE_TARGET, pool.length);
        if (pool.filter((c) => learned.has(c.lemma)).length < target) return s;
    }
    return DRILL_STAGES.length;
}

function shuffle<T>(arr: T[], r: () => number): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    return arr;
}

/**
 * Wrong keys per keystroke over the last finished Drills levels (Meteor Rain and Books when there are none yet), then the lives for a
 * level of `keystrokes` keys: enough for the learner's usual accuracy with a margin, so careful typing passes and guessing does not.
 * Repeated lost levels add a little room. Derived each time from the stored counters; nothing is kept.
 */
export function livesFor(db: Db, keystrokes: number): number {
    const recent = (variant: 'drills' | 'other') =>
        db
            .prepare(
                `SELECT chars_typed AS typed, errors FROM typing_sessions WHERE ${variant === 'drills' ? "mode = 'words' AND variant = 'drills'" : "variant <> 'drills'"} AND status IN ('completed','failed') AND chars_typed >= 40 ORDER BY ended_at DESC LIMIT 10`,
            )
            .all() as Array<{ typed: number; errors: number }>;
    let rows = recent('drills');
    if (rows.length === 0) rows = recent('other');
    const typed = rows.reduce((a, r) => a + r.typed, 0);
    const rate = typed > 0 ? rows.reduce((a, r) => a + r.errors, 0) / typed : DEFAULT_ERROR_RATE;
    const easing = 1 + 0.15 * consecutiveDrillFails(db);
    return Math.max(LIVES_MIN, Math.min(LIVES_MAX, Math.round(keystrokes * rate * LIVES_SLACK * easing) + LIVES_SPARE));
}

function consecutiveDrillFails(db: Db): number {
    const rows = db
        .prepare(
            "SELECT status FROM typing_sessions WHERE mode = 'words' AND variant = 'drills' AND status IN ('completed','failed') ORDER BY ended_at DESC LIMIT 3",
        )
        .all() as Array<{ status: string }>;
    let n = 0;
    for (const r of rows) {
        if (r.status !== 'failed') break;
        n++;
    }
    return n;
}

export interface DrillPlan {
    ruleVersion: string;
    stage: number;
    words: TypingDrillWord[];
    speed: TypingSpeed;
    lives: number;
    learned: number;
}

export function buildDrillPlan(db: Db, settings: SettingsV1, deps: DrillsDeps): DrillPlan {
    const r = deps.random ?? Math.random;
    const n = typingDrillWordsPerLevel(settings);
    const state = drillState(db);
    const cands = candidates(db);
    const stage = currentStage(cands, state.learned);
    const eligible = cands.filter((c) => c.stage <= stage);
    const weak = weakPairs(db, 3);
    const ease = (c: Candidate): number => c.cost - (weak.length > 0 && hasPair(c.lemma, weak) ? 0.5 : 0);
    const byEase = (a: Candidate, b: Candidate): number => ease(a) - ease(b) || (a.lemma < b.lemma ? -1 : a.lemma > b.lemma ? 1 : 0);

    const k = Math.min(MAX_WORKING, MIN_WORKING + Math.floor(state.learned.size / 4));
    const prog = (lemma: string): WordProgress => state.progress.get(lemma)!;
    // the weakest words in practice stay (lowest accuracy first); new words of the same ease always join them, so a level is never only
    // the same few words when they keep going wrong (user decision 2026-11-10)
    const practised = eligible
        .filter((c) => !state.learned.has(c.lemma) && state.reps.has(c.lemma))
        .sort((a, b) => prog(a.lemma).accuracy - prog(b.lemma).accuracy || byEase(a, b));
    const fresh = eligible
        .filter((c) => !state.learned.has(c.lemma) && !state.reps.has(c.lemma))
        .sort((a, b) => Number(b.stage === stage) - Number(a.stage === stage) || byEase(a, b));
    const kept = practised.slice(0, k);
    const freshCount = Math.max(k - kept.length, practised.length > 0 ? FRESH_PER_LEVEL : 0);
    const working = [...kept, ...fresh.slice(0, freshCount)];
    // when nothing new is left, the words resting outside the working set come back
    if (working.length < k) working.push(...practised.slice(k, k + (k - working.length)));
    const learnedCands = cands.filter((c) => state.learned.has(c.lemma));
    if (working.length === 0 && learnedCands.length === 0)
        throw new ApiError(409, 'TYPING_BANK_EMPTY', 'Not enough words in the typing word bank for Finger Drills; run the typing seed first.');

    // learned words due by their review step, the most overdue first; with nothing left to practise every learned word may come back
    const reviews = learnedCands
        .map((c) => {
            const p = prog(c.lemma);
            return { c, step: p.step, overdue: (state.sessions - p.lastSession) / REVIEW_INTERVALS[p.step]! };
        })
        .filter((x) => working.length === 0 || x.overdue >= 1)
        .sort((a, b) => b.overdue - a.overdue || a.step - b.step || (a.c.lemma < b.c.lemma ? -1 : 1));
    const reviewBudget = working.length === 0 ? n : Math.floor(n * REVIEW_CAP);
    const picks: Array<{ c: Candidate; review: boolean }> = [];
    for (let round = 0; picks.length < reviewBudget && reviews.length > 0; round++) {
        let added = 0;
        for (const x of reviews) {
            if (picks.length >= reviewBudget) break;
            if (working.length > 0 && round >= REVIEW_SHOWINGS[x.step]!) continue;
            picks.push({ c: x.c, review: true });
            added++;
        }
        if (added === 0) break;
    }
    const workingShows = n - picks.length;
    for (let i = 0; i < working.length; i++) {
        const count = Math.floor(workingShows / working.length) + (i < workingShows % working.length ? 1 : 0);
        for (let j = 0; j < count; j++) picks.push({ c: working[i]!, review: false });
    }
    shuffle(picks, r);

    const seen = new Map<string, number>();
    const words: TypingDrillWord[] = picks.map((p, planIndex) => {
        const occurrence = seen.get(p.c.lemma) ?? 0;
        seen.set(p.c.lemma, occurrence + 1);
        return {
            planIndex,
            lemma: p.c.lemma,
            source: p.c.source,
            vocabularyEntryId: p.c.vocabularyEntryId,
            translationRu: p.c.translationRu,
            showTranslation: occurrence % TRANSLATION_EVERY === 0,
            speak: occurrence % SPEAK_EVERY === 0,
            review: p.review,
        };
    });

    const multiplier = settings.typingSpeedMultiplier ?? 1.05;
    // there is no pace in Drills; the speed is kept for the record (the learner's usual speed the learning rule compares with)
    const pressure = 1;
    const effectiveWpm = state.baseWpm * multiplier * pressure;
    const round1 = (x: number): number => Math.round(x * 10) / 10;
    const speed: TypingSpeed = {
        ruleVersion: TYPING_DRILL_RULES_VERSION,
        estimateWpm: round1(state.baseWpm),
        multiplier: round1(multiplier),
        pressure: round1(pressure),
        effectiveWpm: round1(effectiveWpm),
        msPerChar: round1(12_000 / effectiveWpm),
    };
    const keystrokes = words.reduce((a, w) => a + w.lemma.length + 1, 0);
    return { ruleVersion: TYPING_DRILL_RULES_VERSION, stage, words, speed, lives: livesFor(db, keystrokes), learned: state.learned.size };
}

const drillsLevel = (db: Db): number =>
    (
        db
            .prepare("SELECT COALESCE(MAX(level_number), 0) AS n FROM typing_sessions WHERE mode = 'words' AND variant = 'drills' AND status = 'completed'")
            .get() as { n: number }
    ).n + 1;

export interface DrillWordRow {
    lemma: string;
    showings: number;
    /** share of perfect showings among the last ACCURACY_WINDOW */
    accuracy: number;
    /** 0 = in practice, 1..MAX_STEP = learned review step */
    step: number;
    /** median time per letter of the recent perfect showings (null without timing) */
    msPerLetter: number | null;
    learned: boolean;
    /** learned words: levels until the next review showing (0 = in the next level) */
    nextInLevels: number | null;
    /** time per letter (ms) of every timed showing, oldest first */
    speed: number[];
    /** perfect share (%) of the last ACCURACY_WINDOW showings after each showing, oldest first */
    trend: number[];
}

export function drillsSummary(db: Db): {
    stage: number;
    learned: number;
    practised: number;
    targetMsPerLetter: number;
    accuracyNeeded: number;
    minShowings: number;
    accuracyWindow: number;
    maxStep: number;
    words: DrillWordRow[];
} {
    const state = drillState(db);
    // every practised word, the most recently practised first (the page sorts and pages them itself)
    const words = [...state.progress]
        .map(([lemma, p]) => {
            const reps = state.reps.get(lemma) ?? [];
            return {
                lemma,
                showings: p.showings,
                accuracy: Math.round(p.accuracy * 1000) / 1000,
                step: p.step,
                msPerLetter: p.msPerLetter,
                learned: p.step > 0,
                nextInLevels: p.step > 0 ? Math.max(0, REVIEW_INTERVALS[p.step]! - (state.sessions - p.lastSession)) : null,
                // typing time per letter of every timed showing, oldest first
                speed: reps.filter((r) => r.ms !== null).map((r) => Math.round(r.ms! / lemma.length)),
                // share of perfect showings (%) among the last ACCURACY_WINDOW after each showing, oldest first
                trend: reps.map((_, i) => {
                    const win = reps.slice(Math.max(0, i + 1 - ACCURACY_WINDOW), i + 1);
                    return Math.round((win.filter((r) => r.errors === 0).length / win.length) * 100);
                }),
                last: p.lastSession,
            };
        })
        .sort((a, b) => b.last - a.last || Number(a.learned) - Number(b.learned) || (a.lemma < b.lemma ? -1 : 1))
        .map(({ last: _last, ...w }) => w);
    return {
        stage: currentStage(candidates(db), state.learned),
        learned: state.learned.size,
        practised: state.reps.size,
        targetMsPerLetter: Math.round(ACQUIRE_SPEED_FACTOR * state.baseMsPerChar),
        accuracyNeeded: ACCURACY_NEEDED,
        minShowings: MIN_SHOWINGS,
        accuracyWindow: ACCURACY_WINDOW,
        maxStep: MAX_STEP,
        words,
    };
}

/** per finished Drills level, oldest first: typed words with and without errors, and how many words were learned after it */
export function drillsProgress(db: Db): Array<{ sessionId: string; clean: number; withErrors: number; learned: number }> {
    const state = drillState(db);
    const sessions = db
        .prepare("SELECT id FROM typing_sessions WHERE mode = 'words' AND variant = 'drills' AND status IN ('completed','failed') ORDER BY started_at, rowid")
        .all() as Array<{ id: string }>;
    const bySession = new Map<number, Rep[]>();
    for (const reps of state.reps.values()) for (const rep of reps) (bySession.get(rep.session) ?? bySession.set(rep.session, []).get(rep.session)!).push(rep);
    // learned words after each level: every word's state as of its last level up to then
    const learnedAt = sessions.map(() => 0);
    for (const p of state.progress.values()) {
        for (let h = 0; h < p.history.length; h++) {
            const [from, learned] = p.history[h]!;
            const to = h + 1 < p.history.length ? p.history[h + 1]![0] : sessions.length;
            if (learned) for (let i = from; i < to; i++) learnedAt[i]!++;
        }
    }
    return sessions.map((s, i) => {
        const typed = bySession.get(i) ?? [];
        return {
            sessionId: s.id,
            clean: typed.filter((t) => t.errors === 0).length,
            withErrors: typed.filter((t) => t.errors > 0).length,
            learned: learnedAt[i]!,
        };
    });
}

export function drillsOverview(db: Db): { nextLevel: number; stage: number; learned: number; activeSessionId: string | null } {
    const active = db.prepare("SELECT id FROM typing_sessions WHERE mode = 'words' AND variant = 'drills' AND status = 'active' LIMIT 1").get() as
        | { id: string }
        | undefined;
    const s = drillsSummary(db);
    return { nextLevel: drillsLevel(db), stage: s.stage, learned: s.learned, activeSessionId: active?.id ?? null };
}

/** for the result screen: the stage and learned words now, and which words this session made learned */
export function drillsResultInfo(db: Db, sessionId: string): { stage: number; learned: number; newlyLearned: string[] } {
    const now = drillState(db);
    const before = drillState(db, sessionId);
    return {
        stage: currentStage(candidates(db), now.learned),
        learned: now.learned.size,
        newlyLearned: [...now.learned].filter((l) => !before.learned.has(l)).sort(),
    };
}

export function startDrills(db: Db, deps: DrillsDeps): TypingDrillsStartResponse {
    const settings = loadSettings(db);
    // one Words session at a time, whichever variant (as for Meteor Rain, no mid-level restore)
    const active = db.prepare("SELECT id FROM typing_sessions WHERE mode = 'words' AND status = 'active' LIMIT 1").get() as { id: string } | undefined;
    if (active) db.prepare("UPDATE typing_sessions SET status = 'interrupted', ended_at = ? WHERE id = ?").run(deps.now().toISOString(), active.id);
    const level = drillsLevel(db);
    const plan = buildDrillPlan(db, settings.values, deps);
    const id = deps.newId();
    db.prepare(
        "INSERT INTO typing_sessions(id, mode, variant, status, level_number, settings_revision, settings_json, plan_json, started_at) VALUES (?, 'words', 'drills', 'active', ?, ?, ?, ?, ?)",
    ).run(id, level, settings.revision, JSON.stringify(settings.values), JSON.stringify(plan), deps.now().toISOString());
    return {
        sessionId: id,
        level,
        stage: plan.stage,
        stageKeys: DRILL_STAGES[plan.stage - 1]!.keys,
        words: plan.words,
        speed: plan.speed,
        lives: plan.lives,
        learned: plan.learned,
    };
}

/** Drills XP: the Meteor Rain rule per typed word, halved, because the words repeat and are short */
export function typingXpForDrills(errorsPerTypedWord: number[]): number {
    return Math.max(1, Math.round(typingXpForWordBands(wordErrorBands(errorsPerTypedWord)) / 2));
}

function drillRow(db: Db, sessionId: string): TypingSessionRow {
    const row = sessionRow(db, sessionId);
    if (row.mode !== 'words' || row.variant !== 'drills') throw new ApiError(409, 'TYPING_SESSION_WRONG_MODE', 'Not a Finger Drills session');
    return row;
}

export function completeDrills(db: Db, deps: DrillsDeps, sessionId: string, req: TypingDrillsCompleteRequest): ReturnType<typeof buildTypingResult> {
    const row = drillRow(db, sessionId);
    if (row.status !== 'active') return buildTypingResult(db, row); // idempotent: the saved result
    const words = (JSON.parse(row.plan_json ?? '{}') as { words?: TypingDrillWord[] }).words ?? [];

    // words are typed strictly in order: the completed ones are 0..c-1, then at most the one being typed
    const completed = req.words.filter((w) => w.completed);
    req.words.forEach((w, i) => {
        if (w.planIndex !== i || !words[i]) throw new ApiError(400, 'TYPING_INDEX_INVALID', 'Drill words must be reported in plan order from the first one');
        if (!w.completed && i !== req.words.length - 1) throw new ApiError(400, 'TYPING_INDEX_INVALID', 'Only the last reported word may be unfinished');
    });
    if (req.status === 'completed' && completed.length !== words.length)
        throw new ApiError(400, 'TYPING_INCOMPLETE', 'A completed Finger Drills level must type every planned word');
    // each word ends with its space, except the last one of the level
    const charsCorrect = completed.reduce((sum, w) => sum + words[w.planIndex]!.lemma.length + (w.planIndex === words.length - 1 ? 0 : 1), 0);
    if (req.charsTyped - req.errors < charsCorrect) throw new ApiError(400, 'TYPING_COUNTERS_INVALID', 'charsTyped minus errors cannot be below charsCorrect');
    if (req.bestCharStreak !== undefined && req.bestCharStreak > req.charsTyped - req.errors)
        throw new ApiError(400, 'TYPING_COUNTERS_INVALID', 'Character streak cannot exceed correct keystrokes');

    const metrics = computeMetrics({
        mode: 'words',
        activeMs: req.activeMs,
        charsTyped: req.charsTyped,
        errors: req.errors,
        charsCorrect,
        level: row.level_number,
        completed: req.status === 'completed',
        plannedWords: words.length,
    });
    const xp = req.status === 'completed' ? typingXpForDrills(completed.map((w) => w.errors)) : 0;
    const now = deps.now().toISOString();

    db.transaction(() => {
        const putWord = db.prepare(
            'INSERT OR IGNORE INTO typing_words(id, session_id, plan_index, appearance_order, lemma, source, vocabulary_entry_id, shown_at, destroyed_at) VALUES (?,?,?,?,?,?,?,?,?)',
        );
        const putResult = db.prepare('INSERT OR IGNORE INTO typing_word_results(session_id, plan_index, errors, type_ms) VALUES (?,?,?,?)');
        for (const w of req.words) {
            const p = words[w.planIndex]!;
            putWord.run(deps.newId(), sessionId, w.planIndex, w.planIndex, p.lemma, p.source, p.vocabularyEntryId, now, w.completed ? now : null);
            putResult.run(sessionId, w.planIndex, w.errors, w.completed ? w.typeMs : null);
        }
        db.prepare(
            'UPDATE typing_sessions SET status = ?, ended_at = ?, active_ms = ?, chars_typed = ?, errors = ?, chars_correct = ?, wpm = ?, cpm = ?, accuracy = ?, score = ?, metrics_version = ?, best_combo = ?, best_char_streak = ? WHERE id = ?',
        ).run(
            req.status,
            now,
            req.activeMs,
            req.charsTyped,
            req.errors,
            charsCorrect,
            metrics.wpm,
            metrics.cpm,
            metrics.accuracy,
            metrics.score,
            METRICS_VERSION,
            req.bestCombo ?? null,
            req.bestCharStreak ?? null,
            sessionId,
        );
        if (xp > 0) awardTypingXp(db, { id: deps.newId(), sessionId, amount: xp, at: now });
        saveKeyStats(db, deps.newId, sessionId, req.keyStats ?? [], now);
    }).immediate();

    return buildTypingResult(db, sessionRow(db, sessionId));
}
