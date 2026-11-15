import { describe, expect, it } from "vitest";
import { floatingTicks } from "../../../apps/web/src/components/Chart.js";

describe("floating chart axis (accuracy never reaches 0)", () => {
  it("starts just below the lowest value and ends at or above the highest", () => {
    const a = floatingTicks(88.2, 99.5);
    expect(a.min).toBeGreaterThan(70);
    expect(a.min).toBeLessThanOrEqual(88.2);
    expect(a.top).toBeGreaterThanOrEqual(99.5);
    expect(a.ticks[0]).toBe(a.min);
    expect(a.ticks[a.ticks.length - 1]).toBe(a.top);
  });
  it("copes with a single value and with values that really do reach 0", () => {
    const one = floatingTicks(96, 96);
    expect(one.top).toBeGreaterThan(one.min);
    expect(floatingTicks(0, 100).min).toBe(0);
  });
});
