import {
  TYPING_KEYS_RULES_VERSION,
  TYPING_KEYS_XP_VERSION,
  type TypingKeyState,
  type TypingKeysCompleteRequest,
  type TypingKeysResult,
  type TypingKeysStartResponse,
  type TypingKeyToken,
} from "@english-lab/contracts";
import type { Db } from "../../../db/open.js";
import { ApiError } from "../../../errors.js";
import { DAILY_TIMEZONE, learningDate } from "../../journey/calendar.js";
import { loadSettings } from "../../sessions/policy.js";
import { lookupBankTranslation } from "../../vocabulary/wordBankLookup.js";
import { loadKeyData } from "./data.js";
import { baselineWpm } from "../drills.js";
import { accuracyOutlook, accuracyScore, DEFAULT_MIN_ACCURACY, goalForecast, learningRate, lessonKeys, MIN_KEYS, timeToSpeed, type KeyLessonRow, type LessonKey } from "./guided.js";
import { keyLessonText } from "./text.js";

/**
 * Key Builder lessons (keybr.com guided lessons). The raw facts are the lessons and their per-key rows; the open keys, the focused
 * key and the forecast are derived from them on every call.
 */
export interface KeysDeps {
  now: () => Date;
  newId: () => string;
  random?: () => number;
}

/** a lesson is one short text of about this many characters (keybr lessons are a line or two) */
export const LESSON_CHARS = 150;
/** one XP per this many correct characters */
export const XP_CHARS = 10;

interface LessonRow {
  id: string;
  status: string;
  target_cpm: number;
  keys_json: string;
  text_json: string;
  started_at: string;
  ended_at: string | null;
  active_ms: number;
  chars_typed: number;
  errors: number;
}

/** the learner's goal (settings, WPM); missing means 55 WPM */
export const DEFAULT_GOAL_WPM = 55;
/**
 * keybr opens keys against one fixed target speed (35 WPM). Here every stage (a set of open letters) has its own fixed target: when a
 * letter opens, the target becomes the learner's speed at that moment (the median of the last RECENT_LESSONS lessons; before
 * MIN_RECENT of them, the usual speed in Meteor Rain and Books) × STEP_FACTOR, never above the goal, and it stays until the next
 * letter opens. So the slowest keys must catch up with the speed you already had, and the bar does not run away while you improve.
 * Once the whole alphabet is open the target is the goal itself.
 */
export const STEP_FACTOR = 1;
export const RECENT_LESSONS = 10;
export const MIN_RECENT = 3;

export interface LessonFact {
  id: string;
  at: number;
  cpm: number;
  activeMs: number;
  accuracy: number;
  open: string[];
  /** the target the lesson was judged by */
  target: number;
}

const lessonCpm = (charsTyped: number, errors: number, activeMs: number): number => (activeMs > 0 ? Math.max(0, charsTyped - errors) / (activeMs / 60000) : 0);

/** every completed lesson (oldest first) and the per-key rows, numbered by completion order */
export function history(db: Db): { lessons: LessonFact[]; rows: KeyLessonRow[] } {
  const raw = db.prepare("SELECT id, ended_at AS endedAt, keys_json AS keys, target_cpm AS target, active_ms AS ms, chars_typed AS c, errors AS e FROM typing_key_lessons WHERE status = 'completed' ORDER BY ended_at, id").all() as Array<{ id: string; endedAt: string; keys: string; target: number; ms: number; c: number; e: number }>;
  const lessons = raw.map((l) => ({ id: l.id, at: Date.parse(l.endedAt), cpm: lessonCpm(l.c, l.e, l.ms), activeMs: l.ms, accuracy: l.c > 0 ? (l.c - l.e) / l.c : 1, open: (JSON.parse(l.keys) as { open: string[] }).open, target: l.target }));
  const index = new Map(lessons.map((l, i) => [l.id, { i, at: l.at }]));
  const hits = db.prepare("SELECT h.lesson_id AS lessonId, h.letter, h.hits, h.misses, h.mean_ms AS meanMs FROM typing_key_hits h JOIN typing_key_lessons l ON l.id = h.lesson_id WHERE l.status = 'completed'").all() as Array<{ lessonId: string; letter: string; hits: number; misses: number; meanMs: number }>;
  const rows = hits.map((h) => ({ lessonIndex: index.get(h.lessonId)!.i, at: index.get(h.lessonId)!.at, letter: h.letter, hits: h.hits, misses: h.misses, meanMs: h.meanMs }));
  return { lessons, rows };
}

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export interface KeysNow {
  keys: LessonKey[];
  /** the speed the keys are judged against now */
  target: number;
  goal: number;
  /** the learner's current speed the target is made from, CPM */
  current: number;
  /** a key counts as reached only with at least this accuracy (0..1) */
  minAccuracy: number;
  lessons: LessonFact[];
  rows: KeyLessonRow[];
}

