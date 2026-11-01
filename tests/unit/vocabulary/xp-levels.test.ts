import { describe, expect, it } from "vitest";
import { levelFromTotal, xpForLevel } from "../../../apps/server/src/domain/sessions/xp.js";

describe("soft-linear level curve", () => {
  it("costs 100 XP for level 1 and 25 more for every next level", () => {
    expect([1, 2, 3, 10].map(xpForLevel)).toEqual([100, 125, 150, 325]);
  });
  it("derives level and progress from the ledger total", () => {
    expect(levelFromTotal(0)).toEqual({ level: 1, withinLevel: 0, threshold: 100 });
    expect(levelFromTotal(60)).toEqual({ level: 1, withinLevel: 60, threshold: 100 });
    expect(levelFromTotal(100)).toEqual({ level: 2, withinLevel: 0, threshold: 125 });
    expect(levelFromTotal(224)).toEqual({ level: 2, withinLevel: 124, threshold: 125 });
    expect(levelFromTotal(225)).toEqual({ level: 3, withinLevel: 0, threshold: 150 });
  });
});
