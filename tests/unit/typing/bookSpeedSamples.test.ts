import { describe, expect, it } from "vitest";
import { BookSpeedSamples } from "../../../apps/web/src/game/bookSpeedSamples.js";

describe("temporary Books speed samples", () => {
  it("records per-interval speed and errors and keeps a partial final interval", () => {
    const sampler = new BookSpeedSamples({ charsTyped: 100, errorCount: 4 });
    sampler.advance(4999, { charsTyped: 119, errorCount: 5 });
    sampler.advance(1, { charsTyped: 121, errorCount: 5 });
    sampler.advance(5000, { charsTyped: 137, errorCount: 7 });
    sampler.advance(2000, { charsTyped: 144, errorCount: 8 });
    expect(sampler.finish({ charsTyped: 144, errorCount: 8 })).toEqual([
      { elapsedMs: 5000, intervalMs: 5000, wpm: 48, errors: 1 },
      { elapsedMs: 10000, intervalMs: 5000, wpm: 33.6, errors: 2 },
      { elapsedMs: 12000, intervalMs: 2000, wpm: 36, errors: 1 },
    ]);
  });
  it("does not add a duplicate final point and returns a separate snapshot", () => {
    const sampler = new BookSpeedSamples({ charsTyped: 0, errorCount: 0 });
    sampler.advance(5000, { charsTyped: 10, errorCount: 0 });
    const first = sampler.finish({ charsTyped: 10, errorCount: 0 });
    first[0]!.wpm = 999;
    expect(sampler.finish({ charsTyped: 10, errorCount: 0 })).toEqual([{ elapsedMs: 5000, intervalMs: 5000, wpm: 24, errors: 0 }]);
  });
  it("counts no elapsed time while the scene does not advance", () => {
    const sampler = new BookSpeedSamples({ charsTyped: 0, errorCount: 0 });
    sampler.advance(2000, { charsTyped: 5, errorCount: 0 });
    // A pause does not call advance, regardless of its wall-clock duration.
    sampler.advance(3000, { charsTyped: 10, errorCount: 0 });
    expect(sampler.finish({ charsTyped: 10, errorCount: 0 })[0]).toMatchObject({ elapsedMs: 5000, wpm: 24, errors: 0 });
  });
});
