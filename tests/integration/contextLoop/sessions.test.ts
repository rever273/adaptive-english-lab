import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { insertSentence } from "../../../apps/server/src/domain/contextLoop/sentences.js";
import { answerCard, completeSession, contextLoopStatus, recordActivity, sessionState, startSession } from "../../../apps/server/src/domain/contextLoop/sessions.js";
import { checkDraft, targetOf } from "../../../apps/server/src/domain/contextLoop/validate.js";
import { contextLoopEvents } from "../../../apps/server/src/domain/contextLoop/plan.js";
import { senseOf } from "../../../apps/server/src/domain/wordLessons/generate.js";
import { eligibleWords } from "../../../apps/server/src/domain/wordLessons/selection.js";
import { getEntry, patchWord } from "../../../apps/server/src/domain/vocabulary/repository.js";
import { deps, saveWord, setup, type Env } from "../wordLessons/fixtures.js";

let env: Env | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

const SENTENCES: Record<string, string[]> = {
  overlook: ["Please do not overlook the small print.", "It is easy to overlook quiet colleagues.", "Never overlook a polite email."],
  scarce: ["Water is scarce in the desert in summer.", "Good builders are scarce this year.", "Fresh bread was scarce after the storm."],
  vivid: ["She has vivid memories of that trip.", "The poster uses vivid colours.", "He told a vivid story about the war."],
};

function seed(db: Env["db"], word: string, translation: string, n = 3): string {
  const id = saveWord(db, word, translation);
  const w = eligibleWords(db).eligible.find((x) => x.entryId === id)!;
  const t = targetOf(id, w.lemma, senseOf(db, w));
  for (const text of SENTENCES[word]!.slice(0, n)) {
    const r = checkDraft({ text, target_surface: word, context_label: "life", difficulty: "easy" }, t);
    if (!r.ok) throw new Error(r.message);
    db.transaction(() => insertSentence(db, deps, { target: t, checked: r.sentence, source: "model", status: "validated", actor: "model" }))();
  }
  return id;
}

const xp = (db: Env["db"]) => (db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM mode_xp_events WHERE source = 'contextLoop'").get() as { n: number }).n;

describe("Context Loop sessions", () => {
  it("refuses to start without sentences, and leaves out learned words, words with one sentence and hidden or stale sentences", async () => {
    env = await setup();
    const { db } = env;
    expect(() => startSession(db, deps, "tab")).toThrow(/Content Studio/);
    const overlook = seed(db, "overlook", "упустить");
    const scarce = seed(db, "scarce", "дефицитный", 1);
    const vivid = seed(db, "vivid", "яркий");
    patchWord(db, deps, vivid, { learned: true });
    expect(contextLoopStatus(db)).toMatchObject({ playableWords: 1, activeSessionId: null });
    const s = startSession(db, deps, "tab");
    expect(sessionState(db, s.sessionId).progress.wordsTotal).toBe(1);
    completeSession(db, deps, s.sessionId);
    // a translation change makes the sentences stale; hiding one leaves too few
    const o = getEntry(db, overlook);
    patchWord(db, deps, o.id, { expectedRevision: o.userRevision, translationRu: "смотреть сверху" });
    expect(() => startSession(db, deps, "tab")).toThrow(/Content Studio/);
    expect(scarce).toBeTruthy();
  });

  it("resumes the open session in a new tab, keeps answers idempotent, checks the current card and the tab, and pays XP by D158", async () => {
    env = await setup();
    const { db } = env;
    seed(db, "overlook", "упустить");
    seed(db, "scarce", "дефицитный");
    const s = startSession(db, deps, "tab1");
    expect(s.resumed).toBe(false);
    const st = sessionState(db, s.sessionId);
    expect(st.card).toMatchObject({ cardIndex: 0, encounter: 1, sameSentenceAgain: false });
    expect(st.card!.sentence.text.slice(st.card!.sentence.targetStart, st.card!.sentence.targetStart + st.card!.sentence.targetLength).toLowerCase()).toBe(st.card!.lemma);
    expect(startSession(db, deps, "tab2")).toEqual({ sessionId: s.sessionId, resumed: true });
    const a = { id: randomUUID(), tabId: "tab1", cardIndex: 0, outcome: "not_recalled" as const, aids: {} };
    expect(() => answerCard(db, deps, s.sessionId, a)).toThrow(/another tab/);
    answerCard(db, deps, s.sessionId, { ...a, tabId: "tab2" });
    answerCard(db, deps, s.sessionId, { ...a, tabId: "tab2" }); // the same answer again changes nothing
    expect(() => answerCard(db, deps, s.sessionId, { ...a, tabId: "tab2", outcome: "recalled" })).toThrow(/already used/);
    expect(() => answerCard(db, deps, s.sessionId, { id: randomUUID(), tabId: "tab2", cardIndex: 5, outcome: "recalled", aids: {} })).toThrow(/current card/);
    expect(xp(db)).toBe(0);
    const c1 = sessionState(db, s.sessionId).card!;
    answerCard(db, deps, s.sessionId, { id: randomUUID(), tabId: "tab2", cardIndex: c1.cardIndex, outcome: "recalled", aids: { sentenceAudio: true } });
    expect(xp(db)).toBe(2);
    // play to the end: every card recalled
    for (let i = 0; i < 30; i++) {
      const c = sessionState(db, s.sessionId).card;
      if (!c) break;
      answerCard(db, deps, s.sessionId, { id: randomUUID(), tabId: "tab2", cardIndex: c.cardIndex, outcome: "recalled", aids: {} });
    }
    const end = sessionState(db, s.sessionId);
    expect(end.finished).toBe(true);
    expect(end.summary).toMatchObject({ words: 2, firstTry: 1, needsWork: [] });
    completeSession(db, deps, s.sessionId);
    expect(sessionState(db, s.sessionId).status).toBe("completed");
    // the next session's scheduling sees one first-encounter event per word: a miss for the first word, a success for the second
    const ev = contextLoopEvents(db);
    expect([...ev.values()].map((e) => e.map((x) => x.outcome)).sort()).toEqual([["miss"], ["success"]]);
  });

  it("records visible time once and never over another mode's interval", async () => {
    env = await setup();
    const { db } = env;
    seed(db, "overlook", "упустить");
    seed(db, "scarce", "дефицитный");
    const s = startSession(db, deps, "tab");
    const t = Date.now();
    const iv = { id: randomUUID(), tabId: "tab", startMs: t + 100, endMs: t + 1000 };
    expect(recordActivity(db, deps, s.sessionId, iv)).toEqual({ recorded: true });
    expect(recordActivity(db, deps, s.sessionId, iv)).toEqual({ recorded: false });
    expect(() => recordActivity(db, deps, s.sessionId, { ...iv, id: randomUUID(), startMs: t + 500, endMs: t + 1200 })).toThrow(/overlaps/);
    db.prepare("INSERT INTO journey_typing_intervals VALUES (?,?,?,?,?,?)").run("j1", "typing-session", "words", t + 1300, t + 1500, "x");
    expect(() => recordActivity(db, deps, s.sessionId, { ...iv, id: randomUUID(), startMs: t + 1200, endMs: t + 1400 })).toThrow(/overlaps/);
    expect(() => recordActivity(db, deps, s.sessionId, { ...iv, id: randomUUID(), tabId: "other", startMs: t + 1600, endMs: t + 1700 })).toThrow(/another tab/);
  });
});
