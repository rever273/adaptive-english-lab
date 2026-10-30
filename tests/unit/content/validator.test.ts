import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exerciseSchemaValidator, validateExercise } from "../../../apps/server/src/domain/content/validator.js";
import { FIXTURE_NAMES, fixture, type Exercise, type FixtureName } from "../../fixtures/exercises/load.js";

const taxonomy = JSON.parse(readFileSync(path.resolve(__dirname, "../../../content/taxonomy/taxonomy-v1.json"), "utf8")) as { skills: Array<{ id: string }> };
const ctx = { taxonomySkillIds: new Set(taxonomy.skills.map((s) => s.id)) };
const codes = (r: { errors: Array<{ code: string }> }) => r.errors.map((e) => e.code);
const mutate = (name: FixtureName, f: (c: Exercise) => void): Exercise => {
  const c = fixture(name);
  f(c);
  return c;
};
const check = (c: unknown) => validateExercise(c, ctx);

describe("the schema in content/ is the approved one", () => {
  // the spec copy is kept locally only (documentation/ is not published, D62): compare when it exists
  it.skipIf(!existsSync(path.resolve(__dirname, "../../../documentation/spec/exercise.schema.json")))("is byte-identical to documentation/spec/exercise.schema.json", () => {
    const a = readFileSync(path.resolve(__dirname, "../../../content/schemas/exercise.schema.json"));
    const b = readFileSync(path.resolve(__dirname, "../../../documentation/spec/exercise.schema.json"));
    expect(a.equals(b)).toBe(true);
    expect(typeof exerciseSchemaValidator()).toBe("function");
  });
});

describe("complete fixtures of every format are valid drafts - and still not approved", () => {
  it.each(FIXTURE_NAMES)("%s validates with no errors, a content hash and sentence units", (name) => {
    const r = check(fixture(name));
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.units.length).toBeGreaterThan(0);
    // validation output has no notion of approval at all
    expect(Object.keys(r).sort()).toEqual(["contentHash", "errors", "ok", "units", "warnings"]);
  });

  it("covers all six formats", () => {
    expect(new Set(FIXTURE_NAMES.map((n) => fixture(n).type)).size).toBe(6);
  });

  it("is stable: field order does not change the hash, content does", () => {
    const a = fixture("choose_form");
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(a).reverse())));
    expect(check(reordered).contentHash).toBe(check(a).contentHash);
    expect(check(mutate("choose_form", (c) => (c.topic = "other"))).contentHash).not.toBe(check(a).contentHash);
  });
});

describe("a model cannot hand in authority", () => {
  it.each(["validated", "pending_review", "approved", "flagged", "rejected"])("status %s on input is refused", (status) => {
    const r = check(mutate("choose_form", (c) => (c.status = status)));
    expect(codes(r)).toContain("STATUS_NOT_DRAFT");
    expect(r.ok).toBe(false);
  });

  it("extra fields such as approved/reviewer/release are refused by the strict schema", () => {
    for (const extra of [{ approved: true }, { reviewer: "human:me" }, { release_id: "x" }]) {
      const r = check({ ...fixture("choose_form"), ...extra });
      expect(r.ok).toBe(false);
      expect(codes(r)).toContain("SCHEMA");
    }
    expect(check(mutate("choose_form", (c) => (c.payload.approved = true))).ok).toBe(false);
  });

  it("qwen provenance needs model tag and digest", () => {
    const r = check(mutate("choose_form", (c) => (c.provenance = { origin: "qwen", model_tag: null, model_digest: null, prompt_version: "p1" })));
    expect(codes(r)).toContain("PROVENANCE_MODEL_MISSING");
  });

  it("requires a UUID exercise id", () => {
    expect(codes(check(mutate("choose_form", (c) => (c.id = "not-a-uuid"))))).toContain("ID_NOT_UUID");
  });
});

