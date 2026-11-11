import { describe, expect, it } from "vitest";
import { splitSentences } from "../../../packages/contracts/src/typingText.js";

const parts = (t: string) => splitSentences(t).map((s) => t.slice(s.start, s.end));

describe("splitSentences with lower-case sentence starts", () => {
  it("breaks after . ! ? before a lower-case word", () => {
    expect(parts("Last night to the flicks. then you saw a boat. there was a woman! might have been")).toEqual(["Last night to the flicks.", "then you saw a boat.", "there was a woman!", "might have been"]);
  });
  it("keeps ellipses, abbreviations, initials and ordinary text together", () => {
    expect(parts("Well... then we left. Mr. smith came, e.g. tom, etc. and went. J. r. said no.")).toEqual(["Well... then we left.", "Mr. smith came, e.g. tom, etc. and went.", "J. r. said no."]);
  });
});
