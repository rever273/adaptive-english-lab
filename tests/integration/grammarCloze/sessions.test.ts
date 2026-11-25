import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase, type Db } from "../../../apps/server/src/db/open.js";
import { importCleaned, type CleanedItem } from "../../../apps/server/src/domain/grammarCloze/importer.js";
import { completeSession, excludeItem, markShown, overview, sessionView, startSession, submitAnswer, summary, stageView } from "../../../apps/server/src/domain/grammarCloze/repository.js";
import { recordClozeActivity } from "../../../apps/server/src/domain/grammarCloze/activity.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

const deps = { now: () => new Date(), newId: randomUUID };
const SKILLS = ["tenses.past_simple", "tenses.present_simple", "articles.definite", "articles.indefinite", "modals.advice", "conditionals.first", "passive.past", "relatives.relative_pronouns", "comparisons.comparatives", "pronouns.reflexives"];

/** 10 rules x 6 sentences + 6 General Grammar ones = 66, in 2-4 options */
function bank(): CleanedItem[] {
  const items: CleanedItem[] = [];
  let n = 0;
  const add = (skillId: string | null, topic: string, k: number): void => {
    n++;
    const d = ["b", "c", "d"].slice(0, k - 1);
    items.push({ sourceIndex: n, gappedText: `Sentence ${n} has a ___ here.`, solution: "a", distractors: d, filledText: `Sentence ${n} has a a here.`, sourceTopic: topic, skillId, skillConfidence: skillId ? "exact" : "general", status: "validated", flagReasons: [], contentHash: `h${n}` });
  };
  for (const s of SKILLS) for (let i = 0; i < 6; i++) add(s, s.split(".")[0]!, 2 + (i % 3));
  for (let i = 0; i < 6; i++) add(null, "prepositions", 3);
  return items;
}

let db: Db;
let cleanup: () => void;
beforeEach(async () => {
  const scratch = makeScratchRoot();
  db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  cleanup = () => { db.close(); scratch.cleanup(); };
  await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "test" });
  importCleaned(db, { source: "zanichelli", sourceSha256: "s", cleanVersion: "c", classifierVersion: "k", configSha256: "x", items: bank() }, { apply: true });
});
afterEach(() => cleanup());

const answer = (sessionId: string, position: number, right: boolean) => {
  const slot = sessionView(db, sessionId).slots.find((s) => s.position === position)!;
  const chosen = right ? "a" : slot.options.find((o) => o !== "a")!;
  return submitAnswer(db, deps, sessionId, { id: randomUUID(), position, chosen, responseMs: 1500 });
};

