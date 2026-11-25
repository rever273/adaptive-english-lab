import { describe, expect, it } from "vitest";
import { diffSentences, isTypo } from "../../../apps/web/src/sentenceDiff.js";

const marks = (l: Array<{ text: string; mark: string }>) => l.map((w) => `${w.text}:${w.mark}`);

describe("sentence diff", () => {
  it("marks a one-letter slip as a typo and the rest as matching", () => {
    const d = diffSentences("We need to be careful with ir", "We need to be careful with it.");
    expect(marks(d.answer).slice(-2)).toEqual(["with:same", "ir:typo"]);
    expect(marks(d.corrected).slice(-1)).toEqual(["it.:typo"]);
    expect(d.answer.filter((w) => w.mark !== "same")).toHaveLength(1);
  });
  it("marks a different word as wrong, an added word in the corrected text as wrong", () => {
    const d = diffSentences("She were tired", "She was very tired");
    expect(marks(d.answer)).toEqual(["She:same", "were:wrong", "tired:same"]);
    expect(marks(d.corrected)).toEqual(["She:same", "was:wrong", "very:wrong", "tired:same"]);
  });
  it("ignores case and punctuation; isTypo needs a near miss", () => {
    expect(diffSentences("It is Fine", "it is fine.").answer.every((w) => w.mark === "same")).toBe(true);
    expect(isTypo("ir", "it")).toBe(true);
    expect(isTypo("were", "are")).toBe(false);
  });
});
