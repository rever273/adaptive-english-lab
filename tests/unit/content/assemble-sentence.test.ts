// TASK_026: assemble_sentence - the blocks helpers, the validator rules and the closed-form grader.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isApprovedOrder, mayHaveNoDistractor, spellsFrom } from "../../../apps/server/src/domain/content/blocks.js";
import { ClosedFormAssessor } from "../../../apps/server/src/domain/content/grader.js";
import { validateExercise } from "../../../apps/server/src/domain/content/validator.js";
import { extractUnits } from "../../../apps/server/src/domain/content/units.js";
import { fixture } from "../../fixtures/exercises/load.js";

const taxonomy = JSON.parse(readFileSync(path.resolve(__dirname, "../../../content/taxonomy/taxonomy-v1.json"), "utf8")) as { skills: Array<{ id: string }> };
const ctx = { taxonomySkillIds: new Set(taxonomy.skills.map((s) => s.id)) };
const codes = (r: { errors: Array<{ code: string }> }) => r.errors.map((e) => e.code);

const B = (...t: string[]) => t.map((text, i) => ({ id: `b${i + 1}`, text }));
const blocks = B("it would", "be", "easier", "to fix", "the issue", "now.", "fix");
const payload = (o: Record<string, unknown> = {}) => ({
  cue_ru: "Скажите, что было бы проще исправить проблему сейчас.",
  blocks,
  distractor_block_ids: ["b7"],
  accepted_answers: ["It would be easier to fix the issue now.", "It would be easier now to fix the issue."],
  ...o,
});
const base = (skill: string, p: Record<string, unknown>) => {
  const c = fixture("choose_missing_fragment" as never) as unknown as Record<string, unknown>;
  return { ...c, type: "assemble_sentence", dimension: "recognition", target_skill: skill, prompt_en: "Build the sentence from the blocks.", payload: p };
};

describe("block helpers", () => {
  it("spellsFrom uses every block exactly once in some order", () => {
    const texts = blocks.slice(0, 6).map((b) => b.text);
    expect(spellsFrom("It would be easier to fix the issue now.", texts)).toBe(true);
    expect(spellsFrom("It would be easier now to fix the issue.", texts)).toBe(true);
    expect(spellsFrom("It would be easier to fix the issue.", texts)).toBe(false); // a block missing
    expect(spellsFrom("It would be easier to fix the issue now now.", texts)).toBe(false); // a block twice
    expect(spellsFrom("It would be easier to fix the problem now.", texts)).toBe(false);
  });
  it("repeated block texts are each used once (two 'the')", () => {
    expect(spellsFrom("the team fixed the bug.", ["the", "team", "fixed", "the", "bug."])).toBe(true);
    expect(spellsFrom("the team fixed bug.", ["the", "team", "fixed", "the", "bug."])).toBe(false);
  });
  it("isApprovedOrder compares the spelled sentence by text, ignoring case and the final full stop; unknown or repeated ids never pass", () => {
    const bl = B("the", "team", "fixed", "the", "bug.");
    const accepted = ["The team fixed the bug."];
    expect(isApprovedOrder(["b1", "b2", "b3", "b4", "b5"], bl, accepted)).toBe(true);
    expect(isApprovedOrder(["b4", "b2", "b3", "b1", "b5"], bl, accepted)).toBe(true); // the two 'the' blocks are interchangeable
    expect(isApprovedOrder(["b2", "b1", "b3", "b4", "b5"], bl, accepted)).toBe(false);
    expect(isApprovedOrder(["b1", "b1", "b3", "b4", "b5"], bl, accepted)).toBe(false);
    expect(isApprovedOrder(["b1", "zz"], bl, accepted)).toBe(false);
  });
  it("only word-order skills may have no wrong block", () => {
    expect(mayHaveNoDistractor("word_order.adverbs")).toBe(true);
    expect(mayHaveNoDistractor("questions.embedded_order")).toBe(true);
    expect(mayHaveNoDistractor("tenses.present_perfect")).toBe(false);
  });
});

