import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assembleExercise, buildGenerationUser, buildGenerationUserV4, draftFormat, EXAMPLES, skillGloss } from "../../../apps/server/src/domain/content/batches/draftFormats.js";
import { groupUnits, planBatch, type ItemPlan } from "../../../apps/server/src/domain/content/batches/plan.js";

const skills = new Set<string>((JSON.parse(readFileSync(path.resolve(__dirname, "../../../content/taxonomy/taxonomy-v1.json"), "utf8")) as { skills: Array<{ id: string }> }).skills.map((s) => s.id));
const ctx = { exerciseId: "6f1c2a10-5d0e-4b6a-8c11-0a1b2c3d4e99", model: { tag: "qwen3:8b", digest: "d".repeat(64) }, promptVersion: "generation-v2", taxonomySkillIds: skills };
const plan = (type: ItemPlan["type"], o: Partial<ItemPlan> = {}): ItemPlan => ({ ordinal: 0, type, dimension: "recognition", target_skill: "verb_patterns.stop_doing_vs_stop_to_do", topic: "workplace", context_id: "workplace-x-0", ...o });
const codes = (r: ReturnType<typeof assembleExercise>) => (r.ok ? [] : r.issues.map((i) => i.code));
const ex = (type: ItemPlan["type"]) => ({ ...(EXAMPLES[type] as Record<string, unknown>) });

