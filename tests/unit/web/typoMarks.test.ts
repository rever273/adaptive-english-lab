import { describe, expect, it } from "vitest";
import { slipLimit, typoMarks } from "../../../apps/web/src/typoMarks.js";

const red = (typed: string, expected: string) => { const m = typoMarks(typed, expected); return m && Array.from(typed).filter((_, i) => m[i]).join(""); };

describe("typo marks", () => {
  it("marks the wrong letter", () => { expect(red("insentive", "incentive")).toBe("s"); });
  it("marks an extra letter and ignores case", () => { expect(red("Incentivve", "incentive")).toBe("v"); });
  it("marks the letter at a gap for a missing letter", () => { expect(red("incentve", "incentive")).toBe("v"); expect(red("incentiv", "incentive")).toBe("v"); });
  it("marks nothing for a right answer or one too far away", () => {
    expect(typoMarks("incentive", "incentive")).toBeNull();
    expect(typoMarks("banana", "incentive")).toBeNull();
    expect(typoMarks("cat", "dog")).toBeNull();
    expect(typoMarks("", "dog")).toBeNull();
  });
  it("allows more slips for longer words", () => { expect([4, 5, 7, 8, 12].map(slipLimit)).toEqual([1, 2, 2, 3, 3]); expect(red("incintave", "incentive")).toBe("ia"); });
});
