import { describe, expect, it } from "vitest";
import { segmentFixes } from "../../../apps/server/src/domain/sessions/feedback.js";

const segs = [{ id: "s1", text: "The latest software " }, { id: "s2", text: "updates is" }, { id: "s3", text: " already available for download." }];

describe("detect_error right answer", () => {
  it("cuts a whole corrected sentence back to the faulty segment", () => {
    expect(segmentFixes(segs, "s2", ["The latest software updates are already available for download."])).toEqual(["updates are"]);
  });
  it("keeps a correction that is already the segment", () => {
    expect(segmentFixes(segs, "s2", ["updates are"])).toEqual(["updates are"]);
  });
});

import { aiExplanation } from "../../../apps/server/src/domain/sessions/feedback.js";
describe("AI explanation text", () => {
  it("replaces the literal word null or an empty text with a plain sentence", () => {
    expect(aiExplanation("acceptable", "null")).toBe("Предложение грамматически верно и передаёт смысл задания.");
    expect(aiExplanation("acceptable", "")).toContain("грамматически верно");
    expect(aiExplanation("incorrect_candidate", null)).toContain("неверным");
  });
  it("keeps a real explanation", () => {
    expect(aiExplanation("incorrect_candidate", "Нужна форма are, а не is.")).toBe("Нужна форма are, а не is.");
  });
});