describe("assembleExercise: the server builds Exercise-v1 and refuses sloppy model drafts", () => {
  /** same draft with every English sentence slightly reworded, so it is NOT a copy of the example */
  const fresh = (v: unknown): unknown => (typeof v === "string" ? (/[Ѐ-ӿ]/.test(v) || !v.includes(" ") ? v : v.split(/(?<=[.!?])\s+/).map((sentence) => sentence.replace(" ", " newly ")).join(" ")) : Array.isArray(v) ? v.map(fresh) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "error_segment" ? x : fresh(x)])) : v);

  it("the worked example itself is refused as a copy; a reworded version of every format assembles into a valid, server-stamped draft", () => {
    for (const type of ["choose_form", "choose_missing_fragment", "detect_error", "guided_short_answer", "russian_to_english_short", "context_reading"] as const) {
      expect(codes(assembleExercise(ex(type), plan(type), ctx)), `${type} copy`).toContain("COPIED_EXAMPLE");
      const r = assembleExercise(fresh(ex(type)), plan(type), ctx);
      expect(codes(r), type).toEqual([]);
      if (r.ok) expect(r.exercise).toMatchObject({ status: "draft", bank_role: "practice", difficulty: "B2", revision: 1, id: ctx.exerciseId, provenance: { origin: "qwen", model_tag: "qwen3:8b", prompt_version: "generation-v2" } });
    }
  });

  it("choose_*: exactly one gap, distinct options, a key that points at an option, English only", () => {
    const base = ex("choose_form");
    expect(codes(assembleExercise({ ...base, sentence: "The council published the timetable." }, plan("choose_form"), ctx))).toContain("GAP_COUNT");
    expect(codes(assembleExercise({ ...base, sentence: "The ___ council ___ the timetable." }, plan("choose_form"), ctx))).toContain("GAP_COUNT");
    expect(codes(assembleExercise({ ...base, options: ["published", "Published", "publish"] }, plan("choose_form"), ctx))).toContain("OPTIONS_NOT_DISTINCT");
    expect(codes(assembleExercise({ ...base, correct_index: 3 }, plan("choose_form"), ctx))).toContain("KEY_OUT_OF_RANGE");
    expect(codes(assembleExercise({ ...base, options: ["published", "опубликовал", "publish"] }, plan("choose_form"), ctx))).toContain("NOT_ENGLISH");
  });

  it("detect_error: the wrong words must really occur once; a correct-sentence item must have empty error fields", () => {
    const base = ex("detect_error");
    const p = plan("detect_error", { dimension: "correction" });
    expect(codes(assembleExercise({ ...base, error_segment: "not in the sentence" }, p, ctx))).toContain("SEGMENT_NOT_IN_SENTENCE");
    expect(codes(assembleExercise({ ...base, sentence: "He went to the shop and went to the bank.", error_segment: "went", correction: "He went to the shop and then to the bank." }, p, ctx))).toContain("SEGMENT_AMBIGUOUS");
    expect(codes(assembleExercise({ ...base, correction: base.sentence }, p, ctx))).toContain("NO_CORRECTION");
    expect(codes(assembleExercise({ ...base, correction: "He suggested to go home." }, p, ctx))).toContain("CORRECTION_KEEPS_ERROR");
    // the "No mistake" quota
    const nm = plan("detect_error", { dimension: "correction", noMistake: true });
    expect(codes(assembleExercise({ ...base, sentence: "Could you tell me where the nearest tram stop is?", error_segment: "", correction: "" }, nm, ctx))).toEqual([]);
    expect(codes(assembleExercise(base, nm, ctx))).toContain("EXPECTED_NO_MISTAKE");
    const ok = assembleExercise({ ...base, sentence: "Could you tell me where the nearest tram stop is?", error_segment: "", correction: "" }, nm, ctx);
    expect(ok.ok && (ok.exercise.payload as { no_mistake: boolean; accepted_segment_ids: string[] })).toMatchObject({ no_mistake: true, accepted_segment_ids: [] });
  });

  it("guided answers must continue the starter, differ from each other, and be English; the cue must be Russian", () => {
    const base = ex("guided_short_answer");
    const p = plan("guided_short_answer", { dimension: "production" });
    expect(codes(assembleExercise({ ...base, accepted_answers: ["She quit the job.", "The employee stopped checking email after work."] }, p, ctx))).toContain("ANSWER_NOT_STARTING_WITH_STARTER");
    expect(codes(assembleExercise({ ...base, accepted_answers: ["The employee stopped", "The employee stopped checking email."] }, p, ctx))).toContain("ANSWER_IS_STARTER");
    expect(codes(assembleExercise({ ...base, accepted_answers: ["The employee stopped checking email.", "The employee stopped checking email."] }, p, ctx))).toContain("ANSWERS_NOT_DISTINCT");
    expect(codes(assembleExercise({ ...base, cue_ru: "Employee stopped checking email after the shift today." }, p, ctx))).toContain("NOT_RUSSIAN");
  });

  it("translation items: Russian cue, English answers; reading items: real passages without gaps", () => {
    const r2e = ex("russian_to_english_short");
    const p = plan("russian_to_english_short", { dimension: "production" });
    expect(codes(assembleExercise({ ...r2e, accepted_answers: ["Не могли бы вы сказать время?"] }, p, ctx))).toContain("NOT_ENGLISH");
    const rd = ex("context_reading") as { paragraphs: string[]; questions: Array<{ prompt: string; options: string[]; correct_index: number }> };
    const pr = plan("context_reading");
    expect(codes(assembleExercise({ ...rd, paragraphs: ["Short text here for the reading task today.", "Another short text here for the task today."] }, pr, ctx))).toContain("PASSAGE_TOO_SHORT");
    expect(codes(assembleExercise({ ...rd, paragraphs: [rd.paragraphs[0]!.replace("postponed", "___"), rd.paragraphs[1]!] }, pr, ctx))).toContain("GAP_IN_PASSAGE");
    expect(codes(assembleExercise({ ...rd, questions: [rd.questions[0]!, rd.questions[0]!] }, pr, ctx))).toContain("QUESTIONS_NOT_DISTINCT");
  });

  it("a model cannot set status, ids, bank role, provenance or the skill tag; unknown keys are refused too", () => {
    const base = ex("choose_form");
    for (const k of ["status", "approved", "confirmed", "bank_role", "id", "provenance", "target_skill", "type", "revision"]) {
      expect(codes(assembleExercise({ ...base, [k]: "x" }, plan("choose_form"), ctx)), k).toEqual(["MODEL_CLAIMED_FIELD"]);
    }
    expect(codes(assembleExercise({ ...base, bonus: 1 }, plan("choose_form"), ctx))).toEqual(["UNEXPECTED_FIELD"]);
    expect(codes(assembleExercise("text", plan("choose_form"), ctx))).toEqual(["NOT_AN_OBJECT"]);
    expect(codes(assembleExercise({ ...base, explanation_ru: "Short explanation in English only here." }, plan("choose_form"), ctx))).toContain("NOT_RUSSIAN");
  });
});