const stageOf = (open: Iterable<string>): string => [...open].sort().join("");

export function currentKeys(db: Db, projectRoot: string): KeysNow {
  const data = loadKeyData(projectRoot);
  const settings = loadSettings(db).values;
  const goal = Math.round((settings.typingKeysGoalWpm ?? DEFAULT_GOAL_WPM) * 5);
  const minAccuracy = (settings.typingKeysMinAccuracy ?? DEFAULT_MIN_ACCURACY * 100) / 100;
  const { lessons, rows } = history(db);
  const recent = lessons.slice(-RECENT_LESSONS).map((l) => l.cpm);
  const current = Math.round(recent.length >= MIN_RECENT ? median(recent) : baselineWpm(db) * 5);
  const fresh = Math.min(goal, Math.round(current * STEP_FACTOR));
  const alreadyOpen = new Set(lessons.flatMap((l) => l.open));
  // the target of the current stage is the one its first lesson was made with; a stage without lessons yet gets a fresh one
  const stageTarget = (open: Iterable<string>): number => {
    const first = lessons.find((l) => stageOf(l.open) === stageOf(open));
    return Math.min(goal, first ? first.target : fresh);
  };
  const judge = (target: number, open: ReadonlySet<string>) => lessonKeys(data.lettersByFrequency, rows, { targetCpm: target, alreadyOpen: open, minAccuracy });
  const openNow = alreadyOpen.size > 0 ? alreadyOpen : new Set(data.lettersByFrequency.slice(0, MIN_KEYS));
  let target = stageTarget(openNow);
  let keys = judge(target, alreadyOpen);
  const opened = new Set(keys.filter((k) => k.included).map((k) => k.letter));
  if (stageOf(opened) !== stageOf(openNow)) {
    // a letter has just opened: the new stage gets its own target, and the keys are judged by it from now on
    target = stageTarget(opened);
    keys = judge(target, opened);
  }
  if (keys.every((k) => k.included) && target < goal) {
    target = goal;
    keys = judge(target, new Set(keys.map((k) => k.letter)));
  }
  return { keys, target, goal, current, minAccuracy, lessons, rows };
}

const round2 = (v: number | null): number | null => (v == null ? null : Math.round(v * 100) / 100);

export function keyState(k: LessonKey): TypingKeyState {
  return {
    letter: k.letter,
    included: k.included,
    focused: k.focused,
    confidence: round2(k.confidence),
    bestConfidence: round2(k.bestConfidence),
    cpm: k.stats.timeToType == null ? null : Math.round(timeToSpeed(k.stats.timeToType)),
    lessons: k.stats.samples.length,
    errorRate: k.stats.errorRate == null ? null : Math.round(k.stats.errorRate * 1000) / 1000,
    readiness: round2(k.readiness) ?? 0,
  };
}

export function keysOverview(db: Db, projectRoot: string): { nextLesson: number; openKeys: number; focused: string | null } {
  const { keys, lessons } = currentKeys(db, projectRoot);
  return { nextLesson: lessons.length + 1, openKeys: keys.filter((k) => k.included).length, focused: keys.find((k) => k.focused)?.letter ?? null };
}

