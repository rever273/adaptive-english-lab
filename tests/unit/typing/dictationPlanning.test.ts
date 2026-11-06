import { describe, expect, it } from "vitest";
import { classifyAnswer, sameStem } from "../../../apps/server/src/domain/typing/dictation/errorTypes.js";
import { GRAMMAR, REGISTER_SHARE, cycle, mulberry32, pickTopics, type DictationTopic } from "../../../apps/server/src/domain/typing/dictation/planning.js";
import { namesTopic } from "../../../apps/server/src/domain/typing/dictation/runner.js";

describe("planning", () => {
  it("cycles a list so everything comes round before it repeats and nothing follows itself", () => {
    const out = cycle(GRAMMAR, mulberry32(3), GRAMMAR.length * 2 + 3);
    for (let i = 1; i < out.length; i++) expect(out[i]).not.toBe(out[i - 1]);
    expect(new Set(out.slice(0, GRAMMAR.length)).size).toBe(GRAMMAR.length);
  });

  it("styles add up to the whole and casual speech has a large share", () => {
    expect(REGISTER_SHARE.reduce((a, [, w]) => a + w, 0)).toBeCloseTo(1);
    expect(REGISTER_SHARE.find(([r]) => r === "conversational")![1]).toBeGreaterThanOrEqual(0.3);
  });

  it("picks topics that were not used lately, with different groups side by side", () => {
    const topics: DictationTopic[] = Array.from({ length: 60 }, (_, i) => ({ name: `Topic ${i}`, group: `g${i % 6}` }));
    const recent = topics.slice(0, 30).map((t) => t.name);
    const picked = pickTopics(topics, recent, 10, mulberry32(5));
    expect(picked).toHaveLength(10);
    expect(picked.every((t) => !recent.includes(t.name))).toBe(true);
    for (let i = 1; i < picked.length; i++) expect(picked[i]!.group).not.toBe(picked[i - 1]!.group);
    // when too few are fresh, the least recently used come back
    expect(pickTopics(topics.slice(0, 12), topics.slice(0, 10).map((t) => t.name), 6, mulberry32(1))).toHaveLength(6);
  });

  it("the topic name is context, not a phrase to say", () => {
    expect(namesTopic("Heavy metal", "The drummer loves heavy metal concerts.")).toBe(true);
    expect(namesTopic("Live concerts", "The sound engineer fixed the speakers before the show.")).toBe(false);
    expect(namesTopic("Creativity", "Creativity is hard to teach.")).toBe(false); // one word: allowed
  });
});

describe("kinds of mistakes in a dictation answer", () => {
  const kinds = (e: string, t: string) => classifyAnswer(e, t);
  it("articles, helper verbs, prepositions, endings, contractions, wrong words, order and missing or extra words", () => {
    expect(kinds("She bought the car yesterday.", "She bought a car yesterday")).toEqual(["articles"]);
    expect(kinds("They have finished the work.", "They had finished the work")).toEqual(["auxiliary_verbs"]);
    expect(kinds("We met at the station.", "We met on the station")).toEqual(["prepositions"]);
    expect(kinds("He worked all night.", "He works all night")).toEqual(["word_endings"]);
    expect(kinds("He's already left the office.", "He already left the office")).toEqual(["contractions"]);
    expect(kinds("The engineer fixed the bridge.", "The engineer fixed the fridge")).toEqual(["vocabulary"]);
    expect(kinds("I quickly finished my work.", "I finished quickly my work")).toEqual(["word_order"]);
    expect(kinds("The cat sat on the mat.", "The cat sat on mat")).toEqual(["articles"]);
    expect(kinds("It was a very long day.", "It was a long day")).toEqual(["missing_word"]);
    expect(kinds("It was a long day.", "It was a very long day")).toEqual(["extra_word"]);
    expect(kinds("It was a long day.", "it was a long day")).toEqual([]);
  });
  it("stems with another ending", () => {
    expect(sameStem("work", "worked")).toBe(true);
    expect(sameStem("carry", "carried")).toBe(true);
    expect(sameStem("cat", "dog")).toBe(false);
    expect(sameStem("play", "player")).toBe(true);
  });
});
