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

describe("generation-v7 word hint of a translation draft", () => {
  const tplan = { ordinal: 0, type: "russian_to_english_short", dimension: "production", target_skill: skill, topic: "everyday", context_id: "c" } as never;
  const draft = (over: Record<string, unknown>) => assembleExercise({ cue_ru: "Я хотел бы узнать, когда начинается регистрация на рейс.", accepted_answers: ["I would like to know when the flight check-in starts."], meaning_ru: "Вежливый вопрос о начале регистрации на рейс.", marker_ru: "прямой порядок слов", reject_ru: "Вопросительный порядок слов не принимается.", hint_ru: "Порядок слов как в утверждении.", explanation_ru: "Во вложенном вопросе порядок слов прямой, без вспомогательного глагола.", word_hint_ru: "check-in — регистрация на рейс; start — начинаться", ...over }, tplan, { exerciseId: "11111111-1111-4111-8111-111111111111", model: { tag: "m", digest: "d" }, promptVersion: "generation-v7", taxonomySkillIds: skills });
  it("becomes the second hint, after the grammar hint", () => {
    const r = draft({});
    expect(r.ok && (r.exercise as { hints_ru: string[] }).hints_ru).toEqual(["Порядок слов как в утверждении.", "Слова: check-in — регистрация на рейс; start — начинаться"]);
  });
  it("must list English words with a Russian translation and never hold a complete answer", () => {
    expect(draft({ word_hint_ru: "регистрация на рейс" }).ok).toBe(false);
    expect(draft({ word_hint_ru: "I would like to know when the flight check-in starts. — целиком" }).ok).toBe(false);
  });
});

describe("article and determiner items", () => {
  it("offer at most three options", () => {
    expect(codes(build({ sentence: "My cousin wants to study at ___ university in Melbourne.", options: ["the", "a", "any", "an"], correct_index: 1 }))).toContain("ARTICLE_OPTIONS_MAX3");
    expect(codes(build({ sentence: "My cousin wants to study at ___ university in Melbourne.", options: ["the", "a", "any"], correct_index: 1 }))).not.toContain("ARTICLE_OPTIONS_MAX3");
    expect(codes(build({ sentence: "She ___ in the centre of town for years.", options: ["has lived", "lived", "is living", "lives"], correct_index: 0 }))).not.toContain("ARTICLE_OPTIONS_MAX3");
  });
});

describe("generation-v8 word-level error detection", () => {
  const dplan = (noMistake = false) => ({ ordinal: 0, type: "detect_error", dimension: "correction", target_skill: skill, topic: "everyday", context_id: "c", noMistake } as never);
  const detect = (over: Record<string, unknown>, noMistake = false) => assembleExercise({ sentence: "The latest software updates is already available for download.", error_words: "updates is", fix_words: "updates are", hint_ru: "Проверьте согласование глагола.", explanation_ru: "Подлежащее во множественном числе требует формы are, а не is.", ...over }, dplan(noMistake), { exerciseId: "11111111-1111-4111-8111-111111111111", model: { tag: "m", digest: "d" }, promptVersion: "generation-v8", taxonomySkillIds: skills });
  it("builds one segment per word, accepts any word of the error and keeps the explicit fix", () => {
    const r = detect({});
    const p = r.ok ? (r.exercise as { payload: { segments: Array<{ id: string; text: string }>; accepted_segment_ids: string[]; corrections: string[]; fixes: string[]; accept_any: boolean } }).payload : null;
    expect(p?.segments.map((s) => s.text).join("")).toBe("The latest software updates is already available for download.");
    expect(p?.segments.filter((s) => p.accepted_segment_ids.includes(s.id)).map((s) => s.text.trim())).toEqual(["updates", "is"]);
    expect(p?.corrections).toEqual(["The latest software updates are already available for download."]);
    expect(p?.fixes).toEqual(["updates are"]);
    expect(p?.accept_any).toBe(true);
  });
  it("refuses an error that is not in the sentence, is not whole words or is not fixed", () => {
    expect(detect({ error_words: "update" }).ok).toBe(false);
    expect(detect({ fix_words: "updates is" }).ok).toBe(false);
    expect(detect({ error_words: "the latest software updates is already" }).ok).toBe(false);
  });
  it("makes a no-mistake sentence of words with empty error fields", () => {
    expect(detect({ sentence: "The latest software updates are already available for download.", error_words: "", fix_words: "" }, true).ok).toBe(true);
  });
});
