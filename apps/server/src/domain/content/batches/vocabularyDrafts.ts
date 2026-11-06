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
Each item has a topic and avoid_sentences. Set the sentence in an everyday situation of that topic ("technology" means software, computing or digital work; every other topic is ordinary adult life and must not be about IT). avoid_sentences are existing sentences with this word: write a clearly different one (new subject, situation and sentence frame); never copy or lightly rephrase them.
Self-check every draft before returning it: put each option and each accepted answer into the sentence and read the whole result (no doubled or leftover word next to the gap, a/an agrees with the next word and with EVERY option, Australian spelling); only the keyed option may fit; the Russian translation of the sentence and of the word is natural and matches this sense; the cue never also fits a common synonym; vary subject, situation and sentence frame between items.`;

/**
 * v5: v4 plus an optional saved EXPRESSION. When an item has `expression` (a phrase the learner is also studying that contains the word), the
 * sentence may be built around that exact phrase; it is never forced, and every other rule still holds.
 */
export const VOCABULARY_SYSTEM_V5 = `${VOCABULARY_SYSTEM_V4}
An item may also have expression: a phrase the learner is studying that contains the target word. When it fits the topic naturally, write the sentence around that exact phrase (the same words in the same order) so the word is learned in its usual company. Never force it, never change the target word's role in the task, and ignore it when it would make the sentence unnatural or the distractors ambiguous.`;

/** v6: v5 plus the defects that cost a v5 batch two thirds of its items in review (2026-11-06). New version because a pinned prompt must never change. */
export const VOCABULARY_SYSTEM_V6 = `${VOCABULARY_SYSTEM_V5}
Review defects to avoid (a batch of v5 drafts lost two thirds of its items to these): (1) a distractor that also fits the gap; an antonym or a weaker/stronger word of the same kind ("profoundly" vs "slightly", "coverage" vs "reach", "passerby" vs "pedestrian", "coherence" vs "clarity") fits whenever the sentence does not exclude it, so add a clause that does exclude it, or choose a distractor of another word class or a clearly different meaning; (2) a missing article or determiner: if the noun phrase needs "a/an/the" or a plural, put it in the sentence outside the gap; (3) an unnatural pairing: "frail" describes people or health, not objects, systems or code (use fragile there); "vile" describes smells, behaviour or food, not code; use the word in its most typical collocations; (4) the same frame for one word: never begin two sentences alike ("I'm not trying to ___ your ...") and never reuse the same scene (stress and stomach, a cafe, a server crash) for different items; (5) a stray space before a comma or full stop, or text left next to the gap.`;

/**
 * v7: v6 plus a wide topic pool (Audio Dictation topics), the word's meaning and its synonyms (never to be used as wrong options) per item,
 * stock-frame bans, and an option check by the local model in the runner. New version because a pinned prompt must never change.
 */
export const VOCABULARY_SYSTEM_V7 = `${VOCABULARY_SYSTEM_V6}
Topic is a direction, not a word: put the sentence in one specific everyday situation connected with it and never name the topic itself; when the topic does not suit the word, use the nearest natural situation of that area. Every item has its own topic, so the sentences of one word must differ in scene, people and vocabulary, not only in wording.
Each item may carry definition_ru (the sense to illustrate) and synonyms_not_to_use_as_distractors: never use any of those words as a wrong option, and make sure no wrong option is a near synonym of the answer. Do not open with or build on stock frames: "I'm not trying to ___", "I just wanted to ___ that", "We need to ___ the", "The local council", "A random ___", "The client ...". Vary the subject: a named person, a relative, a neighbour, a coach, a nurse, a teenager, a tourist, a shopkeeper, a farmer.`;

/**
 * v8 (2026-11-06): a short prompt written from scratch instead of v1..v7 stacked on each other. The model's job is only a correct, natural sentence at the
 * learner's level; topics are suggestions, wrong options are mixed and checked by the program, the recall cue gets the letter count from code.
 */
