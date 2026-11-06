import { describe, expect, it } from "vitest";
import { flagsFactor, liveFactor, offlineFactor, SHARED_FAILURE_WEIGHT } from "../../../apps/server/src/domain/voices/weights.js";

describe("voice weight factors (version 1)", () => {
  it("live: no checks is neutral, a voice that is often misheard drops to the floor, a perfect one rises a little", () => {
    expect(liveFactor(0, 0)).toBe(1);
    expect(liveFactor(5, 20)).toBe(0.4);
    expect(liveFactor(40, 40)).toBeGreaterThan(1);
    expect(liveFactor(400, 400)).toBeLessThanOrEqual(1.25);
    expect(liveFactor(30, 40)).toBeLessThan(liveFactor(36, 40));
  });

  it("live: a failure on a sentence nobody could say counts for half (D127)", () => {
    expect(SHARED_FAILURE_WEIGHT).toBe(0.5);
    // 10 sentences, 6 heard back on the first voice; the 4 misses were sentences every voice failed, so they weigh 2 instead of 4
    expect(liveFactor(6, 6 + 4 * SHARED_FAILURE_WEIGHT)).toBeGreaterThan(liveFactor(6, 10));
  });

  it("flags: 1 mark in 10 sentences gives 0.7, never below 0.5, and few sentences do not exaggerate", () => {
    expect(flagsFactor(0, 0)).toBe(1);
    expect(flagsFactor(1, 10)).toBe(0.7);
    expect(flagsFactor(1, 3)).toBe(0.7); // fewer than ten sentences count as ten
    expect(flagsFactor(10, 20)).toBe(0.5);
    expect(flagsFactor(200, 200)).toBe(0.5);
  });

  it("offline: 90% exact is neutral, quality scores move it within 0.6-1.2, a missing score is ignored", () => {
    expect(offlineFactor(0.9, null, null)).toBe(1);
    expect(offlineFactor(0.5, null, null)).toBe(0.6);
    expect(offlineFactor(1, null, null)).toBeCloseTo(1.2, 5);
    expect(offlineFactor(0.9, 3.4, 3.0)).toBeGreaterThan(1);
    expect(offlineFactor(0.9, 2.5, 3.0)).toBeLessThan(1);
  });
});
