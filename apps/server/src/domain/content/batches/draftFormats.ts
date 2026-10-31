import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { detectProjectRoot } from "../../../config.js";
import { DIMENSION_BY_TYPE, type ExerciseType, type ValidationIssue } from "@english-lab/contracts";
import { validateExercise } from "../validator.js";
import type { ItemPlan } from "./plan.js";

/**
 * generation-v2 (D48). The Trial of generation-v1 (a small model asked for a whole Exercise-v1 document) produced 0 usable drafts out of 24.
 * v2 asks for a SMALL, flat, per-format draft (sentence, options, index of the right one, ...) and the server assembles Exercise-v1 itself:
 * ids, option letters, segments, rubric scaffolding, prompt wording, provenance. Everything the model writes is checked by code before it is
 * stored (exactly one gap, distinct options, the error segment really occurs once, answers start with the given opening, Russian is Russian,
 * English is English, the English answer is not printed in the prompt). Passing is still only "eligible for review", never "correct".
 */

const MIN_EXPLANATION = 15;

export interface SkillCard {
  rule: string;
  good: string[];
  wrong: string;
}
let cards: Record<string, SkillCard> | null = null;
let cardsText = "";
/** content/taxonomy/skill-cards-v1.json: what each skill MEANS, written for the generator (D50). Part of the generation prompt version. */
export function skillCards(): Record<string, SkillCard> {
  if (!cards) {
    cardsText = readFileSync(path.join(detectProjectRoot(), "content", "taxonomy", "skill-cards-v1.json"), "utf8");
    cards = (JSON.parse(cardsText) as { cards: Record<string, SkillCard> }).cards;
  }
  return cards;
}
const CYRILLIC = /[Ѐ-ӿ]/;
const LATIN_WORD = /[A-Za-z]{2,}/;

const str = (min = 1) => ({ type: "string", minLength: min, maxLength: 600 });
const opts = (min: number, max: number) => ({ type: "array", minItems: min, maxItems: max, items: str() });
const common = { explanation_ru: str(MIN_EXPLANATION), hint_ru: str(5) };

const DRAFT_PROPS: Record<ExerciseType, Record<string, unknown>> = {
  choose_form: { ...common, sentence: str(10), options: opts(3, 4), correct_index: { type: "integer", minimum: 0, maximum: 3 } },
  choose_missing_fragment: { ...common, sentence: str(10), options: opts(3, 4), correct_index: { type: "integer", minimum: 0, maximum: 3 } },
  detect_error: { ...common, sentence: str(10), error_segment: { type: "string", maxLength: 200 }, correction: { type: "string", maxLength: 400 } },
  guided_short_answer: { ...common, cue_ru: str(10), starter_en: str(3), accepted_answers: opts(2, 3), meaning_ru: str(5), marker_ru: str(3), reject_ru: str(5) },
  russian_to_english_short: { ...common, cue_ru: str(10), accepted_answers: opts(1, 3), meaning_ru: str(5), marker_ru: str(3), reject_ru: str(5) },
  context_reading: {
    ...common,
    paragraphs: { type: "array", minItems: 2, maxItems: 2, items: { type: "string", minLength: 60, maxLength: 700 } },
    questions: { type: "array", minItems: 2, maxItems: 3, items: { type: "object", additionalProperties: false, required: ["prompt", "options", "correct_index"], properties: { prompt: str(8), options: opts(3, 3), correct_index: { type: "integer", minimum: 0, maximum: 2 } } } },
  },
};

/** JSON schema of one inference unit for a format: {drafts:[...<= count]} - also the `format` handed to the model. */
export function draftFormat(type: ExerciseType, count: number): object {
  const props = DRAFT_PROPS[type];
  return { type: "object", additionalProperties: false, required: ["drafts"], properties: { drafts: { type: "array", minItems: 1, maxItems: count, items: { type: "object", additionalProperties: false, required: Object.keys(props), properties: props } } } };
}

/** Hash input of the prompt version: all schemas + the examples (so changing any of them needs a new version id). */
export function draftFormatsText(): string {
  skillCards();
  return JSON.stringify({ formats: Object.fromEntries((Object.keys(DRAFT_PROPS) as ExerciseType[]).map((t) => [t, draftFormat(t, 2)])), examples: EXAMPLES, cards: cardsText });
}

