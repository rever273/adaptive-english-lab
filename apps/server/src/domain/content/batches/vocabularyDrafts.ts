import { z } from "zod";
import { validateExercise } from "../validator.js";
import type { ItemPlan } from "./plan.js";
import type { Built } from "./draftFormats.js";
import { articleMismatch, australian, hasCyrillic } from "./languageChecks.js";

export { australian };

export const VOCABULARY_SYSTEM = `Write drafts for personal vocabulary practice in natural adult Australian English. Return JSON only: {"drafts":[...]}, in the requested order. Every draft: sentence (one ___ gap), hint_ru, explanation_ru, part_of_speech, sense_id, surface_form, sentence_ru, word_ru. For recognition/collocation: options (3–4 objects with text and rationale_ru), correct_index (zero-based); collocation also pattern. For guided_recall: cue_ru (a precise Russian meaning/POS/first-letter clue that does not reveal the answer), accepted_answers (all valid 1–5 word gap completions). All options must fit the same grammatical slot; context must exclude other meanings. Do not copy examples, repeat sentences, invent morphology or mark a stylistic preference as a grammar error. Translation supplied with the word is tentative. Drafts are never approved by the model.`;

export const VOCABULARY_SYSTEM_V2 = `${VOCABULARY_SYSTEM}
For EVERY item, sentence contains exactly one literal ___ in place of the target word; do not write the answer elsewhere in the sentence. Follow each item's vocabulary.family: recognition and collocation require 3–4 distinct options with text and rationale_ru and a correct_index pointing to the target form; collocation also requires pattern. guided_recall requires cue_ru and a non-empty accepted_answers array containing the target form. Provide all mandatory fields for the requested family, not another family. Check that the target word and its inflection fit the context and the Russian meaning. Reconstruct each option in the gap and ensure exactly one is correct; use natural, clearly incompatible distractors. Never return an incorrect answer as accepted.`;

/** v3: the defects found when a whole batch of v2 drafts was reviewed (D69): several valid options, answers that repeat the words around the gap, wrong cue letters. */
export const VOCABULARY_SYSTEM_V3 = `${VOCABULARY_SYSTEM_V2}
Distractors must be WRONG in this sentence (grammar or meaning). Never use a synonym or near-synonym of the target that also fits; read the sentence with each option and keep exactly one defensible answer. Add context to the sentence that excludes the other meanings. An option or accepted answer must fill ONLY the gap: never repeat the words that stand right before or after ___ (wrong: "We need to ___ every effort" with the option "make every effort"; wrong: accepted "cope with" when the sentence already continues "___ with"). Do not attach letters to the gap (no "___s"): put the inflection into the answer and the options. accepted_answers hold only real English words (letters, hyphen, apostrophe), 1–2 words, and include the target surface_form; for recognition surface_form is the exact text of the correct option. cue_ru names the part of speech and the first LATIN letter of the answer in the form "(прил., на c...)" and the Russian gloss must mean the same as the target in this sentence (not an opposite or a neighbouring sense). sense_id is a short id such as "1". Each item must use a different situation and a different sentence frame from the other items for the same word; do not reuse the sentence opening or the collocation of another item. hint_ru, word_ru and sentence_ru are plain Russian without Markdown.`;

/** v4: varied settings and no sentence that is already in the bank (53 of 59 empty drafts of a v3 batch repeated stock sentences). */
export const VOCABULARY_SYSTEM_V4 = `${VOCABULARY_SYSTEM_V3}
Each item has a topic and avoid_sentences. Set the sentence in an everyday situation of that topic ("technology" means software, computing or digital work; every other topic is ordinary adult life and must not be about IT). avoid_sentences are existing sentences with this word: write a clearly different one (new subject, situation and sentence frame); never copy or lightly rephrase them.`;

