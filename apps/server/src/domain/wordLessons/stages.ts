import type { Validated } from "../ai/validate.js";
import { skillCards } from "../content/batches/draftFormats.js";
import { REWRITE_KINDS, type PlanSkill } from "./plan.js";
import type { LessonPlan } from "./plan.js";
import {
  SentenceLedger,
  bad,
  countTarget,
  englishIssue,
  findTarget,
  gapOut,
  isForm,
  isProperStart,
  ok,
  parseObject,
  russianIssue,
  sentenceKey,
  str,
  strList,
  wordCount,
  wordDistance,
  type LessonWord,
} from "./validate.js";

/** what the model is told about the word; everything else comes from the plan */
export interface WordFacts {
  lemma: string;
  translationRu: string;
  definitionRu: string;
  pos: string;
  synonyms: string[];
  word: LessonWord;
}

export interface Stage12 {
  examples: Array<{ en: string; ru: string; target: { start: number; length: number } }>;
  gap: { full_en: string; gapped_en: string; ru: string; accepted_forms: string[] };
}
export interface Transformation {
  skill_id: string | null;
  construction_en: string;
  instruction_en: string;
  source_en: string;
  expected_en: string;
  accepted_en: string[];
  hint_partial_en: string;
  translation_ru: string;
}
export interface Stage3 {
  chained: boolean;
  items: Transformation[];
}
export interface Stage4 {
  skill_id: string | null;
  construction_en: string;
  pattern: string;
  pattern_example_en: string;
  cue_ru: string;
  expected_en: string;
  accepted_en: string[];
  hint_partial_en: string;
  translation_ru: string;
}
export interface Stage5 {
  situation_en: string;
  situation_ru: string;
  suggested_words: string[];
  hint_start_en: string;
  sample_en: string;
  sample_ru: string;
}

const base = (f: WordFacts, plan: LessonPlan, task: string) => ({
  task,
  target_word: f.lemma,
  part_of_speech: f.pos,
  sense_ru: f.translationRu,
  meaning_ru: f.definitionRu || undefined,
  synonyms: f.synonyms.length ? f.synonyms : undefined,
  word_forms: f.word.forms.slice(0, 12),
  word_rule: /phrasal/i.test(f.pos) ? "Keep this phrasal verb in the active voice in every sentence; never use it in the passive." : /conjunction|preposition/i.test(f.pos) ? "This word links parts of a sentence; never put it inside a question or an indirect question." : undefined,
  cefr: `${plan.difficulty.min}-${plan.difficulty.max}`,
});

/** the user message of each task; `avoid` carries the reviewer's remark when a stage is written again */
export function stageInput(f: WordFacts, plan: LessonPlan, stage: "stage12" | "stage3" | "stage4" | "stage5", avoid: string[]): string {
  const guidance = {
    stage12: "",
    stage3: "Use different actions within meaning-preserving rewrites. In hint_partial_en write one Russian rule cue specific to this item, with placeholders. Do not copy the start of the answer. Apply each planned construction and use its exact supplied name.",
    stage4: "Apply the planned construction and use its exact supplied name. Vary the intent across comparison, condition, preference, advice, cause, consequence, past habit or quantity when appropriate. In hint_partial_en write one Russian rule cue with placeholders, not the start of the answer.",
    stage5: "Write a single direct question or instruction of 3 to 10 English words. No introduction, scene setting or Imagine that. In hint_start_en give one short Russian suggestion for what to say, not the start of the sample.",
  }[stage];
  const extra = { ...(avoid.length ? { avoid_problems: avoid } : {}), ...(plan.version === "word-lesson-plan-v2" && guidance ? { stage_requirements_override: guidance } : {}) };
  switch (stage) {
    case "stage12":
      return JSON.stringify({ ...base(f, plan, "stage12"), topics: plan.topics.slice(0, 4), ...extra });
    case "stage3":
      return JSON.stringify({ ...base(f, plan, "stage3"), count: plan.transformations, skills: plan.skills.slice(0, plan.transformations).map(skillBrief), topics: plan.topics.slice(1, 3), ...extra });
    case "stage4":
      return JSON.stringify({ ...base(f, plan, "stage4"), skill: skillBrief(plan.skills[plan.transformations] ?? plan.skills[0]), topics: [plan.topics[3]], ...extra });
    case "stage5":
      return JSON.stringify({ ...base(f, plan, "stage5"), topics: [plan.topics[4]], ...extra });
  }
}

