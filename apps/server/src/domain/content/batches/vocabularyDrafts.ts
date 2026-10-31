import { z } from "zod";
import { validateExercise } from "../validator.js";
import type { ItemPlan } from "./plan.js";
import type { Built } from "./draftFormats.js";

export const VOCABULARY_SYSTEM = `Write drafts for personal vocabulary practice in natural adult Australian English. Return JSON only: {"drafts":[...]}, in the requested order. Every draft: sentence (one ___ gap), hint_ru, explanation_ru, part_of_speech, sense_id, surface_form, sentence_ru, word_ru. For recognition/collocation: options (3–4 objects with text and rationale_ru), correct_index (zero-based); collocation also pattern. For guided_recall: cue_ru (a precise Russian meaning/POS/first-letter clue that does not reveal the answer), accepted_answers (all valid 1–5 word gap completions). All options must fit the same grammatical slot; context must exclude other meanings. Do not copy examples, repeat sentences, invent morphology or mark a stylistic preference as a grammar error. Translation supplied with the word is tentative. Drafts are never approved by the model.`;

export const VOCABULARY_SYSTEM_V2 = `${VOCABULARY_SYSTEM}
For EVERY item, sentence contains exactly one literal ___ in place of the target word; do not write the answer elsewhere in the sentence. Follow each item's vocabulary.family: recognition and collocation require 3–4 distinct options with text and rationale_ru and a correct_index pointing to the target form; collocation also requires pattern. guided_recall requires cue_ru and a non-empty accepted_answers array containing the target form. Provide all mandatory fields for the requested family, not another family. Check that the target word and its inflection fit the context and the Russian meaning. Reconstruct each option in the gap and ensure exactly one is correct; use natural, clearly incompatible distractors. Never return an incorrect answer as accepted.`;

const Raw = z.object({ sentence: z.string().min(10), hint_ru: z.string().min(1), explanation_ru: z.string().min(1), part_of_speech: z.string().min(1), sense_id: z.string().min(1), surface_form: z.string().min(1), sentence_ru: z.string().min(1), word_ru: z.string().min(1), options: z.array(z.object({ text: z.string().min(1), rationale_ru: z.string().min(1) })).min(3).max(4).optional(), correct_index: z.number().int().min(0).max(3).optional(), pattern: z.string().optional(), cue_ru: z.string().optional(), accepted_answers: z.array(z.string().min(1)).min(1).max(20).optional() });
export const vocabularyFormat = (count: number) => ({ type: "object", required: ["drafts"], properties: { drafts: { type: "array", minItems: count, maxItems: count, items: z.toJSONSchema(Raw) } } });
export function assembleVocabulary(raw: unknown, plan: ItemPlan, exerciseId: string, model: { tag: string; digest: string }, skills: ReadonlySet<string>, promptVersion = "vocabulary-generation-v1"): Built {
  const parsed = Raw.safeParse(raw);
  const bad = (message: string): Built => ({ ok: false, issues: [{ code: "VOCABULARY_DRAFT", path: "", message }] });
  if (!parsed.success) return bad(parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
  const r = parsed.data, target = plan.vocabulary!;
  if ((r.sentence.match(/___/g) ?? []).length !== 1) return bad("Use exactly one ___ gap");
  const t = { entryId: target.lemma, lemma: target.lemma, senseId: r.sense_id, partOfSpeech: r.part_of_speech, surfaceForm: r.surface_form };
  const options = r.options?.map((o, i) => ({ id: "abcd"[i]!, text: o.text, rationaleRu: o.rationale_ru }));
  const acceptedId = r.correct_index === undefined ? undefined : options?.[r.correct_index]?.id;
  const recall = target.family === "guided_recall";
  if (recall ? !r.accepted_answers?.length || !r.cue_ru : !acceptedId || !options) return bad("Missing family-specific answers");
  if (target.family === "collocation" && !r.pattern) return bad("Collocation needs its natural pattern");
  const maxWords = Math.max(...(r.accepted_answers ?? [""]).map(a => a.trim().split(/\s+/).length));
  const payload = recall ? { cue_ru: r.cue_ru, max_words: maxWords, accepted_answers: r.accepted_answers, rubric: { meaning_ru: r.sentence_ru, target_markers: [r.surface_form], acceptable_variation_ru: `Допустимые варианты: ${r.accepted_answers!.join(", ")}.`, reject_conditions_ru: "Иное значение или грамматическая форма, не подходящая к контексту." }, allow_voice: false } : { options: options!.map(o => ({ id: o.id, text: o.text })), accepted_option_ids: [acceptedId], multiple: false };
  const vocabulary = { schemaVersion: "vocabulary-practice-v1", family: target.family, target: t, sentenceRu: r.sentence_ru, wordRu: r.word_ru, ...(recall ? { guidedCue: r.cue_ru, expectedWords: maxWords, acceptedAnswers: r.accepted_answers } : { options, acceptedOptionId: acceptedId, ...(target.family === "collocation" ? { pattern: r.pattern } : {}) }) };
  const exercise = { schema_version: "exercise-v1", id: exerciseId, revision: 1, status: "draft", target_skill: plan.target_skill, additional_skills: [], dimension: plan.dimension, difficulty: "B2", context_level: "B2", topic: plan.topic, context_id: plan.context_id, template_cluster: `vocab-${target.lemma}-${target.family}-${exerciseId.slice(0, 8)}`, bank_role: "practice", prompt_en: r.sentence, hints_ru: [r.hint_ru], explanation_ru: r.explanation_ru, sources: [], provenance: { origin: "qwen", model_tag: model.tag, model_digest: model.digest, prompt_version: promptVersion }, rubric_version: "rubric-v1", type: plan.type, payload, vocabulary };
  const v = validateExercise(exercise, { taxonomySkillIds: skills });
  return v.ok ? { ok: true, exercise } : { ok: false, issues: v.errors };
}
