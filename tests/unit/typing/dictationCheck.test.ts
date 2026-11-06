import { describe, expect, it } from "vitest";
import { spellNumbers } from "@english-lab/contracts";
import { alignWords, isCorrect, tokenize, wordDistance } from "../../../apps/server/src/domain/typing/dictation/check.js";
import { displayWords, revealFor, revealedSet, stuckWord } from "../../../apps/server/src/domain/typing/dictation/hints.js";
import { checkSentence, checkWav } from "../../../apps/server/src/domain/typing/dictation/quality.js";
import { variedLengthScale } from "../../../apps/server/src/domain/typing/dictation/runner.js";

describe("spellNumbers (D127)", () => {
  it("writes digits 0-999 and percent signs as words, the Australian way", () => {
    expect(spellNumbers("almost 10 years")).toBe("almost ten years");
    expect(spellNumbers("0 7 13 21 99 100 305")).toBe("zero seven thirteen twenty one ninety nine one hundred three hundred and five");
    expect(spellNumbers("about 50% of them")).toBe("about fifty percent  of them");
  });
  it("leaves years, big and decimal numbers alone", () => {
    expect(spellNumbers("in 2024 and 1,000 times, 3.5 more")).toBe("in 2024 and 1,000 times, 3.5 more");
    expect(spellNumbers("It was 10.")).toBe("It was ten.");
  });
  it("lets the heard '10' match the spoken 'ten' in the live check, while a typed digit stays a wrong word", () => {
    expect(wordDistance(tokenize("She has lived here for almost ten years."), tokenize(spellNumbers("She has lived here for almost 10 years.")))).toBe(0);
    expect(wordDistance(tokenize("She has lived here for almost ten years."), tokenize("She has lived here for almost 10 years."))).toBe(1);
    expect(wordDistance(tokenize("There were twenty five people."), tokenize(spellNumbers("There were 25 people.")))).toBe(0);
  });
});

describe("dictation-check-v1", () => {
  it("ignores case, punctuation and spacing; apostrophes are deleted", () => {
    expect(isCorrect("It's already finished.", "its already   FINISHED")).toBe(true);
    expect(isCorrect("We're late.", "were late")).toBe(true);
  });
  it("does not merge what must stay different", () => {
    expect(isCorrect("He's here", "his here")).toBe(false);
    expect(isCorrect("They're here", "their here")).toBe(false);
    expect(isCorrect("We're here", "we are here")).toBe(true); // a contraction and its long form are the same
    expect(isCorrect("I have two", "I have 2")).toBe(false);
    expect(isCorrect("me too", "me to")).toBe(false);
  });
  it("accepts a contraction written in full and the other way round", () => {
    expect(isCorrect("I'm sure it's fine.", "I am sure it is fine")).toBe(true);
    expect(isCorrect("I am sure it is fine.", "I'm sure it's fine")).toBe(true);
    expect(isCorrect("They don't know what we've done.", "they do not know what we have done")).toBe(true);
    expect(isCorrect("You can't go.", "you cannot go")).toBe(true);
    expect(isCorrect("It's already finished.", "its already finished")).toBe(true);
    expect(isCorrect("I am sure.", "I sure")).toBe(false);
    expect(isCorrect("He is here.", "his here")).toBe(false);
  });
  it("hyphens and dashes are spaces", () => {
    expect(isCorrect("a well-known fact", "a well known fact")).toBe(true);
    expect(tokenize("word—word")).toEqual(["word", "word"]);
  });
  it("accepts listed regional spellings only", () => {
    expect(isCorrect("my favourite colour", "my favorite color")).toBe(true);
    expect(isCorrect("a quiet street", "a quiet streat")).toBe(false);
  });
  it("counts missing, extra and swapped words", () => {
    expect(wordDistance(tokenize("one two three"), tokenize("one three"))).toBe(1);
    expect(wordDistance(tokenize("one two"), tokenize("one two three"))).toBe(1);
    expect(wordDistance(tokenize("one two three"), tokenize("three two one"))).toBe(2);
    const { ops } = alignWords(["a", "b", "c"], ["a", "x", "c", "d"]);
    expect(ops.map((o) => o.op)).toEqual(["same", "wrong", "same", "extra"]);
  });
});

