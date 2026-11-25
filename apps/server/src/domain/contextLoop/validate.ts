import type { ContextLoopDifficulty } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { fingerprintOf, jaccard, normalizeSentence, trigrams } from "../content/normalize.js";
import { normalizeWord } from "../vocabulary/forms.js";
import type { SenseSnapshot } from "../wordLessons/runner.js";
import { NEAR_DUPLICATE_JACCARD, countTarget, englishIssue, findTarget, lessonWord, sentenceKey, sentencesOfContent, str, type LessonWord } from "../wordLessons/validate.js";

/**
 * Code checks of one Context Loop sentence (TASK_037 §4.4). The same checks run for the local model, for the coding agent's drafts and again on the
 * server when an agent batch is finalised, so a script is never trusted. The target position is always found here, never taken from the writer.
 */
export const MIN_WORDS = 3;
export const MAX_WORDS = 14;
const DIFFICULTIES: readonly ContextLoopDifficulty[] = ["easy", "medium", "challenging"];

export interface WordTarget {
  entryId: string;
  lemma: string;
  sense: SenseSnapshot;
  collocations: string[];
  word: LessonWord;
}

export const targetOf = (entryId: string, lemma: string, sense: SenseSnapshot, collocations: string[] = []): WordTarget => ({
  entryId,
  lemma,
  sense,
  collocations,
  word: lessonWord(lemma, sense.surfaceForms, sense.irregularForms),
});

export interface Draft {
  text: unknown;
  target_surface: unknown;
  context_label: unknown;
  difficulty: unknown;
  /** the Russian translation of the whole sentence; optional for the checks, asked of every writer */
  translation_ru?: unknown;
}

export interface CheckedSentence {
  translationRu: string | null;
  text: string;
  targetSurface: string;
  targetStart: number;
  targetLength: number;
  contextLabel: string;
  difficulty: ContextLoopDifficulty;
  fingerprint: string;
}

export type CheckResult = { ok: true; sentence: CheckedSentence } | { ok: false; code: string; message: string };

const fail = (code: string, message: string): CheckResult => ({ ok: false, code, message });
const escape = (f: string) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
const straight = (s: string) => s.replace(/[\u2018\u2019]/g, "'");
const firstTwo = (s: string) => sentenceKey(s).split(" ").filter(Boolean).slice(0, 2).join(" ");

/** a synonym of the word next to it gives the meaning away (a synonym that is itself a form of the word is ignored) */
export function synonymIn(text: string, t: WordTarget): string | null {
  for (const raw of t.sense.synonyms) {
    const syn = normalizeWord(raw);
    if (!syn || t.word.forms.includes(syn) || syn === t.word.lemma) continue;
    if (new RegExp(`(?<![\\p{L}\\p{N}'-])${escape(syn)}(?![\\p{L}\\p{N}'-])`, "iu").test(straight(text))) return syn;
  }
  return null;
}

export const MAX_TRANSLATION = 400;

/** a reason the Russian translation is unusable, or null (absent is allowed: older writers and learner edits have none) */
export function translationIssue(raw: unknown, english: string): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") return "must be a string";
  const t = raw.trim();
  if (!t) return null;
  if (t.length > MAX_TRANSLATION) return `is longer than ${MAX_TRANSLATION} characters`;
  const cyr = (t.match(/[Ѐ-ӿ]/g) ?? []).length;
  const lat = (t.match(/[A-Za-z]/g) ?? []).length;
  if (cyr === 0 || lat > cyr) return "must be a Russian translation (Cyrillic)";
  if (normalizeSentence(t) === normalizeSentence(english)) return "repeats the English sentence";
  if (/[\n\r]|___|\{|\}/.test(t)) return "must be one plain line";
  return null;
}