describe("closed-choice invariants (spec/05 1, 2, 6)", () => {
  it("accepted ids must be options, unique and non-empty; not every option may be accepted", () => {
    expect(codes(check(mutate("choose_form", (c) => (c.payload.accepted_option_ids = ["zzz"]))))).toContain("ACCEPTED_NOT_IN_OPTIONS");
    expect(codes(check(mutate("choose_form", (c) => (c.payload.accepted_option_ids = []))))).toEqual(expect.arrayContaining(["SCHEMA"]));
    expect(codes(check(mutate("choose_form", (c) => (c.payload.options[1].id = "a"))))).toContain("DUPLICATE_ID");
    expect(codes(check(mutate("choose_form", (c) => ((c.payload.multiple = true), (c.payload.accepted_option_ids = ["a", "b", "c"])))))).toContain("ALL_OPTIONS_ACCEPTED");
  });

  it("multiple=false needs exactly one accepted option; several natural answers need multiple=true", () => {
    const r = check(mutate("choose_form", (c) => (c.payload.accepted_option_ids = ["a", "b"])));
    expect(codes(r)).toContain("SINGLE_CHOICE_ACCEPTED_COUNT");
    expect(check(mutate("choose_form", (c) => ((c.payload.accepted_option_ids = ["a", "b"]), (c.payload.multiple = true)))).ok).toBe(true);
  });

  it("\"I don't know\" is never a content option", () => {
    for (const bad of [{ id: "d", text: "I don't know" }, { id: "idk", text: "unsure" }, { id: "d", text: "I do not know." }]) {
      expect(codes(check(mutate("choose_form", (c) => c.payload.options.push(bad))))).toContain("IDK_AS_OPTION");
    }
    expect(codes(check(mutate("detect_error", (c) => ((c.payload.segments[2].text = " I don't know"), (c.payload.sentence = c.payload.segments.map((s: any) => s.text).join("")))))))
      .toContain("IDK_AS_OPTION");
  });

  it("choose_missing_fragment has exactly one blank", () => {
    expect(codes(check(mutate("choose_missing_fragment", (c) => (c.prompt_en = "The organiser asked us to listen to the safety announcement.")))))
      .toContain("BLANK_COUNT");
    expect(codes(check(mutate("choose_missing_fragment", (c) => (c.prompt_en = "We ___ listen ___ the announcement."))))).toContain("BLANK_COUNT");
  });
});

describe("detect_error invariants (spec/05 2)", () => {
  it("segments must concatenate to the sentence exactly", () => {
    expect(codes(check(mutate("detect_error", (c) => (c.payload.sentence = "He suggested to go to the beach after lunch."))))).toContain("SEGMENTS_NOT_SENTENCE");
  });

  it("No mistake <-> no accepted segments and no corrections; an error needs both", () => {
    expect(check(fixture("detect_error_no_mistake")).ok).toBe(true);
    expect(codes(check(mutate("detect_error_no_mistake", (c) => (c.payload.accepted_segment_ids = ["s2"]))))).toContain("NO_MISTAKE_CONTRADICTION");
    expect(codes(check(mutate("detect_error_no_mistake", (c) => (c.payload.corrections = ["Could you tell me where the nearest tram stop is?"]))))).toContain("NO_MISTAKE_CONTRADICTION");
    expect(codes(check(mutate("detect_error", (c) => (c.payload.accepted_segment_ids = []))))).toContain("NO_ACCEPTED_SEGMENT");
    expect(codes(check(mutate("detect_error", (c) => (c.payload.corrections = []))))).toContain("NO_CORRECTION");
    expect(codes(check(mutate("detect_error", (c) => (c.payload.accepted_segment_ids = ["nope"]))))).toContain("ACCEPTED_NOT_IN_SEGMENTS");
  });
});

