import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadKeyData } from "../../../apps/server/src/domain/typing/keys/data.js";
import { accuracyOutlook, accuracyScore, confidence, DEFAULT_TARGET_CPM, goalForecast, keyStats, learningRate, lessonKeys, type KeyLessonRow } from "../../../apps/server/src/domain/typing/keys/guided.js";
import { polynomialRegression, r2 } from "../../../apps/server/src/domain/typing/keys/regression.js";
import { keyLessonText, pseudoShare, realWordPool } from "../../../apps/server/src/domain/typing/keys/text.js";

const root = path.resolve(__dirname, "../../..");
const seeded = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const target = 60000 / DEFAULT_TARGET_CPM; // ms per key at the target

describe("keybr data", () => {
  const data = loadKeyData(root);
  it("loads the English model with letters in frequency order and the word list", () => {
    expect(data.lettersByFrequency).toHaveLength(26);
    expect(data.lettersByFrequency.slice(0, 3)).toContain("e");
    expect(data.words.length).toBeGreaterThan(40000);
    expect(data.wordSet.has("colour")).toBe(true); // Australian spelling
    expect(data.wordSet.has("don")).toBe(false); // half of "don't"
  });
  it("pseudo-words use only open letters, contain the focused one and are 3+ letters", () => {
    const letters = new Set(data.lettersByFrequency.slice(0, 6));
    const focused = data.lettersByFrequency[5]!;
    const rnd = seeded(7);
    for (let i = 0; i < 200; i++) {
      const w = data.model.nextWord({ letters, focused }, rnd);
      expect(w.length).toBeGreaterThanOrEqual(3);
      expect([...w].every((c) => letters.has(c))).toBe(true);
      expect(w).toContain(focused);
    }
  });
  it("mixes real words and marked pseudo-words; few open letters give mostly pseudo-words", () => {
    const letters = new Set(data.lettersByFrequency.slice(0, 6));
    const filter = { letters, focused: null };
    const tokens = keyLessonText(data.words, data.wordSet, data.model, filter, 300, seeded(3));
    expect(tokens).toHaveLength(300);
    for (const t of tokens) expect(t.kind === "word" ? data.wordSet.has(t.text) : !data.wordSet.has(t.text)).toBe(true);
    const pseudo = tokens.filter((t) => t.kind === "pseudo").length / tokens.length;
    expect(pseudo).toBeGreaterThan(0.25); // ~0.7 generated, some of them turn out to be real words
    for (let i = 1; i < tokens.length; i++) expect(tokens[i]!.text).not.toBe(tokens[i - 1]!.text);
    expect(realWordPool(data.words, filter).every((w) => w.length <= 6)).toBe(true); // short words while few keys are open
  });
  it("pseudo share falls as the real-word pool grows", () => {
    expect(pseudoShare(0)).toBe(0.5);
    expect(pseudoShare(1500)).toBe(0.2);
    expect(pseudoShare(5000)).toBe(0.2);
  });
});

