import { describe, expect, it } from "vitest";
import { buildPrompt } from "../../../apps/server/src/domain/sessions/reveal.js";

describe("exercise presentation", () => {
  it("varies choice positions but keeps option IDs and order stable when a slot is reopened", () => {
    const content = JSON.stringify({ prompt_en: "Choose", payload: { options: [{ id: "a", text: "one" }, { id: "b", text: "two" }, { id: "c", text: "three" }], multiple: false } });
    const prompt = (slot: string) => buildPrompt("choose_form", content, null, slot);
    expect(prompt("slot-1")).toEqual(prompt("slot-1"));
    const positions = new Set(Array.from({ length: 30 }, (_, i) => {
      const result = prompt(`slot-${i}`);
      if (result.kind !== "choice") throw new Error("wrong prompt");
      expect(new Set(result.options.map((o) => o.id))).toEqual(new Set(["a", "b", "c"]));
      return result.options.findIndex((o) => o.id === "a");
    }));
    expect(positions).toEqual(new Set([0, 1, 2]));
  });

  it("presents correct and erroneous sample sentences in four parts while preserving the actual error ID", () => {
    const wrong = { prompt_en: "Find the error", payload: { sentence: "They are interested for learning more today.", no_mistake: false, accepted_segment_ids: ["s2"], segments: [{ id: "s1", text: "They are interested " }, { id: "s2", text: "for" }, { id: "s3", text: " learning more today." }] } };
    const correct = { prompt_en: "Find the error", payload: { sentence: "They are interested in learning more today.", no_mistake: true, segments: [{ id: "s1", text: "They are interested in learning more today." }] } };
    const positions = new Set<number>();
    for (let i = 0; i < 30; i++) {
      const a = buildPrompt("detect_error", JSON.stringify(wrong), null, `slot-${i}`);
      const b = buildPrompt("detect_error", JSON.stringify(correct), null, `slot-${i}`);
      if (a.kind !== "segments" || b.kind !== "segments") throw new Error("wrong prompt");
      expect(a.segments).toHaveLength(4);
      expect(b.segments).toHaveLength(4);
      expect(a.segments.map((s) => s.text).join("")).toBe(wrong.payload.sentence);
      expect(b.segments.map((s) => s.text).join("")).toBe(correct.payload.sentence);
      positions.add(a.segments.findIndex((s) => s.id === "s2"));
    }
    expect(positions).toEqual(new Set([1, 2]));
  });
});
