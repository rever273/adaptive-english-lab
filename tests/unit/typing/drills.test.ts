import { describe, expect, it } from "vitest";
import { buildLines, createDrillsEngine, exportDrillWords, handleDrillKey, tickDrills, type DrillsConfig } from "../../../apps/web/src/game/drillsEngine.js";
import { fingerCost, stageOf } from "../../../apps/server/src/domain/typing/fingerCost.js";
import { MAX_STEP, wordProgress } from "../../../apps/server/src/domain/typing/drills.js";
import type { TypingDrillWord } from "../../../packages/contracts/src/typing.js";

const word = (planIndex: number, lemma: string, extra: Partial<TypingDrillWord> = {}): TypingDrillWord => ({ planIndex, lemma, source: "general", vocabularyEntryId: null, translationRu: null, showTranslation: false, speak: false, review: false, ...extra });
const config = (lemmas: string[], over: Partial<DrillsConfig> = {}): DrillsConfig => ({ plan: lemmas.map((l, i) => word(i, l)), lives: 5, ...over });
const type = (e: ReturnType<typeof createDrillsEngine>, text: string, start = 0, step = 100) => [...text].flatMap((c, i) => handleDrillKey(e, c, start + i * step));

describe("finger cost (finger-cost-v1)", () => {
  it("makes home-row words cheaper than same-finger and row-jumping words", () => {
    expect(fingerCost("sad")!).toBeLessThan(fingerCost("ice")!); // ce: same finger
    expect(fingerCost("dad")!).toBeLessThan(fingerCost("tree")!);
    expect(fingerCost("ask")!).toBeLessThan(fingerCost("myth")!);
    expect(fingerCost("Sad")).toBeNull();
  });

  it("opens keys and lengths stage by stage and never offers long words early", () => {
    expect(stageOf("desk", 2)).toBe(1);
    expect(stageOf("toast", 2)).toBe(2); // t, o open at stage 2
    expect(stageOf("animal", 2)).toBe(3); // n, m and six letters
    expect(stageOf("fresh", 4)).toBe(5); // difficulty 4 waits for stage 5
    expect(stageOf("collection", 3)).toBe(6);
    expect(stageOf("extraordinarily", 2)).toBeNull(); // longer than 12
    expect(stageOf("desk", null)).toBe(1); // own words ignore the bank difficulty
  });
});

describe("learned words (drill-rules-v2)", () => {
  const level = (session: number, errors: number[], ms: number | null = 3 * 300) => errors.map((e) => ({ errors: e, ms, session }));
  it("learns by accuracy over all levels after enough showings, not by one level", () => {
    expect(wordProgress("sad", level(0, Array(9).fill(0)), 400).step).toBe(0); // fewer than MIN_SHOWINGS
    expect(wordProgress("sad", level(0, Array(10).fill(0)), 400).step).toBe(1);
    expect(wordProgress("sad", level(0, [1, 1, ...Array(8).fill(0)]), 400).step).toBe(0); // 80%
    expect(wordProgress("sad", [...level(0, [1, 1, ...Array(8).fill(0)]), ...level(1, Array(10).fill(0))], 400)).toMatchObject({ step: 1, accuracy: 0.9 }); // 18 of 20
  });

  it("moves a learned word up after clean fast levels, down after an error, and back to practice when accuracy falls", () => {
    const base = level(0, Array(10).fill(0));
    const climbed = [...base, ...[1, 2, 3, 4, 5, 6].flatMap((s) => level(s, [0]))];
    expect(wordProgress("sad", climbed, 400).step).toBe(MAX_STEP); // never beyond the top step
    expect(wordProgress("sad", [...base, ...level(1, [0], 3 * 380)], 400).step).toBe(1); // 380 > 0.9 × 400: clean but slow
    expect(wordProgress("sad", [...climbed, ...level(7, [1])], 400).step).toBe(MAX_STEP - 1);
    expect(wordProgress("sad", [...base, ...level(1, [1, 1, 1])], 400).step).toBe(0); // 10 of 13
    const p = wordProgress("sad", [...base, ...level(1, [0, 0])], 400);
    expect(p.history).toEqual([[0, true], [1, true]]);
    expect(p.msPerLetter).toBe(300);
  });
});

