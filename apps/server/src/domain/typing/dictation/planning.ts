import type { Db } from "../../../db/open.js";
import { exportLessonPriorities } from "../../reports/lessonPriorities.js";
import { dictationVocabulary } from "../../vocabulary/repository.js";
import { tokenize } from "./check.js";
import { ApiError } from "../../../errors.js";
import { modelShaOpt } from "../../voices/model.js";
import type { DictationEnv } from "./lessons.js";

/** a direction for sentences (not words that must appear): the sentence is set in a situation related to it */
export interface DictationTopic {
  name: string;
  /** used to keep the voices suitable (a voice's avoidGroups) */
  group: string;
}

export type Register = "conversational" | "neutral" | "explanatory";

export interface PlanItem {
  ordinal: number;
  topic: string;
  topicGroup?: string;
  targetSkillId: string | null;
  targetSkillLabel?: string | null;
  voiceId: number;
  /** about how many words the sentence should have (sentences vary in length, like a dictation test) */
  targetWords?: number;
  /** one of the learner's saved words the sentence must use (any form), for revision */
  vocabularyEntryId?: string | null;
  vocabularyLemma?: string | null;
  vocabularyForms?: string[];
  /** the grammar construction to use (a weak skill's label when `targetSkillId` is set), the communication intent, the style and the grammatical subject */
  grammar?: string;
  intent?: string;
  register?: Register;
  subject?: string;
  /** where the sentence comes from: written now, taken from the prepared tracks, or a repeat of an earlier one */
  from?: "generate" | "pool" | "repeat";
  /** pool row or original exercise (for `pool` / `repeat`) */
  ref?: string;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ the independent parameters of a sentence */

export const GRAMMAR = [
  "Past Simple", "Present Perfect", "Past Perfect", "Past Continuous", "Present Continuous for plans", "Future with will", "going to for plans",
  "First Conditional", "Second Conditional", "Third Conditional", "Passive voice", "Modal verbs of advice (should, ought to)",
  "Modal verbs of possibility (might, could, may)", "Modal verbs of obligation (have to, must)", "Reported speech", "Relative clauses (who, which, that)",
  "Comparatives and superlatives", "used to for past habits", "wish and hope structures", "Gerund after a verb (enjoy doing, avoid doing)",
  "Infinitive of purpose (to do something)", "A question with a question word", "Present Simple for routines", "Present Perfect Continuous",
  "Past Simple with a time clause (when, while, after)", "A phrasal verb", "would rather and prefer",
] as const;

export const INTENTS = [
  "expressing regret", "giving advice", "describing an unexpected event", "explaining a mistake", "making a plan", "expressing uncertainty",
  "comparing alternatives", "describing a past experience", "discussing possibilities", "explaining a problem", "asking for help", "complaining politely",
  "agreeing or disagreeing", "making a prediction", "telling a short story", "reporting what someone said", "giving instructions", "expressing surprise",
] as const;

export const SUBJECTS = [
  "I", "we", "they", "she", "he", "you", "my colleague", "the engineer", "a tourist", "the teacher", "our neighbour", "my friend", "the manager", "a student", "the driver", "my sister",
] as const;

/** the share of each style: casual spoken sentences are a large part, so the lessons do not sound like a book */
export const REGISTER_SHARE: ReadonlyArray<readonly [Register, number]> = [["conversational", 0.4], ["neutral", 0.4], ["explanatory", 0.2]];

/** successive shuffled bags of `list`, so every value comes round before any repeats and no value follows itself */
export function cycle<T>(list: readonly T[], rand: () => number, count: number): T[] {
  const out: T[] = [];
  while (out.length < count) {
    const bag = [...list];
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [bag[i], bag[j]] = [bag[j]!, bag[i]!];
    }
    if (out.length > 0 && bag.length > 1 && bag[0] === out[out.length - 1]) [bag[0], bag[1]] = [bag[1]!, bag[0]!];
    out.push(...bag);
  }
  return out.slice(0, count);
}

const pickWeighted = <T>(items: ReadonlyArray<readonly [T, number]>, rand: () => number): T => {
  const total = items.reduce((a, [, w]) => a + w, 0);
  let x = rand() * total;
  for (const [t, w] of items) {
    x -= w;
    if (x <= 0) return t;
  }
  return items[items.length - 1]![0];
};

/* ------------------------------------------------------------------ the plan */

/** the confirmed weak grammar skills (D91): at least 5 confirmed attempts, highest selection priority first */
export function weakGrammarSkills(db: Db, asOf: string, limit: number): Array<{ id: string; label: string }> {
  const rows = (exportLessonPriorities(db, asOf, 5).json as { skills: Array<{ id: string; label: string; confirmedAttempts: number; priority: number | null }> }).skills;
  return rows
    .filter((r) => r.confirmedAttempts >= 5 && r.priority !== null)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .slice(0, limit)
    .map((r) => ({ id: r.id, label: r.label }));
}

/** about 7-14 words, most often the middle of that range (a dictation test mixes moderately short and medium sentences) */
export function targetWordsFor(rand: () => number): number {
  return 7 + Math.floor(Math.pow(rand(), 1.2) * 8);
}