describe("planning and prompts", () => {
  it("a trial has exactly one 'No mistake' item per four detect_error items and units never exceed 2 (reading 1)", () => {
    const plans = planBatch({ request: { count: 24, mode: "balanced", trial: true }, taxonomySkills: [...skills], coverage: new Map(), tag: "t" });
    const de = plans.filter((p) => p.type === "detect_error");
    expect(de).toHaveLength(4);
    expect(de.filter((p) => p.noMistake)).toHaveLength(1);
    for (const u of groupUnits(plans)) {
      expect(u.length).toBeLessThanOrEqual(u[0]!.type === "context_reading" ? 1 : 2);
      expect(new Set(u.map((item) => item.target_skill)).size).toBe(1);
    }
    expect(plans.filter((p) => p.type === "context_reading").every((p) => p.target_skill.startsWith("linking."))).toBe(true);
    expect(plans.filter((p) => p.type === "choose_missing_fragment").every((p) => !p.target_skill.startsWith("agreement."))).toBe(true);
  });

  it("the user message names the skill in words, carries the format rule and one example, and never the answer key of other items", () => {
    const m = JSON.parse(buildGenerationUser("b1", [plan("choose_form", { target_skill: "agreement.collective_nouns" })])) as { format: string; format_rules: string; items: Array<{ skill_meaning: string }>; example_of_one_draft: unknown };
    expect(m.format).toBe("choose_form");
    expect(m.format_rules).toContain("exactly one gap");
    expect(m.items[0]!.skill_meaning).toBe("agreement: collective nouns");
    expect(skillGloss("articles.zero_general")).toBe("articles: zero general");
    expect(m.example_of_one_draft).toMatchObject({ correct_index: 0 });
    expect(JSON.parse(buildGenerationUserV4("b1", [plan("choose_form")]))).not.toHaveProperty("example_of_one_draft");
    expect((draftFormat("choose_form", 2) as { properties: { drafts: { maxItems: number } } }).properties.drafts.maxItems).toBe(2);
  });
});

describe("TASK_021: requested level from the Settings range", () => {
  it("is named per item in the request and stamped on the assembled draft; without a level nothing changes (B2)", () => {
    const asked = JSON.parse(buildGenerationUser("b", [plan("choose_form", { level: "C1" }), plan("choose_form", { ordinal: 1, level: "B2" })])) as { items: Array<{ target_level?: string }> };
    expect(asked.items[0]!.target_level).toContain("C1");
    expect(asked.items[1]!.target_level).toContain("B2");
    expect(JSON.parse(buildGenerationUser("b", [plan("choose_form")])).items[0]).not.toHaveProperty("target_level");

    const raw = { ...ex("choose_form"), sentence: "Newly the council ___ the revised timetable yesterday." };
    const c1 = assembleExercise(raw, plan("choose_form", { level: "C1" }), ctx);
    const none = assembleExercise(raw, plan("choose_form"), ctx);
    expect(c1.ok && c1.exercise).toMatchObject({ difficulty: "C1", context_level: "C1" });
    expect(none.ok && none.exercise).toMatchObject({ difficulty: "B2", context_level: "B2" });
  });
});
