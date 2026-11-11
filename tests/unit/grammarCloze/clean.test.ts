import { describe, expect, it } from "vitest";
import { cleanAll, cleanRow, type CleanConfig } from "../../../apps/server/src/domain/grammarCloze/clean.js";
import { readColumnar, type RawRow } from "../../../apps/server/src/domain/grammarCloze/source.js";

const cfg: CleanConfig = { version: "t", minWords: 5, maxWords: 40, maxOptionWords: 6, maxOptionChars: 40, noFinalPunctuationFlagShare: 0.02 };
const row = (o: Partial<RawRow> = {}): RawRow => ({ sourceIndex: 1, gappedText: "She ___ to school every day.", solution: "goes", distractors: ["go", "going"], filledText: "She goes to school every day.", sourceTopic: "present_simple", ...o });
const reason = (r: RawRow) => { const o = cleanRow(r, cfg); return o.ok ? "ok" : o.reject.reason; };

describe("columnar source", () => {
  it("turns five column objects into rows and notices index mismatches", () => {
    const col = { gapped_text: { "0": "A ___ b.", "1": "x ___ y." }, solution: { "0": "c", "1": "d" }, distractors: { "0": ["e"], "1": ["f"] }, filled_text: { "0": "A c b.", "1": "x d y." }, grammar_topic: { "0": "t", "1": "t" } };
    const r = readColumnar(col);
    expect(r.rows.map((x) => x.sourceIndex)).toEqual([0, 1]);
    expect(r.indexSetsMatch).toBe(true);
    const b = readColumnar({ ...col, solution: { "0": "c" } });
    expect(b.indexSetsMatch).toBe(false);
    expect(b.rejected).toEqual([{ sourceIndex: 1, reason: "field_missing" }]);
  });
});

describe("cleanRow", () => {
  it("keeps a good row and normalises whitespace and space before punctuation", () => {
    const o = cleanRow(row({ gappedText: "She  ___  to school every day .", filledText: "She goes to school every day ." }), cfg);
    expect(o.ok && o.item.gappedText).toBe("She ___ to school every day.");
    expect(o.ok && o.item.fixes).toContain("whitespace_normalised");
  });
  it("rejects zero or two gaps", () => {
    expect(reason(row({ gappedText: "She goes to school every day." }))).toBe("gap_count");
    expect(reason(row({ gappedText: "She ___ to ___ every day." }))).toBe("gap_count");
  });
  it("removes duplicate distractors that differ only in case and the solution among distractors", () => {
    const o = cleanRow(row({ solution: "is", distractors: ["Is", "are", "IS", "are"], gappedText: "She ___ happy at school today.", filledText: "She is happy at school today." }), cfg);
    expect(o.ok && o.item.distractors).toEqual(["are"]);
    expect(o.ok && o.item.fixes).toEqual(expect.arrayContaining(["distractor_equals_solution", "duplicate_distractor"]));
  });
  it("rejects when fewer than two different options remain", () => {
    expect(reason(row({ distractors: ["Goes", "goes"] }))).toBe("too_few_options");
  });
  it("rejects mojibake and replacement characters but keeps typographic apostrophes", () => {
    expect(reason(row({ gappedText: "She ___ to schoolвЂ™ every day." }))).toBe("encoding");
    expect(reason(row({ solution: "go�es" }))).toBe("encoding");
    expect(cleanRow(row({ gappedText: "It’s true that she ___ to school every day.", filledText: "It’s true that she goes to school every day." }), cfg).ok).toBe(true);
  });
  it("rejects an inconsistent filled text and rebuilds a format-only difference", () => {
    expect(reason(row({ filledText: "She went to school every day." }))).toBe("filled_mismatch");
    expect(cleanRow(row({ filledText: "She  goes to school every day." }), cfg).ok).toBe(true);
  });
  it("applies the sentence length thresholds but not to the answer length", () => {
    expect(reason(row({ gappedText: "He ___ it.", filledText: "He goes it.", solution: "goes" }))).toBe("too_short");
    const ok = cleanRow(row({ gappedText: "By now they ___ finished the whole job.", solution: "would have", filledText: "By now they would have finished the whole job.", distractors: ["will"] }), cfg);
    expect(ok.ok).toBe(true);
    expect(reason(row({ gappedText: "I ___ " + "word ".repeat(45), filledText: "I goes " + "word ".repeat(45) }))).toBe("too_long");
    expect(reason(row({ distractors: ["one two three four five six seven"] }))).toBe("option_too_long");
  });
  it("rejects markup, contacts and empty dialogue turns", () => {
    expect(reason(row({ gappedText: "She ___ to <b>school</b> every day.", filledText: "She goes to <b>school</b> every day." }))).toBe("markup_or_contact");
    expect(reason(row({ gappedText: "Mail ___ me at bob@example.com every day.", filledText: "Mail goes me at bob@example.com every day." }))).toBe("markup_or_contact");
    expect(reason(row({ gappedText: "- Did she ___ to school every day? -", filledText: "- Did she goes to school every day? -" }))).toBe("empty_dialogue_turn");
  });
  it("flags a capital letter in the wrong place", () => {
    const o = cleanRow(row({ gappedText: "Sometimes she ___ to school every day.", solution: "Goes", distractors: ["go"], filledText: "Sometimes she Goes to school every day." }), cfg);
    expect(o.ok && o.item.flagReasons).toContain("case_position");
  });
});

describe("cleanAll", () => {
  it("drops exact duplicates (keeping the smallest index) and flags the same sentence with different keys", () => {
    const a = row({ sourceIndex: 5 });
    const dup = row({ sourceIndex: 9, distractors: ["going", "go"] });
    const c1 = row({ sourceIndex: 20, gappedText: "The book ___ very good and long.", solution: "that", distractors: ["where"], filledText: "The book that very good and long." });
    const c2 = row({ sourceIndex: 21, gappedText: "The book ___ very good and long.", solution: "which", distractors: ["where"], filledText: "The book which very good and long." });
    const r = cleanAll([a, dup, c1, c2], cfg);
    expect(r.items.map((i) => i.sourceIndex)).toEqual([5, 20, 21]);
    expect(r.rejected).toEqual([{ sourceIndex: 9, reason: "duplicate", detail: "5" }]);
    expect(r.items.filter((i) => i.flagReasons.includes("conflicting_keys")).map((i) => i.sourceIndex)).toEqual([20, 21]);
  });
  it("is reproducible", () => {
    const rows = [row({ sourceIndex: 1 }), row({ sourceIndex: 2, solution: "went", gappedText: "She ___ to school yesterday morning.", filledText: "She went to school yesterday morning.", distractors: ["goes"] })];
    expect(JSON.stringify(cleanAll(rows, cfg))).toBe(JSON.stringify(cleanAll(rows, cfg)));
  });
});
