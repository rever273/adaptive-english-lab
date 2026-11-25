import { afterEach, describe, expect, it } from "vitest";
import type { VtCheckCard, VtLearnCard } from "@english-lab/contracts";
import { flagCard, recordCheck, recordLearn, startLearning } from "../../../apps/server/src/domain/vocabTyping/learning.js";
import { buildOverview, listWords } from "../../../apps/server/src/domain/vocabTyping/overview.js";
import { buildAnalytics } from "../../../apps/server/src/domain/vocabTyping/analytics.js";
import { completeSession, recordScreening, startScreening } from "../../../apps/server/src/domain/vocabTyping/sessions.js";
import { emptyLearningState, sessionState } from "../../../apps/server/src/domain/vocabTyping/view.js";
import { loadFacts } from "../../../apps/server/src/domain/vocabTyping/data.js";
import { summarise } from "../../../apps/server/src/domain/vocabTyping/state.js";
import { makeDeps, seedPool, seedSentences, setup, typing, uuid, type Env } from "./fixtures.js";

let env: Env | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

const xp = (db: Env["db"]): number => (db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM mode_xp_events WHERE source = 'vocabTyping'").get() as { n: number }).n;

/** screens the first `n` planned words as unknown (plan order does not matter here) and returns them */
function screenUnknown(db: Env["db"], deps: ReturnType<typeof makeDeps>, n: number): string[] {
  const { sessionId } = startScreening(db, deps, "t");
  const plan = (JSON.parse((db.prepare("SELECT plan_json AS p FROM vocab_typing_sessions WHERE id = ?").get(sessionId) as { p: string }).p) as { words: Array<{ lemma: string }> }).words;
  const lemmas = plan.slice(0, n).map((w) => w.lemma);
  for (const lemma of lemmas) recordScreening(db, deps, sessionId, { clientEventId: uuid(), tabId: "t", lemma, kind: "screen_unknown", typing });
  completeSession(db, deps, sessionId, "t");
  return lemmas;
}

async function prepared(words = 60): Promise<{ db: Env["db"]; deps: ReturnType<typeof makeDeps>; lemmas: string[] }> {
  env = await setup();
  const { db } = env;
  const { lemmas } = seedPool(db, words);
  seedSentences(db, lemmas, 5);
  return { db, deps: makeDeps("2026-11-24T10:00:00.000Z"), lemmas };
}

const learnCard = (db: Env["db"], id: string): VtLearnCard => sessionState(db, id).card as VtLearnCard;
const learnIt = (db: Env["db"], deps: ReturnType<typeof makeDeps>, id: string, kind: "learn_learned" | "learn_exposure", clientEventId = uuid()): VtLearnCard => {
  const card = learnCard(db, id);
  recordLearn(db, deps, id, { clientEventId, tabId: "t", cardIndex: card.cardIndex, kind, typing });
  return card;
};

describe("Vocabulary Typing learning", () => {
  it("has nothing to start before any word was screened as unknown", async () => {
    const { db, deps } = await prepared(30);
    expect(startLearning(db, deps, "t")).toBeNull();
    expect(emptyLearningState(db, deps).empty).toEqual({ reason: "nothing_to_learn", nextDue: null });
    expect(buildOverview(db, deps).learning).toMatchObject({ learning: 0, dueNow: 0, playable: 0 });
  });

  it("teaches new words in real sentences; Tab only awaits verification, Enter brings the word back in another sentence", async () => {
    const { db, deps } = await prepared();
    const lemmas = screenUnknown(db, deps, 8);
    const xpBefore = xp(db);
    const s = startLearning(db, deps, "t")!;
    expect(s.resumed).toBe(false);
    const first = learnCard(db, s.sessionId);
    expect(first).toMatchObject({ kind: "learn", show: 1, maxShows: 4 });
    expect(lemmas).toContain(first.word.lemma);
    expect(first.sentence.text.slice(first.sentence.targetStart, first.sentence.targetStart + first.sentence.targetLength).toLowerCase()).toBe(first.word.lemma);
    expect(first.sentence.textRu.length).toBeGreaterThan(0);
    // Enter = still learning: the word returns after three other cards, in another sentence
    learnIt(db, deps, s.sessionId, "learn_exposure");
    const seen: Array<{ lemma: string; sentence: string }> = [{ lemma: first.word.lemma, sentence: first.sentence.id }];
    for (let i = 0; i < 4; i++) {
      const c = learnIt(db, deps, s.sessionId, "learn_learned");
      seen.push({ lemma: c.word.lemma, sentence: c.sentence.id });
    }
    const back = seen.findIndex((x, i) => i > 0 && x.lemma === first.word.lemma);
    expect(back).toBeGreaterThanOrEqual(4);
    expect(seen[back]!.sentence).not.toBe(first.sentence.id);
    // XP: 2 per typed sentence
    expect(xp(db) - xpBefore).toBe(2 * 5);
    // a self-assessment never makes a word verified
    const o = buildOverview(db, deps);
    expect(o.learning.verified).toBe(0);
    expect(o.learning.awaiting).toBe(4);
  });

  it("is idempotent by client id and refuses a card that is not the current one", async () => {
    const { db, deps } = await prepared();
    screenUnknown(db, deps, 5);
    const { sessionId } = startLearning(db, deps, "t")!;
    const card = learnCard(db, sessionId);
    const id = uuid();
    const input = { clientEventId: id, tabId: "t", cardIndex: card.cardIndex, kind: "learn_learned" as const, typing };
    recordLearn(db, deps, sessionId, input);
    const events = () => (db.prepare("SELECT COUNT(*) AS n FROM vocab_typing_events WHERE stage = 'learning'").get() as { n: number }).n;
    const paid = xp(db);
    recordLearn(db, deps, sessionId, input);
    expect(events()).toBe(1);
    expect(xp(db)).toBe(paid);
    expect(() => recordLearn(db, deps, sessionId, { ...input, kind: "learn_exposure" })).toThrow(/already used/);
    expect(() => recordLearn(db, deps, sessionId, { ...input, clientEventId: uuid(), cardIndex: 0 })).toThrow(/not the current card/);
    expect(() => recordLearn(db, deps, sessionId, { ...input, clientEventId: uuid(), cardIndex: 7 })).toThrow(/not the current card/);
    expect(() => recordLearn(db, deps, sessionId, { ...input, clientEventId: uuid(), tabId: "other", cardIndex: 1 })).toThrow(/another tab/);
    expect(() => recordCheck(db, deps, sessionId, { clientEventId: uuid(), tabId: "t", cardIndex: 1, text: "x" })).toThrow(/not a check/);
  });

  it("checks a self-assessed word the next learning day, hides the answer until it is sent, and rates it by code", async () => {
    const { db, deps } = await prepared();
    const lemmas = screenUnknown(db, deps, 3);
    const s1 = startLearning(db, deps, "t")!;
    for (let i = 0; i < 3; i++) learnIt(db, deps, s1.sessionId, "learn_learned");
    expect(sessionState(db, s1.sessionId).finished).toBe(true);
    completeSession(db, deps, s1.sessionId, "t");
    // the same day: not due, nothing to learn either
    expect(startLearning(db, deps, "t")).toBeNull();
    expect(emptyLearningState(db, deps).empty).toMatchObject({ reason: "all_done", nextDue: "2026-11-25" });
    // the next learning day: three checks
    deps.advance(24 * 3600_000);
    expect(buildOverview(db, deps).learning).toMatchObject({ dueNow: 3, awaiting: 3 });
    const s2 = startLearning(db, deps, "t")!;
    const st = sessionState(db, s2.sessionId);
    const card = st.card as VtCheckCard;
    expect(card.kind).toBe("check");
    // nothing that gives the answer leaves the server before the answer
    const wire = JSON.stringify(st);
    for (const lemma of lemmas) expect(wire).not.toContain(lemma);
    expect(wire).not.toContain("слово");
    expect(card.gapped).toContain("____");
    expect(Object.keys(card).sort()).toEqual(["cardIndex", "gapped", "kind", "pos", "textRu"]);
    // wrong answer: again, the word goes back to learning, the answer is shown afterwards
    recordCheck(db, deps, s2.sessionId, { clientEventId: uuid(), tabId: "t", cardIndex: card.cardIndex, text: "nonsense" });
    let after = sessionState(db, s2.sessionId);
    expect(after.lastCheck).toMatchObject({ outcome: "incorrect", rating: "again" });
    const failed = after.lastCheck!.lemma;
    expect(after.lastCheck!.expected.toLowerCase()).toBe(failed);
    expect(db.prepare("SELECT outcome, rating, algorithm_version AS v FROM vocab_typing_reviews").all()).toEqual([{ outcome: "incorrect", rating: "again", v: "vt-fsrs-v1" }]);
    expect(summarise(loadFacts(db).get(failed)!).state).toBe("learning");
    // typo: good, 3 XP; exact: good, 5 XP; each only once
    const second = after.card as VtCheckCard;
    const plan = (JSON.parse((db.prepare("SELECT plan_json AS p FROM vocab_typing_sessions WHERE id = ?").get(s2.sessionId) as { p: string }).p) as { words: Array<{ lemma: string }> }).words;
    const target = plan[second.cardIndex]!.lemma; // the checks follow the plan order
    expect(target).not.toBe(failed);
    const before = xp(db);
    const expected = (db.prepare("SELECT t.surface AS s FROM vocab_typing_sentence_targets t WHERE t.lemma = ? LIMIT 1").get(target) as { s: string }).s;
    const answer = uuid();
    recordCheck(db, deps, s2.sessionId, { clientEventId: answer, tabId: "t", cardIndex: second.cardIndex, text: expected.toUpperCase() });
    after = sessionState(db, s2.sessionId);
    expect(after.lastCheck).toMatchObject({ outcome: "correct", rating: "good" });
    expect(xp(db) - before).toBe(5);
    recordCheck(db, deps, s2.sessionId, { clientEventId: answer, tabId: "t", cardIndex: second.cardIndex, text: expected.toUpperCase() });
    expect(xp(db) - before).toBe(5);
    expect((db.prepare("SELECT COUNT(*) AS n FROM vocab_typing_reviews").get() as { n: number }).n).toBe(2);
    expect(summarise(loadFacts(db).get(after.lastCheck!.lemma)!).state).toBe("verified");
    // the failed word is not checked twice in the session; it comes back as a learning card
    const rest: string[] = [];
    for (let c = sessionState(db, s2.sessionId).card; c; c = sessionState(db, s2.sessionId).card) {
      rest.push(c.kind);
      if (c.kind === "check") recordCheck(db, deps, s2.sessionId, { clientEventId: uuid(), tabId: "t", cardIndex: c.cardIndex, text: null });
      else recordLearn(db, deps, s2.sessionId, { clientEventId: uuid(), tabId: "t", cardIndex: c.cardIndex, kind: "learn_learned", typing });
    }
    expect(rest).toContain("learn");
    expect(db.prepare("SELECT COUNT(*) AS n FROM vocab_typing_reviews WHERE lemma = ?").get(failed)).toEqual({ n: 1 });
    expect(db.prepare("SELECT outcome FROM vocab_typing_reviews WHERE outcome = 'revealed'").all().length).toBe(1);
    // analytics can read it all
    const a = buildAnalytics(db, deps, 30);
    expect(a.learning.checksPassed + a.learning.checksFailed).toBe(3);
    expect(a.knownNow.verified).toBe(1);
    expect(a.attribution).toContain("Tatoeba");
  });

  it("'Bad example' hides the pair for the word, consumes a check without a rating and replaces a learning card", async () => {
    const { db, deps } = await prepared();
    screenUnknown(db, deps, 4);
    const s1 = startLearning(db, deps, "t")!;
    const c1 = learnCard(db, s1.sessionId);
    const flagId = uuid();
    flagCard(db, deps, s1.sessionId, { clientEventId: flagId, tabId: "t", cardIndex: c1.cardIndex });
    flagCard(db, deps, s1.sessionId, { clientEventId: flagId, tabId: "t", cardIndex: c1.cardIndex }); // a retry flags nothing more
    const c2 = learnCard(db, s1.sessionId);
    expect(c2.cardIndex).toBe(c1.cardIndex);
    expect(c2.word.lemma === c1.word.lemma ? c2.sentence.id !== c1.sentence.id : true).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM vocab_typing_sentence_status WHERE actor = 'learner'").get()).toEqual({ n: 1 });
    expect((db.prepare("SELECT COUNT(*) AS n FROM vocab_typing_events WHERE stage = 'learning'").get() as { n: number }).n).toBe(0);
    for (let i = 0; i < 4; i++) learnIt(db, deps, s1.sessionId, "learn_learned");
    completeSession(db, deps, s1.sessionId, "t");
    deps.advance(24 * 3600_000);
    const s2 = startLearning(db, deps, "t")!;
    const check = sessionState(db, s2.sessionId).card as VtCheckCard;
    flagCard(db, deps, s2.sessionId, { clientEventId: uuid(), tabId: "t", cardIndex: check.cardIndex });
    expect(db.prepare("SELECT outcome, rating FROM vocab_typing_reviews").all()).toEqual([{ outcome: "skipped", rating: null }]);
    expect(xp(db)).toBe(4 + 2 * 4); // 4 screening words and 4 typed sentences; the skipped check earns nothing
    // the skipped check changes nothing about the word: still awaiting, and it can be checked another time
    const rows = listWords(db, { filter: "awaiting_verification", limit: 20, offset: 0 });
    expect(rows.total).toBe(4);
  });

  it("lists words without a usable sentence as 'No examples' and keeps them out of the plan", async () => {
    env = await setup();
    const { db } = env;
    const deps = makeDeps("2026-11-24T10:00:00.000Z");
    const { lemmas } = seedPool(db, 40);
    seedSentences(db, lemmas.slice(0, 20), 3); // the other twenty have none
    const planned = screenUnknown(db, deps, 12);
    const noEx = listWords(db, { filter: "no_examples", limit: 50, offset: 0 });
    expect(noEx.total).toBe(planned.filter((l) => lemmas.indexOf(l) >= 20).length);
    expect(buildOverview(db, deps).learning.noExamples).toBe(noEx.total);
    const s = startLearning(db, deps, "t");
    if (planned.some((l) => lemmas.indexOf(l) < 20)) {
      const plan = (JSON.parse((db.prepare("SELECT plan_json AS p FROM vocab_typing_sessions WHERE id = ?").get(s!.sessionId) as { p: string }).p) as { words: Array<{ lemma: string }> }).words;
      expect(plan.every((w) => lemmas.indexOf(w.lemma) < 20)).toBe(true);
    }
  });
});
