import { describe, expect, it } from "vitest";
import { buildKeys, countRequired, requiredKeyOf, splitSentences, tokensOf } from "../../../packages/contracts/src/typingText.js";

describe("typing text character map", () => {
  it("maps letters to lower-case, digits/space/punctuation to themselves, and skips quotes/dashes/apostrophes", () => {
    expect(requiredKeyOf("A")).toBe("a");
    expect(requiredKeyOf("Z")).toBe("z");
    expect(requiredKeyOf("5")).toBe("5");
    expect(requiredKeyOf(" ")).toBe(" ");
    expect(requiredKeyOf(",")).toBe(",");
    expect(requiredKeyOf("?")).toBe("?");
    expect(requiredKeyOf("-")).toBe("-");
    expect(requiredKeyOf("'")).toBeNull();
    expect(requiredKeyOf("’")).toBeNull();
    expect(requiredKeyOf("“")).toBeNull();
    expect(requiredKeyOf("—")).toBeNull();
    expect(requiredKeyOf("(")).toBeNull();
    expect(requiredKeyOf("*")).toBeNull();
  });

  it("strips diacritics to the base letter", () => {
    expect(requiredKeyOf("é")).toBe("e");
    expect(requiredKeyOf("É")).toBe("e");
  });

  it("builds the required keys of a sentence, skipping quotes and apostrophes but keeping punctuation", () => {
    const text = "“I don't know,” Winston said.";
    const s = splitSentences(text)[0]!;
    const keys = buildKeys(text, s.start, s.end).map((k) => k.key);
    expect(keys.join("")).toBe("i dont know, winston said.");
  });

  it("requires apostrophes inside words in version 2 while skipping dialogue quotes", () => {
    const text = "'Winston's' don't It\u2019s black-moustachio'd.";
    const keys = buildKeys(text, 0, text.length, 2);
    expect(keys.map((k) => k.key).join("")).toBe("winston's don't it's black-moustachio'd.");
    expect(keys.filter((k) => k.key === "'")).toHaveLength(4);
    expect(buildKeys(text, 0, text.length, 1).filter((k) => k.key === "'")).toHaveLength(0);
    expect(countRequired(text, 0, text.length, 2) - countRequired(text, 0, text.length, 1)).toBe(4);
    expect(tokensOf(text, { start: 0, end: text.length }, 2).some((t) => t.keys.some((k) => k.key === "'"))).toBe(true);
  });

  it("counts required characters over a range deterministically", () => {
    const text = "“I don't know,” Winston said.";
    const n = countRequired(text, 0, text.length);
    expect(n).toBe("i dont know, winston said.".length);
  });

  it("splits sentences and merges abbreviations", () => {
    const text = "Mr. Smith arrived. Then he left.";
    const s = splitSentences(text);
    expect(s.length).toBe(2);
    expect(text.slice(s[0]!.start, s[0]!.end)).toBe("Mr. Smith arrived.");
    expect(text.slice(s[1]!.start, s[1]!.end)).toBe("Then he left.");
  });

  it("turns a dash without surrounding spaces into one required space", () => {
    const text = "word—word";
    const s = splitSentences(text)[0]!;
    const keys = buildKeys(text, s.start, s.end).map((k) => k.key);
    expect(keys).toEqual(["w", "o", "r", "d", " ", "w", "o", "r", "d"]);
  });

  it("skips unspaced dashes in version 3 without changing hyphens or real spaces", () => {
    const text = "live—did well-known — yes–indeed";
    expect(buildKeys(text, 0, text.length, 3).map((k) => k.key).join("")).toBe("livedid well-known yesindeed");
    expect(buildKeys(text, 0, text.length, 2).map((k) => k.key).join("")).toBe("live did well-known yes indeed");
  });

  it("builds tokens from a sentence (a leading quote is skipped, trailing punctuation belongs to the token)", () => {
    const text = "He said, \"Go!\"";
    const s = splitSentences(text)[0]!;
    const tokens = tokensOf(text, s);
    expect(tokens.map((t) => text.slice(t.startOffset, t.endOffset))).toEqual(['He', 'said,', 'Go!"']);
  });
});