export const EXAMPLES: Record<ExerciseType, object> = {
  choose_form: { sentence: "The council ___ the revised timetable yesterday.", options: ["published", "has published", "publish"], correct_index: 0, hint_ru: "Обратите внимание на слово yesterday.", explanation_ru: "Слово yesterday указывает на завершённый момент в прошлом, поэтому нужен Past Simple (published), а не Present Perfect." },
  choose_missing_fragment: { sentence: "The organiser asked us to listen ___ the safety announcement before entering the site.", options: ["to", "for", "at"], correct_index: 0, hint_ru: "Какой предлог нужен после listen перед объектом?", explanation_ru: "После listen перед объектом требуется предлог to: listen to the announcement." },
  detect_error: { sentence: "He suggested to go to the beach after work.", error_segment: "to go", correction: "He suggested going to the beach after work.", hint_ru: "Какая форма глагола следует за suggest?", explanation_ru: "После suggest используется форма с -ing: suggested going. Конструкция suggested to go неверна." },
  guided_short_answer: { cue_ru: "Сотрудник перестал проверять почту после смены. Начни: The employee stopped…", starter_en: "The employee stopped", accepted_answers: ["The employee stopped checking emails after the shift.", "The employee stopped checking email after work."], meaning_ru: "Сотрудник прекратил проверять почту после рабочей смены.", marker_ru: "stop + -ing", reject_ru: "Форма stopped to check меняет смысл и не принимается.", hint_ru: "После stop действие, которое прекратили, выражается формой на -ing.", explanation_ru: "Прекращённое действие после stop выражается герундием: stopped checking emails." },
  russian_to_english_short: { cue_ru: "Не могли бы вы сказать, когда закрывается библиотека?", accepted_answers: ["Could you tell me when the library closes?", "Could you tell me what time the library closes?"], meaning_ru: "Вежливая просьба сообщить время закрытия библиотеки.", marker_ru: "вложенный вопрос с прямым порядком слов", reject_ru: "Вопросительный порядок слов внутри придаточной части (when does the library close) не принимается.", hint_ru: "Во вложенном вопросе порядок слов прямой.", explanation_ru: "Во вложенном вопросе после when используется прямой порядок слов: when the library closes." },
  context_reading: {
    paragraphs: ["The Riverside Lantern Festival has been postponed until next month. Organisers made the decision on Tuesday because of the extreme heat forecast for the weekend, and they announced it on the festival website.", "Tickets that were bought for the original date will remain valid. Anyone who cannot attend the new date can ask for a full refund through the festival website."],
    questions: [
      { prompt: "Why did the organisers postpone the event?", options: ["A heatwave was expected.", "Too few tickets were sold.", "The venue was closed for repairs."], correct_index: 0 },
      { prompt: "What can ticket holders do if the new date does not suit them?", options: ["They can request their money back.", "They can swap tickets at the gate.", "They can attend for free next year."], correct_index: 0 },
    ],
    hint_ru: "Найдите в тексте причину решения.",
    explanation_ru: "Причина решения указана после because of; возврат денег описан в последнем предложении.",
  },
};

const FORMAT_RULES: Record<ExerciseType, string> = {
  choose_form: "One sentence with exactly one gap written as ___ . Give 3 or 4 DIFFERENT options (forms of the SAME word or phrase). Exactly one option is correct; every other option must be clearly wrong in this sentence (not just unusual). correct_index is the 0-based position of the right one.",
  choose_missing_fragment: "One sentence with exactly one gap written as ___ . Give 3 or 4 DIFFERENT short options (a preposition, particle, article or small word). Exactly one is correct; the others are clearly wrong here. correct_index is the 0-based position.",
  detect_error: "One natural sentence. If it contains ONE clear mistake: error_segment is the exact wrong words copied from the sentence, correction is the whole corrected sentence. If it is fully correct: error_segment and correction are empty strings. Do not invent errors in correct sentences.",
  guided_short_answer: "starter_en is the first words the learner must continue (also given in cue_ru). accepted_answers are 2-3 complete, natural sentences that all START with starter_en and differ only in harmless wording. They must express the situation in cue_ru.",
  russian_to_english_short: "cue_ru is one Russian sentence (a natural thing someone would say). accepted_answers are 1-3 natural English translations. Keep it to one sentence.",
  context_reading: "Two short paragraphs (about 70-110 words in total) of a realistic notice, email or news item in Australian English, then 2-3 questions that need the text to answer (3 options each, exactly one correct, correct_index 0-based). No gaps in the text.",
};

