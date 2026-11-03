import { describe, expect, it } from "vitest";
import { computeMetrics, skillOf } from "../../../apps/server/src/domain/typing/metrics.js";

describe("typing metrics (typing-metrics-v1)", () => {
  it("computes WPM as charsCorrect/5 per active minute and CPM per minute", () => {
    const m = computeMetrics({ mode: "words", activeMs: 60000, charsTyped: 100, errors: 0, charsCorrect: 250, level: 1, completed: true });
    expect(m.wpm).toBeCloseTo(50, 1);
    expect(m.cpm).toBeCloseTo(250, 1);
  });

  it("returns null accuracy when nothing was typed, not 100", () => {
    const m = computeMetrics({ mode: "books", activeMs: 60000, charsTyped: 0, errors: 0, charsCorrect: 0, level: 1, completed: true });
    expect(m.accuracy).toBeNull();
  });

  it("keeps corrected errors in the accuracy denominator", () => {
    const m = computeMetrics({ mode: "books", activeMs: 60000, charsTyped: 100, errors: 10, charsCorrect: 90, level: 1, completed: true });
    expect(m.accuracy).toBeCloseTo(90, 0);
  });

  it("does not raise score for extra wrong keystrokes", () => {
    const clean = computeMetrics({ mode: "words", activeMs: 60000, charsTyped: 250, errors: 0, charsCorrect: 250, level: 1, completed: true });
    const noisy = computeMetrics({ mode: "words", activeMs: 60000, charsTyped: 300, errors: 50, charsCorrect: 250, level: 1, completed: true });
    expect(noisy.score).toBeLessThan(clean.score);
  });

  it("adds the completion bonus only for completed Words levels", () => {
    const done = computeMetrics({ mode: "words", activeMs: 60000, charsTyped: 250, errors: 0, charsCorrect: 250, level: 1, completed: true });
    const failed = computeMetrics({ mode: "words", activeMs: 60000, charsTyped: 250, errors: 0, charsCorrect: 250, level: 1, completed: false });
    expect(done.score).toBe(failed.score + 100);
  });

  it("maps skill tiers by WPM and accuracy", () => {
    expect(skillOf("words", 90, 97)).toBe("Excellent");
    expect(skillOf("words", 65, 95)).toBe("Very Fast");
    expect(skillOf("words", 45, 93)).toBe("Fast");
    expect(skillOf("words", 30, 91)).toBe("Comfortable");
    expect(skillOf("words", 20, 80)).toBe("Developing");
    // accuracy gate: high WPM but low accuracy drops a tier
    expect(skillOf("words", 90, 50)).toBe("Developing");
  });
});
