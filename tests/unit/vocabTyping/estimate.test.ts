import { describe, expect, it } from "vitest";
import { estimateVocabulary, ESTIMATE_VERSION, monotoneDecreasing, type BandInput } from "../../../apps/server/src/domain/vocabTyping/estimate.js";

const band = (b: number, o: Partial<BandInput> = {}): BandInput => ({ band: b, pool: 1000, known: 0, unknown: 0, probeKnown: 0, probeUnknown: 0, ...o });

describe("vt-estimate-v1", () => {
  it("shows no number before 100 screened words", () => {
    const e = estimateVocabulary([band(1, { known: 40, unknown: 10 }), band(2)]);
    expect(e.estimate).toBeNull();
    expect(e.version).toBe(ESTIMATE_VERSION);
    expect(e.screened).toBe(50);
  });

  it("known words count fully and the rest is extrapolated from the share in the band", () => {
    // band 1: 100 screened, 90 known; 900 left at 90% -> 90 + 810 = 900
    const e = estimateVocabulary([band(1, { known: 90, unknown: 10 })]);
    expect(e.estimate).toBe(900);
    expect(e.low!).toBeLessThan(900);
    expect(e.high!).toBeGreaterThan(900);
    expect(e.high!).toBeLessThanOrEqual(1000);
  });

  it("uses probes when a band has enough of them (the in-order words are the easy ones)", () => {
    const withoutProbes = estimateVocabulary([band(1, { known: 95, unknown: 5 })]);
    const withProbes = estimateVocabulary([band(1, { known: 95 + 5, unknown: 5 + 15, probeKnown: 5, probeUnknown: 15 })]);
    expect(withProbes.bands[0]!.source).toBe("probes");
    expect(withProbes.bands[0]!.p).toBeCloseTo(0.25);
    expect(withProbes.estimate!).toBeLessThan(withoutProbes.estimate!);
  });

  it("a rarer band is never estimated better known than a commoner one", () => {
    const e = estimateVocabulary([band(1, { known: 50, unknown: 50 }), band(2, { known: 90, unknown: 10 })]);
    expect(e.bands[1]!.p).toBeLessThanOrEqual(e.bands[0]!.p + 1e-9);
    expect(monotoneDecreasing([0.2, 0.8], [10, 10])).toEqual([0.5, 0.5]);
  });

  it("bands without a sample take their neighbours' share and widen the interval", () => {
    const e = estimateVocabulary([band(1, { known: 90, unknown: 10 }), band(2), band(3, { known: 10, unknown: 90 })]);
    expect(e.bands[1]!.source).toBe("interpolated");
    expect(e.bands[1]!.p).toBeGreaterThan(e.bands[2]!.p);
    expect(e.bands[1]!.p).toBeLessThan(e.bands[0]!.p);
    const narrow = estimateVocabulary([band(1, { known: 90, unknown: 10 }), band(2, { known: 50, unknown: 50 }), band(3, { known: 10, unknown: 90 })]);
    expect(e.high! - e.low!).toBeGreaterThan(narrow.high! - narrow.low!);
  });

  it("never counts a word twice and respects the pool (excluded words are not in it)", () => {
    const e = estimateVocabulary([band(1, { pool: 100, known: 100, unknown: 0 })]);
    expect(e.estimate).toBe(100);
    expect(e.high).toBe(100);
    const small = estimateVocabulary([band(1, { pool: 150, known: 60, unknown: 40 })]);
    expect(small.estimate!).toBeLessThanOrEqual(150);
    expect(small.estimate!).toBeGreaterThanOrEqual(60);
  });
});