export const GENERATION_SYSTEM_V3 = `You write practice items for ONE adult learner of Australian English (level B2). You output JSON only, in the requested shape.
Each item comes with a SKILL CARD: the rule, correct examples and a typical mistake. The item MUST test exactly that rule: the right answer follows the rule, every wrong option or the error in a find-the-mistake sentence breaks THAT rule (not some other rule). If you cannot do this for a skill, output fewer items.
Rules: natural adult topics (work, services, travel, community, health, technology), no personal-life questions, no listening. Sentences 8-20 words.
Russian text (hint_ru, explanation_ru, cue_ru, meaning_ru, marker_ru, reject_ru) must be correct Russian and state the rule from the card correctly. English text must be correct, natural Australian English.
Never put the correct answer into the question text. Never copy the example draft or the card sentences: write new content on a new topic. Never output a status, score, id or any field that is not in the shape.`;

export const GENERATION_SYSTEM_V4 = `You write practice items for one adult learner of Australian English. Output JSON only in the supplied schema.
All items in this request test the same skill card. Use the rule to design the task and its correct answer; the wrong options must clearly break that same rule. For reading, ask questions that actually test the target linking rule in the passage.
Write natural, varied adult contexts and a concise correct Russian explanation. Do not copy the skill-card examples. Ensure exactly one correct option where requested.
Return one draft for each requested item in the same order. If you cannot meet the requirements, return fewer drafts; they will be discarded for review safety. Never claim approval or invent fields.`;

export const GENERATION_SYSTEM_V5 = `${GENERATION_SYSTEM_V4}
Before returning each draft, insert every option into its sentence: exactly one must work under ordinary Australian English readings. Add clear time or meaning context; do not reject a grammatical dialect variant. A collective noun may take singular or plural agreement in Australian English; police takes plural agreement.
For detect_error, identify one genuine error, ensure each segment is copied exactly from the sentence and every correction fixes it; do not call an indefinite article wrong merely because a noun is specific. For no-mistake items every segment must be correct.
For short answers, give a precise Russian meaning, natural accepted English answers and an accurate rubric; never list an ungrammatical answer. For reading, ask distinct questions about the target construction, with exactly one correct option per question. Hints must not reveal the answer. Explain the actual rule in natural Russian.`;

export const GENERATION_SYSTEM_V2 = `You write practice items for ONE adult learner of Australian English (level B2). You output JSON only, in the requested shape.
Rules: natural adult topics (work, services, travel, community, health, technology), no personal-life questions, no listening. Sentences 8-20 words.
Every item must test exactly the TARGET SKILL given for it. Russian text (hint_ru, explanation_ru, cue_ru, meaning_ru, marker_ru, reject_ru) must be correct Russian; English text must be correct, natural Australian English.
Never put the correct answer into the question text. Never output a status, score, id or any field that is not in the shape. If you cannot make a good item for a skill, output fewer items.
Treat the example as a SHAPE guide only: write new content, never copy its sentences.`;

/** The user message of one unit. The example is the only few-shot; skills are described by their taxonomy id. */
export function buildGenerationUser(batchId: string, items: ItemPlan[]): string {
  const first = items[0]!;
  return JSON.stringify({
    task: `Write ${items.length} new practice item(s) of the format ${first.type}.`,
    format: first.type,
    count: items.length,
    format_rules: FORMAT_RULES[first.type],
    batch_id: batchId,
    items: items.map((i) => ({ ordinal: i.ordinal, target_skill: i.target_skill, skill_meaning: skillGloss(i.target_skill), skill_card: skillCards()[i.target_skill] ?? null, topic: i.topic, ...(first.type === "detect_error" ? { sentence_must_be: i.noMistake ? "fully correct (no mistake)" : "one clear mistake" } : {}) })),
    output_shape: `{"drafts":[ one object per item, in the same order ]}`,
    example_of_one_draft: EXAMPLES[first.type],
  });
}

/** V4 has no unrelated worked example: the exact output shape is supplied by the JSON schema. */
export function buildGenerationUserV4(batchId: string, items: ItemPlan[]): string {
  const request = JSON.parse(buildGenerationUser(batchId, items)) as Record<string, unknown>;
  delete request.example_of_one_draft;
  return JSON.stringify(request);
}

/** "agreement.collective_nouns" -> "agreement: collective nouns" */
export function skillGloss(skill: string): string {
  const [family, ...rest] = skill.split(".");
  return `${family}: ${rest.join(".").replace(/_/g, " ")}`;
}