describe("drills engine", () => {
  it("lays words out in lines that never exceed the slot width", () => {
    const lines = buildLines(Array.from({ length: 30 }, () => ({ lemma: "salad" })), 48);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) for (const w of l.words) expect(w.unitStart + 5).toBeLessThanOrEqual(48);
    expect(lines[0]!.words.map((w) => w.unitStart)).toEqual([0, 8, 16, 24, 32, 40]); // letter + 3-unit gap, evenly
    expect(lines[0]!.chars).toBe(36);
    expect(lines.flatMap((l) => l.words.map((w) => w.index))).toEqual(Array.from({ length: 30 }, (_, i) => i));
  });

  it("does not accept a wrong key, needs the space to finish a word and measures the first letter to the space", () => {
    const cfg = config(["sad", "dad"]);
    const e = createDrillsEngine(cfg);
    handleDrillKey(e, "s", 1000);
    handleDrillKey(e, "x", 1100); // wrong: nothing moves
    expect(e.words[0]!.progress).toBe(1);
    type(e, "ad", 1200);
    expect(e.words[0]!.done).toBe(false);
    handleDrillKey(e, "d", 1400); // a letter instead of the space is an error too
    const done = handleDrillKey(e, " ", 1500);
    expect(done.some((x) => x.type === "done")).toBe(true);
    expect(e.words[0]!.mistakes).toBe(2);
    expect(e.words[0]!.typeMs).toBe(500);
    expect(e.errors).toBe(2);
    expect(e.charsTyped).toBe(6);
    expect(exportDrillWords(e)).toEqual([{ planIndex: 0, errors: 2, completed: true, typeMs: 500 }]);
    const won = type(e, "dad ", 2000);
    expect(won.some((x) => x.type === "won")).toBe(true);
  });

  it("never hurries: time alone takes no life, every wrong key takes one and none left ends the level", () => {
    const cfg = config(["sad", "dad"], { lives: 3 });
    const e = createDrillsEngine(cfg);
    tickDrills(e, 60_000);
    expect(e.activeMs).toBe(0); // active time starts with the first key
    handleDrillKey(e, "s", 0);
    tickDrills(e, 600_000);
    expect(e.lives).toBe(3);
    expect(e.activeMs).toBe(600_000);
    expect(handleDrillKey(e, "x", 1)).toContainEqual({ type: "life", left: 2 });
    handleDrillKey(e, " ", 1500); // a space too early is a wrong key as well
    expect(e.lives).toBe(1);
    const last = handleDrillKey(e, "q", 3000);
    expect(last).toContainEqual({ type: "failed" });
    expect(e.failed).toBe(true);
    expect(handleDrillKey(e, "a", 4)).toEqual([]); // nothing after the end
  });

  it("a burst of wrong keys costs one life: the next one is counted as a mistake only after the grace time", () => {
    const e = createDrillsEngine(config(["sad"], { lives: 5 }));
    handleDrillKey(e, "x", 1000);
    handleDrillKey(e, "y", 1200);
    handleDrillKey(e, "z", 1400);
    expect(e.lives).toBe(4);
    expect(e.errors).toBe(3); // every wrong key is still a mistake in the statistics
    handleDrillKey(e, "q", 2100);
    expect(e.lives).toBe(3);
  });

  it("ends the level on the last letter of the last word, without a space", () => {
    const e = createDrillsEngine(config(["sad", "dad"]));
    type(e, "sad ", 0);
    const ev = type(e, "dad", 1000);
    expect(ev.map((x) => x.type)).toEqual(["hit", "hit", "hit", "done", "won"]);
    expect(e.words[1]!.typeMs).toBe(200);
    expect(e.charsTyped).toBe(7);
  });

  it("reports the word being typed as unfinished", () => {
    const e = createDrillsEngine(config(["sad", "dad"]));
    type(e, "sad da", 0);
    expect(exportDrillWords(e)).toEqual([
      { planIndex: 0, errors: 0, completed: true, typeMs: 300 },
      { planIndex: 1, errors: 0, completed: false, typeMs: null },
    ]);
  });
});