export function startKeysLesson(db: Db, deps: KeysDeps, projectRoot: string): TypingKeysStartResponse {
  const data = loadKeyData(projectRoot);
  const random = deps.random ?? Math.random;
  return db.transaction(() => {
    const now = deps.now().toISOString();
    // an unfinished lesson is left as interrupted: its counters stay, its keys are never counted
    db.prepare("UPDATE typing_key_lessons SET status = 'interrupted', ended_at = ? WHERE status = 'active'").run(now);
    const { keys, target, goal, lessons } = currentKeys(db, projectRoot);
    const open = keys.filter((k) => k.included).map((k) => k.letter);
    const focused = keys.find((k) => k.focused)?.letter ?? null;
    const generated = keyLessonText(data.words, data.wordSet, data.model, { letters: new Set(open), focused }, 80, random);
    const picked: typeof generated = [];
    let chars = 0;
    for (const t of generated) {
      if (chars >= LESSON_CHARS) break;
      picked.push(t);
      chars += t.text.length + 1;
    }
    const translations = new Map<string, string | null>();
    const tokens: TypingKeyToken[] = picked.map((t) => {
      if (t.kind === "pseudo") return { text: t.text, kind: "pseudo", translationRu: null };
      if (!translations.has(t.text)) translations.set(t.text, lookupBankTranslation(db, t.text)?.translationRu ?? null);
      return { text: t.text, kind: "word", translationRu: translations.get(t.text) ?? null };
    });
    const id = deps.newId();
    db.prepare("INSERT INTO typing_key_lessons(id, status, rules_version, target_cpm, keys_json, text_json, started_at) VALUES (?,?,?,?,?,?,?)").run(
      id,
      "active",
      TYPING_KEYS_RULES_VERSION,
      target,
      JSON.stringify({ open, focused }),
      JSON.stringify(tokens.map((t) => ({ text: t.text, kind: t.kind }))),
      now,
    );
    return { lessonId: id, lessonNumber: lessons.length + 1, targetCpm: target, goalCpm: goal, keys: keys.map(keyState), tokens };
  }).immediate();
}

function activeLesson(db: Db, id: string): LessonRow {
  const row = db.prepare("SELECT * FROM typing_key_lessons WHERE id = ?").get(id) as LessonRow | undefined;
  if (!row) throw new ApiError(404, "LESSON_NOT_FOUND", "Unknown Key Builder lesson");
  if (row.status !== "active") throw new ApiError(409, "LESSON_NOT_ACTIVE", "The lesson is already finished");
  return row;
}

export function abortKeysLesson(db: Db, deps: KeysDeps, id: string, c: { activeMs?: number; charsTyped?: number; errors?: number }): { status: "interrupted" } {
  return db.transaction(() => {
    const row = activeLesson(db, id);
    const nowMs = deps.now().getTime();
    db.prepare("UPDATE typing_key_lessons SET status = 'interrupted', ended_at = ?, active_ms = ?, chars_typed = ?, errors = ? WHERE id = ?").run(
      new Date(nowMs).toISOString(),
      Math.max(row.active_ms, Math.min(c.activeMs ?? 0, Math.max(0, nowMs - Date.parse(row.started_at)) + 2000)),
      Math.max(row.chars_typed, c.charsTyped ?? 0),
      Math.max(row.errors, c.errors ?? 0),
      id,
    );
    return { status: "interrupted" as const };
  }).immediate();
}

