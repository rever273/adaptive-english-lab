import { describe, expect, it } from "vitest";
import { ClosedFormAssessor } from "../../../apps/server/src/domain/content/grader.js";

const payload = (accept_any: boolean) => ({
  sentence: "The latest software updates is ready.",
  segments: [{ id: "w1", text: "The " }, { id: "w2", text: "latest " }, { id: "w3", text: "software " }, { id: "w4", text: "updates " }, { id: "w5", text: "is " }, { id: "w6", text: "ready." }],
  accepted_segment_ids: ["w4", "w5"],
  no_mistake: false,
  corrections: ["The latest software updates are ready."],
  optional_correction: true,
  ...(accept_any ? { accept_any: true } : {}),
});
const verdict = (accept_any: boolean, optionIds: string[]) =>
  ClosedFormAssessor.assess({ exerciseType: "detect_error", content: { payload: payload(accept_any) }, rawAnswer: { kind: "options", optionIds }, idk: false } as never).verdict;

describe("detect_error with accept_any (word-level items)", () => {
  it("accepts tapping any one word of the error and nothing else", () => {
    expect(verdict(true, ["w4"])).toBe("correct");
    expect(verdict(true, ["w5"])).toBe("correct");
    expect(verdict(true, ["w2"])).toBe("incorrect");
    expect(verdict(true, ["w4", "w5"])).toBe("incorrect");
  });
  it("keeps exact set equality for older block items", () => {
    expect(verdict(false, ["w4"])).toBe("incorrect");
    expect(verdict(false, ["w4", "w5"])).toBe("correct");
  });
});
