import { describe, expect, it } from "vitest";
import { isSpeakableSentence } from "../../../apps/web/src/components/SpeakButton";

describe("practice sentence playback", () => {
  it("accepts complete sentences including incorrect ones", () => {
    expect(isSpeakableSentence("How long does the crossing take?")).toBe(true);
    expect(isSpeakableSentence("She go to work every day.")).toBe(true);
  });
  it("excludes gaps, fragments and passages", () => {
    expect(isSpeakableSentence("She has a ___.")).toBe(false);
    expect(isSpeakableSentence("take")).toBe(false);
    expect(isSpeakableSentence("One sentence. Another sentence.")).toBe(false);
  });
});