export function completeKeysLesson(db: Db, deps: KeysDeps, projectRoot: string, id: string, req: TypingKeysCompleteRequest): TypingKeysResult {
  return db.transaction(() => {
    const row = activeLesson(db, id);
    const tokens = JSON.parse(row.text_json) as Array<{ text: string }>;
    const text = tokens.map((t) => t.text).join(" ");
    const required = text.length;
    // a wrong key is never accepted, so a whole text is exactly its length in correct presses
    if (req.charsTyped - req.errors !== required) throw new ApiError(400, "LESSON_INCOMPLETE", "The whole text must be typed to complete the lesson");
    if (req.activeMs < 1000) throw new ApiError(400, "LESSON_INVALID", "The lesson time is too short");
    const occurrences = new Map<string, number>();
    for (const ch of text) if (ch !== " ") occurrences.set(ch, (occurrences.get(ch) ?? 0) + 1);
    const seen = new Set<string>();
    let misses = 0;
    // key facts are permanent and open keys for good: every letter of the text exactly once, hit as often as the text has it
    for (const k of req.keys) {
      if (seen.has(k.letter)) throw new ApiError(400, "VALIDATION_ERROR", `Key ${k.letter} is reported twice`);
      seen.add(k.letter);
      if (k.hits !== (occurrences.get(k.letter) ?? 0) || k.hits === 0) throw new ApiError(400, "VALIDATION_ERROR", `Key ${k.letter} does not match the text`);
      misses += k.misses;
    }
    if (seen.size !== occurrences.size) throw new ApiError(400, "VALIDATION_ERROR", "Every letter of the text must be reported");
    if (misses > req.errors) throw new ApiError(400, "VALIDATION_ERROR", "More key misses than wrong keys");
    // letter pairs inside the words of the text: never more correct pairs than the text has, never more pair errors than wrong keys
    const pairsInText = new Map<string, number>();
    for (const t of tokens) for (let i = 1; i < t.text.length; i++) pairsInText.set(t.text.slice(i - 1, i + 1), (pairsInText.get(t.text.slice(i - 1, i + 1)) ?? 0) + 1);
    let pairErrors = 0;
    const pairs = new Set<string>();
    for (const p of req.keyStats ?? []) {
      if (pairs.has(p.pair) || !pairsInText.has(p.pair) || p.count > pairsInText.get(p.pair)!) throw new ApiError(400, "VALIDATION_ERROR", `Pair ${p.pair} does not match the text`);
      pairs.add(p.pair);
      pairErrors += p.errors;
    }
    if (pairErrors > req.errors) throw new ApiError(400, "VALIDATION_ERROR", "More pair errors than wrong keys");
    if ((req.bestCharStreak ?? 0) > required) throw new ApiError(400, "VALIDATION_ERROR", "The streak is longer than the text");
    const before = currentKeys(db, projectRoot);
    const openBefore = new Set(before.keys.filter((k) => k.included).map((k) => k.letter));
    const nowMs = deps.now().getTime();
    const now = new Date(nowMs).toISOString();
    // active time cannot exceed the time the lesson was open
    const activeMs = Math.min(Math.max(row.active_ms, req.activeMs), Math.max(0, nowMs - Date.parse(row.started_at)) + 2000);
    const charsTyped = Math.max(row.chars_typed, req.charsTyped);
    const errors = Math.max(row.errors, req.errors);
    db.prepare("UPDATE typing_key_lessons SET status = 'completed', ended_at = ?, active_ms = ?, chars_typed = ?, errors = ?, best_char_streak = ? WHERE id = ?").run(now, activeMs, charsTyped, errors, req.bestCharStreak ?? null, id);
    const putPair = db.prepare("INSERT INTO typing_key_pairs(id, lesson_id, pair, count, total_ms, errors) VALUES (?,?,?,?,?,?)");
    for (const p of req.keyStats ?? []) if (p.count > 0 || p.errors > 0) putPair.run(deps.newId(), id, p.pair, p.count, p.totalMs, p.errors);
    const put = db.prepare("INSERT INTO typing_key_hits(id, lesson_id, letter, hits, misses, mean_ms) VALUES (?,?,?,?,?,?)");
    for (const k of req.keys) if (k.hits > 0 || k.misses > 0) put.run(deps.newId(), id, k.letter, k.hits, k.misses, k.meanMs);
    const xp = Math.max(1, Math.round(required / XP_CHARS));
    db.prepare("INSERT INTO typing_key_xp_events(id, lesson_id, amount, rule_version, created_at) VALUES (?,?,?,?,?)").run(deps.newId(), id, xp, TYPING_KEYS_XP_VERSION, now);

    const after = currentKeys(db, projectRoot);
    const focusedLetter = (JSON.parse(row.keys_json) as { focused: string | null }).focused;
    const focusKey = after.keys.find((k) => k.letter === focusedLetter);
    const lr = focusKey ? learningRate(focusKey.stats.samples, row.target_cpm) : null;
    const prev = db.prepare("SELECT chars_typed AS c, errors AS e, active_ms AS ms FROM typing_key_lessons WHERE status = 'completed' AND id <> ? ORDER BY ended_at DESC, id DESC LIMIT 1").get(id) as { c: number; e: number; ms: number } | undefined;
    const today = learningDate(deps.now().getTime(), DAILY_TIMEZONE);
    const lessonsToday = (db.prepare("SELECT ended_at AS e FROM typing_key_lessons WHERE status = 'completed'").all() as Array<{ e: string }>).filter((r) => learningDate(Date.parse(r.e), DAILY_TIMEZONE) === today).length;
    const cpm = lessonCpm(charsTyped, errors, activeMs);
    return {
      lessonId: id,
      lessonNumber: after.lessons.length,
      targetCpm: after.target,
      goalCpm: after.goal,
      currentCpm: after.current,
      goalForecast: goalForecast(after.lessons, after.goal),
      cpm: Math.round(cpm),
      wpm: Math.round(cpm / 5),
      accuracy: charsTyped > 0 ? Math.round(((charsTyped - errors) / charsTyped) * 1000) / 1000 : 1,
      activeMs,
      errors,
      previousCpm: prev ? Math.round(lessonCpm(prev.c, prev.e, prev.ms)) : null,
      xpAwarded: xp,
      keys: after.keys.map(keyState),
      newKeys: after.keys.filter((k) => k.included && !openBefore.has(k.letter)).map((k) => k.letter),
      nextKey: nextKeyOutlook(after, req.keys),
      forecast: lr && focusedLetter ? { letter: focusedLetter, cpmPerLesson: Math.round(lr.cpmPerLesson * 10) / 10, remainingLessons: lr.remainingLessons, certainty: Math.round(lr.certainty * 100) / 100 } : null,
      lessonsToday,
    };
  }).immediate();
}

