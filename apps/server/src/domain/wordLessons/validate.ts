import type { Db } from "../../db/open.js";
import { answerKey } from "../content/grader.js";
import { fingerprintOf, jaccard, normalizeSentence, trigrams } from "../content/normalize.js";
import { matchForms, normalizeWord, regularForms } from "../vocabulary/forms.js";
import type { Validated } from "../ai/validate.js";

export const CYRILLIC = /[Ѐ-ӿ]/;
export const NEAR_DUPLICATE_JACCARD = 0.8;

/** the spellings that count as "the word" in a sentence: its regular forms, what the learner met, the irregular forms; a phrase keeps its other words in place */
export interface LessonWord {
  lemma: string;
  /** lower case, longest first */
  forms: string[];
}

export function lessonWord(lemma: string, surfaceForms: readonly string[], irregularForms: readonly string[]): LessonWord {
  const base = normalizeWord(lemma);
  const set = new Set<string>(matchForms(base, surfaceForms));
  const parts = base.split(" ");
  // a phrasal verb lists its irregular forms whole ("ran into", "came up with"); a one-word list entry may also be the bare verb ("ran")
  const irregular = irregularForms.map(normalizeWord).filter((f) => /^[a-z'-]+(?: [a-z'-]+)*$/.test(f));
  if (base.includes("-")) {
    // "trade-off": written with the hyphen, with a space or in one word, and the plural (the regular endings would inflect only the last part)
    for (const v of [base, base.replace(/-/g, " "), base.replace(/-/g, "")]) {
      set.add(v);
      set.add(`${v}s`);
    }
  }
  if (parts.length === 1) {
    for (const f of irregular) set.add(f);
  } else {
    // "give up": the verb inflects, the particle stays (matchForms alone would inflect the last word)
    const rest = parts.slice(1).join(" ");
    for (const f of regularForms(parts[0]!)) set.add(`${f} ${rest}`);
    for (const f of irregular) set.add(f.includes(" ") ? f : `${f} ${rest}`);
  }
  return { lemma: base, forms: [...set].filter(Boolean).sort((a, b) => b.length - a.length || a.localeCompare(b)) };
}

const escape = (f: string) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
const regexOf = (forms: readonly string[]) => new RegExp(`(?<![\\p{L}\\p{N}'-])(?:${forms.map(escape).join("|")})(?![\\p{L}\\p{N}'-])`, "giu");

const straight = (s: string) => s.replace(/[\u2018\u2019]/g, "'");

/** where the word occurs (first match, longest form first); the offsets refer to the text exactly as it is stored */
export function findTarget(text: string, w: LessonWord): { start: number; length: number; form: string } | null {
  if (w.forms.length === 0) return null;
  const m = regexOf(w.forms).exec(straight(text));
  return m ? { start: m.index, length: m[0].length, form: m[0] } : null;
}

export function countTarget(text: string, w: LessonWord): number {
  if (w.forms.length === 0) return 0;
  return (straight(text).match(regexOf(w.forms)) ?? []).length;
}

export const isForm = (form: string, w: LessonWord): boolean => w.forms.includes(normalizeWord(form));

/** the text with the (single) occurrence of the word replaced by a gap; null unless there is exactly one */
export function gapOut(text: string, w: LessonWord): string | null {
  if (countTarget(text, w) !== 1) return null;
  return straight(text).replace(regexOf(w.forms), "___");
}

export const wordCount = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

