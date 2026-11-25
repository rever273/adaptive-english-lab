import { describe, expect, it } from "vitest";
import { planScreening } from "../../../apps/server/src/domain/vocabTyping/screening.js";

const lemmas = (band: number, n: number): string[] => Array.from({ length: n }, (_, i) => `b${band}w${i}`);
const bands = new Map<number, string[]>([1, 2, 3, 4].map((b) => [b, lemmas(b, 50)]));
const inOrder = [...bands.values()].flat();

describe("screening plan", () => {
  it("mixes the next words by frequency with seeded probes, in a shuffled order", () => {
    const plan = planScreening({ inOrder, bands, probeCounts: new Map(), size: 20, probeShare: 0.25, seed: 7 });
    expect(plan).toHaveLength(20);
    expect(plan.filter((w) => w.probe)).toHaveLength(5);
    expect(new Set(plan.map((w) => w.lemma)).size).toBe(20);
    const ordered = plan.filter((w) => !w.probe).map((w) => w.lemma);
    expect(new Set(ordered)).toEqual(new Set(inOrder.slice(0, 15)));
    expect(plan.map((w) => w.lemma)).not.toEqual([...inOrder.slice(0, 15), ...plan.filter((w) => w.probe).map((w) => w.lemma)]);
  });

  it("is deterministic for a seed and differs between seeds", () => {
    const a = planScreening({ inOrder, bands, probeCounts: new Map(), size: 20, probeShare: 0.25, seed: 7 });
    expect(planScreening({ inOrder, bands, probeCounts: new Map(), size: 20, probeShare: 0.25, seed: 7 })).toEqual(a);
    expect(planScreening({ inOrder, bands, probeCounts: new Map(), size: 20, probeShare: 0.25, seed: 8 })).not.toEqual(a);
  });

  it("draws probes from the bands with the fewest probes so far", () => {
    const counts = new Map([[1, 30], [2, 30], [3, 0], [4, 0]]);
    const plan = planScreening({ inOrder, bands, probeCounts: counts, size: 20, probeShare: 0.25, seed: 1 });
    const probeBands = plan.filter((w) => w.probe).map((w) => Number(w.lemma.slice(1, 2)));
    expect(probeBands.every((b) => b === 3 || b === 4)).toBe(true);
  });

  it("takes no probes at share 0 and never repeats a word of the in-order part", () => {
    const plan = planScreening({ inOrder, bands, probeCounts: new Map(), size: 20, probeShare: 0, seed: 3 });
    expect(plan.some((w) => w.probe)).toBe(false);
    expect(new Set(plan.map((w) => w.lemma))).toEqual(new Set(inOrder.slice(0, 20)));
  });

  it("fills the batch with probes when few ordered words are left", () => {
    const plan = planScreening({ inOrder: ["b1w0", "b1w1"], bands, probeCounts: new Map(), size: 10, probeShare: 0.1, seed: 5 });
    expect(plan).toHaveLength(10);
    expect(plan.filter((w) => !w.probe)).toHaveLength(2);
  });
});
