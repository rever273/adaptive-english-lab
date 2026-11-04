import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase, type Db } from "../../../apps/server/src/db/open.js";
import { booksOverview, checkpointBook, completeBook, computeBookEnd, startBook } from "../../../apps/server/src/domain/typing/books.js";
import { addWord } from "../../../apps/server/src/domain/vocabulary/repository.js";
import { countRequired } from "../../../packages/contracts/src/typingText.js";
import { buildTypingResult } from "../../../apps/server/src/domain/typing/result.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

const deps = { now: () => new Date(), newId: randomUUID };

let scratch: ReturnType<typeof makeScratchRoot> | null = null;
let db: Db | null = null;
let booksDir = "";
afterEach(() => {
  db?.close();
  db = null;
  scratch?.cleanup();
  scratch = null;
});

async function setup(bookText = "It was a bright cold day in April.\n\nThe clocks were striking thirteen.\n\nWinston walked in."): Promise<Db> {
  scratch = makeScratchRoot();
  db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "test" });
  booksDir = path.join(scratch.root, "typing-books");
  mkdirSync(booksDir, { recursive: true });
  if (bookText) writeFileSync(path.join(booksDir, "1984.txt"), bookText, "utf8");
  return db;
}

describe("typing books domain", () => {
  it("tiles the book without losing text when a long paragraph is cut at a sentence boundary", () => {
    const para = "One two three four five. Six seven eight nine ten. Eleven twelve thirteen fourteen fifteen.";
    const text = para + "\n\n" + "Next paragraph here.";
    const total = countRequired(text, 0, text.length);
    let covered = 0;
    let start = 0;
    let guard = 0;
    while (start < text.length && guard++ < 50) {
      const end = computeBookEnd(text, start, 20);
      covered += countRequired(text, start, end);
      start = end;
    }
    expect(covered).toBe(total);
  });

  it("cuts a level at a sentence boundary, so a short level is short even inside one long paragraph", async () => {
    const sentence = "The clocks were striking thirteen today. ";
    const text = sentence.repeat(20).trim();
    const end = computeBookEnd(text, 0, 100);
    expect(end).toBeLessThan(text.length / 2);
    expect(text.slice(0, end).endsWith(".")).toBe(true);
    expect(countRequired(text, 0, end)).toBeGreaterThanOrEqual(100);
    expect(countRequired(text, 0, end)).toBeLessThan(100 + 45);
  });

  it("reports no_book when nothing is prepared", async () => {
    const d = await setup(null as unknown as string);
    const o = booksOverview(d, booksDir);
    expect(o.available).toBe(false);
    expect(o.reason).toBe("no_book");
  });

  it("starts a book level and checkpoints with accumulating counters", async () => {
    const d = await setup();
    // register the book metadata (id 1984) against the file
    const text = "It was a bright cold day in April.\n\nThe clocks were striking thirteen.\n\nWinston walked in.";
    const sha = requireSha(text);
    d.prepare("INSERT INTO typing_books(id, title, author, source, content_sha256, text_length, chapters_json, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("1984", "Nineteen Eighty-Four", "George Orwell", "test", sha, text.length, JSON.stringify([{ title: "Part One", startOffset: 0, endOffset: text.length }]), new Date().toISOString());

    const start = startBook(d, deps, booksDir);
    expect(start.bookId).toBe("1984");
    expect(start.sessionId).toBeTruthy();
    expect(start.startOffset).toBe(0);
    expect(start.endOffset).toBeGreaterThan(0);

    // a checkpoint stores counters and offset
    const mid = Math.min(start.endOffset, start.startOffset + 5);
    const cp = checkpointBook(d, start.sessionId, { offset: mid, activeMs: 10000, charsTyped: 20, errors: 1 });
    expect(cp.applied).toBe(true);

    // a stale checkpoint (smaller counters) is ignored without an error
    const stale = checkpointBook(d, start.sessionId, { offset: start.startOffset, activeMs: 1000, charsTyped: 5, errors: 0 });
    expect(stale.applied).toBe(false);
  });

  it("returns the same active session on a second start and never double-awards XP", async () => {
    const d = await setup();
    const text = "It was a bright cold day in April.\n\nThe clocks were striking thirteen.\n\nWinston walked in.";
    const sha = requireSha(text);
    d.prepare("INSERT INTO typing_books(id, title, author, source, content_sha256, text_length, chapters_json, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("1984", "Nineteen Eighty-Four", "George Orwell", "test", sha, text.length, JSON.stringify([{ title: "Part One", startOffset: 0, endOffset: text.length }]), new Date().toISOString());

    const a = startBook(d, deps, booksDir);
    const b = startBook(d, deps, booksDir);
    expect(b.sessionId).toBe(a.sessionId);

    const result = completeBook(d, deps, booksDir, a.sessionId, { offset: a.endOffset, activeMs: 30000, charsTyped: 100, errors: 2 });
    expect(result.status).toBe("completed");
    expect(result.xpAwarded).toBeGreaterThan(0);
    const xp = (d.prepare("SELECT COUNT(*) AS n FROM typing_xp_events WHERE session_id = ?").get(a.sessionId) as { n: number }).n;
    expect(xp).toBe(1);

    // idempotent complete returns the saved result
    const again = completeBook(d, deps, booksDir, a.sessionId, { offset: a.endOffset, activeMs: 30000, charsTyped: 100, errors: 2 });
    expect(again.sessionId).toBe(result.sessionId);
    const xp2 = (d.prepare("SELECT COUNT(*) AS n FROM typing_xp_events WHERE session_id = ?").get(a.sessionId) as { n: number }).n;
    expect(xp2).toBe(1);
  });

  it("records one encounter per occurrence of a saved word when a level is completed, and none twice", async () => {
    const d = await setup();
    const text = "The clocks were striking. A clock struck once, and the clocks again.";
    d.prepare("INSERT INTO typing_books(id, title, author, source, content_sha256, text_length, chapters_json, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("enc-book", "Nineteen Eighty-Four", "George Orwell", "test", requireSha(text), text.length, JSON.stringify([{ title: "Part One", startOffset: 0, endOffset: text.length }]), new Date().toISOString());
    writeFileSync(path.join(booksDir, "enc-book.txt"), text, "utf8");
    const saved = addWord(d, { now: () => new Date(), newId: randomUUID }, { word: "clock" });
    const a = startBook(d, deps, booksDir);
    completeBook(d, deps, booksDir, a.sessionId, { offset: a.endOffset, activeMs: 30000, charsTyped: 100, errors: 0 });
    const rows = d.prepare("SELECT text_offset AS o FROM typing_book_encounters WHERE entry_id = ? ORDER BY text_offset").all(saved.entry.id) as Array<{ o: number }>;
    expect(rows.map((r) => r.o)).toEqual([4, 28, 55]); // "clocks", "clock", "clocks"
    completeBook(d, deps, booksDir, a.sessionId, { offset: a.endOffset, activeMs: 30000, charsTyped: 100, errors: 0 });
    expect((d.prepare("SELECT COUNT(*) AS n FROM typing_book_encounters").get() as { n: number }).n).toBe(3);
    expect(() => d.prepare("DELETE FROM typing_book_encounters").run()).toThrow(/append-only/);
  });

  it("refuses to complete before reaching the end offset", async () => {
    const d = await setup();
    const text = "It was a bright cold day in April.\n\nThe clocks were striking thirteen.\n\nWinston walked in.";
    const sha = requireSha(text);
    d.prepare("INSERT INTO typing_books(id, title, author, source, content_sha256, text_length, chapters_json, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("1984", "Nineteen Eighty-Four", "George Orwell", "test", sha, text.length, JSON.stringify([{ title: "Part One", startOffset: 0, endOffset: text.length }]), new Date().toISOString());
    const a = startBook(d, deps, booksDir);
    expect(() => completeBook(d, deps, booksDir, a.sessionId, { offset: a.startOffset, activeMs: 1000, charsTyped: 5, errors: 0 })).toThrow(/must be completed exactly/);
  });

  it("reports file_changed when the file no longer matches the stored hash", async () => {
    const d = await setup();
    const text = "It was a bright cold day in April.";
    d.prepare("INSERT INTO typing_books(id, title, author, source, content_sha256, text_length, chapters_json, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("1984", "Nineteen Eighty-Four", "George Orwell", "test", "not-the-real-hash", text.length, JSON.stringify([]), new Date().toISOString());
    const o = booksOverview(d, booksDir);
    expect(o.available).toBe(false);
    expect(o.reason).toBe("file_changed");
  });
});

function requireSha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