describe("hint position", () => {
  const words = displayWords("By the time we arrived, the film had started.");
  it("empty field, unfinished word, missing word, complete answer", () => {
    expect(stuckWord(words, [])).toBe(0);
    expect(stuckWord(words, tokenize("By the time we arriv"))).toBe(4);
    expect(stuckWord(words, tokenize("By the we"))).toBe(2);
    expect(stuckWord(words, tokenize("By the time we arrived the film had started"))).toBeNull();
    expect(stuckWord(words, tokenize("By the time we"))).toBe(4);
  });
  it("levels reveal one word, a prefix, everything; earlier reveals accumulate", () => {
    expect(revealFor(1, 4, 9)).toEqual([4, 4]);
    expect(revealFor(2, 4, 9)).toEqual([0, 4]);
    expect(revealFor(3, 4, 9)).toEqual([0, 8]);
    expect([...revealedSet([[4, 4], [0, 6]])].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
  it("a hint finds the stuck word across a contraction written either way", () => {
    expect(stuckWord(displayWords("I am sure it is fine here today"), tokenize("I'm sure it's fine"))).toBe(6);
    expect(stuckWord(displayWords("I'm sure it's fine here today"), tokenize("I am sure it is"))).toBe(3);
  });
  it("hyphenated display words count as several parts", () => {
    expect(stuckWord(displayWords("a well-known fact today"), tokenize("a well known"))).toBe(2);
  });
});

describe("sentence rules and coefficients", () => {
  const ok = "The new update broke half of my plugins last night.";
  const ru = "Новое обновление сломало половину моих плагинов.";
  it("accepts a plain sentence and refuses the listed problems", () => {
    expect(checkSentence(ok, ru)).toBeNull();
    expect(checkSentence("Too short here.", ru)).toBe("WORD_COUNT");
    expect(checkSentence("The new update broke half of my plugins last night", ru)).toBe("NOT_ENDED");
    expect(checkSentence("The new update broke 5 of my plugins last night.", ru)).toBe("CHARS");
    expect(checkSentence("The new API update broke half of my plugins last night.", ru)).toBe("ACRONYM");
    expect(checkSentence("Then Anna and Peter said the update broke their plugins.", ru)).toBe("NAMES");
    expect(checkSentence("The new update broke half of their plugins last night.", ru)).toBe("HOMOPHONE");
    expect(checkSentence(ok, "no russian")).toBe("TRANSLATION");
  });
  it("rejects an empty or implausible WAV and pads a short tail", () => {
    expect(checkWav(Buffer.alloc(10), 8).ok).toBe(false);
    const rate = 22050;
    const n = rate * 3;
    const buf = Buffer.alloc(44 + n * 2);
    buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(8000 * Math.sin(i / 8)), 44 + i * 2);
    const r = checkWav(buf, 10);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.audioMs).toBeGreaterThanOrEqual(3150);
    expect(checkWav(buf, 100).ok).toBe(false);
  });
  it("speeds a sentence up by at most about 20%, never slows it, deterministically", () => {
    const xs = Array.from({ length: 200 }, (_, i) => variedLengthScale(1.3, `lesson:${i}:1`));
    expect(Math.max(...xs)).toBeLessThanOrEqual(1.3);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(1.04);
    expect(new Set(xs).size).toBeGreaterThan(10);
    expect(variedLengthScale(1.3, "a:1:1")).toBe(variedLengthScale(1.3, "a:1:1"));
    expect(variedLengthScale(0.9, "z")).toBeGreaterThanOrEqual(0.85);
  });
});