describe("assemble_sentence validation", () => {
  it("a complete exercise is valid and its approved sentences are the units (the instruction is not)", () => {
    const c = base("verb_patterns.want_to", payload());
    const r = validateExercise(c, ctx);
    expect(codes(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(extractUnits(c as never).map((u) => u.role)).toEqual(["answer", "answer"]);
  });
  it("is refused as production (the blocks are given)", () => {
    expect(codes(validateExercise({ ...base("verb_patterns.want_to", payload()), dimension: "production" }, ctx))).toContain("DIMENSION_MISMATCH");
  });
  it("a non-order skill without a wrong block is refused; a word-order skill may go without", () => {
    const none = payload({ blocks: blocks.slice(0, 6), distractor_block_ids: [] });
    expect(codes(validateExercise(base("tenses.present_perfect", none), ctx))).toContain("DISTRACTOR_REQUIRED");
    expect(codes(validateExercise(base("word_order.adverbs", none), ctx))).toEqual([]);
  });
  it("every approved sentence must be spelled from the non-wrong blocks; the wrong block may not build a sentence", () => {
    expect(codes(validateExercise(base("verb_patterns.want_to", payload({ accepted_answers: ["It would be easier to fix the problem now."] })), ctx))).toContain("ANSWER_NOT_FROM_BLOCKS");
    const fits = payload({ blocks: B("it would", "be", "easier", "to fix", "the issue", "now.", "to fix"), distractor_block_ids: ["b7"], accepted_answers: ["It would be easier to fix the issue now."] });
    expect(codes(validateExercise(base("verb_patterns.want_to", fits), ctx))).toContain("DISTRACTOR_FITS");
  });
  it("unknown wrong-block ids, duplicate block ids and too few blocks are refused", () => {
    expect(codes(validateExercise(base("verb_patterns.want_to", payload({ distractor_block_ids: ["nope"] })), ctx))).toContain("UNKNOWN_DISTRACTOR");
    expect(codes(validateExercise(base("verb_patterns.want_to", payload({ blocks: [{ id: "b1", text: "a" }, { id: "b1", text: "b" }, { id: "b3", text: "c" }], distractor_block_ids: [], accepted_answers: ["a b c"] })), ctx))).toContain("DUPLICATE_ID");
    expect(validateExercise(base("word_order.adverbs", payload({ blocks: B("go", "now."), distractor_block_ids: [], accepted_answers: ["go now."] })), ctx).ok).toBe(false);
  });
});

describe("assemble_sentence grading", () => {
  const assess = (ids: string[], p = payload()) => ClosedFormAssessor.assess({ exerciseType: "assemble_sentence", content: { payload: p }, rawAnswer: { kind: "options", optionIds: ids }, idk: false } as never);
  it("a spelled approved sentence is confirmed correct, a wrong order or the wrong block is confirmed incorrect, never pending", () => {
    expect(assess(["b1", "b2", "b3", "b4", "b5", "b6"])).toMatchObject({ verdict: "correct", confirmation: "confirmed" });
    expect(assess(["b1", "b2", "b3", "b6", "b4", "b5"])).toMatchObject({ verdict: "correct" }); // the second approved order
    expect(assess(["b1", "b2", "b3", "b4", "b6", "b5"])).toMatchObject({ verdict: "incorrect", confirmation: "confirmed" });
    expect(assess(["b1", "b2", "b3", "b7", "b5", "b6"])).toMatchObject({ verdict: "incorrect", confirmation: "confirmed" });
  });
  it("an order that is not approved is incorrect even if it reads naturally (the list of approved sentences is complete)", () => {
    expect(assess(["b1", "b2", "b3", "b6", "b4", "b5"], payload({ accepted_answers: ["It would be easier to fix the issue now."] }))).toMatchObject({ verdict: "incorrect" });
  });
  it("an unknown block id is an invalid answer, not a wrong one", () => {
    expect(() => assess(["b1", "zz"])).toThrow(/Unknown block/);
  });
});
