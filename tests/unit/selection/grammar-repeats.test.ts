import { describe, expect, it } from "vitest";
import { fixedBank } from "./fixed-bank.js";
import { DEFAULT_QUOTAS, GRAMMAR_REPEAT_CONFIG, hardViolations, selectSession, type Candidate, type Dimension, type Format, type SelectionInput } from "../../../packages/learning/src/index.js";

const FAMILIES = ["articles", "tenses", "verb_patterns", "prepositions", "questions", "modals", "conditionals", "passive"];
const DIM: Record<Format, Dimension> = { choose_form: "recognition", choose_missing_fragment: "recognition", detect_error: "correction", guided_short_answer: "production", russian_to_english_short: "production", context_reading: "recognition" };

let seq = 0;
type Rep = NonNullable<Candidate["repeat"]>["reason"];
/** `perFormat` exercises of each format; the first `repeats[format]` of them are repeats with the given reason */
function bank(perFormat: Partial<Record<Format, number>>, repeats: Partial<Record<Format, Rep>> = {}, repeatCount: Partial<Record<Format, number>> = {}): Candidate[] {
  const out: Candidate[] = [];
  for (const [format, count] of Object.entries(perFormat) as Array<[Format, number]>) {
    for (let i = 0; i < count; i++) {
      const id = ++seq;
      const family = FAMILIES[(i + id) % FAMILIES.length]!;
      const reason = repeats[format];
      const isRepeat = reason !== undefined && i < (repeatCount[format] ?? count);
      out.push({
        revisionId: `g${String(id).padStart(5, "0")}`,
        exerciseId: `ge${String(id).padStart(5, "0")}`,
        format,
        dimension: DIM[format],
        skillId: `${family}.skill${i % 3}`,
        family,
        contextId: `ctx${id}`,
        templateCluster: `tpl${id}`,
        bankRole: "practice",
        noMistake: format === "detect_error" && i % 4 === 0,
        childCount: 1,
        // a repeat keeps no fingerprint of its already shown sentences
        unitFingerprints: isRepeat ? [] : [`gfp-${id}-a`, `gfp-${id}-b`],
        ...(isRepeat ? { repeat: { reason: reason!, ofSlotId: `old-${id}` } } : {}),
      });
    }
  }
  return out;
}
const input = (candidates: Candidate[], o: Partial<SelectionInput> = {}): SelectionInput => ({
  n: 18,
  weakRatio: 0.65,
  voiceTarget: 2,
  seed: "rep-1",
  quotas: DEFAULT_QUOTAS,
  readingBlocks: 0,
  candidates,
  blocked: new Set(),
  priority: () => 0.5,
  planMultiplier: () => 1,
  discovery: { bonusBySkill: {}, limit: 0 },
  ...o,
});
const FRESH = { choose_form: 12, choose_missing_fragment: 12, detect_error: 12, guided_short_answer: 4, russian_to_english_short: 5 } as const;
const repeatsIn = (r: ReturnType<typeof selectSession>) => r.slots.filter((s) => s.repeat);

