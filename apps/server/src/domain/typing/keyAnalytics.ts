import type { TypingAnalyticsMode, TypingKeyboardAnalytics } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { loadSettings } from "../sessions/policy.js";
import { loadKeyData } from "./keys/data.js";
import { accuracyScore, confidence, DEFAULT_MIN_ACCURACY, goalForecast, keyStats, timeToSpeed, type KeyLessonRow } from "./keys/guided.js";
import { DEFAULT_GOAL_WPM, history } from "./keys/lessons.js";

/**
 * keybr.com's per-key view for every typing mode: each key's time per press, smoothed over lessons (exponential, alpha 0.1), its best
 * smoothed time, its confidence against the learner's goal, its error rate, and the long-range forecast to the goal.
 * Key Builder records keys directly (typing_key_hits). Words and Books record letter pairs (typing_key_stats): the second letter of a
 * pair is the key pressed, so its interval is that key's time. Everything is derived on read; nothing is stored.
 */

/** English letter frequency order, used only when content/typing is missing */
const FALLBACK_ORDER = "etaoinshrdlcumwfgypbvkjxqz".split("");
/** points of a key's learning curve sent to the client */
const CURVE_POINTS = 60;
/** sessions shown in the progress heatmap */
const GRID_SESSIONS = 60;

interface Session {
  at: number;
  cpm: number;
  activeMs: number;
}

function classicSource(db: Db, mode: "words" | "drills" | "books"): { sessions: Session[]; rows: KeyLessonRow[] } {
  const dbMode = mode === "books" ? "books" : "words";
  const variant = mode === "drills" ? "drills" : "meteors";
  const list = db
    .prepare("SELECT id, ended_at AS endedAt, wpm, active_ms AS ms FROM typing_sessions WHERE mode = ? AND variant = ? AND status IN ('completed','failed') AND ended_at IS NOT NULL ORDER BY ended_at, id")
    .all(dbMode, variant) as Array<{ id: string; endedAt: string; wpm: number | null; ms: number }>;
  const index = new Map(list.map((s, i) => [s.id, { i, at: Date.parse(s.endedAt) }]));
  const facts = db
    .prepare(
      `SELECT k.session_id AS sessionId, substr(k.pair, 2, 1) AS letter, SUM(k.count) AS hits, SUM(k.total_ms) AS ms, SUM(k.errors) AS misses
       FROM typing_key_stats k JOIN typing_sessions s ON s.id = k.session_id
       WHERE s.mode = ? AND s.variant = ? AND s.status IN ('completed','failed') AND substr(k.pair, 2, 1) BETWEEN 'a' AND 'z'
       GROUP BY k.session_id, substr(k.pair, 2, 1)`,
    )
    .all(dbMode, variant) as Array<{ sessionId: string; letter: string; hits: number; ms: number; misses: number }>;
  const rows = facts.flatMap((f) => {
    const s = index.get(f.sessionId);
    return s ? [{ lessonIndex: s.i, at: s.at, letter: f.letter, hits: f.hits, misses: f.misses, meanMs: f.hits > 0 ? f.ms / f.hits : 0 }] : [];
  });
  return { sessions: list.map((s) => ({ at: Date.parse(s.endedAt), cpm: (s.wpm ?? 0) * 5, activeMs: s.ms })), rows };
}

function letterOrder(projectRoot: string | null): string[] {
  if (!projectRoot) return FALLBACK_ORDER;
  try {
    return loadKeyData(projectRoot).lettersByFrequency;
  } catch {
    return FALLBACK_ORDER;
  }
}