const words = (s: string): string[] => s.toLowerCase().match(/[a-z]+(?:['’-][a-z]+)*/g) ?? [];
/** the answer must not repeat the words that already stand next to the gap */
function repeatsNeighbours(answer: string, before: string[], after: string[]): boolean {
  const a = words(answer);
  for (let k = 1; k <= Math.min(a.length, before.length); k++) if (a.slice(0, k).join(" ") === before.slice(-k).join(" ")) return true;
  for (let k = 1; k <= Math.min(a.length, after.length); k++) if (a.slice(-k).join(" ") === after.slice(0, k).join(" ")) return true;
  return false;
}

const Raw = z.object({ sentence: z.string().min(10), hint_ru: z.string().min(1), explanation_ru: z.string().min(1), part_of_speech: z.string().min(1), sense_id: z.string().min(1), surface_form: z.string().min(1), sentence_ru: z.string().min(1), word_ru: z.string().min(1), options: z.array(z.object({ text: z.string().min(1), rationale_ru: z.string().min(1) })).min(3).max(4).optional(), correct_index: z.number().int().min(0).max(3).optional(), pattern: z.string().optional(), cue_ru: z.string().optional(), accepted_answers: z.array(z.string().min(1)).min(1).max(20).optional() });
export const vocabularyFormat = (count: number) => ({ type: "object", required: ["drafts"], properties: { drafts: { type: "array", minItems: count, maxItems: count, items: z.toJSONSchema(Raw) } } });
export function assembleVocabulary(raw: unknown, plan: ItemPlan, exerciseId: string, model: { tag: string; digest: string }, skills: ReadonlySet<string>, promptVersion = "vocabulary-generation-v1"): Built {
  const parsed = Raw.safeParse(raw);
  const bad = (message: string): Built => ({ ok: false, issues: [{ code: "VOCABULARY_DRAFT", path: "", message }] });
  if (!parsed.success) return bad(parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
  const r = parsed.data, target = plan.vocabulary!;
  r.sentence = australian(r.sentence); r.surface_form = australian(r.surface_form);
  if (r.options) r.options = r.options.map(o => ({ ...o, text: australian(o.text) }));
  if (r.accepted_answers) r.accepted_answers = [...new Set(r.accepted_answers.map(australian))];
  if ((r.sentence.match(/___/g) ?? []).length !== 1) return bad("Use exactly one ___ gap");
  if (/[A-Za-z]___|___[A-Za-z]/.test(r.sentence)) return bad("Do not attach letters to the gap; put the inflection into the answer");
  if (!/[A-Za-z0-9]/.test(r.sense_id)) return bad("sense_id must be a short id such as 1");
  const [head = "", tail = ""] = r.sentence.split("___"), before = words(head), after = words(tail);
  const answers = r.accepted_answers ?? r.options?.map(o => o.text) ?? [];
  const wrong = answers.find(a => !/^[A-Za-z][A-Za-z'’ -]*$/.test(a.trim()) || repeatsNeighbours(a, before, after));
  if (wrong !== undefined) return bad(`"${wrong}" is not a clean completion of the gap (foreign characters or it repeats the words next to ___)`);
  if (r.options && new Set(r.options.map(o => o.text.trim().toLowerCase())).size !== r.options.length) return bad("Options must be distinct");
  if (r.accepted_answers && !r.accepted_answers.some(a => a.trim().toLowerCase() === r.surface_form.trim().toLowerCase())) return bad("accepted_answers must include surface_form");
  if (r.options && r.correct_index !== undefined && r.options[r.correct_index]?.text.trim().toLowerCase() !== r.surface_form.trim().toLowerCase()) return bad("surface_form must equal the correct option");
  if (r.cue_ru) {
    const m = r.cue_ru.match(/(?:^|\s)на\s+(?:букву\s+)?([A-Za-zЀ-ӿ])(?![A-Za-zЀ-ӿ])/i);
    if (!m) return bad("cue_ru must name the first letter, e.g. (прил., на c...)");
    if (r.accepted_answers!.some(a => a.trim()[0]?.toLowerCase() !== m[1]!.toLowerCase())) return bad("cue_ru first letter must be the Latin first letter of every accepted answer");
  }
  const article = r.options ? articleMismatch(head, r.options.map(o => o.text)) : undefined;
  if (article) return bad(`The article "${article}" before ___ must fit every option, otherwise it gives the answer away`);
  if ([r.hint_ru, r.sentence_ru, r.word_ru, r.explanation_ru, ...(r.options?.map(o => o.rationale_ru) ?? [])].some(x => !hasCyrillic(x))) return bad("hint_ru, word_ru, sentence_ru, explanation_ru and every rationale_ru must be written in Russian");
  const lemma = target.lemma.toLowerCase();
  if (/^[a-z]{5,}$/.test(lemma) && !r.surface_form.toLowerCase().startsWith(lemma.slice(0, 4))) return bad(`surface_form "${r.surface_form}" is not a form of the planned word "${target.lemma}"`);
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
