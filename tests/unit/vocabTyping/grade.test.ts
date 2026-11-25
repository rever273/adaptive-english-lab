import { describe, expect, it } from "vitest";
import { editDistance, gapSentence, gradeCloze } from "../../../apps/server/src/domain/vocabTyping/grade.js";
import { formsOf } from "../../../apps/server/src/domain/vocabTyping/matching.js";

const forms = formsOf({ lemma: "achieve", pos: "verb", past: [], participle: [] });

describe("cloze grading (D169)", () => {
  it("the exact form is correct, ignoring case, spaces and outer punctuation", () => {
    expect(gradeCloze("achieved", "achieved", forms)).toEqual({ outcome: "correct", rating: "good" });
    expect(gradeCloze("  Achieved. ", "achieved", forms)).toEqual({ outcome: "correct", rating: "good" });
  });

  it("another form of the same lemma is a marked match and still good", () => {
    expect(gradeCloze("achieve", "achieved", forms)).toEqual({ outcome: "form_match", rating: "good" });
    expect(gradeCloze("achieving", "achieved", forms)).toEqual({ outcome: "form_match", rating: "good" });
  });

  it("one slip in a word of five or more letters is a typo and good; shorter words get no such tolerance", () => {
    expect(gradeCloze("achived", "achieved", forms)).toEqual({ outcome: "typo", rating: "good" });
    expect(gradeCloze("acheived", "achieved", forms)).toEqual({ outcome: "typo", rating: "good" }); // two swapped letters
    expect(gradeCloze("achievedd", "achieved", forms)).toEqual({ outcome: "typo", rating: "good" });
    expect(gradeCloze("achivd", "achieved", forms)).toEqual({ outcome: "incorrect", rating: "again" });
    expect(gradeCloze("bak", "back", ["back"])).toEqual({ outcome: "incorrect", rating: "again" });
    expect(gradeCloze("cot", "cat", ["cat"])).toEqual({ outcome: "incorrect", rating: "again" });
  });

  it("anything else is wrong; revealing is again", () => {
    expect(gradeCloze("finish", "achieved", forms)).toEqual({ outcome: "incorrect", rating: "again" });
    expect(gradeCloze("", "achieved", forms)).toEqual({ outcome: "incorrect", rating: "again" });
    expect(gradeCloze(null, "achieved", forms)).toEqual({ outcome: "revealed", rating: "again" });
  });

  it("measures edits with a swap as one", () => {
    expect(editDistance("form", "from")).toBe(1);
    expect(editDistance("abc", "abc")).toBe(0);
    expect(editDistance("kitten", "sitting")).toBe(3);
  });

  it("gaps the stored span only", () => {
    expect(gapSentence("She achieved her goal.", 4, 8)).toBe("She ____ her goal.");
  });
});