export const VOCABULARY_SYSTEM_V8 = `You write practice sentences for ONE adult learner of Australian English who is learning common English words. Return JSON only: {"drafts":[...]}, one draft per item, in the requested order.

What matters most, in this order:
1. The sentence is grammatically correct, natural adult Australian English (Australian spelling), 10-22 words, at the item's target_level: B2 = everyday adult topics, clear structure, some subordinate clauses; C1 = richer vocabulary and more complex structure, still natural speech or writing.
2. The target word is used in its most common meaning (definition_ru when given), in a typical collocation, in a form that fits the sentence.
3. The sentence has exactly one ___ in place of the target word and the answer appears nowhere else. The context makes the meaning clear.

Situation: topic_ideas are only suggestions. Use one of them when the word fits it naturally; otherwise choose any ordinary situation yourself. Never force a word into a topic. avoid_sentences already exist: write something clearly different. If an item has expression and it fits naturally, build the sentence around that exact phrase; otherwise ignore it.

Every draft: sentence, hint_ru (a short Russian hint about the meaning, without the answer), explanation_ru (one or two Russian sentences: what the word means here and why it fits), part_of_speech, sense_id (a short id such as "1"), surface_form (the exact form in the gap), sentence_ru (natural Russian translation of the whole sentence), word_ru (Russian meaning of the word in this sentence).
recognition and collocation also: options (3 objects with text and rationale_ru, one of them the target form) and correct_index (zero-based, pointing to the target form). The two wrong options must be clearly wrong in this sentence: another meaning or another word class, never a synonym or a word that also fits; the program may replace them. collocation also: pattern (the natural phrase, e.g. "make an effort").
guided_recall also: cue_ru in the form "(глаг., на X...) русское значение" where X is the first Latin letter of the answer, and accepted_answers: the surface_form plus only other spellings of the same word.
Russian text must be natural, correct Russian without Markdown.`;

const letters = (n: number): string => (n % 10 === 1 && n % 100 !== 11 ? "буква" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "буквы" : "букв");
/** "(глаг., на r...) повторить" + " — 9 букв" or " — 2 слова: 4 + 4 букв" */
export function withLength(cue: string, answer: string): string {
  const parts = answer.trim().split(/\s+/).map((w) => w.replace(/[^A-Za-z]/g, "").length);
  const tail = parts.length === 1 ? `${parts[0]} ${letters(parts[0]!)}` : `${parts.length} слова: ${parts.join(" + ")} ${letters(parts[parts.length - 1]!)}`;
  return `${cue.trim()} — ${tail}`;
}

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
export function assembleVocabulary(raw: unknown, plan: ItemPlan, exerciseId: string, model: { tag: string; digest: string }, skills: ReadonlySet<string>, promptVersion = "vocabulary-generation-v1", synonyms: readonly string[] = []): Built {
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
  // a listed synonym of the word as a distractor usually also fits the gap (the reviewer would have to reject it)
  const synonym = r.options?.find((o, i) => i !== r.correct_index && synonyms.some(x => x.trim().toLowerCase() === o.text.trim().toLowerCase()));
  if (synonym) return bad(`"${synonym.text}" is a synonym of the target word and may also fit the gap; use a distractor that is clearly wrong here`);
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
  // v8: the cue also tells the length of the answer, so a same-letter synonym ("restate" for "reiterate") no longer fits it
  if (recall && promptVersion === "vocabulary-generation-v8") r.cue_ru = withLength(r.cue_ru!, r.surface_form);
  const payload = recall ? { cue_ru: r.cue_ru, max_words: maxWords, accepted_answers: r.accepted_answers, rubric: { meaning_ru: r.sentence_ru, target_markers: [r.surface_form], acceptable_variation_ru: `Допустимые варианты: ${r.accepted_answers!.join(", ")}.`, reject_conditions_ru: "Иное значение или грамматическая форма, не подходящая к контексту." }, allow_voice: false } : { options: options!.map(o => ({ id: o.id, text: o.text })), accepted_option_ids: [acceptedId], multiple: false };
  const vocabulary = { schemaVersion: "vocabulary-practice-v1", family: target.family, target: t, sentenceRu: r.sentence_ru, wordRu: r.word_ru, ...(recall ? { guidedCue: r.cue_ru, expectedWords: maxWords, acceptedAnswers: r.accepted_answers } : { options, acceptedOptionId: acceptedId, ...(target.family === "collocation" ? { pattern: r.pattern } : {}) }) };
  const exercise = { schema_version: "exercise-v1", id: exerciseId, revision: 1, status: "draft", target_skill: plan.target_skill, additional_skills: [], dimension: plan.dimension, difficulty: plan.level ?? "B2", context_level: plan.level === "C2" ? "C2" : plan.level === "C1" ? "C1" : "B2", topic: plan.topic, context_id: plan.context_id, template_cluster: `vocab-${target.lemma}-${target.family}-${exerciseId.slice(0, 8)}`, bank_role: "practice", prompt_en: r.sentence, hints_ru: [r.hint_ru], explanation_ru: r.explanation_ru, sources: [], provenance: { origin: "qwen", model_tag: model.tag, model_digest: model.digest, prompt_version: promptVersion }, rubric_version: "rubric-v1", type: plan.type, payload, vocabulary };
  const v = validateExercise(exercise, { taxonomySkillIds: skills });
  return v.ok ? { ok: true, exercise } : { ok: false, issues: v.errors };
}