/** the plain checks of one English sentence of a lesson; null = fine */
export function englishIssue(s: string, o: { min?: number; max?: number } = {}): string | null {
  const t = s.trim();
  if (CYRILLIC.test(t)) return "must be English only";
  if (!/[.?!]["')]?$/.test(t)) return "must end with . ? or !";
  if (/[\n\r]/.test(t) || /[*_`#<>{}[\]]/.test(t)) return "must be one plain sentence (no markup)";
  const n = wordCount(t);
  if (n < (o.min ?? 4) || n > (o.max ?? 22)) return `must be ${o.min ?? 4}-${o.max ?? 22} words`;
  return null;
}

export const russianIssue = (s: string, max = 300): string | null => (!CYRILLIC.test(s) || s.trim().length > max ? "must be a short Russian text" : null);

/** the key two sentences are compared by: case, a final stop and typographic quotes do not make a sentence new */
export const sentenceKey = (s: string): string => answerKey(s);

/** how many words differ between two sentences (the fewest insertions, deletions and replacements), case and the final stop ignored */
export function wordDistance(a: string, b: string): number {
  const x = sentenceKey(a).split(" ").filter(Boolean);
  const y = sentenceKey(b).split(" ").filter(Boolean);
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const row = [i];
    for (let j = 1; j <= y.length; j++) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[y.length]!;
}

/** `part` is the start of `full` in whole words and at least two words shorter */
export function isProperStart(part: string, full: string): boolean {
  const a = sentenceKey(part).split(" ").filter(Boolean);
  const b = sentenceKey(full).split(" ").filter(Boolean);
  return a.length >= 1 && a.length <= b.length - 2 && a.every((x, i) => x === b[i]);
}

/** every English sentence of a stored lesson */
export function sentencesOfContent(c: unknown): string[] {
  const x = c as { stage1?: { examples?: Array<{ en: string }> }; stage2?: { full_en?: string }; stage3?: { items?: Array<{ source_en: string; expected_en: string }> }; stage4?: { expected_en?: string }; stage5?: { sample_en?: string } };
  return [
    ...(x.stage1?.examples ?? []).map((e) => e.en),
    ...(x.stage2?.full_en ? [x.stage2.full_en] : []),
    ...(x.stage3?.items ?? []).flatMap((i) => [i.source_en, i.expected_en]),
    ...(x.stage4?.expected_en ? [x.stage4.expected_en] : []),
    ...(x.stage5?.sample_en ? [x.stage5.sample_en] : []),
  ];
}

interface Gram {
  key: string;
  grams: Set<string>;
}

/**
 * No-repeat for lessons (D130): a sentence must not equal one of the exercise bank, nor a sentence of an earlier lesson, and an independent
 * sentence must not nearly copy a sentence of another lesson. The lesson's own sentences are tracked as they are accepted.
 */
export class SentenceLedger {
  private others: Gram[] = [];
  private otherKeys = new Set<string>();
  private own = new Map<string, string>();
  private ownIndependent: Gram[] = [];

  constructor(
    private readonly db: Db,
    lessonId: string,
    preload = true,
  ) {
    if (!preload) return;
    for (const r of db.prepare("SELECT content_json AS c FROM word_lessons WHERE status = 'ready' AND id <> ?").all(lessonId) as Array<{ c: string }>) {
      for (const s of sentencesOfContent(JSON.parse(r.c))) {
        this.otherKeys.add(sentenceKey(s));
        this.others.push({ key: sentenceKey(s), grams: trigrams(normalizeSentence(s)) });
      }
    }
  }

  /** a reason this sentence cannot be used, or null */
  reason(s: string, o: { independent: boolean; allowSameAs?: string }): string | null {
    const key = sentenceKey(s);
    if (this.db.prepare("SELECT 1 FROM prompt_units WHERE fingerprint = ? LIMIT 1").get(fingerprintOf(normalizeSentence(s)))) return "is a sentence of the exercise bank";
    if (this.otherKeys.has(key)) return "repeats a sentence of another lesson";
    if (o.independent) {
      const grams = trigrams(normalizeSentence(s));
      for (const r of this.others) if (jaccard(grams, r.grams) >= NEAR_DUPLICATE_JACCARD) return "nearly copies a sentence of another lesson";
      for (const r of this.ownIndependent) if (r.key !== key && jaccard(grams, r.grams) >= NEAR_DUPLICATE_JACCARD) return "nearly repeats another sentence of this lesson";
    }
    const same = this.own.get(key);
    if (same !== undefined && same !== o.allowSameAs) return "repeats another sentence of this lesson";
    return null;
  }

  /** a sentence accepted into the lesson */
  accept(s: string, o: { independent: boolean; id: string }): void {
    const key = sentenceKey(s);
    this.own.set(key, o.id);
    if (o.independent) this.ownIndependent.push({ key, grams: trigrams(normalizeSentence(s)) });
  }

  /** a copy used to check one model call without recording its sentences until the whole stage is accepted */
  fork(): SentenceLedger {
    const c = new SentenceLedger(this.db, "", false);
    c.others = this.others;
    c.otherKeys = this.otherKeys;
    c.own = new Map(this.own);
    c.ownIndependent = [...this.ownIndependent];
    return c;
  }
}

export const bad = <T>(code: string, message: string): Validated<T> => ({ ok: false, value: null, issues: [{ code, message }] });
export const ok = <T>(value: T): Validated<T> => ({ ok: true, value, issues: [] });

export function parseObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const str = (v: unknown): string => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");
export const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
