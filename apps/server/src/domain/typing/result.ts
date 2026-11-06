import type { Db } from "../../db/open.js";
import type { TypingPlanWord, TypingResult } from "@english-lab/contracts";
import { skillOf } from "./metrics.js";
import { wordErrorBands } from "./xp.js";

export interface TypingSessionRow {
  id: string;
  mode: "words" | "books";
  status: "active" | "completed" | "failed" | "interrupted";
  level_number: number;
  settings_revision: number;
  settings_json: string;
  plan_json: string | null;
  started_at: string;
  ended_at: string | null;
  active_ms: number;
  chars_typed: number;
  errors: number;
  chars_correct: number | null;
  wpm: number | null;
  cpm: number | null;
  accuracy: number | null;
  score: number | null;
  metrics_version: string | null;
  book_id: string | null;
  start_offset: number | null;
  end_offset: number | null;
  current_offset: number | null;
  best_combo: number | null;
}

export function sessionRow(db: Db, id: string): TypingSessionRow {
  const r = db.prepare("SELECT * FROM typing_sessions WHERE id = ?").get(id) as TypingSessionRow | undefined;
  if (!r) throw new Error(`typing session not found: ${id}`);
  return r;
}

interface PlanWord extends TypingPlanWord {
  // identical shape to TypingPlanWord
}

/** only when the client reported per-word errors for every destroyed word (older sessions have none) */
function bandsOf(words: TypingResult["words"]): TypingResult["wordErrorBands"] {
  if (!words) return undefined;
  const destroyed = words.filter((w) => w.destroyed);
  if (destroyed.length === 0 || destroyed.some((w) => w.errors === null)) return undefined;
  return wordErrorBands(destroyed.map((w) => w.errors!));
}

export function planWords(row: TypingSessionRow): PlanWord[] {
  if (!row.plan_json) return [];
  const plan = JSON.parse(row.plan_json) as { words?: PlanWord[] };
  return plan.words ?? [];
}

/** Best WPM and score over finished sessions of the same mode, excluding the session itself. */
function bestOf(db: Db, mode: "words" | "books", excludeId: string): { wpm: number | null; score: number | null } {
  const r = db.prepare("SELECT MAX(wpm) AS w, MAX(score) AS s FROM typing_sessions WHERE mode = ? AND status = 'completed' AND id <> ?").get(mode, excludeId) as {
    w: number | null;
    s: number | null;
  };
  return { wpm: r.w, score: r.s };
}

/** Previous completed session of the same mode with enough active time, or null. */
function previousComparable(db: Db, row: TypingSessionRow): { wpm: number } | null {
  const r = db
    .prepare(
      "SELECT wpm FROM typing_sessions WHERE mode = ? AND status = 'completed' AND active_ms >= 20000 AND id <> ? AND ended_at <= ? ORDER BY ended_at DESC LIMIT 1",
    )
    .get(row.mode, row.id, row.ended_at ?? row.started_at) as { wpm: number } | undefined;
  return r && r.wpm != null && r.wpm > 0 ? { wpm: r.wpm } : null;
}

