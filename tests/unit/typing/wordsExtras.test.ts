import { describe, expect, it } from "vitest";
import { comboMultiplier, createWordsEngine, exportKeyStats, handleWordKey, revealTranslation, type WordsEngineConfig, type WordsEngineState } from "../../../apps/web/src/game/wordsEngine.js";
import { createRecall, isFinished, recallHint, recallKey, recallResults, recallReveal, wordPoints } from "../../../apps/web/src/game/recallEngine.js";
import { learningFactor } from "../../../apps/server/src/domain/vocabulary/difficulty.js";
import type { WordEvent } from "../../../apps/server/src/domain/vocabulary/schedule.js";
import type { TypingPlanWord } from "../../../packages/contracts/src/typing.js";

const plan = (lemma: string, i: number): TypingPlanWord => ({ planIndex: i, lemma, source: "general", vocabularyEntryId: null, translationRu: `перевод ${lemma}`, partOfSpeech: null, definitionRu: null, transcription: null, unverified: true, fallMs: 10000 });
const config = (lemmas: string[]): WordsEngineConfig => ({ plan: lemmas.map(plan), fallMs: () => 10000, spawnGapMs: () => 1000, maxActive: 4 });
const spawn = (s: WordsEngineState, lemma: string, i: number, y = 0.1) => s.words.push({ planIndex: i, lemma, source: "general", y, lane: 1, progress: 0, mistakes: 0, destroying: false, revealed: false, lastHitAt: null });

function typeWord(s: WordsEngineState, c: WordsEngineConfig, word: string, startAt: number, step: number): number {
  let t = startAt;
  for (const ch of word) {
    handleWordKey(s, c, ch, t);
    t += step;
  }
  return t;
}

describe("combo", () => {
  it("multiplies after 3, 5 and 10 clean words, and any wrong key resets it", () => {
    expect([0, 2, 3, 4, 5, 9, 10, 20].map(comboMultiplier)).toEqual([1, 1, 1.1, 1.1, 1.2, 1.2, 1.5, 1.5]);
    const lemmas = ["aa", "bb", "cc", "dd", "ee"];
    const c = config(lemmas);
    const s = createWordsEngine(c);
    lemmas.forEach((l, i) => spawn(s, l, i, 0.1 + i * 0.01));
    typeWord(s, c, "aa", 0, 100);
    typeWord(s, c, "bb", 1000, 100);
    expect(s.streak).toBe(2);
    expect(s.score).toBe(40); // 2 words x 2 letters x 10, no multiplier yet
    typeWord(s, c, "cc", 2000, 100);
    expect(s.streak).toBe(3);
    expect(s.score).toBe(40 + Math.round(2 * 10 * 1.1));
    handleWordKey(s, c, "x", 3000); // a wrong key
    expect(s.streak).toBe(0);
    expect(s.bestStreak).toBe(3);
  });

  it("a word with a wrong key does not extend the streak even if it is finished", () => {
    const c = config(["ab"]);
    const s = createWordsEngine(c);
    spawn(s, "ab", 0);
    handleWordKey(s, c, "a", 0);
    handleWordKey(s, c, "z", 10);
    handleWordKey(s, c, "b", 20);
    expect(s.destroyedCount).toBe(1);
    expect(s.streak).toBe(0);
  });
});

describe("translation on request (F3)", () => {
  it("marks the locked word, else the most urgent one", () => {
    const c = config(["cat", "dog"]);
    const s = createWordsEngine(c);
    spawn(s, "cat", 0, 0.2);
    spawn(s, "dog", 1, 0.7);
    expect(revealTranslation(s)).toBe(true);
    expect(s.words[1]!.revealed).toBe(true); // dog is closer to the line
    expect(s.words[0]!.revealed).toBe(false);
    handleWordKey(s, c, "c", 0); // lock cat
    revealTranslation(s);
    expect(s.words[0]!.revealed).toBe(true);
    s.paused = true;
    expect(revealTranslation(s)).toBe(false);
  });
});