describe("sessions", () => {
  it("opens L01 with 15 sentences around one theme and reopens the same session after a reload", () => {
    const first = startSession(db, deps, "tab-1");
    expect(first.resumed).toBe(false);
    const v = sessionView(db, first.sessionId);
    expect(v.levelNo).toBe(1);
    expect(v.slots).toHaveLength(15);
    expect(v.slots.every((s) => s.state === "pending" && s.correct === undefined)).toBe(true); // the key is not sent
    expect(v.plan?.focusName).toBeTruthy();
    // several rules, never three of one rule in a row
    expect(new Set(v.slots.map((s) => s.ruleName)).size).toBeGreaterThanOrEqual(5);
    for (let i = 2; i < v.slots.length; i++) expect(v.slots[i]!.ruleName === v.slots[i - 1]!.ruleName && v.slots[i]!.ruleName === v.slots[i - 2]!.ruleName).toBe(false);
    const again = startSession(db, deps, "tab-2");
    expect(again).toEqual({ sessionId: first.sessionId, resumed: true });
    expect(sessionView(db, first.sessionId).slots.map((s) => s.options)).toEqual(v.slots.map((s) => s.options)); // same order of options
    const shown = () => db.prepare("SELECT first_shown_at AS t FROM grammar_cloze_session_items WHERE session_id=? AND position=1").get(first.sessionId) as { t: string | null };
    markShown(db, deps, first.sessionId, 1);
    const t1 = shown().t;
    expect(t1).not.toBeNull();
    markShown(db, deps, first.sessionId, 1);
    expect(shown().t).toBe(t1);
  });

  it("locks the first choice, is idempotent per answer id, and refuses a second answer", () => {
    const { sessionId } = startSession(db, deps, "t");
    const slot = sessionView(db, sessionId).slots[0]!;
    const wrong = slot.options.find((o) => o !== "a")!;
    const id = randomUUID();
    const r1 = submitAnswer(db, deps, sessionId, { id, position: 1, chosen: wrong });
    expect(r1).toEqual({ correct: false, correctText: "a", chosenText: wrong });
    expect(submitAnswer(db, deps, sessionId, { id, position: 1, chosen: wrong })).toEqual(r1); // double click
    expect(() => submitAnswer(db, deps, sessionId, { id, position: 1, chosen: "a" })).toThrow(/already used/);
    let err: unknown;
    try { submitAnswer(db, deps, sessionId, { id: randomUUID(), position: 1, chosen: "a" }); } catch (e) { err = e; }
    expect(err).toMatchObject({ code: "ALREADY_ANSWERED", details: { correct: false } });
    expect(() => submitAnswer(db, deps, sessionId, { id: randomUUID(), position: 2, chosen: "zzz" })).toThrow(/options/);
    expect((db.prepare("SELECT COUNT(*) AS n FROM grammar_cloze_attempts").get() as { n: number }).n).toBe(1);
    const after = sessionView(db, sessionId).slots[0]!;
    expect(after).toMatchObject({ state: "incorrect", chosen: wrong, correct: "a" });
  });

  it("never offers an answered sentence again, wrong answers fill stage 2, and the stage numbers stay consistent", () => {
    const seen = new Set<string>();
    let wrongCount = 0;
    for (let level = 1; level <= 3; level++) {
      const { sessionId } = startSession(db, deps, "t");
      const v = sessionView(db, sessionId);
      for (const s of v.slots) { expect(seen.has(s.itemId)).toBe(false); seen.add(s.itemId); }
      for (const s of v.slots) { const right = s.position % 3 !== 0; if (!right) wrongCount++; answer(sessionId, s.position, right); }
      const done = completeSession(db, deps, sessionId);
      expect(done.levelNo).toBe(level);
      expect(done.answered).toBe(v.slots.length);
    }
    const s1 = stageView(db, 1), s2 = stageView(db, 2);
    expect(s1).toMatchObject({ total: 66, processed: 45, status: "in_progress", percent: "68.18" });
    expect(s2).toMatchObject({ total: wrongCount, carriedToNext: 0, status: "locked", ready: false });
    expect(s1.carriedToNext).toBe(wrongCount);
    expect(s1.rulesTouched).toBeLessThanOrEqual(s1.rulesPresent);
    expect(overview(db).nextLevelNo).toBe(4);
  });

  it("plays the remainder when fewer than a full session is left, then reports the stage as done", () => {
    for (;;) {
      let id: string;
      try { id = startSession(db, deps, "t").sessionId; } catch (e) { expect(e).toMatchObject({ code: "STAGE_DONE" }); break; }
      for (const s of sessionView(db, id).slots) answer(id, s.position, true);
      completeSession(db, deps, id);
    }
    expect((db.prepare("SELECT planned_count AS n FROM grammar_cloze_sessions ORDER BY level_no DESC LIMIT 1").get() as { n: number }).n).toBe(66 - 60); // 15+15+15+15+6
    expect(stageView(db, 1)).toMatchObject({ total: 66, processed: 66, percent: "100.00", status: "done", ready: false });
  });

  it("refuses to complete a session with open sentences, and completing twice changes nothing", () => {
    const { sessionId } = startSession(db, deps, "t");
    expect(() => completeSession(db, deps, sessionId)).toThrow(/every sentence/);
    for (const s of sessionView(db, sessionId).slots) answer(sessionId, s.position, true);
    const a = completeSession(db, deps, sessionId);
    expect(completeSession(db, deps, sessionId)).toEqual(a);
    expect(() => answer(sessionId, 1, true)).toThrow();
    expect(summary(db, sessionId)).toMatchObject({ correct: 15, incorrect: 0, accuracy: 1 });
  });
});