/**
 * What stands between the learner and the next letter: every open key's best speed and smoothed accuracy against the stage target,
 * this lesson's own numbers for the key, and a rough count of lessons until it is reached (speed by keybr's learning rate, accuracy by
 * running the error smoothing forward). Explanation only; the open keys are decided by lessonKeys.
 */
function nextKeyOutlook(now: KeysNow, lesson: TypingKeysCompleteRequest["keys"]): TypingKeysResult["nextKey"] {
  const limit = 1 - now.minAccuracy + 1e-9;
  const thisLesson = new Map(lesson.map((k) => [k.letter, k]));
  const keys = now.keys
    .filter((k) => k.included)
    .map((k) => {
      const speedReached = (k.bestConfidence ?? 0) >= 1;
      const accuracyReached = k.stats.errorBound == null || k.stats.errorBound <= limit;
      const acc = accuracyOutlook(k.letter, now.rows, now.minAccuracy);
      const speedLessons = speedReached ? 0 : (learningRate(k.stats.samples, now.target)?.remainingLessons ?? null);
      const accLessons = accuracyReached ? 0 : acc.usualLessons;
      const l = thisLesson.get(k.letter);
      const speedProgress = Math.min(1, k.bestConfidence ?? 0);
      const accuracyProgress = Math.max(0, Math.min(1, accuracyScore(k.stats.errorBound, now.minAccuracy)));
      return {
        letter: k.letter,
        lessons: k.stats.samples.length,
        speedProgress: Math.round(speedProgress * 100) / 100,
        accuracyProgress: Math.round(accuracyProgress * 100) / 100,
        cpm: k.stats.timeToType == null ? null : Math.round(timeToSpeed(k.stats.timeToType)),
        bestCpm: k.stats.bestTimeToType == null ? null : Math.round(timeToSpeed(k.stats.bestTimeToType)),
        errorRate: k.stats.errorRate == null ? null : Math.round(k.stats.errorRate * 1000) / 1000,
        errorBound: k.stats.errorBound == null ? null : Math.round(k.stats.errorBound * 1000) / 1000,
        recentErrorRate: acc.recentErrorRate == null ? null : Math.round(acc.recentErrorRate * 1000) / 1000,
        speedReached,
        accuracyReached,
        lessonsLeft: speedLessons == null || accLessons == null ? null : Math.max(speedLessons, accLessons),
        cleanLessonsLeft: accuracyReached ? 0 : acc.cleanLessons,
        lesson: l ? { cpm: l.meanMs > 0 ? Math.round(timeToSpeed(l.meanMs)) : null, hits: l.hits, misses: l.misses } : null,
      };
    });
  const progress = keys.length > 0 ? keys.reduce((a, k) => a + Math.min(k.speedProgress, k.accuracyProgress), 0) / keys.length : 0;
  return { letter: now.keys.find((k) => !k.included)?.letter ?? null, targetCpm: now.target, minAccuracy: now.minAccuracy, progress: Math.round(progress * 100) / 100, keys };
}