describe("letter-pair facts", () => {
  it("count the gap between correct keys on a word and wrong keys against the pair, ignoring pauses and word starts", () => {
    const c = config(["through"]);
    const s = createWordsEngine(c);
    spawn(s, "through", 0);
    let t = 0;
    for (const ch of "thr") { handleWordKey(s, c, ch, t); t += 200; } // th, hr
    handleWordKey(s, c, "x", t); // wrong key while "o" was expected: counts against "ro"
    t += 300;
    handleWordKey(s, c, "o", t);
    t += 5000; // a long pause: not counted
    handleWordKey(s, c, "u", t);
    const facts = Object.fromEntries(exportKeyStats(s).map((f) => [f.pair, f]));
    expect(facts.th).toMatchObject({ count: 1, totalMs: 200 });
    expect(facts.hr).toMatchObject({ count: 1, totalMs: 200 });
    expect(facts.ro).toMatchObject({ errors: 1 });
    expect(facts.ro!.count).toBe(1);
    expect(facts.ou).toBeUndefined(); // 5 s pause
  });
});

describe("recall check", () => {
  const words = [
    { entryId: "1", lemma: "apple", translationRu: "яблоко" },
    { entryId: "2", lemma: "bread", translationRu: "хлеб" },
    { entryId: "3", lemma: "cloud", translationRu: "облако" },
  ];
  const type = (s: ReturnType<typeof createRecall>, w: string) => { for (const ch of w) recallKey(s, ch); };

  it("the first letter picks the word, wrong keys are free to repeat, a finished word is done", () => {
    const s = createRecall(words);
    expect(recallKey(s, "z").kind).toBe("wrong"); // no word starts with z
    type(s, "bre");
    expect(s.active).toBe(1);
    expect(recallKey(s, "x").kind).toBe("wrong");
    expect(recallKey(s, "x").kind).toBe("wrong");
    type(s, "ad");
    expect(s.words[1]).toMatchObject({ done: true, wrongKeys: 2, typedLetters: 5, hints: 0 });
    expect(s.active).toBeNull();
    type(s, "apple");
    type(s, "cloud");
    expect(isFinished(s)).toBe(true);
    expect(wordPoints(s.words[1]!)).toBe(9);
    expect(recallResults(s).map((r) => r.wrongKeys)).toEqual([0, 2, 0]);
  });

  it("F4 gives the next letter and costs points, F5 shows the word for no points", () => {
    const s = createRecall(words);
    recallHint(s); // first unsolved word: apple
    expect(s.active).toBe(0);
    expect(s.words[0]).toMatchObject({ filled: 1, hints: 1 });
    expect(s.words[0]!.kinds).toEqual(["hinted"]);
    type(s, "pple");
    expect(s.words[0]).toMatchObject({ done: true, typedLetters: 4, hints: 1 });
    expect(wordPoints(s.words[0]!)).toBe(7);
    recallReveal(s);
    recallReveal(s);
    expect(isFinished(s)).toBe(true);
    expect(s.words.slice(1).every((w) => w.revealed && w.done)).toBe(true);
    expect(wordPoints(s.words[1]!)).toBe(0);
    expect(recallKey(s, "a").kind).toBe("ignored");
  });
});

describe("vocabulary difficulty", () => {
  const ev = (...o: Array<"success" | "miss" | "assisted">): WordEvent[] => o.map((outcome, i) => ({ at: `2026-01-0${i + 1}T00:00:00Z`, outcome, revisionId: `r${i}`, slotId: `s${i}` }));
  it("a word that keeps going wrong is shown far more than one answered cleanly the last three times", () => {
    const hard = learningFactor(ev("miss", "success", "miss", "miss", "miss"), false);
    const easy = learningFactor(ev("miss", "success", "success", "success", "success"), false);
    expect(hard).toBeGreaterThan(2.4);
    expect(easy).toBeLessThan(1.1);
    expect(hard / easy).toBeGreaterThan(2.5);
    expect(learningFactor([], false)).toBeGreaterThan(1);
    expect(learningFactor(ev("assisted", "assisted", "success"), false)).toBeGreaterThan(learningFactor(ev("success", "success", "success"), false));
  });
});