describe("grammar repeats in the solver (D68)", () => {
  it("the config is the one the task fixes: 30% soon, 14 days for a correct answer", () => {
    expect(GRAMMAR_REPEAT_CONFIG).toMatchObject({ soonShare: 0.3, correctAfterDays: 14 });
  });

  it("a bank without repeats gives exactly the old session: the revision ids equal what the unchanged selection-v1 code produced", () => {
    // expected lists were generated with the pre-D68 selection.ts (git HEAD) on the same fixed bank, priority and seeds
    const expected: Record<string, string[]> = {
      "base-1": ["f003", "f028", "f016", "f038", "f042", "f004", "f029", "f017", "f044", "f006", "f031", "f019", "f008", "f032", "f020", "f012", "f034", "f024"],
      "base-2": ["f002", "f028", "f013", "f038", "f041", "f003", "f029", "f014", "f042", "f004", "f033", "f016", "f006", "f035", "f018", "f010", "f036", "f024"],
    };
    for (const seed of Object.keys(expected)) {
      const r = selectSession(input(fixedBank(), { seed, priority: (s) => (s.length % 5) / 5 }));
      expect(r.feasible).toBe(true);
      expect(r.slots.map((x) => x.revisionId)).toEqual(expected[seed]);
      expect(r.slots.every((x) => !("repeat" in x))).toBe(true);
    }
  });

  it("fresh first: repeats after a correct answer are not used while fresh exercises fill the quotas", () => {
    const c = [...bank(FRESH), ...bank({ choose_form: 6, detect_error: 6 }, { choose_form: "review", detect_error: "review" })];
    const r = selectSession(input(c));
    expect(r.feasible).toBe(true);
    expect(repeatsIn(r)).toHaveLength(0);
  });

  it("repeats after a correct answer fill the lesson only when fresh exercises cannot (and stay within the total cap)", () => {
    // 3 fresh choose_form + 9 reviews: quota 5 needs 2 repeats
    const c = [...bank({ ...FRESH, choose_form: 3 }), ...bank({ choose_form: 9 }, { choose_form: "review" })];
    const r = selectSession(input(c));
    expect(r.feasible).toBe(true);
    const rep = repeatsIn(r);
    expect(rep.length).toBe(2);
    expect(rep.every((s) => s.repeat!.reason === "review" && s.format === "choose_form")).toBe(true);
    expect(rep.length).toBeLessThanOrEqual(Math.floor(GRAMMAR_REPEAT_CONFIG.totalShare * 18));
  });

  it("missed / assisted repeats may take up to 30% of the slots even when fresh exercises exist, never more", () => {
    const missed = bank({ choose_form: 8, choose_missing_fragment: 8, detect_error: 8 }, { choose_form: "missed", choose_missing_fragment: "assisted", detect_error: "missed" });
    const c = [...bank(FRESH), ...missed];
    const cap = Math.floor(GRAMMAR_REPEAT_CONFIG.soonShare * 18); // 5
    for (const seed of ["a", "b", "c", "d", "e", "f"]) {
      const r = selectSession(input(c, { seed, priority: (s) => (/skill0|skill1/.test(s) ? 0.9 : 0.1) }));
      expect(r.feasible).toBe(true);
      expect(repeatsIn(r).length).toBeLessThanOrEqual(cap);
      expect(hardViolations(r.slots, 18, new Map(c.map((x) => [x.revisionId, x])), new Set())).toEqual([]);
    }
    // with a priority that favours the missed skills, the cap is reached on at least one seed
    const used = ["a", "b", "c", "d", "e", "f"].map((seed) => repeatsIn(selectSession(input(c, { seed, priority: () => 0.9 }))).length);
    expect(Math.max(...used)).toBeGreaterThan(0);
  });

  it("an exercise is never used twice in one session, repeat or not", () => {
    const c = [...bank(FRESH), ...bank({ choose_form: 10, detect_error: 10 }, { choose_form: "missed", detect_error: "assisted" })];
    for (const seed of ["x", "y", "z"]) {
      const r = selectSession(input(c, { seed }));
      expect(new Set(r.slots.map((s) => s.exerciseId)).size).toBe(r.slots.length);
    }
  });

  it("is deterministic by seed with repeats in the bank", () => {
    const c = [...bank(FRESH), ...bank({ choose_form: 6 }, { choose_form: "missed" })];
    const a = selectSession(input(c, { seed: "same" }));
    const b = selectSession(input(c, { seed: "same" }));
    expect(b).toEqual(a);
  });

  it("a repeat never takes a discovery probe slot", () => {
    const c = [...bank(FRESH), ...bank({ choose_form: 6, detect_error: 6 }, { choose_form: "missed", detect_error: "missed" })];
    const skill = c.find((x) => !x.repeat && x.format === "choose_form")!.skillId;
    const r = selectSession(input(c, { discovery: { bonusBySkill: { [skill]: 1 }, limit: 1 } }));
    expect(r.feasible).toBe(true);
    expect(r.slots.filter((s) => s.role === "discovery").every((s) => !s.repeat)).toBe(true);
  });

  it("the validator refuses a session whose repeats exceed the cap", () => {
    const c = bank({ choose_form: 18 }, { choose_form: "missed" });
    const fake = c.map((x, i) => ({ ordinal: i, revisionId: x.revisionId, exerciseId: x.exerciseId, format: x.format, dimension: x.dimension, skillId: x.skillId, family: x.family, role: "explore" as const, priority: 0, multiplier: 1, bonus: 0, readingGroupId: null, childIndex: null, inputPreference: "text" as const, repeat: x.repeat }));
    expect(hardViolations(fake, 18, new Map(c.map((x) => [x.revisionId, x])), new Set()).join("|")).toMatch(/above the cap/);
  });

  it("the strict hard rules hold for repeats: a blocked (reserved) unit of a repeat keeps it out", () => {
    const c = bank({ choose_form: 3 }, { choose_form: "missed" }).map((x) => ({ ...x, unitFingerprints: ["held"] }));
    const r = selectSession(input([...bank({ ...FRESH, choose_form: 4 }), ...c], { blocked: new Set(["held"]) }));
    expect(r.feasible).toBe(false);
    expect(r.deficits.some((d) => d.kind === "format" && d.format === "choose_form")).toBe(true);
  });

  it("a missed 4-question passage that does not fit the repeat cap gives a proper shortage, never an invariant error (n=10)", () => {
    const passage = (id: string, repeat?: Candidate["repeat"]): Candidate => ({ revisionId: id, exerciseId: `e-${id}`, format: "context_reading", dimension: "recognition", skillId: "linking.contrast", family: "linking", contextId: `c-${id}`, templateCluster: `t-${id}`, bankRole: "practice", noMistake: false, childCount: 4, unitFingerprints: repeat ? [] : [`p-${id}`], ...(repeat ? { repeat } : {}) });
    const c = [...bank({ choose_form: 12, choose_missing_fragment: 12, detect_error: 12, guided_short_answer: 4, russian_to_english_short: 5 }), passage("rd1", { reason: "missed", ofSlotId: "old" })];
    const r = selectSession(input(c, { n: 10, quotas: scaleTen(), readingBlocks: 1 }));
    expect(r.feasible).toBe(false);
    expect(r.deficits[0]).toMatchObject({ kind: "reading" });
    // a review passage (4 questions) fits the total cap of 6 and is used
    const ok = selectSession(input([...c.slice(0, -1), passage("rd2", { reason: "review", ofSlotId: "old" })], { n: 10, quotas: scaleTen(), readingBlocks: 1 }));
    expect(ok.feasible).toBe(true);
    expect(hardViolations(ok.slots, 10, new Map(c.concat(passage("rd2", { reason: "review", ofSlotId: "old" })).map((x) => [x.revisionId, x])), new Set())).toEqual([]);
  });

  it("when the repeat limit is the binding constraint the shortage says so", () => {
    // 2 fresh choose_form of 5 needed; 9 reviews would do for the format, but only floor(0.6*18)=10 repeats total across formats and 3 formats are short
    const c = [
      ...bank({ choose_form: 0, choose_missing_fragment: 0, detect_error: 0, guided_short_answer: 4, russian_to_english_short: 5 }),
      ...bank({ choose_form: 12, choose_missing_fragment: 12, detect_error: 12 }, { choose_form: "review", choose_missing_fragment: "review", detect_error: "review" }),
    ];
    const r = selectSession(input(c));
    expect(r.feasible).toBe(false);
    const d = r.deficits.find((x) => x.kind === "repeat_cap");
    expect(d?.message).toMatch(/repeated exercise\(s\) can be used per session; \d+ more NEW exercise/);
  });
});

function scaleTen() {
  return { choose_form: 3, choose_missing_fragment: 2, detect_error: 3, guided_short_answer: 1, russian_to_english_short: 1 };
}