/** The full result view for a finished (or interrupted) session, recomputed from stored data. */
export function buildTypingResult(db: Db, row: TypingSessionRow): TypingResult {
  const finished = row.status === "completed" || row.status === "failed";
  // interrupted sessions keep no computed metrics; derive a minimal one from the raw counters
  const destroyedCount = row.mode === "words" ? db.prepare("SELECT COUNT(*) AS n FROM typing_words WHERE session_id = ? AND destroyed_at IS NOT NULL").get(row.id) as { n: number } : { n: 0 };
  const wordsCharsCorrect = db.prepare("SELECT COALESCE(SUM(length(lemma)), 0) AS n FROM typing_words WHERE session_id = ? AND destroyed_at IS NOT NULL").get(row.id) as { n: number };

  const wpm = finished && row.wpm != null ? row.wpm : 0;
  const cpm = finished && row.cpm != null ? row.cpm : 0;
  const accuracy = finished ? row.accuracy : row.chars_typed > 0 ? ((row.chars_typed - row.errors) / row.chars_typed) * 100 : null;
  const score = finished && row.score != null ? row.score : 0;
  const charsCorrect = finished && row.chars_correct != null ? row.chars_correct : row.mode === "words" ? wordsCharsCorrect.n : 0;

  const xp = (db.prepare("SELECT amount FROM typing_xp_events WHERE session_id = ?").get(row.id) as { amount: number } | undefined)?.amount ?? 0;
  const best = bestOf(db, row.mode, row.id);
  const prev = previousComparable(db, row);
  const comparison = prev && wpm > 0 ? { percent: Math.round(Math.abs(wpm / prev.wpm - 1) * 100), faster: wpm >= prev.wpm } : null;

  const words = row.mode === "words" ? resultWords(db, row) : undefined;
  const book = row.mode === "books" ? resultBook(db, row) : undefined;

  return {
    sessionId: row.id,
    mode: row.mode,
    status: row.status === "active" ? "interrupted" : row.status,
    level: row.level_number,
    metrics: {
      wpm: Math.round(wpm * 10) / 10,
      cpm: Math.round(cpm * 10) / 10,
      accuracy: accuracy === null ? null : Math.round(accuracy * 10) / 10,
      errors: row.errors,
      score,
      activeMs: row.active_ms,
      charsCorrect,
      charsTyped: row.chars_typed,
    },
    best,
    comparison,
    skill: skillOf(row.mode, wpm, accuracy),
    xpAwarded: xp,
    words,
    wordsShown: row.mode === "words" ? (db.prepare("SELECT COUNT(*) AS n FROM typing_words WHERE session_id = ?").get(row.id) as { n: number }).n : undefined,
    wordsDestroyed: row.mode === "words" ? destroyedCount.n : undefined,
    wordErrorBands: bandsOf(words),
    book,
  };
}

function resultWords(db: Db, row: TypingSessionRow): TypingResult["words"] {
  const plan = new Map(planWords(row).map((w) => [w.planIndex, w]));
  const rows = db.prepare("SELECT plan_index AS pi, destroyed_at AS d, appearance_order AS o FROM typing_words WHERE session_id = ? ORDER BY appearance_order").all(row.id) as Array<{
    pi: number;
    d: string | null;
    o: number;
  }>;
  const errors = new Map((db.prepare("SELECT plan_index AS pi, errors AS e FROM typing_word_results WHERE session_id = ?").all(row.id) as Array<{ pi: number; e: number }>).map((x) => [x.pi, x.e]));
  return rows.map((r) => {
    const w = plan.get(r.pi);
    return {
      planIndex: r.pi,
      lemma: w?.lemma ?? "",
      source: w?.source ?? "general",
      vocabularyEntryId: w?.vocabularyEntryId ?? null,
      translationRu: w?.translationRu ?? null,
      partOfSpeech: w?.partOfSpeech ?? null,
      definitionRu: w?.definitionRu ?? null,
      transcription: w?.transcription ?? null,
      unverified: w?.unverified ?? false,
      destroyed: r.d !== null,
      order: r.o,
      errors: errors.get(r.pi) ?? null,
    };
  });
}

function resultBook(db: Db, row: TypingSessionRow): TypingResult["book"] {
  if (!row.book_id) return undefined;
  const b = db.prepare("SELECT title, text_length AS len, chapters_json AS c FROM typing_books WHERE id = ?").get(row.book_id) as
    | { title: string; len: number; c: string }
    | undefined;
  const offset = row.current_offset ?? row.start_offset ?? 0;
  const chapters = b ? (JSON.parse(b.c) as Array<{ title: string; startOffset: number; endOffset: number }>) : [];
  const chapter = chapters.find((c) => offset >= c.startOffset && offset < c.endOffset)?.title ?? null;
  const percentRead = b ? Math.round((offset / b.len) * 1000) / 10 : 0;
  const finished = b ? offset >= b.len : false;
  return { title: b?.title ?? "", chapter, percentRead, finished };
}