/** what the model is told about a construction: its rule and good examples from the skill cards (a bare label such as "defining" means nothing to it) */
export function skillBrief(s: PlanSkill | undefined): { construction: string; rule?: string; good_examples?: string[] } {
  if (!s) return { construction: "a common construction you know well" };
  const card = s.id ? skillCards()[s.id] : undefined;
  if (card) return { construction: s.label, rule: card.rule, good_examples: card.good.slice(0, 2) };
  const kind = REWRITE_KINDS.find((k) => k.label === s.label);
  return kind ? { construction: s.label, rule: kind.rule, good_examples: kind.good } : { construction: s.label };
}

const hasOnly = (o: Record<string, unknown>, keys: string[]): boolean => Object.keys(o).every((k) => keys.includes(k));

export function validateStage12(text: string, f: WordFacts, ledger: SentenceLedger): Validated<Stage12> {
  const o = parseObject(text);
  if (!o || !hasOnly(o, ["examples", "gap"])) return bad("SHAPE", "expected {examples, gap}");
  const ex = Array.isArray(o.examples) ? o.examples : [];
  if (ex.length !== 3) return bad("EXAMPLES", "exactly three example sentences are needed");
  const l = ledger.fork();
  const examples: Stage12["examples"] = [];
  for (let i = 0; i < 3; i++) {
    const e = ex[i] as Record<string, unknown>;
    const en = str(e?.en);
    const ru = str(e?.ru);
    const issue = englishIssue(en, { min: 5, max: 22 });
    if (issue) return bad("EXAMPLE_EN", `example ${i + 1} ${issue}`);
    const t = findTarget(en, f.word);
    if (!t) return bad("EXAMPLE_WITHOUT_WORD", `example ${i + 1} must use "${f.lemma}" (a form of the word, the phrase kept together)`);
    if (russianIssue(ru)) return bad("EXAMPLE_RU", `example ${i + 1}: ru ${russianIssue(ru)}`);
    const why = l.reason(en, { independent: true });
    if (why) return bad("EXAMPLE_REPEAT", `example ${i + 1} ${why}`);
    l.accept(en, { independent: true, id: `e${i + 1}` });
    examples.push({ en, ru, target: { start: t.start, length: t.length } });
  }
  const g = o.gap as Record<string, unknown> | undefined;
  if (!g || typeof g !== "object") return bad("GAP", "gap is missing");
  const full = str(g.full_en);
  const ru = str(g.ru);
  const issue = englishIssue(full, { min: 6, max: 22 });
  if (issue) return bad("GAP_EN", `gap.full_en ${issue}`);
  const gapped = gapOut(full, f.word);
  if (!gapped) return bad("GAP_WORD", `gap.full_en must contain the word "${f.lemma}" exactly once`);
  if (russianIssue(ru)) return bad("GAP_RU", `gap.ru ${russianIssue(ru)}`);
  const why = l.reason(full, { independent: true });
  if (why) return bad("GAP_REPEAT", `gap.full_en ${why}`);
  const found = findTarget(full, f.word)!;
  const forms = [found.form.toLowerCase()];
  // other forms are NOT accepted whatever the model says (it cannot judge them reliably: "managed to coping" was offered): the recall task has one form
  return ok({ examples, gap: { full_en: full, gapped_en: gapped, ru, accepted_forms: forms } });
}

/** accepted variants: the expected sentence first, only English sentences with the word, no repeats */
function variants(expected: string, given: string[], f: WordFacts): string[] | string {
  const list = [expected];
  for (const v of given) {
    if (sentenceKey(v) === sentenceKey(expected) || list.some((x) => sentenceKey(x) === sentenceKey(v))) continue;
    const issue = englishIssue(v, { min: 3, max: 28 });
    if (issue) return `accepted variant "${v.slice(0, 60)}" ${issue}`;
    if (countTarget(v, f.word) < 1) return `accepted variant "${v.slice(0, 60)}" does not use the word`;
    list.push(v);
  }
  return list;
}

/**
 * Words that a construction may take away or swap by itself: auxiliaries and the words of the opening phrase (do/did/have/will, "I wonder", "I don't know"),
 * the pronouns that change case in a passive, and time words that a tense change replaces (yesterday, so far, last week).
 * Every other word of the source (a person, a place, a thing, a manner, a reason) must still be in the rewritten sentence.
 */
