import { describe, expect, it } from "vitest";
import { answerLetterFacts } from "../../../apps/server/src/domain/typing/dictation/keyFacts.js";

const total = (m: Map<string, { hits: number; misses: number }>, key: "hits" | "misses") => [...m.values()].reduce((a, f) => a + f[key], 0);

describe("answerLetterFacts", () => {
  it("counts every letter of a right answer as a hit", () => {
    const f = answerLetterFacts("The cat sat.", "the cat sat");
    expect(total(f, "misses")).toBe(0);
    expect(total(f, "hits")).toBe(9);
    expect(f.get("t")).toEqual({ hits: 3, misses: 0 });
  });
  it("marks the letter typed wrong or left out inside a wrong word, and ignores words never typed", () => {
    const wrong = answerLetterFacts("a cat sat", "a cot sat");
    expect(wrong.get("a")).toEqual({ hits: 2, misses: 1 }); // "a" and "sat" right; the a of "cat" typed as o
    const left = answerLetterFacts("a cat sat", "a ct sat");
    expect(left.get("a")?.misses).toBe(1);
    const unfinished = answerLetterFacts("a cat sat", "a cat");
    expect(total(unfinished, "misses")).toBe(0);
    expect(total(unfinished, "hits")).toBe(4);
  });
});
