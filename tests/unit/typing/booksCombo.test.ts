import { describe, expect, it } from "vitest";
import { COMBO_MILESTONES, comboMultiplier, comboTier, createBooksEngine, handleBookKey, nextMilestone } from "../../../apps/web/src/game/booksEngine.js";

const TEXT = "The quick brown fox jumps over the lazy dog again and again until the evening comes.";
const engine = () => createBooksEngine({ text: TEXT, startOffset: 0, initialOffset: 0, initialActiveMs: 0, initialCharsTyped: 0, initialErrors: 0 });
const type = (s: ReturnType<typeof engine>, str: string) => { for (const ch of str) handleBookKey(s, ch); };

describe("Precision Combo (Books)", () => {
  it("tiers and milestones", () => {
    expect(COMBO_MILESTONES).toEqual([10, 25, 50, 100, 200]);
    expect([0, 9, 10, 24, 25, 49, 50, 99, 100, 199, 200].map(comboTier)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5]);
    expect([5, 10, 25, 50, 100, 200].map(comboMultiplier)).toEqual([1, 1.1, 1.2, 1.3, 1.5, 2]);
    expect(nextMilestone(48)).toBe(50);
    expect(nextMilestone(200)).toBeNull();
  });

  it("grows with correct characters, flags a milestone, and a wrong key resets it but keeps the best", () => {
    const s = engine();
    type(s, TEXT.slice(0, 12));
    expect(s.combo).toBe(12);
    expect(s.milestoneSeq).toBe(1);
    handleBookKey(s, "#"); // wrong key
    expect(s.combo).toBe(0);
    expect(s.bestCombo).toBe(12);
  });

  it("Backspace restores nothing, and a corrected character is not counted again", () => {
    const s = engine();
    type(s, "The q");
    expect(s.combo).toBe(5);
    handleBookKey(s, "x"); // wrong where "u" is expected
    expect(s.combo).toBe(0);
    handleBookKey(s, "Backspace");
    expect(s.combo).toBe(0); // the lost combo does not come back
    handleBookKey(s, "u"); // the corrected character: no credit
    expect(s.combo).toBe(0);
    handleBookKey(s, "i");
    expect(s.combo).toBe(1);
  });

  it("speed does not matter: no time is involved in the combo", () => {
    const s = engine();
    s.sinceLastKeyMs = 60_000;
    type(s, "The");
    expect(s.combo).toBe(3);
  });
});
