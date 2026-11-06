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

describe("vocabulary recall letter tiles", () => {
  const recall = (answer: string, family = "guided_recall", wordRu: string | undefined = "повторять") => JSON.stringify({ prompt_en: "I'd like to ___ that we meet on Friday.", payload: { cue_ru: "(глаг., на r...) повторять", max_words: 1, accepted_answers: [answer], allow_voice: false }, vocabulary: { family, wordRu } });
  const tilesOf = (content: string, slot = "slot-1") => {
    const p = buildPrompt("guided_short_answer", content, null, slot);
    if (p.kind !== "short") throw new Error("wrong prompt");
    return p.build;
  };
  it("gives the letters of the answer plus two decoys, in a stable order, never in the answer's order", () => {
    const b = tilesOf(recall("reiterate"))!;
    expect(b.pattern).toEqual([9]);
    expect(b.meaning_ru).toBe("повторять");
    expect(b.tiles).toHaveLength(11);
    expect([...b.tiles].sort().join("")).toContain([..."reiterate"].sort().join("").slice(0, 3));
    expect(tilesOf(recall("reiterate"))).toEqual(b);
    expect(b.tiles.join("")).not.toBe("reiterate");
    const rest = [...b.tiles];
    for (const l of "reiterate") rest.splice(rest.indexOf(l), 1);
    expect(rest).toHaveLength(2);
  });
  it("handles a phrase and leaves other items without tiles", () => {
    expect(tilesOf(recall("pin down"))!.pattern).toEqual([3, 4]);
    expect(tilesOf(recall("reiterate", "recognition"))).toBeUndefined();
    expect(tilesOf(recall("reiterate", "guided_recall", ""))).toBeUndefined();
    expect(tilesOf(recall("re-iterate"))).toBeUndefined();
  });
});
