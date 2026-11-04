import { describe, expect, it } from "vitest";
import { computeSpeed, fallMs, spawnGapMs, type SpeedHistoryPoint } from "../../../apps/server/src/domain/typing/speed.js";

const pt = (status: "completed" | "failed", charsCorrect: number, activeMs: number): SpeedHistoryPoint => ({ status, charsCorrect, activeMs });

describe("typing speed (typing-speed-v3)", () => {
  it("uses a calm default when there is no informative history", () => {
    const s = computeSpeed([], { multiplier: 1.05 });
    expect(s.estimateWpm).toBe(25);
    expect(s.effectiveWpm).toBe(26.3); // round(25 * 1.05)
  });

  it("ignores too-short attempts as uninformative", () => {
    const s = computeSpeed([pt("completed", 10, 5000), pt("completed", 100, 120000)], { multiplier: 1 });
    // only the second is informative (charsCorrect >= 40, activeMs >= 15000)
    expect(s.estimateWpm).toBe(10); // 100 chars / 5 / 2 min
  });

  it("lowers pressure after consecutive failures and recovers after a win", () => {
    const base = { multiplier: 1, previousEstimate: null };
    const fails = computeSpeed([pt("failed", 100, 120000), pt("failed", 100, 120000), pt("failed", 100, 120000)], base);
    expect(fails.pressure).toBeCloseTo(0.7, 1);
    const afterWin = computeSpeed([pt("failed", 100, 120000), pt("completed", 100, 120000)], base);
    expect(afterWin.pressure).toBe(1);
  });

  it("clamps the estimate to ±8% of the previous estimate", () => {
    // previous estimate 25; new raw median much higher (a single fast record)
    const s = computeSpeed([pt("completed", 500, 60000)], { multiplier: 1, previousEstimate: 25 });
    // raw would be 100 wpm; clamped to 25*1.08 = 27
    expect(s.estimateWpm).toBeCloseTo(27, 0);
  });

  it("does not make fast players hit a floor: no fixed 30 wpm minimum", () => {
    const s = computeSpeed([pt("completed", 1000, 60000)], { multiplier: 1 });
    // 1000 chars / 5 / 1 min = 200 wpm raw (no previous estimate)
    expect(s.estimateWpm).toBeCloseTo(200, 0);
    expect(s.msPerChar).toBeLessThan(100);
  });

  it("gives longer words proportionally more fall time", () => {
    expect(fallMs(3, 100)).toBeLessThan(fallMs(10, 100));
    expect(fallMs(30, 100)).toBeLessThanOrEqual(22000);
    expect(fallMs(1, 100)).toBeGreaterThanOrEqual(5000);
  });

  it("scales the spawn gap by the previous word length", () => {
    expect(spawnGapMs(10, 100)).toBeGreaterThan(spawnGapMs(3, 100));
  });

  it("leaves slack: meteors arrive slower than the estimated typing speed", () => {
    // a 5-letter word at 100 ms/char takes 500 ms to type; the next meteor comes later than that
    expect(spawnGapMs(5, 100)).toBeGreaterThan(5 * 100 * 1.5);
  });
});
