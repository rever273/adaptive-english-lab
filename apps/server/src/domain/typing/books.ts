import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Db } from "../../db/open.js";
import { countRequired, splitSentences, type TypingBookStartResponse } from "@english-lab/contracts";
import { ApiError } from "../../errors.js";
import { loadSettings } from "../sessions/policy.js";
import { computeMetrics, METRICS_VERSION } from "./metrics.js";
import { buildTypingResult, sessionRow, type TypingSessionRow } from "./result.js";
import { saveKeyStats, type KeyStat } from "./keyStats.js";
import { bookEncounters } from "../vocabulary/repository.js";
import { awardTypingXp, typingXpForBooks } from "./xp.js";

export interface BooksDeps {
  now: () => Date;
  newId: () => string;
}

interface BookRow {
  id: string;
  title: string;
  author: string;
  source: string;
  content_sha256: string;
  text_length: number;
  chapters_json: string;
}

interface Chapter {
  title: string;
  startOffset: number;
  endOffset: number;
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** File contents are cached per book id for the lifetime of the process (the hash is checked once). */
const fileCache = new Map<string, string>();

function readBookText(booksDir: string, id: string): { text: string } | { error: "file_missing" } {
  const cached = fileCache.get(id);
  if (cached !== undefined) return { text: cached };
  const file = path.join(booksDir, `${id}.txt`);
  if (!existsSync(file)) return { error: "file_missing" };
  const text = readFileSync(file, "utf8");
  fileCache.set(id, text);
  return { text };
}

function bookRow(db: Db): BookRow | undefined {
  return db.prepare("SELECT * FROM typing_books ORDER BY created_at LIMIT 1").get() as BookRow | undefined;
}

function activeBooks(db: Db): TypingSessionRow | undefined {
  return db.prepare("SELECT * FROM typing_sessions WHERE mode = 'books' AND status = 'active' LIMIT 1").get() as TypingSessionRow | undefined;
}

function completedBooksWpm(db: Db): number {
  const rows = db
    .prepare("SELECT chars_correct, active_ms FROM typing_sessions WHERE mode = 'books' AND status = 'completed' ORDER BY ended_at DESC LIMIT 5")
    .all() as Array<{ chars_correct: number | null; active_ms: number }>;
  const chars = rows.reduce((a, x) => a + (x.chars_correct ?? 0), 0);
  const ms = rows.reduce((a, x) => a + x.active_ms, 0);
  return ms > 0 ? chars / 5 / (ms / 60000) : 25;
}

/**
 * End offset of the next book level: walk the sentences from `start` until about `targetChars` required characters are collected
 * and end at that sentence boundary, so a short level (2 minutes) really is short even when paragraphs are long.
 */
export function computeBookEnd(text: string, start: number, targetChars: number): number {
  if (start >= text.length) return text.length;
  let acc = 0;
  let last = -1;
  for (const s of splitSentences(text)) {
    if (s.end <= start) continue;
    const count = countRequired(text, Math.max(s.start, start), s.end);
    if (count === 0) continue;
    acc += count;
    last = s.end;
    if (acc >= targetChars) return s.end;
  }
  return last > start ? last : text.length;
}

function chaptersOf(row: BookRow): Chapter[] {
  return JSON.parse(row.chapters_json) as Chapter[];
}

function loadBookTextOrThrow(row: BookRow, booksDir: string): string {
  const read = readBookText(booksDir, row.id);
  if ("error" in read) throw new ApiError(409, "TYPING_BOOK_UNAVAILABLE", "The book file is missing; run `npm run typing:prepare-book` again.");
  if (sha256(read.text) !== row.content_sha256) throw new ApiError(409, "TYPING_BOOK_UNAVAILABLE", "The book file changed since it was prepared; prepare it again.");
  return read.text;
}

export interface BooksOverview {
  available: boolean;
  reason: "no_book" | "file_missing" | "file_changed" | null;
  finished: boolean;
  bookId: string | null;
  title: string | null;
  level: number;
  chapter: string | null;
  offset: number;
  percentRead: number | null;
  activeSessionId: string | null;
}

export function booksOverview(db: Db, booksDir: string): BooksOverview {
  const row = bookRow(db);
  if (!row) return { available: false, reason: "no_book", finished: false, bookId: null, title: null, level: 1, chapter: null, offset: 0, percentRead: null, activeSessionId: null };

  const active = activeBooks(db);
  const completed = db.prepare("SELECT COALESCE(MAX(level_number), 0) AS n, COALESCE(MAX(end_offset), 0) AS o FROM typing_sessions WHERE mode = 'books' AND status = 'completed' AND book_id = ?").get(row.id) as { n: number; o: number };
  const level = active ? active.level_number : completed.n + 1;
  const offset = active ? (active.current_offset ?? active.start_offset ?? 0) : completed.o;
  const chapter = chaptersOf(row).find((c) => offset >= c.startOffset && offset < c.endOffset)?.title ?? null;

  const read = readBookText(booksDir, row.id);
  if ("error" in read) return { available: false, reason: read.error, finished: false, bookId: row.id, title: row.title, level, chapter, offset, percentRead: null, activeSessionId: active?.id ?? null };
  if (sha256(read.text) !== row.content_sha256) return { available: false, reason: "file_changed", finished: false, bookId: row.id, title: row.title, level, chapter, offset, percentRead: null, activeSessionId: active?.id ?? null };

  const percentRead = row.text_length > 0 ? Math.round((offset / row.text_length) * 1000) / 10 : 0;
  return { available: true, reason: null, finished: offset >= row.text_length, bookId: row.id, title: row.title, level, chapter, offset, percentRead, activeSessionId: active?.id ?? null };
}

function bookStartResponse(db: Db, s: TypingSessionRow, row: BookRow, booksDir: string): TypingBookStartResponse {
  const text = loadBookTextOrThrow(row, booksDir);
  const start = s.start_offset ?? 0;
  const end = s.end_offset ?? start;
  const current = s.current_offset ?? start;
  const percentRead = row.text_length > 0 ? Math.round((current / row.text_length) * 1000) / 10 : 0;
  return {
    sessionId: s.id,
    bookId: row.id,
    title: row.title,
    author: row.author,
    level: s.level_number,
    startOffset: start,
    endOffset: end,
    currentOffset: current,
    text: text.slice(start, end),
    chapters: chaptersOf(row),
    textLength: row.text_length,
    percentRead,
    activeMs: s.active_ms,
    charsTyped: s.chars_typed,
    errors: s.errors,
  };
}

export function startBook(db: Db, deps: BooksDeps, booksDir: string): TypingBookStartResponse {
  const row = bookRow(db);
  if (!row) throw new ApiError(409, "TYPING_BOOK_UNAVAILABLE", "No book is prepared; run `npm run typing:prepare-book` first.");

  const active = activeBooks(db);
  if (active) return bookStartResponse(db, active, row, booksDir);

  const settings = loadSettings(db);
  const minutes = settings.values.typingBookMinutes ?? 5;
  const completed = db.prepare("SELECT COALESCE(MAX(level_number), 0) AS n, COALESCE(MAX(end_offset), 0) AS o FROM typing_sessions WHERE mode = 'books' AND status = 'completed' AND book_id = ?").get(row.id) as { n: number; o: number };
  const text = loadBookTextOrThrow(row, booksDir);
  // a level starts at the first character of the next paragraph, not on the blank line before it
  let startOffset = completed.o;
  while (startOffset < text.length && /\s/.test(text.charAt(startOffset))) startOffset++;
  if (startOffset >= row.text_length) throw new ApiError(409, "TYPING_BOOK_FINISHED", "You have reached the end of the book.");

  const wpm = completedBooksWpm(db);
  const targetChars = minutes * wpm * 5;
  const endOffset = computeBookEnd(text, startOffset, targetChars);
  if (endOffset <= startOffset) throw new ApiError(409, "TYPING_BOOK_FINISHED", "You have reached the end of the book.");

  const id = deps.newId();
  const level = completed.n + 1;
  db.prepare(
    "INSERT INTO typing_sessions(id, mode, status, level_number, settings_revision, settings_json, started_at, book_id, start_offset, end_offset, current_offset) VALUES (?, 'books', 'active', ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, level, settings.revision, JSON.stringify(settings.values), deps.now().toISOString(), row.id, startOffset, endOffset, startOffset);

  return bookStartResponse(db, sessionRow(db, id), row, booksDir);
}

export interface BookCheckpoint {
  offset: number;
  activeMs: number;
  charsTyped: number;
  errors: number;
  /** letter-pair timing and wrong keys (only sent with the completion) */
  keyStats?: KeyStat[] | undefined;
  /** longest run of correct characters (Precision Combo) */
  bestCombo?: number | undefined;
}

export function checkpointBook(db: Db, sessionId: string, req: BookCheckpoint): { ok: true; applied: boolean } {
  const row = sessionRow(db, sessionId);
  if (row.mode !== "books") throw new ApiError(409, "TYPING_SESSION_WRONG_MODE", "Not a books session");
  if (row.status !== "active") return { ok: true, applied: false };
  const start = row.start_offset ?? 0;
  const end = row.end_offset ?? start;
  if (req.offset < start || req.offset > end) throw new ApiError(400, "TYPING_OFFSET_INVALID", `offset must be within [${start}, ${end}]`);
  if (req.activeMs < row.active_ms || req.charsTyped < row.chars_typed || req.errors < row.errors) {
    // stale keepalive from before an earlier checkpoint: ignore without tripping the identity trigger
    return { ok: true, applied: false };
  }
  db.prepare("UPDATE typing_sessions SET current_offset = ?, active_ms = ?, chars_typed = ?, errors = ? WHERE id = ?").run(req.offset, req.activeMs, req.charsTyped, req.errors, sessionId);
  return { ok: true, applied: true };
}

export function completeBook(db: Db, deps: BooksDeps, booksDir: string, sessionId: string, req: BookCheckpoint): ReturnType<typeof buildTypingResult> {
  const row = sessionRow(db, sessionId);
  if (row.mode !== "books") throw new ApiError(409, "TYPING_SESSION_WRONG_MODE", "Not a books session");
  if (row.status !== "active") return buildTypingResult(db, row); // idempotent

  const end = row.end_offset;
  if (end === null) throw new ApiError(400, "TYPING_OFFSET_INVALID", "session has no end offset");
  if (req.offset !== end) throw new ApiError(409, "TYPING_LEVEL_INCOMPLETE", "The level must be completed exactly to its end offset");

  const bRow = row.book_id ? (db.prepare("SELECT * FROM typing_books WHERE id = ?").get(row.book_id) as BookRow | undefined) : undefined;
  if (!bRow) throw new ApiError(409, "TYPING_BOOK_UNAVAILABLE", "Book not found");

  const text = loadBookTextOrThrow(bRow, booksDir);
  const charsCorrect = countRequired(text, row.start_offset ?? 0, end);
  const metrics = computeMetrics({ mode: "books", activeMs: req.activeMs, charsTyped: req.charsTyped, errors: req.errors, charsCorrect, level: row.level_number, completed: true });
  const xp = typingXpForBooks(charsCorrect);
  const now = deps.now().toISOString();

  db.transaction(() => {
    db.prepare(
      "UPDATE typing_sessions SET status = 'completed', ended_at = ?, current_offset = ?, active_ms = ?, chars_typed = ?, errors = ?, chars_correct = ?, wpm = ?, cpm = ?, accuracy = ?, score = ?, metrics_version = ?, best_combo = ? WHERE id = ?",
    ).run(now, end, req.activeMs, req.charsTyped, req.errors, charsCorrect, metrics.wpm, metrics.cpm, metrics.accuracy, metrics.score, METRICS_VERSION, req.bestCombo ?? null, sessionId);
    awardTypingXp(db, { id: deps.newId(), sessionId, amount: xp, at: now });
    saveKeyStats(db, deps.newId, sessionId, req.keyStats ?? [], now);
    // the saved words that were in the passage just typed: one encounter per occurrence (re-completing adds nothing)
    const start = row.start_offset ?? 0;
    const putEncounter = db.prepare("INSERT OR IGNORE INTO typing_book_encounters(id, session_id, entry_id, text_offset, created_at) VALUES (?,?,?,?,?)");
    for (const f of bookEncounters(db, text.slice(start, end), start)) putEncounter.run(deps.newId(), sessionId, f.entryId, f.offset, now);
  }).immediate();

  return buildTypingResult(db, sessionRow(db, sessionId));
}

export function abortBook(db: Db, deps: BooksDeps, sessionId: string, req: { activeMs?: number; charsTyped?: number; errors?: number }): { ok: true } {
  const row = sessionRow(db, sessionId);
  if (row.mode !== "books") throw new ApiError(409, "TYPING_SESSION_WRONG_MODE", "Not a books session");
  if (row.status !== "active") return { ok: true };
  db.prepare("UPDATE typing_sessions SET status = 'interrupted', ended_at = ?, active_ms = ?, chars_typed = ?, errors = ? WHERE id = ?").run(
    deps.now().toISOString(),
    req.activeMs ?? row.active_ms,
    req.charsTyped ?? row.chars_typed,
    req.errors ?? row.errors,
    sessionId,
  );
  return { ok: true };
}