describe("guided keys (keybr rules)", () => {
  const letters = ["e", "t", "a", "o", "i", "n", "s", "h"];
  const rows = (letter: string, times: number[]): KeyLessonRow[] => times.map((ms, i) => ({ lessonIndex: i, at: i * 60000, letter, hits: 20, misses: 1, meanMs: ms }));

  it("starts with a plain mean, then smooths with alpha 0.1; the best counts from the third lesson; errors are smoothed too", () => {
    const twelve = keyStats("e", Array.from({ length: 12 }, (_, i) => ({ lessonIndex: i, at: i, letter: "e", hits: 19, misses: i < 10 ? 1 : 0, meanMs: i === 0 ? 1000 : 300 })));
    const mean10 = (1000 + 9 * 300) / 10; // a slow first lesson weighs 1/10, not 100% falling by 10% a lesson
    expect(twelve.samples[9]!.filteredTimeToType).toBeCloseTo(mean10);
    expect(twelve.timeToType).toBeCloseTo(0.1 * 300 + 0.9 * (0.1 * 300 + 0.9 * mean10));
    // misses and presses are smoothed separately (weight 0.9 per later lesson), so a lesson counts by its presses
    const w = (i: number) => 0.9 ** (11 - i);
    const m = [...Array(10).keys()].reduce((a, i) => a + w(i), 0);
    const p = [...Array(12).keys()].reduce((a, i) => a + 20 * w(i), 0);
    expect(twelve.errorRate).toBeCloseTo(m / p);
    expect(twelve.errorBound!).toBeLessThan(twelve.errorRate!);
  });
  it("keeps the old example's raw data in order", () => {
    const s = keyStats("e", rows("e", [500, 300, 1000, 30 /* invalid, ignored */]));
    expect(s.samples).toHaveLength(3);
    expect(s.timeToType).toBeCloseTo((500 + 300 + 1000) / 3);
    expect(s.bestTimeToType).toBeCloseTo((500 + 300 + 1000) / 3); // only from the third lesson on
    expect(confidence(target, DEFAULT_TARGET_CPM)).toBeCloseTo(1);
  });
  it("opens six keys first, the seventh only when all six reached the target, and focuses the weakest", () => {
    const start = lessonKeys(letters, [], { targetCpm: DEFAULT_TARGET_CPM });
    expect(start.filter((k) => k.included).map((k) => k.letter)).toEqual(letters.slice(0, 6));
    expect(start.find((k) => k.focused)?.letter).toBe("e"); // all at 0: the first of them

    const fast = letters.slice(0, 6).flatMap((l) => rows(l, [target * 0.9, target * 0.9, target * 0.9]));
    const slowN = [...fast.filter((r) => r.letter !== "n"), ...rows("n", [target * 1.5, target * 1.5, target * 1.5])];
    const k1 = lessonKeys(letters, slowN, { targetCpm: DEFAULT_TARGET_CPM });
    expect(k1.filter((k) => k.included)).toHaveLength(6);
    expect(k1.find((k) => k.focused)?.letter).toBe("n");

    const k2 = lessonKeys(letters, fast, { targetCpm: DEFAULT_TARGET_CPM });
    expect(k2.filter((k) => k.included).map((k) => k.letter)).toEqual(letters.slice(0, 7));
    expect(k2.find((k) => k.focused)?.letter).toBe("s"); // the new key has no data yet

    // a fast key with fewer than three lessons is not reached yet: the seventh key stays closed
    const young = [...fast.filter((r) => r.letter !== "n"), ...rows("n", [target * 0.5, target * 0.5])];
    const k3 = lessonKeys(letters, young, { targetCpm: DEFAULT_TARGET_CPM });
    expect(k3.filter((k) => k.included)).toHaveLength(6);
    expect(k3.find((k) => k.letter === "n")!.readiness).toBeLessThan(1);
  });
  it("chooses focus using mostly speed and also smoothed errors without changing the opening gate", () => {
    const order = ["r", "t", "a", "o", "i", "n", "s"];
    const make = (letter: string, cpm: number, misses: number) => Array.from({ length: 10 }, (_, i) => ({
      lessonIndex: i, at: i, letter, hits: 100 - misses, misses, meanMs: 60000 / cpm,
    }));
    const other = order.slice(2, 6).flatMap((l) => make(l, 250, 0));
    const input = [...other, ...make("r", 218, 15), ...make("t", 214, 2)];
    const keys = lessonKeys(order, input, { targetCpm: 225 });
    expect(keys.find((k) => k.focused)?.letter).toBe("r");
    expect(keys.filter((k) => k.included)).toHaveLength(6);
    // A much slower key still takes priority over the error difference.
    const slower = lessonKeys(order, [...other, ...make("r", 218, 15), ...make("t", 160, 2)], { targetCpm: 225 });
    expect(slower.find((k) => k.focused)?.letter).toBe("t");
  });
});

