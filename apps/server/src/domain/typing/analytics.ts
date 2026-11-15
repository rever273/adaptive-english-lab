import type { Db } from "../../db/open.js";
import type { TypingAnalytics, TypingAnalyticsMode, TypingMode } from "@english-lab/contracts";
import { drillsProgress, drillsSummary } from "./drills.js";
import { localDateIn } from "../attempts/canonical.js";
import { keyInsights } from "./keyStats.js";
import { keyboardAnalytics } from "./keyAnalytics.js";
import { currentKeys, keyState } from "./keys/lessons.js";
import type { TypingKeyState } from "@english-lab/contracts";
import { loadSettings } from "../sessions/policy.js";
import { DEFAULT_MIN_ACCURACY } from "./keys/guided.js";
import { recallSummary } from "./recall.js";
import { buildTypingResult, sessionRow, type TypingSessionRow } from "./result.js";

export interface AnalyticsInput {
  /** words = Meteor Rain, drills = Finger Drills (both are Words sessions), books */
  mode: TypingAnalyticsMode;
  days: number | null;
  timezone: string;
  now: Date;
  /** content/typing (Key Builder letter order); without it the analytics use a fixed English order */
  projectRoot?: string;
}

/** Key Builder lessons in the shape of a typing session row, so every summary and series below is computed the same way */
function keyLessonRows(db: Db): Array<TypingSessionRow & { keys_json: string; target_cpm: number }> {
  const rows = db.prepare("SELECT * FROM typing_key_lessons WHERE status <> 'active' ORDER BY ended_at ASC").all() as Array<{ id: string; status: "completed" | "interrupted"; started_at: string; ended_at: string | null; active_ms: number; chars_typed: number; errors: number; best_char_streak: number | null; keys_json: string; target_cpm: number }>;
  return rows.map((r) => {
    const correct = Math.max(0, r.chars_typed - r.errors);
    const minutes = r.active_ms / 60000;
    const wpm = minutes > 0 ? correct / 5 / minutes : 0;
    return {
      id: r.id, mode: "words", variant: "meteors", status: r.status, level_number: 1, settings_revision: 0, settings_json: "{}", plan_json: null,
      started_at: r.started_at, ended_at: r.ended_at, active_ms: r.active_ms, chars_typed: r.chars_typed, errors: r.errors, chars_correct: correct,
      wpm, cpm: wpm * 5, accuracy: r.chars_typed > 0 ? (correct / r.chars_typed) * 100 : null, score: null, metrics_version: null,
      book_id: null, start_offset: null, end_offset: null, current_offset: null, best_combo: null, best_char_streak: r.best_char_streak, current_char_streak: null,
      keys_json: r.keys_json, target_cpm: r.target_cpm,
    };
  });
}

/**
 * Key Builder, lesson by lesson: the letters open when the lesson started, the target it was judged by, and its own speed and
 * accuracy. The letters that opened since the previous finished lesson are the lesson's newKeys (a new letter is the usual reason
 * for a drop in speed); they are found over all finished lessons, then the window is applied.
 */
function keyProgressSeries(db: Db, rows: Array<TypingSessionRow & { keys_json: string; target_cpm: number }>, inWindow: (r: TypingSessionRow) => boolean) {
  const limit = Math.round(loadSettings(db).values.typingKeysMinAccuracy ?? DEFAULT_MIN_ACCURACY * 100);
  let before = new Set<string>();
  const out: Array<{ at: string; open: number; targetCpm: number; wpm: number; accuracy: number | null; accuracyLimit: number; newKeys: string[] }> = [];
  for (const r of rows.filter((x) => x.status === "completed")) {
    const open = (JSON.parse(r.keys_json) as { open: string[] }).open;
    const newKeys = before.size === 0 ? [] : open.filter((l) => !before.has(l));
    before = new Set([...before, ...open]);
    if (inWindow(r)) out.push({ at: r.ended_at ?? r.started_at, open: open.length, targetCpm: r.target_cpm, wpm: Math.round((r.wpm ?? 0) * 10) / 10, accuracy: r.accuracy === null ? null : Math.round(r.accuracy * 10) / 10, accuracyLimit: limit, newKeys });
  }
  return out;
}

