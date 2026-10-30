// TASK_017 / D59: the first-ten-lessons bank is written by an AI agent (claude-sonnet-5-5) in compact tuples and expanded here into exercise-v1 objects.
// Review is by the SAME agent family, individually per revision, recorded as an agent - NOT an independent strong review and NOT a human one (D59).
// Ids are derived from the key, so seeding is idempotent. Sentences are original, abstract and en-AU; nothing is copied from a reference or held-out text.
import { base, opts, rubric } from "../slice/slice-bank.mjs";

export const FIRST10_AUTHOR = "agent:claude-sonnet-5-5@first10-author-v1";
export const FIRST10_REVIEWER = "agent:claude-sonnet-5-5@first10-self-review-v1";
const PROMPT_VERSION = "first10-v1";

function finish(item, difficulty, role, topicPrefix) {
  return {
    ...item,
    difficulty,
    bank_role: role,
    topic: `${topicPrefix}:${item.topic}`,
    provenance: { origin: "agent", model_tag: null, model_digest: null, prompt_version: PROMPT_VERSION },
  };
}

/**
 * One block of exercises. `defs` holds the compact tuples (the same shapes as the slice bank, plus an optional trailing difficulty A2/B1/B2):
 *   form / fragment: [skill, topic, prompt, [options], correctIndex, hint, explanation, difficulty?]
 *   detect:          [skill, topic, segments[], faultyIndex | null, corrections[], hint, explanation, difficulty?]
 *   guided:          [skill, topic, prompt, cue_ru, answers[], hint, markers[], explanation, difficulty?]
 *   translate:       [skill, topic, cue_ru, answers[], hint, explanation, difficulty?]
 *   reading:         [skill, topic, paragraphs[], [[question, [options], correctIndex, questionSkill], ...], hint, explanation, difficulty?]
 */
export function buildBlock(code, defs, role = "practice", idPrefix = "f10") {
  const out = [];
  const add = (key, type, dim, skill, topic, prompt, hints, expl, payload, diff) => out.push(finish(base(`${idPrefix}-${code}-${key}`, type, dim, skill, topic, prompt, hints, expl, payload), diff ?? "B1", role, code));
  (defs.form ?? []).forEach(([skill, topic, prompt, o, c, hint, expl, d], i) => add(`form-${i + 1}`, "choose_form", "recognition", skill, topic, prompt, [hint], expl, { options: opts(...o), accepted_option_ids: ["abc"[c]], multiple: false }, d));
  (defs.fragment ?? []).forEach(([skill, topic, prompt, o, c, hint, expl, d], i) => add(`fragment-${i + 1}`, "choose_missing_fragment", "recognition", skill, topic, prompt, [hint], expl, { options: opts(...o), accepted_option_ids: ["abc"[c]], multiple: false }, d));
  (defs.detect ?? []).forEach(([skill, topic, segs, bad, corrections, hint, expl, d], i) =>
    add(`detect-${i + 1}`, "detect_error", "correction", skill, topic, "Find the part of the sentence that contains a mistake, or choose No mistake.", [hint], expl, {
      sentence: segs.join(""),
      segments: segs.map((text, k) => ({ id: `s${k + 1}`, text })),
      accepted_segment_ids: bad === null ? [] : [`s${bad + 1}`],
      no_mistake: bad === null,
      corrections,
      optional_correction: bad !== null,
    }, d),
  );
  (defs.guided ?? []).forEach(([skill, topic, prompt, cue, answers, hint, markers, expl, d], i) =>
    add(`guided-${i + 1}`, "guided_short_answer", "production", skill, topic, prompt, [hint], expl, {
      cue_ru: cue,
      max_words: 15,
      accepted_answers: answers,
      rubric: rubric(cue.split(". Начни")[0] + ".", markers, "Допустимы близкие естественные формулировки с той же грамматикой.", "Неверная целевая форма не принимается."),
      allow_voice: true,
    }, d),
  );
  (defs.translate ?? []).forEach(([skill, topic, cue, answers, hint, expl, d], i) =>
    add(`translate-${i + 1}`, "russian_to_english_short", "production", skill, topic, "Translate the idea into natural English.", [hint], expl, {
      cue_ru: cue,
      max_words: 15,
      accepted_answers: answers,
      rubric: rubric(cue, ["целевая грамматическая форма"], "Допустимы другие естественные формулировки с той же грамматикой.", "Неверная целевая форма не принимается."),
      allow_voice: true,
    }, d),
  );
  (defs.reading ?? []).forEach(([skill, topic, paragraphs, questions, hint, expl, d], i) =>
    add(`reading-${i + 1}`, "context_reading", "recognition", skill, topic, "Read the text and answer the questions.", [hint], expl, {
      paragraphs,
      questions: questions.map(([prompt, o, c, qSkill], k) => ({ id: `q${k + 1}`, prompt, options: opts(...o), accepted_option_ids: ["abc"[c]], target_skill: qSkill })),
    }, d ?? "B2"),
  );
  return out;
}

/** lessons with one reading passage in place of three recognition slots (spec/LESSON_BLUEPRINTS, D19) */
export const READING_LESSONS = new Set(["L03", "L06", "L10"]);

/** the ten lesson blueprints (spec/LESSON_BLUEPRINTS.md): pools and default first-run quotas; all pending_review in the spec, published only after the item reviews */
export const LESSONS = [
  ["L01", "Everyday arrangements", ["prepositions.listen_to", "prepositions.wait_for", "articles.indefinite", "agreement.be_auxiliary", "questions.embedded_order"]],
  ["L02", "Decisions and trade-offs", ["verb_patterns.stop_doing_vs_stop_to_do", "verb_patterns.would_rather", "conditionals.second", "modals.advice", "articles.zero_general"]],
  ["L03", "Travel and public transport", ["questions.embedded_order", "questions.embedded_whether", "prepositions.movement", "tenses.perfect_vs_past", "countability.much_many"]],
  ["L04", "Entertainment and preferences", ["verb_patterns.enjoy_doing", "verb_patterns.think_of_doing", "tenses.habitual_used_to", "relatives.defining", "articles.definite"]],
  ["L05", "Shopping and services", ["countability.few_little", "countability.mass_nouns", "modals.polite_requests", "passive.past", "pronouns.demonstratives"]],
  ["L06", "Technology and public decisions", ["passive.present", "reported_speech.statements", "agreement.third_person", "conditionals.first", "register.politeness"]],
  ["L07", "Social and community situations", ["articles.possessive_no_article", "pronouns.reflexives", "word_order.adverbs", "linking.contrast", "questions.direct_auxiliary"]],
  ["L08", "Problems and practical solutions", ["tenses.present_perfect", "tenses.past_continuous", "prepositions.explain_to", "modals.obligation", "conditionals.third"]],
  ["L09", "Australia and local services", ["articles.definite", "prepositions.time_at_on_in", "relatives.nondefining", "modals.deduction", "register.dialect_variants"]],
  ["L10", "Mixed transfer review", ["questions.embedded_order", "verb_patterns.stop_doing_vs_stop_to_do", "tenses.perfect_vs_past", "countability.singular_plural", "collocations.make_do"]],
];
export const LESSON_QUOTAS = { choose_form: 5, choose_missing_fragment: 5, detect_error: 5, guided_short_answer: 1, russian_to_english_short: 2 };