/** Audio Dictation: one column per completed lesson; hits and misses are derived from each typed answer, the time of a key from the page */
function dictationSource(db: Db): { sessions: Session[]; rows: KeyLessonRow[] } {
  const lessons = db
    .prepare(
      `SELECT l.id, l.completed_at AS endedAt, l.active_ms AS activeMs,
              COALESCE((SELECT SUM(length(c.answer_text)) FROM typing_dictation_attempts c JOIN typing_dictation_exercises e ON e.id = c.exercise_id WHERE e.lesson_id = l.id AND c.correct = 1), 0) AS chars,
              COALESCE((SELECT SUM(a.typing_ms) FROM typing_dictation_attempts a JOIN typing_dictation_exercises e ON e.id = a.exercise_id WHERE e.lesson_id = l.id), 0) AS typingMs
         FROM typing_dictation_lessons l WHERE l.status = 'completed' AND l.completed_at IS NOT NULL ORDER BY l.completed_at, l.id`,
    )
    .all() as Array<{ id: string; endedAt: string; activeMs: number; chars: number; typingMs: number }>;
  const index = new Map(lessons.map((l, i) => [l.id, { i, at: Date.parse(l.endedAt) }]));
  const facts = db
    .prepare(
      `SELECT e.lesson_id AS lessonId, k.letter, SUM(k.hits) AS hits, SUM(k.misses) AS misses, SUM(k.total_ms) AS ms, SUM(k.timed) AS timed
         FROM typing_dictation_keys k JOIN typing_dictation_attempts a ON a.id = k.attempt_id JOIN typing_dictation_exercises e ON e.id = a.exercise_id
        GROUP BY e.lesson_id, k.letter`,
    )
    .all() as Array<{ lessonId: string; letter: string; hits: number; misses: number; ms: number; timed: number }>;
  const rows = facts.flatMap((f) => {
    const s = index.get(f.lessonId);
    return s ? [{ lessonIndex: s.i, at: s.at, letter: f.letter, hits: f.hits, misses: f.misses, meanMs: f.timed > 0 ? f.ms / f.timed : 0 }] : [];
  });
  return { sessions: lessons.map((l) => ({ at: Date.parse(l.endedAt), cpm: l.typingMs > 0 ? (l.chars / l.typingMs) * 60000 : 0, activeMs: l.activeMs })), rows };
}

export function dictationKeyboardAnalytics(db: Db, projectRoot: string | null): TypingKeyboardAnalytics {
  return buildKeyboard(db, dictationSource(db), projectRoot);
}

export function keyboardAnalytics(db: Db, mode: TypingAnalyticsMode, projectRoot: string | null): TypingKeyboardAnalytics {
  const src = mode === "keys" ? (() => { const h = history(db); return { sessions: h.lessons, rows: h.rows }; })() : classicSource(db, mode);
  return buildKeyboard(db, src, projectRoot);
}

function buildKeyboard(db: Db, src: { sessions: Session[]; rows: KeyLessonRow[] }, projectRoot: string | null): TypingKeyboardAnalytics {
  const settings = loadSettings(db).values;
  const goalCpm = Math.round((settings.typingKeysGoalWpm ?? DEFAULT_GOAL_WPM) * 5);
  const minAccuracy = (settings.typingKeysMinAccuracy ?? DEFAULT_MIN_ACCURACY * 100) / 100;
  const keys = letterOrder(projectRoot).map((letter) => {
    const st = keyStats(letter, src.rows);
    const own = src.rows.filter((r) => r.letter === letter);
    const hits = own.reduce((a, r) => a + r.hits, 0);
    const misses = own.reduce((a, r) => a + r.misses, 0);
    const conf = confidence(st.timeToType, goalCpm);
    const best = confidence(st.bestTimeToType, goalCpm);
    return {
      letter,
      lessons: st.samples.length,
      cpm: st.timeToType == null ? null : Math.round(timeToSpeed(st.timeToType)),
      bestCpm: st.bestTimeToType == null ? null : Math.round(timeToSpeed(st.bestTimeToType)),
      confidence: conf == null ? null : Math.round(conf * 100) / 100,
      bestConfidence: best == null ? null : Math.round(best * 100) / 100,
      hits,
      misses,
      errorRate: hits + misses > 0 ? Math.round((misses / (hits + misses)) * 1000) / 1000 : null,
      /** best speed against the goal and recent accuracy together (as Key Builder judges keys): 1 = reached */
      readiness: Math.round(Math.min(best ?? 0, accuracyScore(st.errorBound, minAccuracy)) * 100) / 100,
      curve: st.samples.slice(-CURVE_POINTS).map((p) => ({ at: new Date(p.at).toISOString(), cpm: Math.round(timeToSpeed(p.timeToType)), smoothed: Math.round(timeToSpeed(p.filteredTimeToType)) })),
    };
  });
  const byLesson = new Map<number, KeyLessonRow[]>();
  for (const r of src.rows) (byLesson.get(r.lessonIndex) ?? byLesson.set(r.lessonIndex, []).get(r.lessonIndex)!).push(r);
  const grid = [...byLesson.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(-GRID_SESSIONS)
    .map(([, rows]) => ({
      at: new Date(rows[0]!.at).toISOString(),
      keys: rows.map((r) => ({ letter: r.letter, hits: r.hits, misses: r.misses, cpm: r.meanMs > 0 ? Math.round(timeToSpeed(r.meanMs)) : null })),
    }));
  return { goalCpm, minAccuracy, keys, forecast: goalForecast(src.sessions, goalCpm), grid };
}