/** share of generated sentences that must use one of the learner's saved words */
export const VOCABULARY_SHARE = 0.35;
const RECENT_TOPICS = 30;
const RECENT_SENTENCES_FOR_WORDS = 240;

/** topics of the latest sentences (lessons and prepared tracks), newest first */
function recentTopicNames(db: Db): string[] {
  return (
    db
      .prepare(`SELECT topic FROM (SELECT topic, created_at FROM typing_dictation_exercises UNION ALL SELECT topic, created_at FROM typing_dictation_pool) ORDER BY created_at DESC LIMIT ${RECENT_TOPICS}`)
      .all() as Array<{ topic: string }>
  ).map((r) => r.topic);
}

/**
 * Topics for `count` sentences: not the ones used lately while there are enough others, shuffled, and with neighbours from different groups
 * where possible (a run of three music sentences is dull).
 */
export function pickTopics(topics: readonly DictationTopic[], recent: readonly string[], count: number, rand: () => number): DictationTopic[] {
  const fresh = topics.filter((t) => !recent.includes(t.name));
  const stale = topics.filter((t) => recent.includes(t.name)).sort((a, b) => recent.lastIndexOf(b.name) - recent.lastIndexOf(a.name));
  const pool = [...fresh];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  const source = pool.length >= count ? pool : [...pool, ...stale];
  const out: DictationTopic[] = [];
  const left = source.slice(0, Math.max(count, Math.min(source.length, count * 2)));
  while (out.length < count && left.length > 0) {
    const prev = out[out.length - 1];
    const k = left.findIndex((t) => t.group !== prev?.group);
    out.push(left.splice(k < 0 ? 0 : k, 1)[0]!);
  }
  return out;
}

/**
 * The plan of `count` sentences. Every sentence gets independent parameters: a topic (a direction, never a phrase to repeat), a grammar construction
 * (a weak skill from the learner's grammar practice for up to half of them), a communication intent, a style, a subject, a target length and a voice;
 * sometimes also one of the learner's saved words.
 */
export function buildItems(db: Db, env: DictationEnv, o: { count: number; seed: number; topicOffset: number; asOf: string }): PlanItem[] {
  const { count } = o;
  const rand = mulberry32(o.seed ^ 0x5bd1e995);
  const topics = pickTopics(env.topics, recentTopicNames(db), count, rand);
  const grammar = cycle(GRAMMAR, rand, count);
  const intents = cycle(INTENTS, rand, count);
  const subjects = cycle(SUBJECTS, rand, count);
  const voiceIds = env.voices.plan(db, { purpose: "dictation", count, seed: o.seed, groups: topics.map((t) => t.group), ...modelShaOpt(env.tts) }).map((v) => v.id);
  if (voiceIds.length < count) throw new ApiError(409, "TYPING_DICTATION_NO_VOICE", "No voice is switched on for Audio Dictation. Turn one on in Settings → Voices.");
  const weak = weakGrammarSkills(db, o.asOf, count);
  // at most half of the sentences practise a weak skill, spread over the list; the rest is a plain mix
  const skillSlots = new Set<number>();
  const wanted = Math.min(Math.floor(count / 2), weak.length);
  for (let k = 0; k < wanted; k++) skillSlots.add(Math.floor((k * count) / wanted));
  // saved words that did not appear in the latest dictation sentences, picked at random
  const recent = (db.prepare(`SELECT text_en AS t FROM (SELECT text_en, created_at FROM typing_dictation_exercises UNION ALL SELECT text_en, created_at FROM typing_dictation_pool) ORDER BY created_at DESC LIMIT ${RECENT_SENTENCES_FOR_WORDS}`).all() as Array<{ t: string }>).flatMap((r) => tokenize(r.t));
  const seen = new Set(recent);
  const words = dictationVocabulary(db).filter((w) => !w.forms.some((f) => seen.has(f)));
  for (let i = words.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [words[i], words[j]] = [words[j]!, words[i]!];
  }
  let nextSkill = 0;
  let nextWord = 0;
  return Array.from({ length: count }, (_, ordinal) => {
    const skill = skillSlots.has(ordinal) ? weak[nextSkill++ % weak.length]! : null;
    const word = rand() < VOCABULARY_SHARE && nextWord < words.length ? words[nextWord++]! : null;
    const topic = topics[ordinal] ?? env.topics[ordinal % env.topics.length]!;
    return {
      ordinal,
      topic: topic.name,
      topicGroup: topic.group,
      targetSkillId: skill?.id ?? null,
      targetSkillLabel: skill?.label ?? null,
      voiceId: voiceIds[ordinal]!,
      targetWords: targetWordsFor(rand),
      vocabularyEntryId: word?.entryId ?? null,
      vocabularyLemma: word?.lemma ?? null,
      vocabularyForms: word?.forms ?? [],
      grammar: skill?.label ?? grammar[ordinal]!,
      intent: intents[ordinal]!,
      register: pickWeighted(REGISTER_SHARE, rand),
      subject: subjects[ordinal]!,
      from: "generate" as const,
    };
  });
}
