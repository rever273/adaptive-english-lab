import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assembleExercise } from "../../../apps/server/src/domain/content/batches/draftFormats.js";

const skills = new Set<string>(JSON.parse(readFileSync(path.resolve(__dirname, "../../../content/taxonomy/taxonomy-v1.json"), "utf8")).skills.map((s: { id: string }) => s.id));
const skill = [...skills][0]!;
const plan = { ordinal: 0, type: "choose_form", dimension: "recognition", target_skill: skill, topic: "everyday", context_id: "c" } as never;
const build = (over: Record<string, unknown>) => assembleExercise({ sentence: "She ___ in the centre of town for years.", options: ["has lived", "lived", "is living"], correct_index: 0, hint_ru: "подсказка", explanation_ru: "Present perfect с for описывает период до настоящего момента.", ...over }, plan, { exerciseId: "11111111-1111-4111-8111-111111111111", model: { tag: "gemma4:12b", digest: "d" }, promptVersion: "generation-test", taxonomySkillIds: skills });
const codes = (r: ReturnType<typeof build>) => (r.ok ? [] : r.issues.map(i => i.code));

describe("grammar draft checks shared with vocabulary", () => {
  it("writes Australian spelling", () => {
    const r = build({ sentence: "She ___ near the center of town for years." });
    expect(r.ok && (r.exercise as { prompt_en: string }).prompt_en).toContain("centre");
  });
  it("rejects an article that gives the answer away", () => {
    expect(codes(build({ sentence: "He bought a ___ umbrella.", options: ["big", "tall", "huge"], correct_index: 1 }))).not.toContain("ARTICLE_GIVES_ANSWER");
    expect(codes(build({ sentence: "He bought an ___ umbrella.", options: ["old", "ugly", "huge"], correct_index: 1 }))).toContain("ARTICLE_GIVES_ANSWER");
  });
});
