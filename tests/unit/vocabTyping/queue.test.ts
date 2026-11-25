import { describe, expect, it } from "vitest";
import { LEARN_QUEUE_VERSION, QUEUE_DEFAULTS, nextCard, summarise, type Answer, type AnswerKind, type LearnPlan, type PlanWord } from "../../../apps/server/src/domain/vocabTyping/queue.js";

const word = (lemma: string, o: { kind?: "check" | "learn"; sentences?: number } = {}): PlanWord => ({ lemma, kind: o.kind ?? "learn", isNew: true, sentences: Array.from({ length: o.sentences ?? 4 }, (_, i) => ({ id: `${lemma}-s${i}`, seenBefore: false })) });
const plan = (words: PlanWord[], maxCards = 30): LearnPlan => ({ version: LEARN_QUEUE_VERSION, params: { maxCards, ...QUEUE_DEFAULTS }, words });

/** plays a session: `decide(lemma, show, kind)` returns the answer of each card */
function play(p: LearnPlan, decide: (lemma: string, show: number, kind: "check" | "learn") => AnswerKind, hidden = new Set<string>()) {
  const answers: Answer[] = [];
  const cards: Array<{ lemma: string; sentenceId: string; kind: string; show: number }> = [];
  for (;;) {
    const c = nextCard(p, answers, hidden);
    if (!c) break;
    cards.push({ lemma: c.word.lemma, sentenceId: c.sentenceId, kind: c.kind, show: c.show });
    answers.push({ cardIndex: c.cardIndex, lemma: c.word.lemma, sentenceId: c.sentenceId, kind: decide(c.word.lemma, c.show, c.kind) });
    if (cards.length > 200) throw new Error("loop");
  }
  return { cards, answers };
}

describe("vt-learn-v1 queue", () => {
  it("starts with the due checks, then words met before, then new ones (the plan order)", () => {
    const p = plan([word("chk1", { kind: "check" }), word("chk2", { kind: "check" }), word("old1"), word("new1")]);
    const { cards } = play(p, () => "learned");
    expect(cards.map((c) => c.lemma)).toEqual(["chk1", "chk2", "old1", "new1"]);
    expect(cards.slice(0, 2).every((c) => c.kind === "check")).toBe(true);
  });

  it("Learned removes the word from the session; Still learning brings it back after at least three other cards, in another sentence", () => {
    const p = plan(["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((l) => word(l)));
    const { cards } = play(p, (l, show) => (l === "a" && show < 3 ? "still" : "learned"));
    const a = cards.map((c, i) => ({ ...c, i })).filter((c) => c.lemma === "a");
    expect(a.map((c) => c.show)).toEqual([1, 2, 3]);
    for (let k = 1; k < a.length; k++) {
      expect(a[k]!.i - a[k - 1]!.i - 1).toBeGreaterThanOrEqual(3);
      expect(a[k]!.sentenceId).not.toBe(a[k - 1]!.sentenceId);
    }
    expect(cards.filter((c) => c.lemma === "b")).toHaveLength(1);
  });

  it("shows a word at most four times in a session", () => {
    const p = plan(["a", "b", "c", "d", "e"].map((l) => word(l)), 60);
    const { cards } = play(p, () => "still");
    for (const l of ["a", "b", "c", "d", "e"]) expect(cards.filter((c) => c.lemma === l)).toHaveLength(4);
    expect(cards).toHaveLength(20);
  });

  it("a small pool may bring a word back sooner, but never the card just answered when another word is open", () => {
    const p = plan([word("a"), word("b")], 30);
    const { cards } = play(p, (_l, show) => (show < 3 ? "still" : "learned"));
    expect(cards.length).toBe(6);
    for (let i = 1; i < cards.length; i++) if (cards[i]!.lemma === cards[i - 1]!.lemma) expect(cards.slice(i).every((c) => c.lemma === cards[i]!.lemma)).toBe(true);
    const one = play(plan([word("solo")]), (_l, show) => (show < 4 ? "still" : "learned"));
    expect(one.cards.map((c) => c.show)).toEqual([1, 2, 3, 4]);
  });

  it("a passed check ends the word; a failed check returns it as a learning card later, never as a second check", () => {
    const p = plan([word("chk", { kind: "check" }), word("a"), word("b"), word("c"), word("d"), word("e")]);
    const { cards, answers } = play(p, (l, _s, kind) => (kind === "check" ? "check_fail" : "learned"));
    const chk = cards.filter((c) => c.lemma === "chk");
    expect(chk.map((c) => c.kind)).toEqual(["check", "learn"]);
    expect(chk[1]!.sentenceId).not.toBe(chk[0]!.sentenceId);
    expect(cards.map((c) => c.lemma).indexOf("chk", 1)).toBeGreaterThanOrEqual(4);
    expect(summarise(answers)).toMatchObject({ checksFailed: 1, checksPassed: 0, learned: 6, stillLearning: 0 });
    const passed = play(p, (_l, _s, kind) => (kind === "check" ? "check_pass" : "learned"));
    expect(passed.cards.filter((c) => c.lemma === "chk")).toHaveLength(1);
  });

  it("a skipped check (bad example) is not repeated in the session", () => {
    const p = plan([word("chk", { kind: "check" }), word("a")]);
    const { cards } = play(p, (_l, _s, kind) => (kind === "check" ? "check_skipped" : "learned"));
    expect(cards.map((c) => c.lemma)).toEqual(["chk", "a"]);
  });

  it("stops at the card limit and leaves unfinished words alone", () => {
    const p = plan(["a", "b", "c", "d", "e", "f", "g", "h"].map((l) => word(l)), 5);
    const { cards } = play(p, () => "still");
    expect(cards).toHaveLength(5);
  });

  it("replaces a sentence the learner hid, and drops a word with no sentence left", () => {
    const p = plan([word("a", { sentences: 2 }), word("b", { sentences: 1 })]);
    expect(nextCard(p, [])!.sentenceId).toBe("a-s0");
    expect(nextCard(p, [], new Set(["a:a-s0"]))!.sentenceId).toBe("a-s1");
    const next = nextCard(p, [{ cardIndex: 0, lemma: "a", sentenceId: "a-s1", kind: "learned" }], new Set(["b:b-s0"]));
    expect(next).toBeNull();
  });

  it("prefers a sentence not shown before and labels one that was", () => {
    const w: PlanWord = { lemma: "a", kind: "learn", isNew: false, sentences: [{ id: "n1", seenBefore: false }, { id: "old", seenBefore: true }] };
    const p = plan([w], 10);
    const c1 = nextCard(p, [])!;
    expect(c1).toMatchObject({ sentenceId: "n1", seenBefore: false });
    const c2 = nextCard(p, [{ cardIndex: 0, lemma: "a", sentenceId: "n1", kind: "still" }])!;
    expect(c2).toMatchObject({ sentenceId: "old", seenBefore: true });
  });

  it("is deterministic: the same plan and answers give the same card", () => {
    const p = plan(["a", "b", "c"].map((l) => word(l)));
    const answers: Answer[] = [{ cardIndex: 0, lemma: "a", sentenceId: "a-s0", kind: "still" }];
    expect(nextCard(p, answers)).toEqual(nextCard(p, answers));
  });
});
