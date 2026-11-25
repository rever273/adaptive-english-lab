import { describe, expect, it } from "vitest";
import { CONTEXT_LOOP_QUEUE_VERSION, QUEUE_DEFAULTS, nextCard, summarise, type CardOutcome, type QueueAttempt, type SessionPlan } from "../../../apps/server/src/domain/contextLoop/queue.js";

const params = { missGap: QUEUE_DEFAULTS.missGap, verifyGap: QUEUE_DEFAULTS.verifyGap, sameSentenceMisses: QUEUE_DEFAULTS.sameSentenceMisses, maxEncounters: QUEUE_DEFAULTS.maxEncounters, maxCards: 40 };
function plan(n: number, o: { sentences?: number; wasReview?: boolean; seen?: boolean; maxCards?: number } = {}): SessionPlan {
  return {
    version: CONTEXT_LOOP_QUEUE_VERSION,
    params: { ...params, maxCards: o.maxCards ?? params.maxCards },
    words: Array.from({ length: n }, (_, i) => ({ entryId: `w${i}`, lemma: `word${i}`, wasReview: o.wasReview ?? false, sentences: Array.from({ length: o.sentences ?? 3 }, (_, j) => ({ id: `w${i}s${j}`, seen: o.seen ?? false })), meaning: { translationRu: "", definitionRu: "", pos: "" } })),
  };
}

/** plays a session: `answer(word, encounter)` decides each outcome; returns the cards in order */
function play(p: SessionPlan, answer: (entryId: string, encounter: number) => CardOutcome) {
  const attempts: QueueAttempt[] = [];
  const cards: Array<{ entryId: string; sentenceId: string; encounter: number; same: boolean; newContext: boolean }> = [];
  for (;;) {
    const c = nextCard(p, attempts);
    if (!c) break;
    cards.push({ entryId: c.word.entryId, sentenceId: c.sentenceId, encounter: c.encounter, same: c.sameInSession, newContext: c.newContext });
    attempts.push({ cardIndex: c.cardIndex, entryId: c.word.entryId, sentenceId: c.sentenceId, outcome: answer(c.word.entryId, c.encounter) });
    if (cards.length > 200) throw new Error("loop");
  }
  return { cards, attempts };
}

describe("context-loop-queue-v1", () => {
  it("brings a missed word back after at least three other cards, first with the same sentence twice, then another", () => {
    const { cards } = play(plan(10), (w, n) => (w === "w0" && n <= 3 ? "not_recalled" : "recalled"));
    const w0 = cards.map((c, i) => ({ ...c, i })).filter((c) => c.entryId === "w0");
    // while other words are still open (at the very end a lone word may come back sooner)
    for (let k = 1; k <= 2; k++) expect(w0[k]!.i - w0[k - 1]!.i).toBeGreaterThanOrEqual(4);
    expect(w0.slice(0, 3).map((c) => c.sentenceId)).toEqual(["w0s0", "w0s0", "w0s0"]);
    expect(w0[1]!.same && w0[2]!.same).toBe(true);
    expect(w0[3]!.sentenceId).not.toBe("w0s0");
  });

  it("after the first success checks the word in another sentence after at least eight other cards, and closes it after two successes", () => {
    const { cards } = play(plan(10), () => "recalled");
    for (const w of ["w0", "w1"]) {
      const idx = cards.map((c, i) => ({ ...c, i })).filter((c) => c.entryId === w);
      expect(idx).toHaveLength(2);
      expect(idx[1]!.i - idx[0]!.i).toBeGreaterThanOrEqual(9);
      expect(idx[1]!.sentenceId).not.toBe(idx[0]!.sentenceId);
      expect(idx[1]!.newContext).toBe(true);
    }
  });

  it("a word already in review is closed by one success in a sentence never seen before, not by one seen before", () => {
    expect(play(plan(3, { wasReview: true }), () => "recalled").cards).toHaveLength(3);
    expect(play(plan(3, { wasReview: true, seen: true }), () => "recalled").cards).toHaveLength(6);
  });

  it("never shows a word more than five times, never twice in a row unless it is the last one, and stops at maxCards", () => {
    const { cards } = play(plan(4), () => "not_recalled");
    for (const w of ["w0", "w1", "w2", "w3"]) expect(cards.filter((c) => c.entryId === w)).toHaveLength(5);
    const openAt = (i: number) => new Set(cards.slice(i).map((c) => c.entryId)).size;
    for (let i = 1; i < cards.length; i++) if (cards[i]!.entryId === cards[i - 1]!.entryId) expect(openAt(i)).toBe(1);
    expect(play(plan(8, { maxCards: 10 }), () => "not_recalled").cards).toHaveLength(10);
  });

  it("with a spread, two words missed in a row do not always return in the same lockstep order", () => {
    const p = { ...plan(10), params: { ...plan(10).params, missSpread: 2 } };
    let lockstep = 0;
    for (let k = 0; k < 8; k++) {
      const ids = p.words.map((w, i) => ({ ...w, entryId: `k${k}w${i}` }));
      const q = { ...p, words: ids };
      const { cards } = play(q, (w, n) => ((w.endsWith("w0") || w.endsWith("w1")) && n === 1 ? "not_recalled" : "recalled"));
      const at = (id: string) => cards.findIndex((c, i) => i > 1 && c.entryId === id);
      const a = at(`k${k}w0`), b = at(`k${k}w1`);
      expect(a - 0).toBeGreaterThanOrEqual(4);
      expect(b - 1).toBeGreaterThanOrEqual(4);
      if (b === a + 1) lockstep++;
    }
    expect(lockstep).toBeLessThan(8);
    expect(play(p, () => "recalled")).toEqual(play(p, () => "recalled"));
  });

  it("is deterministic and the summary counts first tries, new-context successes and returns", () => {
    const p = plan(3);
    const ans = (w: string, n: number): CardOutcome => (w === "w1" && n === 1 ? "not_recalled" : "recalled");
    const a = play(p, ans);
    expect(play(p, ans)).toEqual(a);
    expect(summarise(p, a.attempts)).toMatchObject({ wordsDone: 3, wordsStarted: 3, firstTry: 2, returns: a.cards.length - 3, needsWork: [] });
    expect(summarise(p, a.attempts).newContextSuccess).toBeGreaterThanOrEqual(2);
  });
});