// ---------------------------------------------------------------------------------------------------------------- assembly

export type Built = { ok: true; exercise: Record<string, unknown> } | { ok: false; issues: ValidationIssue[] };
const issue = (code: string, path: string, message: string): ValidationIssue => ({ code, path, message });
const words = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
const GAP = /_{2,}/g;
const ids = ["a", "b", "c", "d"];

/** A draft must be new text: no sentence of the worked example or of the skill card may come back verbatim. */
function copiedFrom(d: Record<string, unknown>, skill: string, issues: ValidationIssue[]): void {
  const forbidden = new Set<string>();
  for (const ex of Object.values(EXAMPLES)) collectEnglish(ex, forbidden);
  for (const g of skillCards()[skill]?.good ?? []) forbidden.add(norm(g));
  const mine = new Set<string>();
  collectEnglish(d, mine);
  for (const s of mine) if (s.split(" ").length >= 4 && forbidden.has(s)) issues.push(issue("COPIED_EXAMPLE", "", `copies a sentence from the example or the skill card: "${s}"`));
}
function collectEnglish(v: unknown, into: Set<string>): void {
  if (typeof v === "string") {
    if (!CYRILLIC.test(v)) for (const part of v.split(/(?<=[.!?])\s+/)) if (part.trim()) into.add(norm(part.replace(/_{2,}/g, " ")));
  } else if (Array.isArray(v)) v.forEach((x) => collectEnglish(x, into));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => collectEnglish(x, into));
}
function checkRussian(label: string, v: unknown, out: ValidationIssue[]): void {
  if (typeof v !== "string" || !CYRILLIC.test(v)) out.push(issue("NOT_RUSSIAN", `/${label}`, `${label} must be written in Russian`));
}
function checkEnglish(label: string, v: unknown, out: ValidationIssue[]): void {
  if (typeof v !== "string" || CYRILLIC.test(v) || !LATIN_WORD.test(v)) out.push(issue("NOT_ENGLISH", `/${label}`, `${label} must be English text`));
}

/**
 * Turns ONE model draft into a complete Exercise-v1 and checks it. Keys outside the format's shape (status, id, confirmed, ...) are refused.
 * The server owns every control field; the model never decides ids, status, bank role, provenance or the skill tag.
 */
