import { describe, expect, it } from "vitest";
import { createWordsEngine, handleWordKey, tickWords, type WordsEngineConfig, type WordsEngineState } from "../../../apps/web/src/game/wordsEngine.js";
import type { TypingPlanWord } from "../../../packages/contracts/src/typing.js";

const planWord = (planIndex: number, lemma: string): TypingPlanWord => ({
  planIndex,
  lemma,
  source: "general",
  vocabularyEntryId: null,
  translationRu: null,
  partOfSpeech: null,
  definitionRu: null,
  transcription: null,
  unverified: true,
  fallMs: 10000,
});

const config = (words: TypingPlanWord[]): WordsEngineConfig => ({ plan: words, fallMs: () => 10000, spawnGapMs: () => 1000, maxActive: 4 });

/** type a whole word, returning events */
function typeWord(s: WordsEngineState, c: WordsEngineConfig, word: string): ReturnType<typeof handleWordKey> {
  const events: ReturnType<typeof handleWordKey> = [];
  for (const ch of word) events.push(...handleWordKey(s, c, ch));
  return events;
}

describe("words engine", () => {
  it("locks the most dangerous matching target on the first letter", () => {
    const s = createWordsEngine(config([planWord(0, "cat"), planWord(1, "dog")]));
    // spawn both manually
    s.words.push({ planIndex: 0, lemma: "cat", source: "general", y: 0.2, lane: 1, progress: 0, mistakes: 0, destroying: false });
    s.words.push({ planIndex: 1, lemma: "dog", source: "general", y: 0.8, lane: 2, progress: 0, mistakes: 0, destroying: false });
    const events = handleWordKey(s, config(s.plan), "d");
    expect(events.map((e) => e.type)).toEqual(["hit"]);
    expect(s.target).toBe(1); // "dog" is closer to the line
  });

  it("advances progress and destroys the word when complete", () => {
    const s = createWordsEngine(config([planWord(0, "cat")]));
    s.words.push({ planIndex: 0, lemma: "cat", source: "general", y: 0, lane: 1, progress: 0, mistakes: 0, destroying: false });
    const events = typeWord(s, config(s.plan), "cat");
    expect(events.some((e) => e.type === "destroyed")).toBe(true);
    expect(s.destroyedCount).toBe(1);
    expect(s.destroyedPlanIndexes).toEqual([0]);
  });

  it("reports each correct letter as a hit (one shot per letter)", () => {
    const s = createWordsEngine(config([planWord(0, "cat")]));
    s.words.push({ planIndex: 0, lemma: "cat", source: "general", y: 0, lane: 1, progress: 0, mistakes: 0, destroying: false });
    const events = typeWord(s, config(s.plan), "cat");
    expect(events.filter((e) => e.type === "hit")).toHaveLength(3);
  });

  it("a wrong letter never changes the word: it is a counted miss that restarts the shake", () => {
    const s = createWordsEngine(config([planWord(0, "cat")]));
    s.words.push({ planIndex: 0, lemma: "cat", source: "general", y: 0, lane: 1, progress: 0, mistakes: 0, destroying: false });
    handleWordKey(s, config(s.plan), "c");
    const first = handleWordKey(s, config(s.plan), "x");
    expect(first).toEqual([{ type: "miss", word: s.words[0] }]);
    expect(s.words[0]!.progress).toBe(1);
    expect(s.errors).toBe(1);
    expect(s.charsTyped).toBe(2);
    expect(s.errorSeq).toBe(1);
    expect(s.errorPlanIndex).toBe(0);
    handleWordKey(s, config(s.plan), "q"); // a second wrong letter restarts the shake
    expect(s.errorSeq).toBe(2);
    handleWordKey(s, config(s.plan), "a"); // the right letter continues straight away, nothing to delete
    expect(s.words[0]!.progress).toBe(2);
  });

  it("counts a wrong letter without a matching target as an error that shakes every word", () => {
    const s = createWordsEngine(config([planWord(0, "cat")]));
    s.words.push({ planIndex: 0, lemma: "cat", source: "general", y: 0, lane: 1, progress: 0, mistakes: 0, destroying: false });
    const events = handleWordKey(s, config(s.plan), "z"); // no word starts with z
    expect(events).toEqual([{ type: "miss", word: null }]);
    expect(s.target).toBeNull();
    expect(s.errors).toBe(1);
    expect(s.errorPlanIndex).toBeNull();
  });

  it("ignores Backspace: it is neither counted nor does it release the lock", () => {
    const s = createWordsEngine(config([planWord(0, "cat")]));
    s.words.push({ planIndex: 0, lemma: "cat", source: "general", y: 0, lane: 1, progress: 0, mistakes: 0, destroying: false });
    handleWordKey(s, config(s.plan), "c");
    const typedBefore = s.charsTyped;
    expect(handleWordKey(s, config(s.plan), "Backspace")).toEqual([]);
    expect(s.target).toBe(0);
    expect(s.words[0]!.progress).toBe(1);
    expect(s.charsTyped).toBe(typedBefore);
  });

  it("types a hyphenated word through the hyphen", () => {
    const s = createWordsEngine(config([planWord(0, "well-known")]));
    s.words.push({ planIndex: 0, lemma: "well-known", source: "general", y: 0, lane: 1, progress: 0, mistakes: 0, destroying: false });
    const events = typeWord(s, config(s.plan), "well-known");
    expect(events.some((e) => e.type === "destroyed")).toBe(true);
    expect(s.errors).toBe(0);
  });

  it("emits won after the last word is destroyed", () => {
    const s = createWordsEngine(config([planWord(0, "cat")]));
    s.words.push({ planIndex: 0, lemma: "cat", source: "general", y: 0, lane: 1, progress: 0, mistakes: 0, destroying: false });
    const events = typeWord(s, config(s.plan), "cat");
    expect(events.some((e) => e.type === "won")).toBe(true);
    expect(s.won).toBe(true);
  });

  it("fails when a meteor reaches the line", () => {
    const s = createWordsEngine(config([planWord(0, "cat")]));
    s.words.push({ planIndex: 0, lemma: "cat", source: "general", y: 0.99, lane: 1, progress: 0, mistakes: 0, destroying: false });
    const { events } = tickWords(s, config(s.plan), 2000);
    expect(s.failed).toBe(true);
    expect(events.some((e) => e.type === "failed")).toBe(true);
  });

  it("does not let a destroying meteor cause a loss", () => {
    const s = createWordsEngine(config([planWord(0, "cat")]));
    s.words.push({ planIndex: 0, lemma: "cat", source: "general", y: 0.99, lane: 1, progress: 0, destroying: true });
    tickWords(s, config(s.plan), 2000);
    expect(s.failed).toBe(false);
  });

  it("locks the matching meteor closest to the line, not the highest one", () => {
    const s = createWordsEngine(config([planWord(0, "tree"), planWord(1, "table")]));
    s.words.push({ planIndex: 0, lemma: "tree", source: "general", y: 0.2, lane: 1, progress: 0, mistakes: 0, destroying: false });
    s.words.push({ planIndex: 1, lemma: "table", source: "general", y: 0.7, lane: 2, progress: 0, mistakes: 0, destroying: false });
    handleWordKey(s, config(s.plan), "t");
    expect(s.target).toBe(1);
  });
});
