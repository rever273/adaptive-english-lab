import type { Db } from "../../db/open.js";
import type { TypingAnalytics, TypingMode } from "@english-lab/contracts";
import { localDateIn } from "../attempts/canonical.js";
import { buildTypingResult, sessionRow, type TypingSessionRow } from "./result.js";

export interface AnalyticsInput {
  mode: TypingMode;
  days: number | null;
  timezone: string;
  now: Date;
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
  const start = new Date(minDate + "T00:00:00");
  const end = new Date(localDateIn(timezone, now) + "T00:00:00");
  const out: string[] = [];
  for (let d = start; d <= end; d = new Date(d.getTime() + 86_400_000)) {
    out.push(localDateIn(timezone, d));
  }
  return out;
}

export function typingAnalytics(db: Db, input: AnalyticsInput): TypingAnalytics {
  const { mode, timezone } = input;
  const rows = db
    .prepare("SELECT * FROM typing_sessions WHERE mode = ? AND status <> 'active' ORDER BY ended_at ASC")
    .all(mode) as TypingSessionRow[];

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

  const lastRow = rows.length ? sessionRow(db, rows[rows.length - 1]!.id) : null;

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
  const perDate = new Map<string, { attempts: number; activeSeconds: number }>();
  for (const r of finished) {
    const d = localDateIn(timezone, new Date(r.ended_at ?? r.started_at));
    const cur = perDate.get(d) ?? { attempts: 0, activeSeconds: 0 };
    cur.attempts += 1;
    cur.activeSeconds += Math.round(r.active_ms / 1000);
    perDate.set(d, cur);
  }
  const daily = dates.map((d) => ({ date: d, attempts: perDate.get(d)?.attempts ?? 0, activeSeconds: perDate.get(d)?.activeSeconds ?? 0 }));

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
    last: lastRow ? buildTypingResult(db, lastRow) : null,
    ...(mode === "words"
      ? { wordsShown: countWords(db, "shown"), wordsDestroyed: countWords(db, "destroyed") }
      : booksProgress(db, mode)),
  };

  return {
    mode,
    window: { days: input.days, timezone },
    summary,
    series: { wpm, accuracy, score, daily, duration, personalBest },
  };
}

function countWords(db: Db, kind: "shown" | "destroyed"): number {
  const where = kind === "shown" ? "1=1" : "destroyed_at IS NOT NULL";
  const r = db.prepare(`SELECT COUNT(*) AS n FROM typing_words WHERE ${where}`).get() as { n: number };
  return r.n;
}

function booksProgress(db: Db, mode: TypingMode): { currentLevel: number; chapter: string | null; percentRead: number | null } {
  void mode;
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