describe("exclusion", () => {
  it("before an answer: leaves the total, is neither right nor wrong, and the session can finish without it", () => {
    const { sessionId } = startSession(db, deps, "t");
    const v = sessionView(db, sessionId);
    excludeItem(db, deps, v.slots[0]!.itemId, { sessionId, reason: "unnatural" });
    expect(excludeItem(db, deps, v.slots[0]!.itemId, { sessionId })).toEqual({ excluded: true }); // repeat is harmless
    expect(() => answer(sessionId, 1, true)).toThrow(/excluded/);
    for (const s of v.slots.slice(1)) answer(sessionId, s.position, true);
    const done = completeSession(db, deps, sessionId);
    expect(done).toMatchObject({ answered: 14, excluded: 1, correct: 14 });
    expect(stageView(db, 1)).toMatchObject({ total: 65, processed: 14, excluded: 1 });
  });

  it("after a wrong answer: the answer stays in the history but the sentence does not move to stage 2", () => {
    const { sessionId } = startSession(db, deps, "t");
    const v = sessionView(db, sessionId);
    answer(sessionId, 1, false);
    expect(stageView(db, 1).carriedToNext).toBe(1);
    excludeItem(db, deps, v.slots[0]!.itemId, { sessionId });
    expect(stageView(db, 1)).toMatchObject({ carriedToNext: 0, total: 66, processed: 1 });
    expect(stageView(db, 2).total).toBe(0);
    expect(sessionView(db, sessionId).slots[0]!.state).toBe("incorrect");
    expect((db.prepare("SELECT answered_before AS a FROM grammar_cloze_exclusions").get() as { a: number }).a).toBe(1);
    // an excluded sentence is never planned again, even by a later import
    importCleaned(db, { source: "zanichelli", sourceSha256: "s2", cleanVersion: "c", classifierVersion: "k", configSha256: "x", items: bank().map((i) => ({ ...i, contentHash: i.contentHash + "x" })) }, { apply: true });
    expect(db.prepare("SELECT 1 FROM grammar_cloze_exclusions WHERE item_id=?").get(v.slots[0]!.itemId)).toBeTruthy();
  });
});

describe("time", () => {
  it("records visible intervals once and refuses overlap with practice time (and the other way round)", () => {
    const { sessionId } = startSession(db, { ...deps, now: () => new Date(Date.now() - 60000) }, "tab"); // started a minute ago
    const iv = (offset: number) => ({ id: randomUUID(), tabId: "tab", startMs: Date.now() - 30000 + offset, endMs: Date.now() - 25000 + offset });
    const a = { id: randomUUID(), tabId: "tab", startMs: Date.now() - 6000, endMs: Date.now() - 1000 };
    expect(recordClozeActivity(db, deps, sessionId, a)).toEqual({ recorded: true });
    expect(recordClozeActivity(db, deps, sessionId, a)).toEqual({ recorded: false });
    expect(() => recordClozeActivity(db, deps, sessionId, { ...a, endMs: a.endMs - 1 })).toThrow(/already used/);
    expect(() => recordClozeActivity(db, deps, sessionId, { ...a, id: randomUUID(), startMs: a.startMs + 1000 })).toThrow(/overlaps/);
    expect(() => recordClozeActivity(db, deps, sessionId, { ...iv(0), tabId: "other" })).toThrow(/not the one/);
    expect(() => recordClozeActivity(db, deps, sessionId, { ...a, id: randomUUID(), startMs: a.endMs, endMs: a.endMs + 16000 })).toThrow(/Invalid/);
    expect(summary(db, sessionId).activeMs).toBe(5000);
  });
});