describe("speed forecast", () => {
  it("fits a polynomial exactly to exact data", () => {
    const xs = [1, 2, 3, 4, 5, 6];
    const ys = xs.map((x) => 2 + 3 * x - 0.5 * x * x);
    const m = polynomialRegression(xs, ys, 2);
    expect(m.eval(10)).toBeCloseTo(2 + 30 - 50);
    expect(r2(xs, ys, m)).toBeCloseTo(1);
  });
  it("predicts the lessons left to reach the target from a steady improvement", () => {
    const s = keyStats("e", Array.from({ length: 14 }, (_, i) => ({ lessonIndex: i, at: i * 60000, letter: "e", hits: 30, misses: 0, meanMs: 600 - i * 15 })));
    const lr = learningRate(s.samples, DEFAULT_TARGET_CPM);
    expect(lr).not.toBeNull();
    expect(lr!.cpmPerLesson).toBeGreaterThan(0);
    expect(lr!.remainingLessons).toBeGreaterThan(0);
  });
  it("forecasts lessons and hours to the goal from a straight line through recent lessons", () => {
    const lessons = Array.from({ length: 20 }, (_, i) => ({ cpm: 150 + i * 2, activeMs: 60_000 }));
    const f = goalForecast(lessons, 275)!;
    expect(f.cpmPerLesson).toBeCloseTo(2);
    expect(f.lessonsToGoal).toBe(Math.ceil((275 - 188) / 2));
    expect(f.hoursToGoal).toBeCloseTo((f.lessonsToGoal! * 60_000) / 3_600_000, 1);
    expect(goalForecast(lessons.slice(0, 9), 275)).toBeNull();
    expect(goalForecast(lessons.map((l, i) => ({ ...l, cpm: 200 - i })), 275)!.lessonsToGoal).toBeNull();
  });
  it("keys opened earlier stay open under a higher target", () => {
    const keys = lessonKeys(["e", "t", "a", "o", "i", "n", "s", "h"], [], { targetCpm: 300, alreadyOpen: new Set(["s"]) });
    expect(keys.filter((k) => k.included).map((k) => k.letter)).toEqual(["e", "t", "a", "o", "i", "n", "s"]);
  });
  it("accuracy is judged over all open keys together: one sloppy key does not hold the next letter back", () => {
    const letters = ["e", "t", "a", "o", "i", "n", "s"];
    const fastMs = target * 0.8;
    const make = (misses: (l: string) => number) => letters.slice(0, 6).flatMap((l) => Array.from({ length: 3 }, (_, i) => ({ lessonIndex: i, at: i, letter: l, hits: 20, misses: misses(l), meanMs: fastMs })));
    const oneBad = lessonKeys(letters, make((l) => (l === "t" ? 3 : 0)), { targetCpm: DEFAULT_TARGET_CPM });
    expect(oneBad.filter((k) => k.included)).toHaveLength(7); // t alone is 13% wrong, all keys together about 2%
    const allBad = lessonKeys(letters, make((l) => (l === "t" ? 6 : 2)), { targetCpm: DEFAULT_TARGET_CPM });
    expect(allBad.filter((k) => k.included)).toHaveLength(6); // about 9% wrong overall: s stays closed
    expect(allBad.find((k) => k.focused)?.letter).toBe("t"); // the key with the most wrong presses is practised
    expect(lessonKeys(letters, make((l) => (l === "t" ? 6 : 2)), { targetCpm: DEFAULT_TARGET_CPM, minAccuracy: 0.8 }).filter((k) => k.included)).toHaveLength(7);
  });
});

describe("accuracy outlook", () => {
  const row = (i: number, hits: number, misses: number): KeyLessonRow => ({ lessonIndex: i, at: i, letter: "a", hits, misses, meanMs: 300 });
  it("counts clean lessons to the limit and gives no usual estimate when recent accuracy is above it", () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(i, 46, 4)); // 8% wrong every lesson
    const o = accuracyOutlook("a", rows, 0.95);
    expect(o.recentErrorRate).toBeCloseTo(0.08);
    expect(o.usualLessons).toBeNull();
    // lower bound of 8% over ~500 smoothed presses is ~6.8%; two clean lessons of 50 presses bring it under 5%
    expect(o.cleanLessons).toBe(2);
  });
  it("does not hold a key back for one wrong press in a short lesson (within chance)", () => {
    const st = keyStats("a", [row(0, 14, 1), row(1, 14, 1), row(2, 14, 1)]); // 6.7% wrong over 45 presses
    expect(st.errorRate!).toBeGreaterThan(0.05);
    expect(st.errorBound!).toBeLessThan(0.05);
    expect(accuracyScore(st.errorBound, 0.95)).toBeGreaterThanOrEqual(1);
  });
  it("weighs a miss by how many keys were open: clean easy lessons do not hide misses made with more keys", () => {
    const easy = (i: number, misses: number): KeyLessonRow => ({ lessonIndex: i, at: i, openKeys: 6, letter: "n", hits: 20 - misses, misses, meanMs: 300 });
    const hard = (i: number, misses: number): KeyLessonRow => ({ lessonIndex: i, at: i, openKeys: 24, letter: "n", hits: 20 - misses, misses, meanMs: 300 });
    // 5 clean lessons with 6 keys, then 5 lessons with 24 keys at 10% wrong: plain smoothing gives ~6.3%
    const rows = [...[0, 1, 2, 3, 4].map((i) => easy(i, 0)), ...[5, 6, 7, 8, 9].map((i) => hard(i, 2))];
    const plain = keyStats("n", rows.map(({ openKeys: _o, ...r }) => r));
    const weighted = keyStats("n", rows);
    expect(plain.errorRate!).toBeLessThan(0.065);
    expect(weighted.errorRate!).toBeGreaterThan(0.08);
    // with every lesson at the same number of keys the weights cancel
    const same = keyStats("n", rows.map((r) => ({ ...r, openKeys: 10 })));
    expect(same.errorRate).toBeCloseTo(plain.errorRate!, 10);
  });
  it("is 0 when the key is already within the limit", () => {
    const o = accuracyOutlook("a", Array.from({ length: 5 }, (_, i) => row(i, 99, 1)), 0.95);
    expect(o).toMatchObject({ cleanLessons: 0, usualLessons: 0 });
  });
});