const MAY_VANISH = new Set([
  "a", "an", "the", "do", "does", "did", "have", "has", "had", "will", "would", "was", "were", "is", "are", "am", "be", "been", "being", "to", "that", "if", "whether", "not", "dont", "wonder", "know", "want", "like", "used", "could", "can", "you", "tell", "me",
  "i", "he", "she", "it", "we", "they", "him", "her", "us", "them", "his", "its", "our", "their", "my", "your",
  "but", "although", "though", "despite", "because", "so", "unless", "then", "after", "before", "of", "than", "no", "any", "order", "able", "yesterday", "ago", "last", "week", "month", "year", "so", "far", "now", "already", "yet", "still", "just", "ever", "since", "for", "during", "today", "currently", "usually", "often", "always",
]);
const sameWord = (x: string, y: string): boolean => x === y || (x.length >= 4 && y.length >= 4 && x.slice(0, 4) === y.slice(0, 4)); // an ending may change (cope/coped, resolves/resolved)

/** the words of the first sentence that are missing from the second and that the construction does not account for (see MAY_VANISH) */
export function lostWords(a: string, b: string): string[] {
  const rest = sentenceKey(b).replace(/'/g, "").split(" ").filter(Boolean);
  const lost: string[] = [];
  for (const w of sentenceKey(a).replace(/'/g, "").split(" ").filter(Boolean)) {
    const i = rest.findIndex((x) => sameWord(x, w));
    if (i >= 0) rest.splice(i, 1);
    else if (!MAY_VANISH.has(w)) lost.push(w);
  }
  return lost;
}

export function validateStage3(text: string, f: WordFacts, plan: LessonPlan, ledger: SentenceLedger): Validated<Stage3> {
  const o = parseObject(text);
  if (!o || !hasOnly(o, ["chained", "items"]) || typeof o.chained !== "boolean") return bad("SHAPE", "expected {chained, items}");
  const raw = Array.isArray(o.items) ? o.items : [];
  if (raw.length !== plan.transformations) return bad("ITEMS", `exactly ${plan.transformations} transformations are needed`);
  const chained = o.chained;
  const l = ledger.fork();
  const items: Transformation[] = [];
  for (let k = 0; k < raw.length; k++) {
    const r = raw[k] as Record<string, unknown>;
    const n = k + 1;
    const source = str(r.source_en);
    const expected = str(r.expected_en);
    const construction = str(r.construction_en);
    const instruction = str(r.instruction_en);
    const hint = str(r.hint_partial_en);
    const tr = str(r.translation_ru);
    for (const [label, s] of [["source_en", source], ["expected_en", expected]] as const) {
      const issue = englishIssue(s, { min: 4, max: 26 });
      if (issue) return bad("T_EN", `item ${n} ${label} ${issue}`);
      if (countTarget(s, f.word) < 1) return bad("T_WORD", `item ${n} ${label} must use "${f.lemma}" (a form of the word)`);
    }
    if (wordDistance(source, expected) < 2) return bad("T_SAME", `item ${n}: expected_en must be visibly different from source_en (at least two words changed, not just the ending of one word); the source must not already use the construction`);
    if (!construction || /[Ѐ-ӿ]/.test(construction) || construction.length > 120) return bad("T_CONSTRUCTION", `item ${n}: construction_en must be a short English name`);
    if (!instruction || /[Ѐ-ӿ]/.test(instruction) || wordCount(instruction) < 6) return bad("T_INSTRUCTION", `item ${n}: instruction_en must say exactly what to do, in a full English sentence (a grammar label is not an instruction)`);
    if (plan.skills[k]?.id?.startsWith("questions.embedded") && /\bdirect\b/i.test(instruction)) return bad("T_INSTRUCTION", `item ${n}: an embedded question is an indirect question; do not call it a direct question`);
    // code rules that small models break most often: a transformation must not grow a new clause, and the embedded-question and relative-clause tasks need the right kind of source
    const planned = plan.skills[k];
    if (plan.version === "word-lesson-plan-v2" && planned && (construction.toLowerCase() !== planned.label.toLowerCase() || r.used_skill !== true)) return bad("T_PLAN_SKILL", "Use the requested construction and its exact name");
    const skillId = planned?.id ?? "";
    const embedded = skillId.startsWith("questions.embedded");
    if (wordCount(expected) > wordCount(source) + (embedded ? 5 : 4)) return bad("T_GROWS", `item ${n}: expected_en is much longer than source_en; a transformation must not add new information or a new clause`);
    // the rewritten sentence keeps the details of the source: only the words the construction replaces may disappear (a learner who keeps "in her old job" must be right too)
    const gone = lostWords(source, expected);
    if (gone.length > 1) return bad("T_DROPS", `item ${n}: expected_en loses ${gone.map((w) => `"${w}"`).join(", ")} from source_en; keep every detail (people, places, things, manner) of the source and change only what the construction needs`);
    if (embedded && !(/[?]$/.test(source.trim()) || /^(i wonder|i don't know|i do not know|i want to know|i'd like to know|i would like to know)\b/i.test(source.trim()))) return bad("T_SOURCE", `item ${n}: for an embedded-question task source_en must be a direct question (ending with ?) or start with "I wonder" / "I don't know"`);
    if (skillId === "relatives.defining" && !/\b(who|whom|which|that|whose)\b/i.test(expected)) return bad("T_RELATIVE", `item ${n}: expected_en must contain a relative clause (who, which or that)`);
    if (plan.version === "word-lesson-plan-v2" && (russianIssue(hint) || hint.length > 180 || hint.includes(expected))) return bad("T_RULE_HINT", "Give a brief Russian cue about the rule without the full answer");
    if (plan.version === "word-lesson-plan-v1" && !isProperStart(hint, expected)) return bad("T_HINT", `item ${n}: hint_partial_en must be the first words of expected_en and at least two words shorter`);
    if (russianIssue(tr)) return bad("T_RU", `item ${n}: translation_ru ${russianIssue(tr)}`);
    if (chained && k > 0 && sentenceKey(source) !== sentenceKey(items[k - 1]!.expected_en)) return bad("T_CHAIN", `item ${n}: in a chain source_en must be exactly the previous expected_en`);
    const accepted = variants(expected, strList(r.accepted_en), f);
    if (typeof accepted === "string") return bad("T_ACCEPTED", `item ${n}: ${accepted}`);
    const chainedSource = chained && k > 0;
    const why = l.reason(source, { independent: !chainedSource, allowSameAs: chainedSource ? `s3.${k}.exp` : undefined });
    if (why) return bad("T_REPEAT", `item ${n} source_en ${why}`);
    const why2 = l.reason(expected, { independent: false });
    if (why2) return bad("T_REPEAT", `item ${n} expected_en ${why2}`);
    if (!chainedSource) l.accept(source, { independent: true, id: `s3.${n}.src` });
    l.accept(expected, { independent: false, id: `s3.${n}.exp` });
    items.push({
      skill_id: r.used_skill === true ? (plan.skills[k]?.id ?? null) : null,
      construction_en: construction,
      instruction_en: instruction,
      source_en: source,
      expected_en: expected,
      accepted_en: accepted,
      hint_partial_en: hint,
      translation_ru: tr,
    });
  }
  return ok({ chained, items });
}

export function validateStage4(text: string, f: WordFacts, plan: LessonPlan, ledger: SentenceLedger): Validated<Stage4> {
  const o = parseObject(text);
  const keys = ["cue_ru", "construction_en", "pattern", "pattern_example_en", "expected_en", "accepted_en", "hint_partial_en", "translation_ru", "used_skill"];
  if (!o || !hasOnly(o, keys)) return bad("SHAPE", "unexpected shape");
  const expected = str(o.expected_en);
  const pattern = str(o.pattern);
  const example = str(o.pattern_example_en);
  const construction = str(o.construction_en);
  const cue = str(o.cue_ru);
  const hint = str(o.hint_partial_en);
  const tr = str(o.translation_ru);
  const issue = englishIssue(expected, { min: 4, max: 26 });
  if (issue) return bad("S4_EN", `expected_en ${issue}`);
  if (countTarget(expected, f.word) < 1) return bad("S4_WORD", `expected_en must use "${f.lemma}" (a form of the word)`);
  if (!pattern || /[Ѐ-ӿ]/.test(pattern) || pattern.length > 70) return bad("S4_PATTERN", "pattern must be a short English scheme (at most 70 characters)");
  const exIssue = englishIssue(example, { min: 3, max: 22 });
  if (exIssue) return bad("S4_EXAMPLE", `pattern_example_en ${exIssue}`);
  if (countTarget(example, f.word) > 0) return bad("S4_EXAMPLE_WORD", "pattern_example_en must NOT contain the target word");
  if (!construction || /[Ѐ-ӿ]/.test(construction) || construction.length > 120) return bad("S4_CONSTRUCTION", "construction_en must be a short English name");
  if (russianIssue(cue)) return bad("S4_CUE", `cue_ru ${russianIssue(cue)}`);
  if (russianIssue(tr)) return bad("S4_RU", `translation_ru ${russianIssue(tr)}`);
  const planned = plan.skills[plan.transformations];
  if (plan.version === "word-lesson-plan-v2" && planned && (construction.toLowerCase() !== planned.label.toLowerCase() || o.used_skill !== true)) return bad("S4_PLAN_SKILL", "Use the requested construction and its exact name");
  if (plan.version === "word-lesson-plan-v2" && (russianIssue(hint) || hint.length > 180 || hint.includes(expected))) return bad("S4_RULE_HINT", "Give a brief Russian cue about the rule without the full answer");
  if (plan.version === "word-lesson-plan-v1" && !isProperStart(hint, expected)) return bad("S4_HINT", "hint_partial_en must be the first words of expected_en and at least two words shorter");
  const accepted = variants(expected, strList(o.accepted_en), f);
  if (typeof accepted === "string") return bad("S4_ACCEPTED", accepted);
  const why = ledger.fork().reason(expected, { independent: true });
  if (why) return bad("S4_REPEAT", `expected_en ${why}`);
  return ok({
    skill_id: o.used_skill === true ? (plan.skills[plan.transformations]?.id ?? null) : null,
    construction_en: construction,
    pattern,
    pattern_example_en: example,
    cue_ru: cue,
    expected_en: expected,
    accepted_en: accepted,
    hint_partial_en: hint,
    translation_ru: tr,
  });
}

export function validateStage5(text: string, f: WordFacts, ledger: SentenceLedger, concise = false): Validated<Stage5> {
  const o = parseObject(text);
  const keys = ["situation_en", "situation_ru", "suggested_words", "sample_en", "sample_ru", "hint_start_en"];
  if (!o || !hasOnly(o, keys)) return bad("SHAPE", "unexpected shape");
  const situation = str(o.situation_en);
  const sample = str(o.sample_en);
  const sitIssue = englishIssue(situation, concise ? { min: 3, max: 10 } : { min: 4, max: 30 });
  if (sitIssue) return bad("S5_SITUATION", `situation_en ${sitIssue}`);
  if (russianIssue(str(o.situation_ru))) return bad("S5_SITUATION_RU", "situation_ru must be Russian");
  const sIssue = englishIssue(sample, { min: 5, max: 24 });
  if (sIssue) return bad("S5_SAMPLE", `sample_en ${sIssue}`);
  if (countTarget(sample, f.word) < 1) return bad("S5_WORD", `sample_en must use "${f.lemma}" (a form of the word)`);
  if (russianIssue(str(o.sample_ru))) return bad("S5_SAMPLE_RU", "sample_ru must be Russian");
  const words = [...new Set(strList(o.suggested_words))];
  if (words.length < 3 || words.length > 5) return bad("S5_WORDS", "3 to 5 different suggested_words are needed");
  for (const w of words) {
    if (/[Ѐ-ӿ]/.test(w) || w.split(" ").length > 3 || !/^[A-Za-z][A-Za-z' -]*$/.test(w)) return bad("S5_WORD_FORM", `suggested word "${w}" must be 1 to 3 English words`);
    if (!w.includes(" ") && w.length < 4) return bad("S5_WORD_SHORT", `"${w}" is too small a word to suggest; suggest useful words or short phrases`);
    if (isForm(w, f.word) || findTarget(w, f.word)) return bad("S5_WORD_TARGET", `"${w}" is the target word; suggest other words`);
    // a synonym would only replace the target word, and the task is to use the target word itself
    const lw = w.toLowerCase();
    const syn = f.synonyms.map((x) => x.toLowerCase().trim()).filter((x) => x.length >= 3).find((x) => new RegExp(`(^|[^a-z])${x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(lw));
    if (syn) return bad("S5_WORD_SYNONYM", `"${w}" is a synonym of the target word ("${syn}"); suggest words that go WITH the target word, not instead of it`);
  }
  if (concise && (/^imagine\b|^you are\b/i.test(situation) || russianIssue(str(o.hint_start_en)) || str(o.hint_start_en).length > 140 || str(o.hint_start_en).includes(sample))) return bad("S5_DIRECT", "Use a direct cue and one brief Russian suggestion without the full answer");
  if (!concise && !isProperStart(str(o.hint_start_en), sample)) return bad("S5_HINT", "hint_start_en must be the first words of sample_en and at least two words shorter");
  const why = ledger.fork().reason(sample, { independent: true });
  if (why) return bad("S5_REPEAT", `sample_en ${why}`);
  return ok({ situation_en: situation, situation_ru: str(o.situation_ru), suggested_words: words, hint_start_en: str(o.hint_start_en), sample_en: sample, sample_ru: str(o.sample_ru) });
}

const ruleOf = (id: string | null): string => (id && skillCards()[id] ? `; rule: ${skillCards()[id]!.rule}` : "");

/** the whole lesson as the self-review sees it */
export function reviewSentences(s12: Stage12, s3: Stage3, s4: Stage4, s5: Stage5): Array<Record<string, string>> {
  return [
    ...s12.examples.map((e, i) => ({ id: `e${i + 1}`, en: e.en, ru: e.ru })),
    { id: "gap", en: s12.gap.full_en, ru: s12.gap.ru, note: `the learner sees "${s12.gap.gapped_en}" and must supply the word` },
    ...s3.items.map((t, i) => ({ id: `t${i + 1}`, en: `${t.source_en}  =>  ${t.expected_en}`, ru: t.translation_ru, note: `instruction: ${t.instruction_en}; construction: ${t.construction_en}${ruleOf(t.skill_id)}` })),
    { id: "b", en: s4.expected_en, ru: s4.cue_ru, note: `construction: ${s4.construction_en}; scheme: ${s4.pattern}${ruleOf(s4.skill_id)}` },
    { id: "s5", en: s5.sample_en, ru: s5.sample_ru, note: `situation: ${s5.situation_en}` },
  ];
}

/** every English sentence with the Russian that must say the same (the translation check is a separate, narrow question: small models do it better than inside the general review) */
export function pairsOf(s12: Stage12, s3: Stage3, s4: Stage4, s5: Stage5): Array<{ id: string; en: string; ru: string }> {
  return [
    ...s12.examples.map((e, i) => ({ id: `e${i + 1}`, en: e.en, ru: e.ru })),
    { id: "gap", en: s12.gap.full_en, ru: s12.gap.ru },
    ...s3.items.map((t, i) => ({ id: `t${i + 1}`, en: t.expected_en, ru: t.translation_ru })),
    { id: "b", en: s4.expected_en, ru: s4.cue_ru },
    { id: "s5", en: s5.sample_en, ru: s5.sample_ru },
  ];
}

/** each transformation as a pair, to ask whether the result keeps the meaning of the source */
export function keepPairs(s3: Stage3): Array<{ id: string; a: string; b: string; instruction: string }> {
  return s3.items.map((t, i) => ({ id: `t${i + 1}`, a: t.source_en, b: t.expected_en, instruction: t.instruction_en }));
}

/** the sentences whose use of the target word is judged (the gapped sentence and the model sentences, with the word in them) */
export function senseSentences(s12: Stage12, s3: Stage3, s4: Stage4, s5: Stage5): Array<{ id: string; en: string }> {
  return [
    ...s12.examples.map((e, i) => ({ id: `e${i + 1}`, en: e.en })),
    { id: "gap", en: s12.gap.full_en },
    ...s3.items.map((t, i) => ({ id: `t${i + 1}`, en: `${t.source_en} / ${t.expected_en}` })),
    { id: "b", en: s4.expected_en },
    { id: "s5", en: s5.sample_en },
  ];
}

export function reviewInput(f: WordFacts, s12: Stage12, s3: Stage3, s4: Stage4, s5: Stage5): string {
  return JSON.stringify({ target_word: f.lemma, sense_ru: f.translationRu, part_of_speech: f.pos, sentences: reviewSentences(s12, s3, s4, s5) });
}

export const stageOfReviewId = (id: string): "stage12" | "stage3" | "stage4" | "stage5" | null =>
  /^e\d$/.test(id) || id === "gap" ? "stage12" : /^t\d$/.test(id) ? "stage3" : id === "b" ? "stage4" : id === "s5" ? "stage5" : null;