export function assembleExercise(raw: unknown, plan: ItemPlan, ctx: { exerciseId: string; model: { tag: string; digest: string }; promptVersion: string; taxonomySkillIds: ReadonlySet<string> }): Built {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, issues: [issue("NOT_AN_OBJECT", "", "a draft must be a JSON object")] };
  const d = raw as Record<string, unknown>;
  const type = plan.type as ExerciseType;
  const allowed = new Set(Object.keys(DRAFT_PROPS[type]));
  const issues: ValidationIssue[] = [];
  for (const k of Object.keys(d)) {
    if (allowed.has(k)) continue;
    if (["status", "approved", "confirmed", "bank_role", "id", "revision", "provenance", "target_skill", "type"].includes(k)) issues.push(issue("MODEL_CLAIMED_FIELD", `/${k}`, `the model may not set "${k}" (status, ids, bank role, provenance and skill are decided by the server)`));
    else issues.push(issue("UNEXPECTED_FIELD", `/${k}`, `not part of the ${type} draft shape`));
  }
  if (issues.length > 0) return { ok: false, issues };
  copiedFrom(d, plan.target_skill, issues);
  checkRussian("explanation_ru", d.explanation_ru, issues);
  checkRussian("hint_ru", d.hint_ru, issues);
  if (typeof d.explanation_ru === "string" && d.explanation_ru.trim().length < MIN_EXPLANATION) issues.push(issue("EXPLANATION_TOO_SHORT", "/explanation_ru", "explanation is too short to teach anything"));

  let promptEn = "";
  let payload: Record<string, unknown> = {};
  switch (type) {
    case "choose_form":
    case "choose_missing_fragment": {
      const options = d.options as string[];
      const sentence = String(d.sentence ?? "");
      checkEnglish("sentence", sentence, issues);
      if ((sentence.match(GAP) ?? []).length !== 1) issues.push(issue("GAP_COUNT", "/sentence", "the sentence needs exactly one gap written ___"));
      const uniq = new Set(options.map((o) => norm(o)));
      if (uniq.size !== options.length || options.some((o) => norm(o) === "")) issues.push(issue("OPTIONS_NOT_DISTINCT", "/options", "options must be different, non-empty texts"));
      if (options.some((o) => CYRILLIC.test(o))) issues.push(issue("NOT_ENGLISH", "/options", "options must be English"));
      const ci = Number(d.correct_index);
      if (!Number.isInteger(ci) || ci < 0 || ci >= options.length) issues.push(issue("KEY_OUT_OF_RANGE", "/correct_index", "correct_index must point at one of the options"));
      promptEn = sentence.replace(GAP, "___");
      payload = { options: options.map((text, i) => ({ id: ids[i]!, text })), accepted_option_ids: [ids[ci] ?? "a"], multiple: false };
      break;
    }
    case "detect_error": {
      const sentence = String(d.sentence ?? "").trim();
      const seg = String(d.error_segment ?? "");
      const correction = String(d.correction ?? "").trim();
      checkEnglish("sentence", sentence, issues);
      if (words(sentence) < 4) issues.push(issue("TOO_SHORT", "/sentence", "the sentence is too short"));
      const wantsMistake = !plan.noMistake;
      if (wantsMistake) {
        const at = sentence.indexOf(seg);
        if (seg === "" || at < 0) issues.push(issue("SEGMENT_NOT_IN_SENTENCE", "/error_segment", "error_segment must be copied exactly from the sentence"));
        else if (sentence.indexOf(seg, at + 1) >= 0) issues.push(issue("SEGMENT_AMBIGUOUS", "/error_segment", "error_segment occurs more than once"));
        if (correction === "" || norm(correction) === norm(sentence)) issues.push(issue("NO_CORRECTION", "/correction", "the correction must differ from the sentence"));
        else if (seg !== "" && correction.includes(seg)) issues.push(issue("CORRECTION_KEEPS_ERROR", "/correction", "the corrected sentence still contains the wrong words"));
        if (issues.length === 0) {
          const at2 = sentence.indexOf(seg);
          const parts = [sentence.slice(0, at2), seg, sentence.slice(at2 + seg.length)];
          const segs = parts.map((text, i) => ({ id: `s${i + 1}`, text })).filter((s) => s.text !== "");
          payload = { sentence, segments: segs, accepted_segment_ids: [segs.find((s) => s.text === seg)!.id], no_mistake: false, corrections: [correction], optional_correction: true };
        }
      } else {
        if (seg !== "" || correction !== "") issues.push(issue("EXPECTED_NO_MISTAKE", "/error_segment", "this item must be a fully correct sentence: leave error_segment and correction empty"));
        const w = sentence.split(/\s+/);
        const a = Math.max(1, Math.floor(w.length / 3));
        const b = Math.max(a + 1, Math.floor((2 * w.length) / 3));
        const chunks = [w.slice(0, a).join(" ") + " ", w.slice(a, b).join(" ") + " ", w.slice(b).join(" ")];
        payload = { sentence, segments: chunks.map((text, i) => ({ id: `s${i + 1}`, text })), accepted_segment_ids: [], no_mistake: true, corrections: [], optional_correction: false };
      }
      promptEn = "Find the part of the sentence that contains a mistake, or choose No mistake.";
      break;
    }
    case "guided_short_answer": {
      const answers = d.accepted_answers as string[];
      const starter = String(d.starter_en ?? "").trim();
      checkRussian("cue_ru", d.cue_ru, issues);
      checkEnglish("starter_en", starter, issues);
      for (const [i, a] of answers.entries()) {
        checkEnglish(`accepted_answers/${i}`, a, issues);
        if (!norm(a).startsWith(norm(starter))) issues.push(issue("ANSWER_NOT_STARTING_WITH_STARTER", `/accepted_answers/${i}`, "every accepted answer must begin with starter_en"));
        if (norm(a) === norm(starter)) issues.push(issue("ANSWER_IS_STARTER", `/accepted_answers/${i}`, "the answer must continue the starter"));
      }
      if (new Set(answers.map(norm)).size !== answers.length) issues.push(issue("ANSWERS_NOT_DISTINCT", "/accepted_answers", "accepted answers must differ"));
      promptEn = `Complete the sentence in your own words, starting with: ${starter}...`;
      payload = rubricPayload(d, answers, Math.max(...answers.map(words)) + 5);
      break;
    }
    case "russian_to_english_short": {
      const answers = d.accepted_answers as string[];
      checkRussian("cue_ru", d.cue_ru, issues);
      for (const [i, a] of answers.entries()) checkEnglish(`accepted_answers/${i}`, a, issues);
      if (new Set(answers.map(norm)).size !== answers.length) issues.push(issue("ANSWERS_NOT_DISTINCT", "/accepted_answers", "accepted answers must differ"));
      promptEn = "Translate the idea into natural English.";
      payload = rubricPayload(d, answers, Math.max(...answers.map(words)) + 5);
      break;
    }
    case "context_reading": {
      const paragraphs = d.paragraphs as string[];
      const questions = d.questions as Array<{ prompt: string; options: string[]; correct_index: number }>;
      paragraphs.forEach((p, i) => {
        checkEnglish(`paragraphs/${i}`, p, issues);
        if (GAP.test(p)) issues.push(issue("GAP_IN_PASSAGE", `/paragraphs/${i}`, "a reading passage has no gaps"));
        GAP.lastIndex = 0;
      });
      if (paragraphs.reduce((a, p) => a + words(p), 0) < 45) issues.push(issue("PASSAGE_TOO_SHORT", "/paragraphs", "the passage is too short for a reading item"));
      if (paragraphs[0] && paragraphs[1] && norm(paragraphs[0]) === norm(paragraphs[1])) issues.push(issue("PARAGRAPHS_IDENTICAL", "/paragraphs", "the two paragraphs are the same"));
      if (new Set(questions.map((q) => norm(q.prompt))).size !== questions.length) issues.push(issue("QUESTIONS_NOT_DISTINCT", "/questions", "questions must ask different things"));
      questions.forEach((q, i) => {
        checkEnglish(`questions/${i}/prompt`, q.prompt, issues);
        if (new Set(q.options.map(norm)).size !== q.options.length) issues.push(issue("OPTIONS_NOT_DISTINCT", `/questions/${i}/options`, "options must be different"));
        if (q.options.some((o) => CYRILLIC.test(o))) issues.push(issue("NOT_ENGLISH", `/questions/${i}/options`, "options must be English"));
        if (!Number.isInteger(q.correct_index) || q.correct_index < 0 || q.correct_index >= q.options.length) issues.push(issue("KEY_OUT_OF_RANGE", `/questions/${i}/correct_index`, "correct_index must point at one of the options"));
      });
      promptEn = "Read the text and answer the questions.";
      payload = {
        paragraphs,
        questions: questions.map((q, i) => ({ id: `q${i + 1}`, prompt: q.prompt, options: q.options.map((text, k) => ({ id: ids[k]!, text })), accepted_option_ids: [ids[q.correct_index] ?? "a"], target_skill: plan.target_skill })),
      };
      break;
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  const fingerprint = createHash("sha256").update(norm(promptEn || JSON.stringify(payload))).digest("hex").slice(0, 10);
  const exercise: Record<string, unknown> = {
    schema_version: "exercise-v1",
    id: ctx.exerciseId,
    revision: 1,
    status: "draft",
    target_skill: plan.target_skill,
    additional_skills: [],
    dimension: DIMENSION_BY_TYPE[type],
    difficulty: "B2",
    context_level: "B2",
    topic: plan.topic,
    context_id: plan.context_id,
    template_cluster: `gen-${type}-${plan.target_skill}-${fingerprint}`,
    bank_role: "practice",
    prompt_en: promptEn,
    hints_ru: [String(d.hint_ru).trim()],
    explanation_ru: String(d.explanation_ru).trim(),
    sources: [],
    provenance: { origin: "qwen", model_tag: ctx.model.tag, model_digest: ctx.model.digest, prompt_version: ctx.promptVersion },
    rubric_version: "rubric-v1",
    type,
    payload,
  };
  const v = validateExercise(exercise, { taxonomySkillIds: ctx.taxonomySkillIds });
  return v.ok ? { ok: true, exercise } : { ok: false, issues: v.errors };
}

function rubricPayload(d: Record<string, unknown>, answers: string[], maxWords: number): Record<string, unknown> {
  return {
    cue_ru: String(d.cue_ru).trim(),
    max_words: Math.min(40, Math.max(6, maxWords)),
    accepted_answers: answers,
    rubric: { meaning_ru: String(d.meaning_ru).trim(), target_markers: [String(d.marker_ru).trim()], acceptable_variation_ru: "Допустимы естественные альтернативы стандартного английского с тем же значением.", reject_conditions_ru: String(d.reject_ru).trim() },
    allow_voice: true,
  };
}