/** the checks that need no other sentence */
export function checkDraft(d: Draft, t: WordTarget): CheckResult {
  const text = str(d.text);
  if (!text) return fail("EMPTY", "the sentence is empty");
  const plain = englishIssue(text, { min: MIN_WORDS, max: MAX_WORDS });
  if (plain) return fail("SENTENCE", `the sentence ${plain}`);
  if (/\b(?:or|\/)\s*$/i.test(text) || /\([a-d]\)|\ba\)|\bb\)/i.test(text)) return fail("OPTIONS", "the sentence looks like a choice of options");
  const n = countTarget(text, t.word);
  if (n === 0) return fail("TARGET_MISSING", `"${t.lemma}" (or one of its forms) is not in the sentence`);
  if (n > 1) return fail("TARGET_TWICE", `"${t.lemma}" appears more than once`);
  const found = findTarget(text, t.word)!;
  const surface = str(d.target_surface);
  if (normalizeWord(surface) !== normalizeWord(found.form)) return fail("TARGET_SURFACE", `target_surface "${surface}" does not match "${found.form}" in the sentence`);
  const syn = synonymIn(text, t);
  if (syn) return fail("SYNONYM", `the synonym "${syn}" gives the meaning away`);
  const contextLabel = str(d.context_label).slice(0, 40);
  if (!contextLabel) return fail("CONTEXT_LABEL", "context_label is empty");
  const difficulty = str(d.difficulty) as ContextLoopDifficulty;
  if (!DIFFICULTIES.includes(difficulty)) return fail("DIFFICULTY", "difficulty must be easy, medium or challenging");
  const tr = translationIssue(d.translation_ru, text);
  if (tr) return fail("TRANSLATION", `translation_ru ${tr}`);
  const translationRu = str(d.translation_ru).replace(/\s+/g, " ") || null;
  return { ok: true, sentence: { translationRu, text, targetSurface: text.slice(found.start, found.start + found.length), targetStart: found.start, targetLength: found.length, contextLabel, difficulty, fingerprint: sentenceKey(text) } };
}

interface Known {
  key: string;
  grams: Set<string>;
  frame: string;
}

/**
 * No-repeat at writing time (D153): a sentence must not equal one of the exercise bank or of a Single Word lesson, and must not equal or nearly copy
 * another sentence of the same word (stored ones of any status, and those accepted earlier in this batch). At most two sentences of one word in a batch
 * may open with the same two words.
 */
export class ContextLedger {
  private lessonKeys = new Set<string>();
  private byEntry = new Map<string, Known[]>();
  private batchFrames = new Map<string, Map<string, number>>();

  constructor(private readonly db: Db) {
    for (const r of db.prepare("SELECT content_json AS c FROM word_lessons WHERE status = 'ready'").all() as Array<{ c: string }>) {
      for (const s of sentencesOfContent(JSON.parse(r.c))) this.lessonKeys.add(sentenceKey(s));
    }
  }

  private known(entryId: string): Known[] {
    let list = this.byEntry.get(entryId);
    if (!list) {
      list = (this.db.prepare("SELECT text FROM context_loop_sentences WHERE entry_id = ?").all(entryId) as Array<{ text: string }>).map((r) => ({ key: sentenceKey(r.text), grams: trigrams(normalizeSentence(r.text)), frame: firstTwo(r.text) }));
      this.byEntry.set(entryId, list);
    }
    return list;
  }

  /** a reason this sentence cannot be used for the word, or null */
  reason(entryId: string, text: string): string | null {
    const key = sentenceKey(text);
    if (this.db.prepare("SELECT 1 FROM prompt_units WHERE fingerprint = ? LIMIT 1").get(fingerprintOf(normalizeSentence(text)))) return "is a sentence of the exercise bank";
    if (this.lessonKeys.has(key)) return "is a sentence of a Single Word lesson";
    const grams = trigrams(normalizeSentence(text));
    for (const k of this.known(entryId)) {
      if (k.key === key) return "repeats a sentence this word already has";
      if (jaccard(grams, k.grams) >= NEAR_DUPLICATE_JACCARD) return "nearly copies a sentence this word already has";
    }
    if ((this.batchFrames.get(entryId)?.get(firstTwo(text)) ?? 0) >= 2) return `two sentences of this word already start with "${firstTwo(text)}"; change the sentence type`;
    return null;
  }

  accept(entryId: string, text: string): void {
    this.known(entryId).push({ key: sentenceKey(text), grams: trigrams(normalizeSentence(text)), frame: firstTwo(text) });
    const frames = this.batchFrames.get(entryId) ?? this.batchFrames.set(entryId, new Map()).get(entryId)!;
    frames.set(firstTwo(text), (frames.get(firstTwo(text)) ?? 0) + 1);
  }
}

/** checkDraft plus the ledger; an accepted sentence is recorded in the ledger */
export function checkAndAccept(d: Draft, t: WordTarget, ledger: ContextLedger): CheckResult {
  const r = checkDraft(d, t);
  if (!r.ok) return r;
  const why = ledger.reason(t.entryId, r.sentence.text);
  if (why) return fail("DUPLICATE", `the sentence ${why}`);
  ledger.accept(t.entryId, r.sentence.text);
  return r;
}
