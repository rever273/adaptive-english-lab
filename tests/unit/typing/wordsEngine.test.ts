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
    s.words.push({ planIndex: 0, lemma: "cat", source: "general", y: 0.2, lane: 1, progress: 0, errors: [], destroying: false });
    s.words.push({ planIndex: 1, lemma: "dog", source: "general", y: 0.8, lane: 2, progress: 0, errors: [], destroying: false });
    const events = handleWordKey(s, config(s.plan), "d");
    expect(events).toEqual([]);
    expect(s.target).toBe(1); // "dog" is closer to the line
  });

  it("advances progress and destroys the word when complete", () => {
    const s = createWordsEngine(config([planWord(0, "cat")]));
    s.words.push({ planIndex: 0, lemma: "cat", source: "general", y: 0, lane: 1, progress: 0, errors: [], destroying: false });
    const events = typeWord(s, config(s.plan), "cat");
    expect(events.some((e) => e.type === "destroyed")).toBe(true);
    expect(s.destroyedCount).toBe(1);
    expect(s.destroyedPlanIndexes).toEqual([0]);
  });

  it("shows wrong letters as errors that must be cleared with Backspace before progress continues", () => {
    const s = createWordsEngine(config([planWord(0, "cat")]));
    s.words.push({ planIndex: 0, lemma: "cat", source: "general", y: 0, lane: 1, progress: 0, errors: [], destroying: false });
    handleWordKey(s, config(s.plan), "c");
    handleWordKey(s, config(s.plan), "x"); // wrong
    expect(s.words[0]!.errors).toEqual(["x"]);
    expect(s.errors).toBe(1);
    handleWordKey(s, config(s.plan), "a"); // correct letter but a red error is pending: counts as an error too
    expect(s.words[0]!.progress).toBe(1); // unchanged: "c" only
    handleWordKey(s, config(s.plan), "Backspace"); // clear "a"
    handleWordKey(s, config(s.plan), "Backspace"); // clear "x"
    expect(s.words[0]!.errors).toEqual([]);
    handleWordKey(s, config(s.plan), "a"); // now advances
    expect(s.words[0]!.progress).toBe(2);
  });

  it("counts a wrong letter without a matching target as an error with a flash", () => {
    const s = createWordsEngine(config([planWord(0, "cat")]));
    s.words.push({ planIndex: 0, lemma: "cat", source: "general", y: 0, lane: 1, progress: 0, errors: [], destroying: false });
    handleWordKey(s, config(s.plan), "z"); // no word starts with z
    expect(s.target).toBeNull();
    expect(s.errors).toBe(1);
    expect(s.flash).toBeGreaterThan(0);
  });

  it("releases the lock when Backspace removes all typed characters", () => {
    const s = createWordsEngine(config([planWord(0, "cat")]));
    s.words.push({ planIndex: 0, lemma: "cat", source: "general", y: 0, lane: 1, progress: 0, errors: [], destroying: false });
    handleWordKey(s, config(s.plan), "c");
    expect(s.target).toBe(0);
    handleWordKey(s, config(s.plan), "Backspace");
    expect(s.target).toBeNull();
  });

  it("fails when a meteor reaches the line", () => {
    const s = createWordsEngine(config([planWord(0, "cat")]));
    s.words.push({ planIndex: 0, lemma: "cat", source: "general", y: 0.99, lane: 1, progress: 0, errors: [], destroying: false });
    const { events } = tickWords(s, config(s.plan), 2000);
    expect(s.failed).toBe(true);
    expect(events.some((e) => e.type === "failed")).toBe(true);
  });

  it("does not let a destroying meteor cause a loss", () => {
    const s = createWordsEngine(config([planWord(0, "cat")]));
    s.words.push({ planIndex: 0, lemma: "cat", source: "general", y: 0.99, lane: 1, progress: 0, errors: [], destroying: true });
    tickWords(s, config(s.plan), 2000);
    expect(s.failed).toBe(false);
  });
});
