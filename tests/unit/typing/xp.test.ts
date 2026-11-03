import { describe, expect, it } from "vitest";
import { typingXpForBooks, typingXpForWords } from "../../../apps/server/src/domain/typing/xp.js";

describe("typing XP (typing-xp-v1)", () => {
  it("awards 4/3 XP per destroyed word (40 for a 30-word level)", () => {
    expect(typingXpForWords(30)).toBe(40);
    expect(typingXpForWords(15)).toBe(20);
    expect(typingXpForWords(10)).toBe(13); // round(40/3)
  });

  it("is never below 1 for any completed level", () => {
    expect(typingXpForWords(1)).toBe(1);
    expect(typingXpForBooks(1)).toBe(1);
  });

  it("awards one XP per 12 required book characters", () => {
    expect(typingXpForBooks(600)).toBe(50); // ~5 min at 25 wpm = 625 chars
    expect(typingXpForBooks(120)).toBe(10);
  });
});