function dateList(days: number | null, timezone: string, now: Date, minDate: string | null): string[] {
  if (days !== null) {
    const out: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86_400_000);
      out.push(localDateIn(timezone, d));
    }
    return out;
  }
  if (!minDate) return [];
  const start = Date.parse(minDate + "T00:00:00Z");
  const end = Date.parse(localDateIn(timezone, now) + "T00:00:00Z");
  const out: string[] = [];
  for (let t = start; t <= end; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export function typingAnalytics(db: Db, input: AnalyticsInput): TypingAnalytics {
  const { mode, timezone } = input;
  const dbMode: TypingMode = mode === "books" ? "books" : "words";
  const variant = mode === "drills" ? "drills" : "meteors"; // Books rows carry the default 'meteors'
  const keyRows = mode === "keys" ? keyLessonRows(db) : null;
  const rows = keyRows ?? (db
    .prepare("SELECT * FROM typing_sessions WHERE mode = ? AND variant = ? AND status <> 'active' ORDER BY ended_at ASC")
    .all(dbMode, variant) as TypingSessionRow[]);

  const finished = rows.filter((r) => r.status === "completed" || r.status === "failed");
  const completed = rows.filter((r) => r.status === "completed");

  const totalActiveMs = finished.reduce((a, r) => a + r.active_ms, 0);
  const charsCorrect = finished.reduce((a, r) => a + (r.chars_correct ?? 0), 0);
  const charsTyped = finished.reduce((a, r) => a + r.chars_typed, 0);
  const errors = finished.reduce((a, r) => a + r.errors, 0);
  const avgWpm = totalActiveMs > 0 ? Math.round((charsCorrect / 5 / (totalActiveMs / 60000)) * 10) / 10 : null;
  const avgAccuracy = charsTyped > 0 ? Math.round(((charsTyped - errors) / charsTyped) * 1000) / 10 : null;
  const maxWpm = completed.length ? Math.max(...completed.map((r) => r.wpm ?? 0)) : null;
  const maxScore = completed.length ? Math.max(...completed.map((r) => r.score ?? 0)) : null;

  const lastRow = rows.length && !keyRows ? sessionRow(db, rows[rows.length - 1]!.id) : null;

  // series
  const wpm: Array<{ at: string; value: number; status: string }> = finished.filter((r) => r.wpm != null).map((r) => ({ at: r.ended_at ?? r.started_at, value: Math.round((r.wpm ?? 0) * 10) / 10, status: r.status }));
  const accuracy: Array<{ at: string; value: number; status: string }> = finished.filter((r) => r.accuracy != null).map((r) => ({ at: r.ended_at ?? r.started_at, value: Math.round((r.accuracy ?? 0) * 10) / 10, status: r.status }));
  const score: Array<{ at: string; value: number; status: string }> = finished.filter((r) => r.score != null).map((r) => ({ at: r.ended_at ?? r.started_at, value: r.score ?? 0, status: r.status }));
  const duration: Array<{ at: string; value: number; status: string }> = finished.map((r) => ({ at: r.ended_at ?? r.started_at, value: Math.round(r.active_ms / 1000), status: r.status }));

  const personalBest: Array<{ at: string; wpm: number; score: number }> = [];
  let bestWpm = 0;
  let bestScore = 0;
  for (const r of completed) {
    const w = r.wpm ?? 0;
    const s = r.score ?? 0;
    if (w > bestWpm || s > bestScore) {
      bestWpm = Math.max(bestWpm, w);
      bestScore = Math.max(bestScore, s);
      personalBest.push({ at: r.ended_at ?? r.started_at, wpm: Math.round(bestWpm * 10) / 10, score: bestScore });
    }
  }

  // daily activity over the window
  const minDate = rows.length ? localDateIn(timezone, new Date(rows[0]!.ended_at ?? rows[0]!.started_at)) : null;
  const dates = dateList(input.days, timezone, input.now, minDate);
  const perDate = new Map<string, { attempts: number; activeSeconds: number; chars: number }>();
  for (const r of finished) {
    const d = localDateIn(timezone, new Date(r.ended_at ?? r.started_at));
    const cur = perDate.get(d) ?? { attempts: 0, activeSeconds: 0, chars: 0 };
    cur.attempts += 1;
    cur.activeSeconds += Math.round(r.active_ms / 1000);
    cur.chars += r.chars_typed;
    perDate.set(d, cur);
  }
  let cumulative = 0;
  const allDates = [...perDate.keys()].sort();
  let cursor = 0;
  const daily = dates.map((d) => {
    while (cursor < allDates.length && allDates[cursor]! <= d) cumulative += perDate.get(allDates[cursor++]!)!.chars;
    return { date: d, attempts: perDate.get(d)?.attempts ?? 0, activeSeconds: perDate.get(d)?.activeSeconds ?? 0, chars: perDate.get(d)?.chars ?? 0, cumulativeChars: cumulative };
  });

  // Older Books sessions may have a recorded combo but could have lost earlier
  // visits on reload. Old Words combos count words, not characters.
  const recordedCharStreak = (r: TypingSessionRow): number | null => r.best_char_streak ?? (mode === "books" ? r.best_combo : null);
  const inWindow = (r: TypingSessionRow) => input.days === null || visibleDatesOf(r);
  const visibleDatesOf = (r: TypingSessionRow) => dates.includes(localDateIn(timezone, new Date(r.ended_at ?? r.started_at)));
  const values = finished.map(recordedCharStreak).filter((n): n is number => n !== null);
  const visibleDates = new Set(dates);
  const charStreak = finished.filter((r) => input.days === null || visibleDates.has(localDateIn(timezone, new Date(r.ended_at ?? r.started_at))))
    .map((r) => ({ at: r.ended_at ?? r.started_at, value: recordedCharStreak(r), status: r.status }));

  const summary = {
    totalActiveMs,
    attempts: rows.length,
    completed: completed.length,
    failed: rows.filter((r) => r.status === "failed").length,
    interrupted: rows.filter((r) => r.status === "interrupted").length,
    avgWpm,
    maxWpm,
    avgAccuracy,
    maxScore,
    totalChars: finished.reduce((a, r) => a + r.chars_typed, 0),
    bestCharStreak: values.length ? Math.max(...values) : null,
    bestCombo: finished.reduce<number | null>((best, r) => (r.best_combo !== null && r.best_combo !== undefined && (best === null || r.best_combo > best) ? r.best_combo : best), null),
    last: lastRow ? buildTypingResult(db, lastRow) : null,
    ...(mode === "words"
      ? { wordsShown: countWords(db, "shown", "meteors"), wordsDestroyed: countWords(db, "destroyed", "meteors"), recall: recallSummary(db) }
      : mode === "drills"
        ? { wordsShown: countWords(db, "shown", "drills"), wordsDestroyed: countWords(db, "destroyed", "drills"), drills: drillsSummary(db) }
        : mode === "keys"
          ? keyBuilderSummary(db, input.projectRoot)
          : booksProgress(db)),
  };

  return {
    mode,
    window: { days: input.days, timezone },
    summary,
    series: { wpm, accuracy, score, daily, duration, personalBest, charStreak, ...(keyRows ? { keyProgress: keyProgressSeries(db, keyRows, inWindow) } : {}), ...(mode === "drills" ? { drillProgress: drillSeries(db, finished, (r) => input.days === null || visibleDates.has(localDateIn(timezone, new Date(r.ended_at ?? r.started_at)))) } : {}), ...(mode === "books" ? { bookWordAccuracy: finished.filter(r => input.days === null || visibleDates.has(localDateIn(timezone,new Date(r.ended_at ?? r.started_at)))).flatMap(r => { const w = db.prepare("SELECT tracked_from AS start,completed_words AS completed,error_words AS withErrors,reliable FROM typing_book_word_tracking WHERE session_id=?").get(r.id) as {start:number;completed:number;withErrors:number;reliable:number}|undefined; return w?.reliable ? [{at:r.ended_at ?? r.started_at,completed:w.completed,withErrors:w.withErrors,partial:w.start > (r.start_offset ?? 0)}] : []; }) } : {}) },
    keyInsights: keyInsights(db),
    keyboard: keyboardAnalytics(db, mode, input.projectRoot ?? null),
  };
}

function keyBuilderSummary(db: Db, projectRoot: string | undefined): { keyBuilder?: { openKeys: number; focused: string | null; targetCpm: number; goalCpm: number; currentCpm: number; keys: TypingKeyState[] } } {
  if (!projectRoot) return {};
  try {
    const k = currentKeys(db, projectRoot);
    return { keyBuilder: { openKeys: k.keys.filter((x) => x.included).length, focused: k.keys.find((x) => x.focused)?.letter ?? null, targetCpm: k.target, goalCpm: k.goal, currentCpm: k.current, keys: k.keys.map(keyState) } };
  } catch {
    return {};
  }
}

function drillSeries(db: Db, finished: TypingSessionRow[], visible: (r: TypingSessionRow) => boolean): Array<{ at: string; status: string; clean: number; withErrors: number; learned: number }> {
  const byId = new Map(finished.map((r) => [r.id, r]));
  return drillsProgress(db).flatMap((p) => {
    const r = byId.get(p.sessionId);
    return r && visible(r) ? [{ at: r.ended_at ?? r.started_at, status: r.status, clean: p.clean, withErrors: p.withErrors, learned: p.learned }] : [];
  });
}

function countWords(db: Db, kind: "shown" | "destroyed", variant: "meteors" | "drills"): number {
  const where = kind === "shown" ? "1=1" : "w.destroyed_at IS NOT NULL";
  const r = db.prepare(`SELECT COUNT(*) AS n FROM typing_words w JOIN typing_sessions s ON s.id = w.session_id AND s.variant = ? WHERE ${where}`).get(variant) as { n: number };
  return r.n;
}

function booksProgress(db: Db): { currentLevel: number; chapter: string | null; percentRead: number | null } {
  const active = db.prepare("SELECT current_offset, start_offset, book_id FROM typing_sessions WHERE mode = 'books' AND status = 'active' LIMIT 1").get() as
    | { current_offset: number | null; start_offset: number | null; book_id: string | null }
    | undefined;
  const completed = db.prepare("SELECT COALESCE(MAX(level_number), 0) AS n, COALESCE(MAX(end_offset), 0) AS o FROM typing_sessions WHERE mode = 'books' AND status = 'completed'").get() as { n: number; o: number };
  const offset = active ? (active.current_offset ?? active.start_offset ?? 0) : completed.o;
  const currentLevel = active ? (db.prepare("SELECT level_number AS n FROM typing_sessions WHERE mode = 'books' AND status = 'active' LIMIT 1").get() as { n: number }).n : completed.n + 1;
  const bookId = active?.book_id ?? null;
  let chapter: string | null = null;
  let percentRead: number | null = null;
  if (bookId) {
    const b = db.prepare("SELECT text_length AS len, chapters_json AS c FROM typing_books WHERE id = ?").get(bookId) as { len: number; c: string } | undefined;
    if (b) {
      const chapters = JSON.parse(b.c) as Array<{ title: string; startOffset: number; endOffset: number }>;
      chapter = chapters.find((c) => offset >= c.startOffset && offset < c.endOffset)?.title ?? null;
      percentRead = b.len > 0 ? Math.round((offset / b.len) * 1000) / 10 : 0;
    }
  }
  return { currentLevel, chapter, percentRead };
}
