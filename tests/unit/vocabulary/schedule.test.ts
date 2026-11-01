import { describe, expect, it } from "vitest";
import {
  intervalFor,
  pickVocabulary,
  wordState,
  type Outcome,
  type PickInput,
  type ShownCandidate,
  type VocabularyCandidate,
  type WordEvent,
} from "../../../apps/server/src/domain/vocabulary/schedule.js";

const NOW = new Date("2026-03-20T00:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
let seq = 0;
const ev = (outcome: Outcome, d: number, revisionId = `r${++seq}`): WordEvent => ({ at: daysAgo(d), outcome, revisionId, slotId: `slot-${revisionId}` });

const fresh = (lemma: string, id: string, family: VocabularyCandidate["family"] = "recognition", learned = false): VocabularyCandidate => ({
  revisionId: id, lemma, entryId: `e-${lemma}`, learned, family, difficulty: "B2", rubricVersion: "v1", units: [`u-${id}`], unitFingerprints: [`f-${id}`],
});
const shown = (lemma: string, id: string, lastShownAt: string, lastOutcome: Outcome | null, learned = false): ShownCandidate => ({ ...fresh(lemma, id, "recognition", learned), unexposedUnits: [], lastShownAt, lastSlotId: `slot-${id}`, lastOutcome });

const input = (o: Partial<PickInput> & Pick<PickInput, "n">): PickInput => ({ fresh: [], shown: [], events: new Map(), now: NOW, seed: "s", newWordsPerSession: 4, ...o });
const lemmasOf = (p: ReturnType<typeof pickVocabulary>) => p.map((x) => x.candidate.lemma);

describe("vocabulary-selection-v2 word state", () => {
  it("intervals cap at 21 days, or 30 for learned words", () => {
    expect([1, 2, 3, 4, 5, 6, 9].map((s) => intervalFor(s, false))).toEqual([1, 2, 4, 7, 14, 21, 21]);
    expect([1, 3, 6].map((s) => intervalFor(s, true))).toEqual([2, 8, 30]);
  });

  it("only an independent success separated by 24 hours advances; repeats do not postpone the due date", () => {
    const initial = ev("success", 4, "one");
    const sameDay = ev("success", 3.5, "two");
    const repeat = { ...ev("success", 2, "repeat"), independent: false };
    const a = wordState("a", [initial, sameDay, repeat], false, NOW);
    expect(a.streak).toBe(1);
    expect(a.dueAt).toBe(new Date(Date.parse(initial.at) + 86_400_000).toISOString());
    expect(wordState("a", [initial, sameDay, repeat, ev("success", 1, "three")], false, NOW).streak).toBe(2);
  });

  it("keeps room for a new word when there are many due words", () => {
    const events = new Map(["a", "b", "c"].map(l => [l, [ev("miss", 1, l)]]));
    const result = pickVocabulary(input({ n: 3, fresh: [fresh("a", "a"), fresh("b", "b"), fresh("c", "c"), fresh("new", "new")], events }));
    expect(lemmasOf(result)).toContain("new");
    expect(lemmasOf(result).filter(l => l !== "new")).toHaveLength(2);
  });

  it("a success grows the streak and the due date; a miss resets it and makes the word due at once", () => {
    const ok = wordState("a", [ev("success", 3), ev("success", 2)], false, NOW);
    expect(ok).toMatchObject({ streak: 2, intervalDays: 2, due: true, state: "learning" }); // 2 days passed, interval 2
    const notYet = wordState("a", [ev("success", 3), ev("success", 1)], false, NOW);
    expect(notYet.due).toBe(false);
    const miss = wordState("a", [ev("success", 9), ev("success", 8), ev("miss", 0)], false, NOW);
    expect(miss).toMatchObject({ streak: 0, due: true, lastOutcome: "miss" });
    expect(miss.dueAt).toBe(daysAgo(0));
  });

  it("assisted is neither a success nor a reset, and the word is due again after a day", () => {
    const s = wordState("a", [ev("success", 5), ev("success", 4), ev("assisted", 0.5)], false, NOW);
    expect(s.streak).toBe(2);
    expect(s).toMatchObject({ lastOutcome: "assisted", intervalDays: 1, due: false });
    expect(wordState("a", [ev("success", 5), ev("assisted", 2)], false, NOW).due).toBe(true);
  });

  it("learned words wait twice as long, are never new, and a learned word with no history is a review at streak 3", () => {
    const l = wordState("a", [ev("success", 3)], true, NOW);
    expect(l).toMatchObject({ intervalDays: 2, due: true, state: "review" });
    expect(wordState("a", [ev("success", 1.5)], true, NOW).due).toBe(false);
    expect(wordState("a", [], true, NOW)).toMatchObject({ state: "review", streak: 3, due: false });
    expect(wordState("a", [], false, NOW).state).toBe("new");
  });

  it("recent misses add to the priority (capped) on top of the overdue ratio", () => {
    const calm = wordState("a", [ev("success", 4)], false, NOW);
    const bumpy = wordState("a", [ev("miss", 6), ev("success", 5), ev("miss", 4)], false, NOW);
    expect(bumpy.recentMisses).toBe(2);
    expect(bumpy.priority).toBeGreaterThan(calm.priority);
    const many = wordState("a", [ev("miss", 3), ev("miss", 2), ev("miss", 1)], false, NOW);
    expect(many.priority - many.ratio).toBe(3);
  });
});

describe("vocabulary-selection-v2 picking", () => {
  it("due words come before new words, and not-yet-due words only fill", () => {
    const events = new Map([
      ["due", [ev("success", 5)]], // interval 1, overdue
      ["wait", [ev("success", 0.1)]], // not due
    ]);
    const p = pickVocabulary(input({ n: 2, fresh: [fresh("due", "d1"), fresh("wait", "w1"), fresh("newbie", "n1")], events }));
    expect(lemmasOf(p)).toEqual(["due", "newbie"]);
    const filled = pickVocabulary(input({ n: 3, fresh: [fresh("due", "d1"), fresh("wait", "w1"), fresh("newbie", "n1")], events }));
    expect(lemmasOf(filled)).toEqual(["due", "newbie", "wait"]);
  });

  it("most overdue (with misses) goes first", () => {
    const events = new Map([
      ["mild", [ev("success", 3)]],
      ["worse", [ev("success", 4), ev("miss", 3), ev("miss", 2)]],
    ]);
    const p = pickVocabulary(input({ n: 2, fresh: [fresh("mild", "m1"), fresh("worse", "x1")], events }));
    expect(lemmasOf(p)[0]).toBe("worse");
  });

  it("at most newWordsPerSession new words, extra ones only when the session could not be filled", () => {
    const f = ["a", "b", "c", "d", "e", "f"].map((l) => fresh(l, `n-${l}`));
    const two = [...f, ...["a", "b", "c", "d", "e", "f"].map((l) => fresh(l, `n-${l}2`))];
    // enough sentences for the two capped words: the cap holds
    expect(new Set(lemmasOf(pickVocabulary(input({ n: 4, fresh: two, newWordsPerSession: 2 })))).size).toBe(2);
    // one sentence per word: the capped words run out, so the cap is relaxed only to fill the session
    expect(new Set(lemmasOf(pickVocabulary(input({ n: 4, fresh: f, newWordsPerSession: 2 })))).size).toBe(4);
    expect(new Set(lemmasOf(pickVocabulary(input({ n: 2, fresh: f, newWordsPerSession: 2 })))).size).toBe(2);
  });

  it("new words with no unshown sentence do not use up the new-word cap", () => {
    const f = [fresh("a", "na"), fresh("b", "nb")];
    const onlyShown = shown("ghost", "g1", daysAgo(5), null);
    const p = pickVocabulary(input({ n: 2, fresh: f, shown: [onlyShown], newWordsPerSession: 2 }));
    expect(lemmasOf(p).sort()).toEqual(["a", "b"]);
  });

  it("a skipped sentence with no confirmed word events may return in a later session", () => {
    const old = shown("w", "skipped", daysAgo(0), null);
    const p = pickVocabulary(input({ n: 1, shown: [old] }));
    expect(p[0]).toMatchObject({ repeat: { reason: "missed", ofSlotId: "slot-skipped" } });
  });

  it("after a miss the first choice is a repeat of the missed sentence, labelled with the reason", () => {
    const events = new Map([["w", [ev("miss", 2, "rm")]]]);
    const p = pickVocabulary(input({ n: 2, fresh: [fresh("w", "f1")], shown: [shown("w", "rm", daysAgo(2), "miss")], events }));
    expect(p[0]!.repeat).toBeNull();
    expect(p[1]).toMatchObject({ repeat: { reason: "missed", ofSlotId: "slot-rm" } });
    const assisted = pickVocabulary(input({ n: 2, fresh: [fresh("w", "f1")], shown: [shown("w", "ra", daysAgo(2), "assisted")], events: new Map([["w", [ev("assisted", 2, "ra")]]]) }));
    expect(assisted[0]!.repeat).toBeNull();
    expect(assisted[1]!.repeat?.reason).toBe("assisted");
  });

  it("after a success a fresh sentence is preferred; a repeat only when none is left and the word is due, oldest correct one first", () => {
    const events = new Map([["w", [ev("success", 3, "o1"), ev("success", 2, "o2")]]]);
    const shownList = [shown("w", "o2", daysAgo(2), "success"), shown("w", "o1", daysAgo(3), "success")];
    const withFresh = pickVocabulary(input({ n: 1, fresh: [fresh("w", "f1")], shown: shownList, events }));
    expect(withFresh[0]).toMatchObject({ repeat: null });
    const noFresh = pickVocabulary(input({ n: 2, shown: shownList, events }));
    expect(noFresh[0]!.candidate.revisionId).toBe("o1");
    expect(noFresh[0]!.repeat?.reason).toBe("review");
    const notDue = pickVocabulary(input({ n: 2, shown: [shown("w", "o1", daysAgo(0.5), "success"), shown("w", "o2", daysAgo(0.5), "success")], events: new Map([["w", [ev("success", 1, "o1"), ev("success", 0.5, "o2")]]]) }));
    expect(notDue).toHaveLength(0);
  });

  it("correct sentences can return after one day only to fill a shortage, preferring fresh items", () => {
    const events = new Map([["w", [ev("success", 1.5, "old")]]]);
    const previous = shown("w", "old", daysAgo(1.5), "success");
    expect(pickVocabulary(input({ n: 1, fresh: [fresh("w", "new")], shown: [previous], events }))[0]!.repeat).toBeNull();
    expect(pickVocabulary(input({ n: 1, shown: [previous], events }))[0]!.repeat?.reason).toBe("review");
    expect(pickVocabulary(input({ n: 1, shown: [shown("w", "old", daysAgo(0.5), "success")], events }))).toHaveLength(0);
  });

  it("with no fresh stock, missed sentences come back before correct ones, oldest first, and rotate across sessions", () => {
    const events = new Map([["w", [ev("miss", 5, "a1"), ev("miss", 4, "a2"), ev("success", 3, "c1")]]]);
    const pool = (a1At: number) => [shown("w", "a1", daysAgo(a1At), "miss"), shown("w", "a2", daysAgo(4), "miss"), shown("w", "c1", daysAgo(3), "success")];
    const three = pickVocabulary(input({ n: 3, shown: pool(5), events }));
    expect(three.map((x) => x.candidate.revisionId)).toEqual(["a1", "a2", "c1"]);
    expect(three.map((x) => x.repeat?.reason)).toEqual(["missed", "missed", "review"]);
    expect(pickVocabulary(input({ n: 1, shown: pool(5), events }))[0]!.candidate.revisionId).toBe("a1");
    // a1 was shown again (and missed again) more recently than a2: a2 now goes first
    expect(pickVocabulary(input({ n: 1, shown: pool(1), events }))[0]!.candidate.revisionId).toBe("a2");
  });

  it("a miss on A followed by a success on another sentence: A is still offered once the word is due, even with fresh stock", () => {
    const events = new Map([["w", [ev("miss", 5, "A"), ev("success", 2, "B")]]]);
    const p = pickVocabulary(input({ n: 2, fresh: [fresh("w", "F")], shown: [shown("w", "A", daysAgo(5), "miss"), shown("w", "B", daysAgo(2), "success")], events }));
    expect(p[0]!.candidate.revisionId).toBe("F");
    expect(p[1]).toMatchObject({ repeat: { reason: "missed" } });
    expect(p[1]!.candidate.revisionId).toBe("A");
    // not due yet: fresh first, A waits
    const wait = pickVocabulary(input({ n: 1, fresh: [fresh("w", "F")], shown: [shown("w", "A", daysAgo(5), "miss"), shown("w", "B", daysAgo(0.2), "success")], events: new Map([["w", [ev("miss", 5, "A"), ev("success", 0.2, "B")]]]) }));
    expect(wait[0]!.candidate.revisionId).toBe("F");
  });

  it("a missed sentence answered only with a hint stays open: it is offered ahead of fresh once the word is due", () => {
    const events = new Map([["w", [ev("miss", 6, "A"), ev("assisted", 4, "A"), ev("success", 2, "F")]]]);
    const p = pickVocabulary(input({ n: 2, fresh: [fresh("w", "G")], shown: [shown("w", "A", daysAgo(4), "assisted"), shown("w", "F", daysAgo(2), "success")], events }));
    expect(p[0]!.candidate.revisionId).toBe("G");
    expect(p[1]!.candidate.revisionId).toBe("A");
    expect(p[1]!.repeat?.reason).toBe("assisted");
  });

  it("a repeat answered correctly without help is no longer offered ahead of fresh sentences; skipped ones rank below helped ones", () => {
    const events = new Map([["w", [ev("miss", 6, "A"), ev("success", 4, "A")]]]);
    const p = pickVocabulary(input({ n: 1, fresh: [fresh("w", "G")], shown: [shown("w", "A", daysAgo(4), "success")], events }));
    expect(p[0]).toMatchObject({ repeat: null });
    expect(p[0]!.candidate.revisionId).toBe("G");
    const e2 = new Map([["w", [ev("success", 3, "Z")]]]);
    const order = pickVocabulary(input({ n: 3, shown: [shown("w", "S", daysAgo(5), null), shown("w", "H", daysAgo(1), "assisted"), shown("w", "Z", daysAgo(3), "success")], events: e2 }));
    expect(order.map((x) => x.candidate.revisionId)).toEqual(["H", "S", "Z"]);
  });

  it("never the same revision twice in a session, and never two sentences sharing a unit", () => {
    const events = new Map([["w", [ev("success", 9, "o1"), ev("success", 8, "o2")]]]);
    const p = pickVocabulary(input({ n: 10, shown: [shown("w", "o1", daysAgo(9), "success"), shown("w", "o2", daysAgo(8), "success")], events }));
    expect(new Set(p.map((x) => x.candidate.revisionId)).size).toBe(p.length);
    const a = fresh("w", "a1");
    const b = { ...fresh("w", "b1"), unitFingerprints: a.unitFingerprints };
    expect(pickVocabulary(input({ n: 2, fresh: [a, b] }))).toHaveLength(1);
  });

  it("the 60% repeat share is soft: fresh sentences take the places beyond it, repeats fill what fresh cannot", () => {
    const lemmas = ["a", "b", "c", "d", "e"];
    const events = new Map(lemmas.map((l) => [l, [ev("miss", 2, `r-${l}`)]]));
    const shownList = lemmas.map((l) => shown(l, `r-${l}`, daysAgo(2), "miss"));
    const p = pickVocabulary(input({ n: 5, fresh: lemmas.map((l) => fresh(l, `f-${l}`)), shown: shownList, events }));
    expect(p).toHaveLength(5);
    expect(p.filter((x) => x.repeat).length).toBe(0); // different sentences are preferred for those words
    const noFresh = pickVocabulary(input({ n: 5, shown: shownList, events }));
    expect(noFresh).toHaveLength(5);
    expect(noFresh.every((x) => x.repeat?.reason === "missed")).toBe(true); // repeat-only stock fills the whole session
    expect(new Set(noFresh.map((x) => x.candidate.revisionId)).size).toBe(5);
  });

  it("the same seed gives the same choice, another seed may differ", () => {
    const f = ["a", "b", "c", "d", "e", "f", "g"].flatMap((l) => [fresh(l, `${l}1`, "recognition"), fresh(l, `${l}2`, "guided_recall"), fresh(l, `${l}3`, "collocation")]);
    const run = (seed: string) => pickVocabulary(input({ n: 6, fresh: f, seed, newWordsPerSession: 6 })).map((x) => x.candidate.revisionId);
    expect(run("seed-1")).toEqual(run("seed-1"));
    expect(run("seed-1")).not.toEqual(run("seed-2"));
  });
});