describe("taxonomy, dimension and reading rules (spec/05 4)", () => {
  it("target and additional skills must exist and differ", () => {
    expect(codes(check(mutate("choose_form", (c) => (c.target_skill = "tenses.made_up"))))).toContain("UNKNOWN_SKILL");
    expect(codes(check(mutate("choose_form", (c) => (c.additional_skills = ["nope.skill"]))))).toContain("UNKNOWN_SKILL");
  });

  it("additional equal to target is a semantic error", () => {
    expect(codes(check(mutate("choose_form", (c) => (c.additional_skills = [c.target_skill, "articles.definite"]))))).toContain("ADDITIONAL_EQUALS_TARGET");
  });

  it("the format fixes the dimension", () => {
    expect(codes(check(mutate("choose_form", (c) => (c.dimension = "production"))))).toContain("DIMENSION_MISMATCH");
    expect(codes(check(mutate("detect_error", (c) => (c.dimension = "recognition"))))).toContain("DIMENSION_MISMATCH");
    expect(codes(check(mutate("guided_short_answer", (c) => (c.dimension = "correction"))))).toContain("DIMENSION_MISMATCH");
  });

  it("every reading question has its own valid skill, options and accepted ids", () => {
    expect(codes(check(mutate("context_reading", (c) => (c.payload.questions[1].target_skill = "bad.skill"))))).toContain("UNKNOWN_SKILL");
    expect(codes(check(mutate("context_reading", (c) => (c.payload.questions[0].accepted_option_ids = ["zzz"]))))).toContain("ACCEPTED_NOT_IN_OPTIONS");
    expect(codes(check(mutate("context_reading", (c) => (c.payload.questions[1].id = "q1"))))).toContain("DUPLICATE_ID");
    expect(check(mutate("context_reading", (c) => c.payload.questions.pop())).ok).toBe(true); // 2 questions are allowed
    expect(check(mutate("context_reading", (c) => c.payload.questions.pop() && c.payload.questions.pop())).ok).toBe(false); // 1 is not (schema)
  });
});

describe("short answers (spec/05 3)", () => {
  it("need meaning and a target marker (schema) while empty alternatives are allowed and merely warned about", () => {
    expect(check(mutate("guided_short_answer", (c) => (c.payload.rubric.target_markers = []))).ok).toBe(false);
    const empty = check(mutate("guided_short_answer", (c) => (c.payload.accepted_answers = [])));
    expect(empty.ok).toBe(true);
    expect(empty.warnings.map((w) => w.code)).toContain("NO_ACCEPTED_ANSWERS");
    expect(empty.units.filter((u) => u.role === "answer")).toEqual([]);
  });

  it("an answer longer than max_words is a warning, not a failure", () => {
    const r = check(mutate("guided_short_answer", (c) => (c.payload.max_words = 3)));
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code)).toContain("ANSWER_OVER_MAX_WORDS");
  });

  it("max_words is bounded to 1..40 by the schema", () => {
    expect(check(mutate("guided_short_answer", (c) => (c.payload.max_words = 41))).ok).toBe(false);
    expect(check(mutate("guided_short_answer", (c) => (c.payload.max_words = 0))).ok).toBe(false);
  });
});

describe("schema-valid but linguistically wrong content passes validation (and is why review exists)", () => {
  it("a wrong 'correct' answer is structurally fine: the validator cannot approve English", () => {
    const wrong = mutate("choose_form", (c) => (c.payload.accepted_option_ids = ["c"])); // 'publish' after 'yesterday' is wrong English
    const r = check(wrong);
    expect(r.ok).toBe(true); // valid draft...
    expect(r.errors).toEqual([]);
    // ...nothing in the output grants authority: no status, no approval flag
    expect(JSON.stringify(r)).not.toMatch(/approved/i);
  });
});

describe("Russian-language fields", () => {
  it("warns when explanation or hints contain no Russian", () => {
    const r = check(mutate("choose_form", (c) => ((c.explanation_ru = "Use past simple."), (c.hints_ru = ["Look at yesterday."]))));
    expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["EXPLANATION_NOT_RUSSIAN", "HINT_NOT_RUSSIAN"]));
    expect(r.ok).toBe(true);
  });
});
