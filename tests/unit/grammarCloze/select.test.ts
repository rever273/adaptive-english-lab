import { describe, expect, it } from "vitest";
import { groupSizes, orderOptions, planSession, type Candidate } from "../../../apps/server/src/domain/grammarCloze/select.js";

const bank = (rules: Record<string, number>): Candidate[] => Object.entries(rules).flatMap(([r, n]) => Array.from({ length: n }, (_, i) => ({ itemId: `${r}#${i}`, ruleKey: r })));
const counts = (l: Candidate[]) => l.reduce<Record<string, number>>((m, c) => ((m[c.ruleKey] = (m[c.ruleKey] ?? 0) + 1), m), {});

describe("planSession", () => {
  it("group sizes: 15 is six pairs and a triple", () => {
    expect(groupSizes(15)).toEqual([2, 2, 2, 2, 2, 2, 3]);
    expect(groupSizes(10)).toEqual([2, 2, 2, 2, 2]);
    expect(groupSizes(1)).toEqual([1]);
    expect(groupSizes(3)).toEqual([3]);
  });
  it("picks seven rules, six pairs and a triple, whatever the bank sizes", () => {
    const available = bank({ a: 500, b: 3, c: 40, d: 40, e: 9, f: 9, g: 100, h: 100, i: 100, j: 100 });
    const plan = planSession({ available, history: new Map(), size: 15, seed: 1 });
    expect(plan).toHaveLength(15);
    expect(new Set(plan.map((c) => c.itemId)).size).toBe(15);
    const c = Object.values(counts(plan)).sort();
    expect(c).toEqual([2, 2, 2, 2, 2, 2, 3]);
  });
  it("prefers the rules planned least before", () => {
    const available = bank({ a: 20, b: 20, c: 20, d: 20, e: 20, f: 20, g: 20, h: 20, x: 20 });
    const history = new Map([["a", 30], ["b", 30], ["x", 30]]);
    const plan = planSession({ available, history, size: 15, seed: 5 });
    const c = counts(plan);
    expect(Object.keys(c).sort()).toEqual(["c", "d", "e", "f", "g", "h"].concat(["a", "b", "x"].filter((k) => c[k])).sort());
    for (const k of ["c", "d", "e", "f", "g", "h"]) expect(c[k]).toBeGreaterThanOrEqual(2);
  });
  it("redistributes when a rule has too few sentences, and never repeats a sentence", () => {
    const available = bank({ a: 1, b: 1, c: 2, d: 2 });
    const plan = planSession({ available, history: new Map(), size: 15, seed: 3 });
    expect(plan).toHaveLength(6);
    expect(new Set(plan.map((p) => p.itemId)).size).toBe(6);
  });
  it("uses the remainder of the stage when fewer than the session size are left", () => {
    expect(planSession({ available: bank({ a: 2, b: 1 }), history: new Map(), size: 15, seed: 1 })).toHaveLength(3);
    expect(planSession({ available: [], history: new Map(), size: 15, seed: 1 })).toEqual([]);
  });
  it("skips exhausted rules (they are simply not offered)", () => {
    const plan = planSession({ available: bank({ b: 4, c: 4 }), history: new Map([["b", 0]]), size: 6, seed: 2 });
    expect(Object.keys(counts(plan)).sort()).toEqual(["b", "c"]);
  });
  it("is deterministic for a seed and differs between seeds", () => {
    const available = bank({ a: 9, b: 9, c: 9, d: 9, e: 9, f: 9, g: 9, h: 9 });
    const a1 = planSession({ available, history: new Map(), size: 15, seed: 11 });
    expect(planSession({ available, history: new Map(), size: 15, seed: 11 })).toEqual(a1);
    expect(planSession({ available, history: new Map(), size: 15, seed: 12 })).not.toEqual(a1);
  });
  it("avoids three sentences of one rule in a row when the mix allows it", () => {
    for (let seed = 1; seed < 30; seed++) {
      const p = planSession({ available: bank({ a: 9, b: 9, c: 9, d: 9 }), history: new Map(), size: 12, seed });
      for (let i = 2; i < p.length; i++) expect(p[i]!.ruleKey === p[i - 1]!.ruleKey && p[i]!.ruleKey === p[i - 2]!.ruleKey).toBe(false);
    }
  });
});

describe("orderOptions", () => {
  it("keeps the options, spreads the right position and avoids a third equal position in a row", () => {
    const items = Array.from({ length: 24 }, (_, i) => ({ solution: `s${i}`, distractors: [`x${i}`, `y${i}`, `z${i}`] }));
    const out = orderOptions(items, 7);
    const pos = out.map((o, i) => o.indexOf(`s${i}`));
    for (let i = 0; i < out.length; i++) expect([...out[i]!].sort()).toEqual([`s${i}`, `x${i}`, `y${i}`, `z${i}`].sort());
    for (let p = 0; p < 4; p++) expect(pos.filter((x) => x === p).length).toBe(6);
    for (let i = 2; i < pos.length; i++) expect(pos[i] === pos[i - 1] && pos[i] === pos[i - 2]).toBe(false);
  });
  it("works with 2 and 3 options and is deterministic", () => {
    const items = [{ solution: "a", distractors: ["b"] }, { solution: "c", distractors: ["d", "e"] }];
    const out = orderOptions(items, 3);
    expect(out[0]!.sort()).toEqual(["a", "b"]);
    expect(out[1]!).toHaveLength(3);
    expect(orderOptions(items, 3)).toEqual(orderOptions(items, 3));
  });
});
