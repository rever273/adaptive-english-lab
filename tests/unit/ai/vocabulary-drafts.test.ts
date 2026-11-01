import { describe, expect, it } from "vitest";
import { assembleVocabulary, australian } from "../../../apps/server/src/domain/content/batches/vocabularyDrafts.js";

const skills = new Set(["collocations.natural_phrases"]);
const model = { tag: "gemma4:12b", digest: "d" };
const plan = (family: "recognition" | "guided_recall", lemma: string) => ({ ordinal: 0, type: family === "recognition" ? "choose_missing_fragment" : "guided_short_answer", dimension: family === "recognition" ? "recognition" : "production", target_skill: "collocations.natural_phrases", topic: "everyday", context_id: "c", vocabulary: { lemma, translationRu: "x", family } }) as never;
const base = { hint_ru: "подсказка", explanation_ru: "объяснение", part_of_speech: "verb", sense_id: "1", sentence_ru: "перевод", word_ru: "слово" };
const recog = (over: Record<string, unknown> = {}) => ({ ...base, sentence: "Constant stress can ___ your health over time.", surface_form: "undermine", options: [{ text: "undermine", rationale_ru: "верно" }, { text: "strengthen", rationale_ru: "нет" }, { text: "replace", rationale_ru: "нет" }], correct_index: 0, ...over });
const recall = (over: Record<string, unknown> = {}) => ({ ...base, sentence: "It can be tough to ___ with a heavy workload.", surface_form: "cope", cue_ru: "справляться (глагол, на c...)", accepted_answers: ["cope"], ...over });
const build = (raw: unknown, family: "recognition" | "guided_recall", lemma: string) => assembleVocabulary(raw, plan(family, lemma), "11111111-1111-4111-8111-111111111111", model, skills, "vocabulary-generation-v3");
const message = (r: ReturnType<typeof build>) => (r.ok ? "" : r.issues.map(i => i.message).join("|"));

describe("vocabulary draft checks (v3)", () => {
  it("accepts clean drafts", () => {
    expect(build(recog(), "recognition", "undermine").ok).toBe(true);
    expect(build(recall(), "guided_recall", "cope").ok).toBe(true);
  });
  it("rejects answers that repeat the words around the gap", () => {
    expect(message(build(recall({ accepted_answers: ["cope", "cope with"] }), "guided_recall", "cope"))).toMatch(/repeats the words/);
    expect(message(build(recog({ sentence: "We need to ___ every effort now.", surface_form: "make every effort", options: [{ text: "make every effort", rationale_ru: "a" }, { text: "do every effort", rationale_ru: "b" }, { text: "give every effort", rationale_ru: "c" }] }), "recognition", "endeavour"))).toMatch(/repeats the words/);
  });
  it("rejects a letter glued to the gap, a bad sense id and a placeholder answer", () => {
    expect(message(build(recall({ sentence: "Severe budget ___s hurt us badly." }), "guided_recall", "cope"))).toMatch(/attach letters/);
    expect(message(build(recog({ sense_id: "," }), "recognition", "undermine"))).toMatch(/sense_id/);
    expect(message(build(recall({ accepted_answers: ["cope", "cope_"] }), "guided_recall", "cope"))).toMatch(/clean completion/);
  });
  it("checks the cue letter and the surface form", () => {
    expect(message(build(recall({ cue_ru: "справляться (глагол, на с...)" }), "guided_recall", "cope"))).toMatch(/first letter/);
    expect(message(build(recall({ cue_ru: "справляться (глагол, на p...)" }), "guided_recall", "cope"))).toMatch(/first letter/);
    expect(message(build(recall({ cue_ru: "справляться (глагол)" }), "guided_recall", "cope"))).toMatch(/first letter/);
    expect(message(build(recog({ surface_form: "undermines" }), "recognition", "undermine"))).toMatch(/surface_form/);
  });
  it("writes Australian spelling and checks article, language and word form", () => {
    expect(australian("We realized the neighbors' flavor at the center")).toBe("We realised the neighbours' flavour at the centre");
    const r = build(recall({ sentence: "He will ___ the color scheme.", surface_form: "organize", cue_ru: "организовать (глагол, на o...)", accepted_answers: ["organize"] }), "guided_recall", "organise");
    expect(r.ok && (r.exercise as { prompt_en: string }).prompt_en).toBe("He will ___ the colour scheme.");
    const opt = (...t: string[]) => t.map((x, i) => ({ text: x, rationale_ru: i ? "нет" : "верно" }));
    expect(message(build(recog({ sentence: "It was an ___ plan.", surface_form: "elaborate", options: opt("elaborate", "simple", "brief") }), "recognition", "elaborate"))).toMatch(/article "an"/);
    expect(build(recog({ sentence: "It was an ___ plan.", surface_form: "elaborate", options: opt("elaborate", "outdated", "ambitious") }), "recognition", "elaborate").ok).toBe(true);
    expect(message(build(recog({ options: [{ text: "undermine", rationale_ru: "right" }, { text: "strengthen", rationale_ru: "нет" }, { text: "replace", rationale_ru: "нет" }] }), "recognition", "undermine"))).toMatch(/written in Russian/);
    expect(message(build(recog({ sentence: "The speech was so ___ that nobody followed it.", surface_form: "incoherent", options: opt("incoherent", "clear", "brief") }), "recognition", "coherent"))).toMatch(/not a form of the planned word/);
  });
});
